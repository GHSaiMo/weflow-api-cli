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

interface ProcessedMessage {
    localId: number;
    serverId: number;
    localType: number;
    createTime: number;
    isSend: number;
    senderUsername: string;
    parsedContent: string;
    rawContent: string;
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

                        const parsedContent = this.parseMessageContent(content, localType);

                        const message: ProcessedMessage = {
                            localId,
                            serverId: parseInt(row.server_id || '0', 10),
                            localType,
                            createTime,
                            isSend: isSend ? 1 : 0,
                            senderUsername: isSend ? myWxid : senderUsername || sessionId,
                            parsedContent: parsedContent || `[类型 ${localType}]`,
                            rawContent: content,
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
                    const preview = this.truncateMessagePreview(msg.parsedContent || msg.rawContent || '', 20);
                    console.log(`[消息推送] ${msg.senderUsername} 推送 1 条新消息 "${preview}"`);

                    const notification = {
                        type: 'new_message',
                        sessionId,
                        data: msg,
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
        return cleaned.slice(0, maxLength);
    }

    // 简化的消息内容解析
    private parseMessageContent(content: string, localType: number): string | null {
        if (!content) return null;

        switch (localType) {
            case 1: // 文本
                return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '').trim() || content;
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
                const title = this.extractXmlValue(content, 'title');
                const type = this.extractXmlValue(content, 'type');
                if (type === '6') return title ? `[文件] ${title}` : '[文件]';
                if (type === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]';
                if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]';
                if (type === '57') return title || '[引用消息]';
                if (type === '2000') {
                    const feedesc = this.extractXmlValue(content, 'feedesc');
                    return feedesc ? `[转账] ${feedesc}` : '[转账]';
                }
                return title ? `[链接] ${title}` : '[链接]';
            }
            case 50:
                return '[通话]';
            case 10000:
                return content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '[系统消息]';
            default:
                return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '').trim() || null;
        }
    }

    private extractXmlValue(xml: string, tagName: string): string {
        const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
        const match = regex.exec(xml);
        if (match) {
            return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
        }
        return '';
    }

    // 手动触发消息推送（供外部调用）
    public pushMessage(sessionId: string, message: any): void {
        const notification = {
            type: 'new_message',
            sessionId,
            data: message,
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
