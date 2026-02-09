/**
 * WeFlow API CLI - HTTP API 服务
 * 提供 REST API 接口查询微信数据
 */
import * as http from 'http';
import { URL } from 'url';
import * as fzstd from 'fzstd';
import { getConfig } from './config.js';
import { getWcdbCore } from './wcdbCore.js';

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

interface Message {
    localId: number;
    serverId: number;
    localType: number;
    createTime: number;
    sortSeq: number;
    isSend: number;
    senderUsername: string;
    parsedContent: string;
    rawContent: string;
}

export class HttpService {
    private server: http.Server | null = null;
    private port: number;
    private host: string;
    private running = false;
    private connections: Set<import('net').Socket> = new Set();

    constructor() {
        const config = getConfig();
        this.port = config.httpPort;
        this.host = config.httpHost;
    }

    async start(): Promise<{ success: boolean; port?: number; error?: string }> {
        if (this.running && this.server) {
            return { success: true, port: this.port };
        }

        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res));

            this.server.on('connection', (socket) => {
                this.connections.add(socket);
                socket.on('close', () => {
                    this.connections.delete(socket);
                });
            });

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    console.error(`❌ HTTP 端口 ${this.port} 已被占用`);
                    resolve({ success: false, error: `Port ${this.port} is already in use` });
                } else {
                    console.error('❌ HTTP 服务错误:', err);
                    resolve({ success: false, error: err.message });
                }
            });

            this.server.listen(this.port, this.host, () => {
                this.running = true;
                console.log(`✅ HTTP API 服务启动: http://${this.host}:${this.port}`);
                resolve({ success: true, port: this.port });
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                for (const socket of this.connections) {
                    socket.destroy();
                }
                this.connections.clear();

                this.server.close(() => {
                    this.running = false;
                    this.server = null;
                    console.log('HTTP API 服务已停止');
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

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
        const pathname = url.pathname;

        try {
            if (pathname === '/health' || pathname === '/api/v1/health') {
                this.sendJson(res, { status: 'ok' });
            } else if (pathname === '/api/v1/messages') {
                await this.handleMessages(url, res);
            } else if (pathname === '/api/v1/sessions') {
                await this.handleSessions(url, res);
            } else if (pathname === '/api/v1/contacts') {
                await this.handleContacts(url, res);
            } else {
                this.sendError(res, 404, 'Not Found');
            }
        } catch (error) {
            console.error('HTTP 请求错误:', error);
            this.sendError(res, 500, String(error));
        }
    }

    private async handleMessages(url: URL, res: http.ServerResponse): Promise<void> {
        const talker = url.searchParams.get('talker');
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const startParam = url.searchParams.get('start');
        const endParam = url.searchParams.get('end');
        const chatlab = url.searchParams.get('chatlab') === '1';
        const format = url.searchParams.get('format') || (chatlab ? 'chatlab' : 'json');

        if (!talker) {
            this.sendError(res, 400, 'Missing required parameter: talker');
            return;
        }

        const startTime = this.parseTimeParam(startParam);
        const endTime = this.parseTimeParam(endParam, true);
        const dateRange = startTime > 0 || endTime > 0 ? { start: startTime, end: endTime } : null;

        const messages = await this.collectMessages(talker, offset, limit, dateRange);

        if (messages.length === 0) {
            this.sendJson(res, {
                success: true,
                talker,
                count: 0,
                hasMore: false,
                messages: [],
            });
            return;
        }

        if (format === 'chatlab') {
            const wcdb = getWcdbCore();
            const displayNames = await wcdb.getDisplayNames([talker]);
            const talkerName = displayNames.success && displayNames.data ? displayNames.data[talker] || talker : talker;
            const chatLabData = await this.convertToChatLab(messages, talker, talkerName);
            this.sendJson(res, chatLabData);
        } else {
            this.sendJson(res, {
                success: true,
                talker,
                count: messages.length,
                hasMore: messages.length >= limit,
                messages,
            });
        }
    }

    private async collectMessages(
        sessionId: string,
        offset: number,
        limit: number,
        dateRange: { start: number; end: number } | null
    ): Promise<Message[]> {
        const wcdb = getWcdbCore();
        const config = getConfig();
        const myWxid = config.myWxid;
        const rows: Message[] = [];
        const BATCH_SIZE = 500;

        const cursorResult = await wcdb.openMessageCursor(
            sessionId,
            BATCH_SIZE,
            true,
            dateRange?.start || 0,
            dateRange?.end || 0
        );

        if (!cursorResult.success || !cursorResult.data) {
            console.error('打开消息游标失败:', cursorResult.error);
            return [];
        }

        const cursor = cursorResult.data;

        try {
            let hasMore = true;
            let skipped = 0;

            while (hasMore && rows.length < limit) {
                const batch = await wcdb.fetchMessageBatch(cursor);
                if (!batch.success || !batch.data) {
                    break;
                }

                for (const row of batch.data.rows) {
                    const createTime = parseInt(row.create_time || '0', 10);

                    if (dateRange) {
                        if (createTime < dateRange.start || createTime > dateRange.end) {
                            continue;
                        }
                    }

                    const content = this.decodeMessageContent(row.message_content, row.compress_content);
                    const localType = parseInt(row.local_type || row.type || '1', 10);
                    const senderUsername = row.sender_username || '';
                    const isSendRaw = row.computed_is_send ?? row.is_send ?? '0';
                    const isSend = parseInt(isSendRaw, 10) === 1;
                    const localId = parseInt(row.local_id || row.localId || '0', 10);

                    if (skipped < offset) {
                        skipped++;
                        continue;
                    }

                    const parsedContent = this.parseMessageContent(content, localType);
                    const message: Message = {
                        localId,
                        serverId: parseInt(row.server_id || row.serverId || '0', 10),
                        localType,
                        createTime,
                        sortSeq: parseInt(row.sort_seq || row.sortSeq || row.sequence || String(createTime), 10),
                        isSend: isSend ? 1 : senderUsername === myWxid ? 1 : 0,
                        senderUsername: isSend ? myWxid : senderUsername || sessionId,
                        parsedContent: parsedContent || `[类型 ${localType}]`,
                        rawContent: content,
                    };

                    rows.push(message);

                    if (rows.length >= limit) {
                        break;
                    }
                }

                hasMore = batch.data.hasMore;
            }
        } finally {
            await wcdb.closeMessageCursor(cursor);
        }

        return rows;
    }

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

            if (raw.length > 16 && /^[0-9a-fA-F]+$/.test(raw)) {
                try {
                    const bytes = Buffer.from(raw, 'hex');
                    if (bytes.length > 0) return this.decodeBinaryContent(bytes);
                } catch { }
            }

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
            if (data.length >= 4) {
                const magic = data.readUInt32LE(0);
                if (magic === 0xfd2fb528) {
                    const decompressed = fzstd.decompress(data);
                    return Buffer.from(decompressed).toString('utf-8');
                }
            }
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

    private parseMessageContent(content: string, localType: number): string | null {
        if (!content) return null;

        switch (localType) {
            case 1:
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
                const title = this.extractXmlValue(content, 'title');
                const type = this.extractXmlValue(content, 'type');

                if (type === '2000') {
                    const feedesc = this.extractXmlValue(content, 'feedesc');
                    return feedesc ? `[转账] ${feedesc}` : '[转账]';
                }
                if (type === '6') return title ? `[文件] ${title}` : '[文件]';
                if (type === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]';
                if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]';
                if (type === '57') return title || '[引用消息]';
                return title ? `[链接] ${title}` : '[链接]';
            }
            case 50:
                return '[通话]';
            case 10000:
                return this.cleanSystemMessage(content);
            default:
                return this.stripSenderPrefix(content) || null;
        }
    }

    private cleanSystemMessage(content: string): string {
        if (!content) return '[系统消息]';
        content = content.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
        return content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '[系统消息]';
    }

    private stripSenderPrefix(content: string): string | null {
        const result = content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)/, '');
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

    private async handleSessions(url: URL, res: http.ServerResponse): Promise<void> {
        const keyword = url.searchParams.get('keyword') || '';
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);

        const wcdb = getWcdbCore();
        const result = await wcdb.getSessions();

        if (!result.success || !result.data) {
            this.sendError(res, 500, result.error || 'Failed to get sessions');
            return;
        }

        let sessions = result.data;

        if (keyword) {
            const lowerKeyword = keyword.toLowerCase();
            sessions = sessions.filter(
                (s: any) =>
                    s.username?.toLowerCase().includes(lowerKeyword) ||
                    s.display_name?.toLowerCase().includes(lowerKeyword)
            );
        }

        const limited = sessions.slice(0, limit);

        this.sendJson(res, {
            success: true,
            count: limited.length,
            sessions: limited.map((s: any) => ({
                username: s.username || s.user_name,
                displayName: s.display_name || s.username,
                type: s.type,
                lastTimestamp: s.sort_timestamp || s.last_timestamp,
                unreadCount: s.unread_count || 0,
            })),
        });
    }

    private async handleContacts(url: URL, res: http.ServerResponse): Promise<void> {
        const keyword = url.searchParams.get('keyword') || '';
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);

        const wcdb = getWcdbCore();
        const result = await wcdb.execQuery(
            'contact',
            null,
            'SELECT username, remark, nick_name, alias, local_type FROM contact'
        );

        if (!result.success || !result.data) {
            this.sendError(res, 500, result.error || 'Failed to get contacts');
            return;
        }

        let contacts = result.data;

        if (keyword) {
            const lowerKeyword = keyword.toLowerCase();
            contacts = contacts.filter(
                (c: any) =>
                    c.username?.toLowerCase().includes(lowerKeyword) ||
                    c.nick_name?.toLowerCase().includes(lowerKeyword) ||
                    c.remark?.toLowerCase().includes(lowerKeyword)
            );
        }

        const limited = contacts.slice(0, limit);

        this.sendJson(res, {
            success: true,
            count: limited.length,
            contacts: limited.map((c: any) => ({
                username: c.username,
                nickname: c.nick_name,
                remark: c.remark,
                alias: c.alias,
            })),
        });
    }

    private parseTimeParam(param: string | null, isEnd = false): number {
        if (!param) return 0;

        if (/^\d{8}$/.test(param)) {
            const year = parseInt(param.slice(0, 4), 10);
            const month = parseInt(param.slice(4, 6), 10) - 1;
            const day = parseInt(param.slice(6, 8), 10);
            const date = new Date(year, month, day);
            if (isEnd) {
                date.setHours(23, 59, 59, 999);
            }
            return Math.floor(date.getTime() / 1000);
        }

        if (/^\d+$/.test(param)) {
            const ts = parseInt(param, 10);
            return ts > 10000000000 ? Math.floor(ts / 1000) : ts;
        }

        return 0;
    }

    private async convertToChatLab(messages: Message[], talkerId: string, talkerName: string): Promise<any> {
        const config = getConfig();
        const wcdb = getWcdbCore();
        const isGroup = talkerId.endsWith('@chatroom');
        const myWxid = config.myWxid;

        // 收集所有发送者
        const senderSet = new Set<string>();
        for (const msg of messages) {
            if (msg.senderUsername) {
                senderSet.add(msg.senderUsername);
            }
        }

        // 获取发送者显示名
        const senderNamesResult = await wcdb.getDisplayNames(Array.from(senderSet));
        const senderNames = senderNamesResult.success && senderNamesResult.data ? senderNamesResult.data : {};

        // 获取群昵称
        let groupNicknamesMap = new Map<string, string>();
        if (isGroup) {
            const result = await wcdb.getGroupNicknames(talkerId);
            if (result.success && result.data) {
                groupNicknamesMap = new Map(Object.entries(result.data));
            }
        }

        // 构建成员列表
        const memberMap = new Map<string, any>();
        for (const msg of messages) {
            const sender = msg.senderUsername || '';
            if (sender && !memberMap.has(sender)) {
                const displayName = senderNames[sender] || sender;
                const isSelf = sender === myWxid;
                const groupNickname = isGroup ? groupNicknamesMap.get(sender) || '' : '';
                memberMap.set(sender, {
                    platformId: sender,
                    accountName: isSelf ? '我' : displayName,
                    groupNickname: groupNickname || undefined,
                });
            }
        }

        // 转换消息
        const chatLabMessages = messages.map((msg) => {
            const sender = msg.senderUsername || '';
            const isSelf = msg.isSend === 1 || sender === myWxid;
            const accountName = isSelf ? '我' : senderNames[sender] || sender;
            const groupNickname = isGroup ? groupNicknamesMap.get(sender) || '' : '';

            return {
                sender,
                accountName,
                groupNickname: groupNickname || undefined,
                timestamp: msg.createTime,
                type: this.mapMessageType(msg.localType),
                content: msg.parsedContent,
                platformMessageId: msg.serverId ? String(msg.serverId) : undefined,
            };
        });

        return {
            chatlab: {
                version: '0.0.2',
                exportedAt: Math.floor(Date.now() / 1000),
                generator: 'WeFlow-CLI',
            },
            meta: {
                name: talkerName,
                platform: 'wechat',
                type: isGroup ? 'group' : 'private',
                groupId: isGroup ? talkerId : undefined,
                ownerId: myWxid || undefined,
            },
            members: Array.from(memberMap.values()),
            messages: chatLabMessages,
        };
    }

    private mapMessageType(localType: number): number {
        switch (localType) {
            case 1:
                return ChatLabType.TEXT;
            case 3:
                return ChatLabType.IMAGE;
            case 34:
                return ChatLabType.VOICE;
            case 43:
                return ChatLabType.VIDEO;
            case 47:
                return ChatLabType.EMOJI;
            case 48:
                return ChatLabType.LOCATION;
            case 42:
                return ChatLabType.CONTACT;
            case 50:
                return ChatLabType.CALL;
            case 10000:
                return ChatLabType.SYSTEM;
            case 49:
                return ChatLabType.LINK;
            default:
                return ChatLabType.OTHER;
        }
    }

    private sendJson(res: http.ServerResponse, data: any): void {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
    }

    private sendError(res: http.ServerResponse, code: number, message: string): void {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(code);
        res.end(JSON.stringify({ error: message }));
    }
}

let httpServiceInstance: HttpService | null = null;

export function getHttpService(): HttpService {
    if (!httpServiceInstance) {
        httpServiceInstance = new HttpService();
    }
    return httpServiceInstance;
}
