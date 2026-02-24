/**
 * WeFlow API CLI - WebSocket 服务
 * 提供实时消息推送功能（含消息内容解密）
 * 
 * 设计原则：
 * 1. 只推送 new_message 类型的消息，不推送 db_change 和 session_update
 * 2. 使用 localId 进行去重，避免重复推送相同消息
 * 3. 实时监听数据库变更，通过命名管道 IPC 获取通知
 */
import { WebSocketServer, WebSocket } from 'ws';
import * as fzstd from 'fzstd';
import { getConfig } from './config.js';
import { getWcdbCore } from './wcdbCore.js';

interface WsClient {
    ws: WebSocket;
    id: string;
    subscribedSessions: Set<string>;
}

// ChatLab 消息类型映射
const ChatLabType = {
    TEXT: 0,
    IMAGE: 1,
    VOICE: 2,
    VIDEO: 3,
    FILE: 4,
    EMOJI: 5,
    LINK: 7,
    LOCATION: 8,
    RED_PACKET: 20,
    TRANSFER: 21,
    POKE: 22,
    CALL: 23,
    SHARE: 24,
    REPLY: 25,
    FORWARD: 26,
    CONTACT: 27,
    SYSTEM: 80,
    RECALL: 81,
    OTHER: 99,
} as const;

interface ProcessedMessage {
    localId: number;
    serverId: string;
    localType: number;
    createTime: number;
    isSend: number;
    senderUsername: string;
    parsedContent: string;
    rawContent: string;
    xmlType?: string;
    url?: string;
    referencedMessageId?: string;
}

export class WsService {
    private wss: WebSocketServer | null = null;
    private port: number;
    private host: string;
    private running = false;
    private clients: Map<string, WsClient> = new Map();
    private clientIdCounter = 0;
    private monitorStarted = false;
    private pollingTimer: ReturnType<typeof setInterval> | null = null;
    private pollingIntervalMs = 1000; // 轮询间隔（毫秒）— 降低以减少延迟
    private usingFallbackPolling = false;

    // 使用 localId 追踪每个会话已推送的消息，避免重复
    // key: sessionId, value: Set of localIds that have been sent
    private sentMessageIds: Map<string, Set<number>> = new Map();

    // 每个会话保留的最大已发送消息 ID 数量（防止内存无限增长）
    private readonly maxSentIdsPerSession = 1000;

    // 防止频繁查询的节流
    private pendingCheck = false;
    private checkDebounceMs = 100;  // 降低防抖时间以减少延迟
    private lastCheckTime = 0;

    constructor() {
        const config = getConfig();
        this.port = config.wsPort;
        this.host = config.wsHost;
    }

    async start(): Promise<{ success: boolean; port?: number; error?: string }> {
        if (this.running && this.wss) {
            return { success: true, port: this.port };
        }

        return new Promise((resolve) => {
            try {
                this.wss = new WebSocketServer({
                    port: this.port,
                    host: this.host,
                });

                this.wss.on('listening', () => {
                    this.running = true;
                    console.log(`✅ WebSocket 服务启动: ws://${this.host}:${this.port}`);

                    // 启动数据库监控
                    this.startDbMonitor();

                    resolve({ success: true, port: this.port });
                });

                this.wss.on('error', (err: NodeJS.ErrnoException) => {
                    if (err.code === 'EADDRINUSE') {
                        console.error(`❌ WebSocket 端口 ${this.port} 已被占用`);
                        resolve({ success: false, error: `Port ${this.port} is already in use` });
                    } else {
                        console.error('❌ WebSocket 服务错误:', err);
                        resolve({ success: false, error: err.message });
                    }
                });

                this.wss.on('connection', (ws, req) => {
                    this.handleConnection(ws, req);
                });
            } catch (e) {
                console.error('❌ WebSocket 服务启动失败:', e);
                resolve({ success: false, error: String(e) });
            }
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            // 停止数据库监控
            this.stopDbMonitor();

            if (this.wss) {
                // 关闭所有客户端连接
                for (const client of this.clients.values()) {
                    client.ws.close(1000, 'Server shutting down');
                }
                this.clients.clear();

                this.wss.close(() => {
                    this.running = false;
                    this.wss = null;
                    console.log('WebSocket 服务已停止');
                    resolve();
                });
            } else {
                this.running = false;
                resolve();
            }
        });
    }

    isRunning(): boolean {
        return this.running;
    }

    private handleConnection(ws: WebSocket, req: any): void {
        const clientId = `client_${++this.clientIdCounter}`;
        const client: WsClient = {
            ws,
            id: clientId,
            subscribedSessions: new Set(),
        };

        this.clients.set(clientId, client);
        console.log(`WebSocket 客户端连接: ${clientId} (当前连接数: ${this.clients.size})`);

        // 发送欢迎消息
        this.sendToClient(client, {
            type: 'connected',
            clientId,
            message: 'Welcome to WeFlow WebSocket API',
            timestamp: Date.now(),
        });

        ws.on('message', (data) => {
            this.handleMessage(client, data);
        });

        ws.on('close', () => {
            this.clients.delete(clientId);
            console.log(`WebSocket 客户端断开: ${clientId} (当前连接数: ${this.clients.size})`);
        });

        ws.on('error', (err) => {
            console.error(`WebSocket 客户端错误 ${clientId}:`, err);
        });
    }

    private handleMessage(client: WsClient, data: any): void {
        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case 'subscribe':
                    // 订阅特定会话的消息更新
                    if (message.sessions && Array.isArray(message.sessions)) {
                        for (const sessionId of message.sessions) {
                            client.subscribedSessions.add(sessionId);
                        }
                        this.sendToClient(client, {
                            type: 'subscribed',
                            sessions: Array.from(client.subscribedSessions),
                            timestamp: Date.now(),
                        });
                    }
                    break;

                case 'unsubscribe':
                    // 取消订阅
                    if (message.sessions && Array.isArray(message.sessions)) {
                        for (const sessionId of message.sessions) {
                            client.subscribedSessions.delete(sessionId);
                        }
                    } else {
                        client.subscribedSessions.clear();
                    }
                    this.sendToClient(client, {
                        type: 'unsubscribed',
                        sessions: Array.from(client.subscribedSessions),
                        timestamp: Date.now(),
                    });
                    break;

                case 'subscribe_all':
                    // 订阅所有会话更新
                    client.subscribedSessions.add('*');
                    this.sendToClient(client, {
                        type: 'subscribed',
                        sessions: ['*'],
                        message: 'Subscribed to all sessions',
                        timestamp: Date.now(),
                    });
                    break;

                case 'ping':
                    this.sendToClient(client, {
                        type: 'pong',
                        timestamp: Date.now(),
                    });
                    break;

                case 'status':
                    this.sendToClient(client, {
                        type: 'status',
                        connected: true,
                        monitorActive: this.monitorStarted,
                        subscribedSessions: Array.from(client.subscribedSessions),
                        totalClients: this.clients.size,
                        timestamp: Date.now(),
                    });
                    break;

                default:
                    this.sendToClient(client, {
                        type: 'error',
                        error: `Unknown message type: ${message.type}`,
                        timestamp: Date.now(),
                    });
            }
        } catch (e) {
            this.sendToClient(client, {
                type: 'error',
                error: 'Invalid JSON message',
                timestamp: Date.now(),
            });
        }
    }

    private sendToClient(client: WsClient, data: any): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    }

    private broadcast(data: any, sessionId?: string): void {
        const message = JSON.stringify(data);
        let sentCount = 0;

        for (const client of this.clients.values()) {
            if (client.ws.readyState !== WebSocket.OPEN) continue;

            // 如果指定了 sessionId，只发送给订阅了该会话或订阅了所有会话的客户端
            if (sessionId) {
                if (client.subscribedSessions.has(sessionId) || client.subscribedSessions.has('*')) {
                    client.ws.send(message);
                    sentCount++;
                }
            } else {
                // 没有指定 sessionId，发送给所有客户端
                client.ws.send(message);
                sentCount++;
            }
        }
    }

    private startDbMonitor(): void {
        if (this.monitorStarted) return;

        const wcdb = getWcdbCore();
        const success = wcdb.startMonitor((type, json) => {
            if (type === 'monitor_unavailable') {
                // 管道监控不可用，启用轮询备用方案
                if (!this.usingFallbackPolling) {
                    console.warn('⚠️ 管道监控不可用，切换到轮询模式检测新消息');
                    this.startFallbackPolling();
                }
                return;
            }

            // 管道监控恢复后，停止轮询
            if (this.usingFallbackPolling) {
                console.log('✅ 管道监控已恢复，停止轮询模式');
                this.stopFallbackPolling();
            }

            this.handleDbChange(type, json);
        });

        // startMonitor 现在总是返回 true（因为它会后台重试）
        // 但我们仍然标记 monitorStarted
        this.monitorStarted = true;

        if (success) {
            console.log('✅ 数据库变更监控已启动');
        }

        // 如果管道监控在短时间内未建立连接，启动轮询作为备用
        setTimeout(() => {
            if (this.monitorStarted && !wcdb.isMonitorConnected() && !this.usingFallbackPolling) {
                console.warn('⚠️ 管道监控未在预期时间内连接，启用轮询备用模式');
                this.startFallbackPolling();
            }
        }, 2000);  // 降低超时以更快切换到轮询备用
    }

    private stopDbMonitor(): void {
        if (!this.monitorStarted) return;

        this.stopFallbackPolling();

        const wcdb = getWcdbCore();
        wcdb.stopMonitor();
        this.monitorStarted = false;
        console.log('数据库变更监控已停止');
    }

    /** 启动轮询备用方案 */
    private startFallbackPolling(): void {
        if (this.pollingTimer) return;
        this.usingFallbackPolling = true;

        console.log(`📡 轮询模式已启动 (间隔: ${this.pollingIntervalMs}ms)`);
        this.pollingTimer = setInterval(() => {
            if (this.hasSubscribedClients()) {
                this.checkNewMessages();
            }
        }, this.pollingIntervalMs);
    }

    /** 停止轮询备用方案 */
    private stopFallbackPolling(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
        this.usingFallbackPolling = false;
    }

    private handleDbChange(type: string, json: string): void {
        try {
            if (!this.hasSubscribedClients()) return;

            // 尝试从管道消息中提取 sessionId，实现定向查询而非全量扫描
            let targetSession: string | undefined;
            try {
                const parsed = JSON.parse(json);
                targetSession = parsed.sessionId || parsed.username || parsed.talker || parsed.session_id || parsed.user_name;
            } catch { }

            if (targetSession) {
                // 定向查询：只检查变化的那个会话，跳过防抖直接查
                console.log(`[定向检查] 管道通知会话变更: ${targetSession}`);
                this.checkSessionNewMessages(targetSession);
            } else {
                // 无法确定具体会话，回退到防抖全量检查
                this.debouncedCheckNewMessages();
            }
        } catch (e) {
            console.error('处理数据库变更失败:', e);
        }
    }

    // 检查是否有客户端订阅了任何会话
    private hasSubscribedClients(): boolean {
        for (const client of this.clients.values()) {
            if (client.subscribedSessions.size > 0) {
                return true;
            }
        }
        return false;
    }

    // 获取所有订阅的会话（包括 * 通配符）
    private getSubscribedSessionIds(): Set<string> {
        const sessions = new Set<string>();
        for (const client of this.clients.values()) {
            for (const session of client.subscribedSessions) {
                sessions.add(session);
            }
        }
        return sessions;
    }

    // 防抖检查新消息
    private debouncedCheckNewMessages(): void {
        const now = Date.now();

        // 如果距离上次检查时间太短，延迟执行
        if (now - this.lastCheckTime < this.checkDebounceMs) {
            if (!this.pendingCheck) {
                this.pendingCheck = true;
                setTimeout(() => {
                    this.pendingCheck = false;
                    this.checkNewMessages();
                }, this.checkDebounceMs);
            }
            return;
        }

        this.lastCheckTime = now;
        this.checkNewMessages();
    }

    // 检查并推送新消息
    private async checkNewMessages(): Promise<void> {
        try {
            const wcdb = getWcdbCore();
            const subscribedSessions = this.getSubscribedSessionIds();
            const hasWildcard = subscribedSessions.has('*');

            // 获取会话列表
            const sessionsResult = await wcdb.getSessions();
            if (!sessionsResult.success || !sessionsResult.data) {
                return;
            }

            // 确定要检查的会话
            let sessionsToCheck: any[] = sessionsResult.data;

            if (!hasWildcard) {
                // 只检查被订阅的会话
                sessionsToCheck = sessionsToCheck.filter((session: any) => {
                    const username = session.username || session.user_name || '';
                    return subscribedSessions.has(username);
                });
            } else {
                // 只检查前 20 个最近活跃的会话
                sessionsToCheck = sessionsToCheck.slice(0, 20);
            }

            // 检查每个会话的最新消息
            for (const session of sessionsToCheck) {
                const username = session.username || session.user_name || '';
                if (!username) continue;

                await this.checkSessionNewMessages(username);
            }
        } catch (e) {
            console.error('检查新消息失败:', e);
        }
    }

    // 检查单个会话的新消息
    private async checkSessionNewMessages(sessionId: string): Promise<void> {
        try {
            const wcdb = getWcdbCore();
            const config = getConfig();
            const myWxid = config.myWxid;

            // 获取该会话已发送的消息 ID 集合
            let sentIds = this.sentMessageIds.get(sessionId);
            const isFirstCheck = !sentIds;
            if (!sentIds) {
                sentIds = new Set();
                this.sentMessageIds.set(sessionId, sentIds);
            }

            // 查询最新的几条消息（降序，最新的在前）
            const cursorResult = await wcdb.openMessageCursor(
                sessionId,
                10,      // 每次检查最新 10 条
                false,   // descending - 最新的在前
                0,       // no start time limit
                0        // no end time limit
            );

            if (!cursorResult.success || !cursorResult.data) {
                return;
            }

            const cursor = cursorResult.data;
            const newMessages: ProcessedMessage[] = [];

            try {
                const batch = await wcdb.fetchMessageBatch(cursor);
                if (batch.success && batch.data?.rows) {

                    for (const row of batch.data.rows) {
                        const localId = parseInt(row.local_id || row.localId || '0', 10);

                        // 首次检查：初始化已发送 ID，但不推送
                        if (isFirstCheck) {
                            sentIds.add(localId);
                            continue;
                        }

                        // 检查是否已经发送过这条消息
                        if (sentIds.has(localId)) {
                            continue;
                        }


                        // 解码消息内容
                        const content = this.decodeMessageContent(row.message_content, row.compress_content);
                        const localType = parseInt(row.local_type || row.type || '1', 10);
                        const createTime = parseInt(row.create_time || '0', 10);
                        const senderUsername = row.sender_username || '';
                        const isSend = parseInt(row.is_send || '0', 10) === 1;

                        // 提取 XML 中的 type
                        const xmlType = this.extractMessageXmlType(content, localType) || undefined;
                        const linkUrl = this.extractLinkUrl(content, localType) || undefined;
                        const referencedMessageId = this.isReplyMessage(localType, xmlType)
                            ? this.extractReferencedMessageId(content)
                            : undefined;

                        const parsedContent = this.parseMessageContent(content, localType);

                        const serverId = row.server_id ?? row.serverId ?? '';
                        const message: ProcessedMessage = {
                            localId,
                            serverId: serverId ? String(serverId) : '',
                            localType,
                            createTime,
                            isSend: isSend ? 1 : 0,
                            senderUsername: isSend ? myWxid : senderUsername || sessionId,
                            parsedContent: parsedContent || `[类型 ${localType}]`,
                            rawContent: content,
                            xmlType,
                            url: linkUrl,
                            referencedMessageId,
                        };

                        newMessages.push(message);

                        // 标记为已发送
                        sentIds.add(localId);
                    }
                }
            } finally {
                await wcdb.closeMessageCursor(cursor);
            }

            // 清理过多的已发送 ID（保持内存可控）
            if (sentIds.size > this.maxSentIdsPerSession) {
                const idsArray = Array.from(sentIds);
                const toRemove = idsArray.slice(0, sentIds.size - this.maxSentIdsPerSession);
                for (const id of toRemove) {
                    sentIds.delete(id);
                }
            }

            // 有新消息才广播
            if (newMessages.length > 0) {
                newMessages.reverse();

                for (const msg of newMessages) {
                    const preview = this.truncateMessagePreview(msg.parsedContent || '', 20);
                    console.log(`[\u65b0\u6d88\u606f] ${msg.senderUsername} \u63a8\u9001\u4e86 1 \u6761\u6d88\u606f ${preview}`);

                    // 使用 mapMessageType 转换消息类型
                    const chatlabType = this.mapMessageType(msg.localType, msg.xmlType);
                    const url = chatlabType === ChatLabType.LINK
                        ? (msg.url || this.extractLinkUrl(msg.rawContent, msg.localType) || undefined)
                        : undefined;

                    const notification = {
                        type: 'new_message',
                        sessionId,
                        message: {
                            sender: msg.senderUsername,
                            timestamp: msg.createTime,
                            type: chatlabType,
                            content: msg.parsedContent,
                            referencedPlatformMessageId: chatlabType === ChatLabType.REPLY ? msg.referencedMessageId : undefined,
                            url,
                            platformMessageId: msg.serverId || undefined,
                        },
                        timestamp: Date.now(),
                    };
                    this.broadcast(notification, sessionId);
                }
            }
        } catch (e) {
            console.error(`检查会话 ${sessionId} 新消息失败:`, e);
        }
    }

    // 解码消息内容
    private decodeMessageContent(messageContent: any, compressContent: any): string {
        let content = '';

        if (compressContent) {
            content = this.decodeMaybeCompressed(compressContent);
        }
        if (!content && messageContent) {
            content = this.decodeMaybeCompressed(messageContent);
        }

        return content;
    }

    private decodeMaybeCompressed(raw: any): string {
        if (!raw) return '';
        if (typeof raw === 'string') {
            if (raw.length === 0) return '';

            // 检查是否是 hex 编码
            if (raw.length > 16 && /^[0-9a-fA-F]+$/.test(raw)) {
                try {
                    const bytes = Buffer.from(raw, 'hex');
                    if (bytes.length > 0) return this.decodeBinaryContent(bytes);
                } catch { }
            }

            // 检查是否是 base64 编码
            if (raw.length > 16 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
                try {
                    const bytes = Buffer.from(raw, 'base64');
                    return this.decodeBinaryContent(bytes);
                } catch {
                    return raw;
                }
            }

            return raw;
        }
        return '';
    }

    private decodeBinaryContent(data: Buffer): string {
        if (data.length === 0) return '';
        try {
            // 检查是否是 zstd 压缩
            if (data.length >= 4) {
                const magic = data.readUInt32LE(0);
                if (magic === 0xfd2fb528) {
                    const decompressed = fzstd.decompress(data);
                    return Buffer.from(decompressed).toString('utf-8');
                }
            }
            // 直接尝试 UTF-8 解码
            const decoded = data.toString('utf-8');
            const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
            if (replacementCount < decoded.length * 0.2) {
                return decoded.replace(/\uFFFD/g, '');
            }
            return data.toString('latin1');
        } catch {
            return '';
        }
    }
    private truncateMessagePreview(content: string, maxLength: number): string {
        if (!content) return '';
        const cleaned = content.replace(/\s+/g, ' ').trim();
        if (cleaned.length <= maxLength) return cleaned;
        return `${cleaned.slice(0, maxLength)}\u2026`;
    }

    // 消息内容解析（与 HTTP 服务保持一致）
    private parseMessageContent(content: string, localType: number): string | null {
        if (!content) return null;

        // 检查 XML 中的 type 标签
        const xmlType = this.extractMessageXmlType(content, localType) || null;

        switch (localType) {
            case 1: // 文本
                return this.stripSenderPrefix(content);
            case 3:
                return '[图片]';
            case 34:
                return '[语音消息]';
            case 42:
                return '[名片]';
            case 43:
                return '[视频]';
            case 47:
                return '[动画表情]';
            case 48:
                return '[位置]';
            case 49: {
                const appMsg = this.extractAppMessageInfo(content, localType);
                const title = appMsg.title || this.extractXmlValue(content, 'title');
                const type = appMsg.xmlType || this.extractXmlValue(content, 'type');

                // 转账消息特殊处理
                if (type === '2000') {
                    const feedesc = this.extractXmlValue(content, 'feedesc');
                    const payMemo = this.extractXmlValue(content, 'pay_memo');
                    if (feedesc) {
                        return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`;
                    }
                    return '[转账]';
                }

                if (type === '6') return title ? `[文件] ${title}` : '[文件]';
                if (type === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]';
                if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]';
                if (type === '57') return this.formatReplyContent(title);
                if (type === '5' || type === '49') return title ? `[链接] ${title}` : '[链接]';
                return title ? `[链接] ${title}` : '[链接]';
            }
            case 50:
                return '[通话]';
            case 10000:
                return this.cleanSystemMessage(content);
            case 266287972401: // 拍一拍
                return this.formatPokeMessage(content);
            case 244813135921: {
                // 引用消息 - 提取 title
                const title = this.extractXmlValue(content, 'title');
                return this.formatReplyContent(title);
            }
            default:
                // 对于未知的 localType，检查 XML type 来判断消息类型
                if (xmlType) {
                    const appMsg = this.extractAppMessageInfo(content, localType);
                    const title = appMsg.title || this.extractXmlValue(content, 'title');

                    // 群公告消息（type 87）
                    if (xmlType === '87') {
                        const textAnnouncement = this.extractXmlValue(content, 'textannouncement');
                        if (textAnnouncement) {
                            return `[群公告] ${textAnnouncement}`;
                        }
                        return '[群公告]';
                    }

                    // 转账消息
                    if (xmlType === '2000') {
                        const feedesc = this.extractXmlValue(content, 'feedesc');
                        const payMemo = this.extractXmlValue(content, 'pay_memo');
                        if (feedesc) {
                            return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`;
                        }
                        return '[转账]';
                    }

                    // 其他类型
                    if (xmlType === '6') return title ? `[文件] ${title}` : '[文件]';
                    if (xmlType === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]';
                    if (xmlType === '33' || xmlType === '36') return title ? `[小程序] ${title}` : '[小程序]';
                    if (xmlType === '57') return this.formatReplyContent(title);
                    if (xmlType === '5' || xmlType === '49') return title ? `[链接] ${title}` : '[链接]';
                    if (title) return title;
                }

                // 最后尝试提取文本内容
                return this.stripSenderPrefix(content) || null;
        }
    }

    /**
     * 清理系统消息
     */
    private cleanSystemMessage(content: string): string {
        if (!content) return '[系统消息]';

        // 处理 CDATA 内容
        content = content.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');

        // 移除所有 XML 标签
        let cleaned = content.replace(/<[^>]+>/g, '');
        
        // 移除尾部的数字（如撤回消息后的时间戳）
        cleaned = cleaned.replace(/\d+\s*$/, '');
        
        // 清理多余空白
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        cleaned = this.normalizeChineseQuotes(cleaned);
        return cleaned || '[系统消息]';
    }

    /**
     * 移除发送者前缀
     */


    private normalizeChineseQuotes(text: string): string {
        if (!text || !text.includes('"')) return text;
        let result = '';
        let open = true;
        for (const ch of text) {
            if (ch === '"') {
                result += open ? '\u201c' : '\u201d';
                open = !open;
            } else {
                result += ch;
            }
        }
        return result;
    }

    private formatReplyContent(title: string | null | undefined): string {
        const value = (title || '').trim();
        if (!value) return '[\u5f15\u7528]';
        if (value.startsWith('[\u5f15\u7528]')) return value;
        return `[\u5f15\u7528] ${value}`;
    }

    private formatPokeMessage(content: string): string {
        const cleaned = this.cleanSystemMessage(content);
        const names: string[] = [];
        const regex = /["\u201c\u201d](.*?)["\u201c\u201d]/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(cleaned)) && names.length < 2) {
            const name = match[1].trim();
            if (name) names.push(name);
        }
        if (names.length >= 2) {
            return `\u201c${names[0]}\u201d \u62cd\u4e86\u62cd \u201c${names[1]}\u201d`;
        }
        return cleaned;
    }

    private stripSenderPrefix(content: string): string | null {
        const result = content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '').trim();
        return result || null;
    }

    private extractXmlValue(xml: string, tagName: string): string {
        const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
        const match = regex.exec(xml);
        if (match) {
            return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
        }
        return '';
    }

    private normalizeAppMessageContent(content: string): string {
        if (!content) return '';
        if (content.includes('&lt;') && content.includes('&gt;')) {
            return content
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&apos;/g, "'");
        }
        return content;
    }

    private isAppMessageContent(content: string): boolean {
        if (!content) return false;
        return (
            content.includes('<appmsg') ||
            content.includes('&lt;appmsg') ||
            content.includes('<msg>') ||
            content.includes('&lt;msg')
        );
    }

    private extractAppMessageInfo(content: string, localType?: number): { xmlType?: string; title?: string; url?: string } {
        if (!content) return {};
        if (localType !== 49 && !this.isAppMessageContent(content)) return {};

        const normalized = this.normalizeAppMessageContent(content);
        const appMsgBodyMatch = /<appmsg\b[^>]*>([\s\S]*?)<\/appmsg>/i.exec(normalized);
        const appMsgBody = appMsgBodyMatch ? appMsgBodyMatch[1] : normalized;

        const xmlType = this.extractXmlValue(appMsgBody, 'type') || this.extractXmlValue(normalized, 'type') || undefined;
        const title = this.extractXmlValue(appMsgBody, 'title') || this.extractXmlValue(appMsgBody, 'des') || undefined;
        const rawUrl = this.extractXmlValue(appMsgBody, 'url') || this.extractXmlValue(normalized, 'url');
        const url = this.normalizeLinkUrl(rawUrl) || undefined;

        return { xmlType, title, url };
    }


    private extractReferencedMessageId(content: string): string | undefined {
        if (!content) return undefined;

        const normalized = this.normalizeAppMessageContent(content);
        const blocks: string[] = [];

        const referMatch = /<refermsg\b[^>]*>([\s\S]*?)<\/refermsg>/i.exec(normalized);
        if (referMatch?.[1]) {
            blocks.push(referMatch[1]);
        }

        const appMsgMatch = /<appmsg\b[^>]*>([\s\S]*?)<\/appmsg>/i.exec(normalized);
        if (appMsgMatch?.[1]) {
            blocks.push(appMsgMatch[1]);
        }

        blocks.push(normalized);

        const tags = ['svrid', 'msgid', 'msgId', 'frommsgid', 'from_msgid', 'quoteid', 'refermsgid'];
        for (const block of blocks) {
            for (const tag of tags) {
                const value = this.extractXmlValue(block, tag);
                if (value && /^[0-9]+$/.test(value)) {
                    return value;
                }
            }
        }

        return undefined;
    }

    private isReplyMessage(localType: number, xmlType?: string): boolean {
        return localType === 244813135921 || xmlType === '57';
    }

    private extractMessageXmlType(content: string, localType?: number): string {
        const appMsg = this.extractAppMessageInfo(content, localType);
        return appMsg.xmlType || this.extractXmlValue(content, 'type');
    }

    private extractLinkUrl(content: string, localType?: number): string {
        const appMsg = this.extractAppMessageInfo(content, localType);
        if (!appMsg.url) return '';
        if (!appMsg.xmlType || appMsg.xmlType === '5' || appMsg.xmlType === '49') return appMsg.url;
        return '';
    }

    private normalizeLinkUrl(rawUrl: string): string {
        const value = (rawUrl || '').trim();
        if (!value) return '';

        const parseHttpUrl = (candidate: string): string => {
            try {
                const parsed = new URL(candidate);
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                    return parsed.toString();
                }
            } catch {
                return '';
            }
            return '';
        };

        if (value.startsWith('//')) {
            return parseHttpUrl(`https:${value}`);
        }

        const direct = parseHttpUrl(value);
        if (direct) return direct;

        const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
        const isDomainLike = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:[/:?#].*)?$/.test(value);
        if (!hasScheme && isDomainLike) {
            return parseHttpUrl(`https://${value}`);
        }

        return '';
    }

    /**
     * 映射 WeChat 消息类型到 ChatLab 类型
     */
    private mapMessageType(localType: number, xmlType?: string): number {
        switch (localType) {
            case 1: // 文本
                return ChatLabType.TEXT;
            case 3: // 图片
                return ChatLabType.IMAGE;
            case 34: // 语音
                return ChatLabType.VOICE;
            case 43: // 视频
                return ChatLabType.VIDEO;
            case 47: // 动画表情
                return ChatLabType.EMOJI;
            case 48: // 位置
                return ChatLabType.LOCATION;
            case 42: // 名片
                return ChatLabType.CONTACT;
            case 50: // 语音/视频通话
                return ChatLabType.CALL;
            case 10000: // 系统消息
                return ChatLabType.SYSTEM;
            case 49: // 复合消息
                return this.mapType49(xmlType);
            case 244813135921: // 引用消息
                return ChatLabType.REPLY;
            case 266287972401: // 拍一拍
                return ChatLabType.POKE;
            case 8594229559345: // 红包
                return ChatLabType.RED_PACKET;
            case 8589934592049: // 转账
                return ChatLabType.TRANSFER;
            default:
                if (xmlType) {
                    return this.mapType49(xmlType);
                }
                return ChatLabType.OTHER;
        }
    }

    /**
     * 映射 Type 49 子类型
     */
    private mapType49(xmlType?: string): number {
        switch (xmlType) {
            case '5': // 链接
            case '49':
                return ChatLabType.LINK;
            case '6': // 文件
                return ChatLabType.FILE;
            case '19': // 聊天记录
                return ChatLabType.FORWARD;
            case '33': // 小程序
            case '36':
                return ChatLabType.SHARE;
            case '57': // 引用消息
                return ChatLabType.REPLY;
            case '2000': // 转账
                return ChatLabType.TRANSFER;
            case '2001': // 红包
                return ChatLabType.RED_PACKET;
            default:
                return ChatLabType.OTHER;
        }
    }

    // 手动触发消息推送（供外部调用）
    public pushMessage(sessionId: string, message: any): void {
        const notification = {
            type: 'new_message',
            sessionId,
            message: {
                sender: message.sender,
                timestamp: message.timestamp,
                type: message.type,
                content: message.content,
                referencedPlatformMessageId: message.referencedPlatformMessageId,
                url: message.type === ChatLabType.LINK ? message.url : undefined,
                platformMessageId: message.platformMessageId,
            },
            timestamp: Date.now(),
        };
        this.broadcast(notification, sessionId);
    }
}

let wsServiceInstance: WsService | null = null;

export function getWsService(): WsService {
    if (!wsServiceInstance) {
        wsServiceInstance = new WsService();
    }
    return wsServiceInstance;
}
