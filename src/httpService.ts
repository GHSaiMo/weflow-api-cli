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
    xmlType?: string; // XML 中的 <type> 标签值
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

    /**
     * 检查发送者是否是自己（支持部分匹配）
     */
    private isSelfSender(sender: string, myWxid: string): boolean {
        if (!sender || !myWxid) return false;
        const lowerSender = sender.toLowerCase();
        const lowerMyWxid = myWxid.toLowerCase();
        // 完全匹配
        if (lowerSender === lowerMyWxid) return true;
        // sender 以 myWxid 开头（如 wxid_xxx 匹配 wxid_xxx_b0e4）
        if (lowerSender.startsWith(lowerMyWxid + '_')) return true;
        // myWxid 以 sender 开头
        if (lowerMyWxid.startsWith(lowerSender + '_')) return true;
        return false;
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

                    // 提取 XML 中的 type
                    const xmlType = this.extractXmlValue(content, 'type') || undefined;

                    const parsedContent = this.parseMessageContent(content, localType);

                    // 判断是否是自己发送的消息
                    const isSelfMessage = isSend || this.isSelfSender(senderUsername, myWxid);

                    const message: Message = {
                        localId,
                        serverId: parseInt(row.server_id || row.serverId || '0', 10),
                        localType,
                        createTime,
                        sortSeq: parseInt(row.sort_seq || row.sortSeq || row.sequence || String(createTime), 10),
                        isSend: isSelfMessage ? 1 : 0,
                        senderUsername: isSelfMessage ? myWxid : senderUsername || sessionId,
                        parsedContent: parsedContent || `[类型 ${localType}]`,
                        rawContent: content,
                        xmlType,
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

    /**
     * 解析消息内容（与原项目保持一致）
     */
    private parseMessageContent(content: string, localType: number): string | null {
        if (!content) return null;

        // 检查 XML 中的 type 标签
        const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content);
        const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null;

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
                const title = this.extractXmlValue(content, 'title');
                const type = this.extractXmlValue(content, 'type');

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
                if (type === '57') return title || '[引用消息]';
                if (type === '5' || type === '49') return title ? `[链接] ${title}` : '[链接]';
                return title ? `[链接] ${title}` : '[链接]';
            }
            case 50:
                return this.parseVoipMessage(content);
            case 10000:
                return this.cleanSystemMessage(content);
            case 266287972401: // 拍一拍
                return this.cleanSystemMessage(content);
            case 244813135921: {
                // 引用消息 - 提取 title
                const title = this.extractXmlValue(content, 'title');
                return title || '[引用消息]';
            }
            default:
                // 对于未知的 localType，检查 XML type 来判断消息类型
                if (xmlType) {
                    const title = this.extractXmlValue(content, 'title');

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
                    if (xmlType === '57') return title || '[引用消息]';
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
        return cleaned.replace(/\s+/g, ' ').trim() || '[系统消息]';
    }

    /**
     * 解析通话消息
     */
    private parseVoipMessage(content: string): string {
        try {
            if (!content) return '[通话]';

            // 提取 msg 内容（中文通话状态）
            const msgMatch = /<msg><!\[CDATA\[(.*?)\]\]><\/msg>/i.exec(content);
            const msg = msgMatch?.[1]?.trim() || '';

            // 提取 room_type（0=视频，1=语音）
            const roomTypeMatch = /<room_type>(\d+)<\/room_type>/i.exec(content);
            const roomType = roomTypeMatch ? parseInt(roomTypeMatch[1], 10) : -1;

            let callType: string;
            if (roomType === 0) {
                callType = '视频通话';
            } else if (roomType === 1) {
                callType = '语音通话';
            } else {
                callType = '通话';
            }

            // 解析通话状态
            if (msg.includes('通话时长')) {
                const durationMatch = /通话时长\s*(\d{1,2}:\d{2}(?::\d{2})?)/i.exec(msg);
                const duration = durationMatch?.[1] || '';
                if (duration) {
                    return `[${callType}] ${duration}`;
                }
                return `[${callType}] 已接听`;
            } else if (msg.includes('对方无应答')) {
                return `[${callType}] 对方无应答`;
            } else if (msg.includes('已取消')) {
                return `[${callType}] 已取消`;
            } else if (msg.includes('已在其它设备接听') || msg.includes('已在其他设备接听')) {
                return `[${callType}] 已在其他设备接听`;
            } else if (msg.includes('对方已拒绝') || msg.includes('已拒绝')) {
                return `[${callType}] 对方已拒绝`;
            } else if (msg.includes('忙线未接听') || msg.includes('忙线')) {
                return `[${callType}] 忙线未接听`;
            } else if (msg.includes('未接听')) {
                return `[${callType}] 未接听`;
            } else if (msg) {
                return `[${callType}] ${msg}`;
            }

            return `[${callType}]`;
        } catch {
            return '[通话]';
        }
    }

    private stripSenderPrefix(content: string): string | null {
        // 移除开头的空白字符（包括换行符），然后移除发送者前缀
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

        // 构建成员列表 - 优先使用 getGroupMembers 获取准确的群成员信息
        const memberMap = new Map<string, any>();
        const allUsernames: string[] = [];

        if (isGroup) {
            // 尝试获取群成员列表
            const groupMembersResult = await wcdb.getGroupMembers(talkerId);
            if (groupMembersResult.success && groupMembersResult.data) {
                // 收集所有群成员的 username
                for (const member of groupMembersResult.data) {
                    const username = member.username || member.userName || member.wxid || member.platformId;
                    if (username) {
                        allUsernames.push(username);
                    }
                }

                // 获取所有群成员的显示名（包括不在消息发送者中的）
                const displayNamesResult = await wcdb.getDisplayNames(allUsernames);
                const displayNamesMap = displayNamesResult.success && displayNamesResult.data ? displayNamesResult.data : {};

                // 获取群昵称
                const groupNicknamesResult = await wcdb.getGroupNicknames(talkerId);
                const groupNicknames = groupNicknamesResult.success && groupNicknamesResult.data ? groupNicknamesResult.data : {};

                for (const member of groupMembersResult.data) {
                    const username = member.username || member.userName || member.wxid || member.platformId;
                    if (!username) continue;

                    // 优先使用 getDisplayNames 获取的显示名
                    const displayName = displayNamesMap[username] || member.displayName || member.nickname || member.remark || member.accountName || username;
                    const groupNickname = groupNicknames[username] || groupNicknames[username.toLowerCase()] || member.groupNickname || '';
                    const isSelf = this.isSelfSender(username, myWxid);

                    memberMap.set(username, {
                        platformId: username,
                        accountName: (isSelf && !isGroup) ? '我' : displayName,
                        groupNickname: groupNickname || undefined,
                    });
                }
            }
        }

        // 如果是群聊但没有获取到群成员，或者获取发送者显示名
        const senderArray = Array.from(senderSet);
        const senderNamesResult = await wcdb.getDisplayNames(senderArray);
        const senderNames = senderNamesResult.success && senderNamesResult.data ? senderNamesResult.data : {};

        // 对于没有在群成员中的发送者，也添加到 memberMap
        for (const msg of messages) {
            const sender = msg.senderUsername || '';
            if (sender && !memberMap.has(sender)) {
                const displayName = senderNames[sender] || sender;
                const isSelf = this.isSelfSender(sender, myWxid);
                // 群聊中不使用"我"，统一使用真实昵称
                memberMap.set(sender, {
                    platformId: sender,
                    accountName: (isSelf && !isGroup) ? '我' : displayName,
                });
            }
        }

        // 转换消息 - 不包含 accountName 和 groupNickname（这些信息已在 members 中）
        const chatLabMessages = messages.map((msg) => {
            const sender = msg.senderUsername || '';

            return {
                sender,
                timestamp: msg.createTime,
                type: this.mapMessageType(msg.localType, msg),
                content: this.getMessageContent(msg),
                platformMessageId: msg.serverId ? String(msg.serverId) : undefined,
            };
        });

        return {
            chatlab: {
                version: '0.0.2',
                exportedAt: Math.floor(Date.now() / 1000),
                generator: 'WeFlow-API-CLI',
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

    /**
     * 映射 WeChat 消息类型到 ChatLab 类型
     */
    private mapMessageType(localType: number, msg: Message): number {
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
                return this.mapType49(msg);
            case 244813135921: // 引用消息
                return ChatLabType.REPLY;
            case 266287972401: // 拍一拍
                return ChatLabType.POKE;
            case 8594229559345: // 红包
                return ChatLabType.RED_PACKET;
            case 8589934592049: // 转账
                return ChatLabType.TRANSFER;
            default:
                return ChatLabType.OTHER;
        }
    }

    /**
     * 映射 Type 49 子类型
     */
    private mapType49(msg: Message): number {
        const xmlType = msg.xmlType;

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

    /**
     * 获取消息内容
     */
    private getMessageContent(msg: Message): string | null {
        // 优先使用已解析的内容
        if (msg.parsedContent) {
            return msg.parsedContent;
        }

        // 根据类型返回占位符
        switch (msg.localType) {
            case 1:
                return msg.rawContent || null;
            case 3:
                return '[图片]';
            case 34:
                return '[语音]';
            case 43:
                return '[视频]';
            case 47:
                return '[表情]';
            case 42:
                return '[名片]';
            case 48:
                return '[位置]';
            case 49: {
                const title = this.extractXmlValue(msg.rawContent, 'title');
                return title || '[消息]';
            }
            default:
                return msg.rawContent || null;
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
