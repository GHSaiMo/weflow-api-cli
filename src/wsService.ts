/**
 * WeFlow API CLI - WebSocket 服务
 * 提供实时消息推送功能
 */
import { WebSocketServer, WebSocket } from 'ws';
import { getConfig } from './config.js';
import { getWcdbCore } from './wcdbCore.js';

interface WsClient {
    ws: WebSocket;
    id: string;
    subscribedSessions: Set<string>;
}

export class WsService {
    private wss: WebSocketServer | null = null;
    private port: number;
    private host: string;
    private running = false;
    private clients: Map<string, WsClient> = new Map();
    private clientIdCounter = 0;
    private monitorStarted = false;

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

        for (const client of this.clients.values()) {
            if (client.ws.readyState !== WebSocket.OPEN) continue;

            // 如果指定了 sessionId，只发送给订阅了该会话或订阅了所有会话的客户端
            if (sessionId) {
                if (client.subscribedSessions.has(sessionId) || client.subscribedSessions.has('*')) {
                    client.ws.send(message);
                }
            } else {
                // 没有指定 sessionId，发送给所有客户端
                client.ws.send(message);
            }
        }
    }

    private startDbMonitor(): void {
        if (this.monitorStarted) return;

        const wcdb = getWcdbCore();
        const success = wcdb.startMonitor((type, json) => {
            this.handleDbChange(type, json);
        });

        if (success) {
            this.monitorStarted = true;
            console.log('✅ 数据库变更监控已启动');
        } else {
            console.warn('⚠️ 数据库变更监控启动失败（可能不支持此功能）');
        }
    }

    private stopDbMonitor(): void {
        if (!this.monitorStarted) return;

        const wcdb = getWcdbCore();
        wcdb.stopMonitor();
        this.monitorStarted = false;
        console.log('数据库变更监控已停止');
    }

    private handleDbChange(type: string, json: string): void {
        try {
            const data = JSON.parse(json);
            const action = data.action || type;

            // 解析变更信息
            let sessionId: string | undefined;
            let changeInfo: any = data;

            // 根据不同的变更类型处理
            if (data.talker || data.username || data.session_id) {
                sessionId = data.talker || data.username || data.session_id;
            }

            // 构建推送消息
            const notification = {
                type: 'db_change',
                action,
                sessionId,
                data: changeInfo,
                timestamp: Date.now(),
            };

            // 广播给订阅的客户端
            this.broadcast(notification, sessionId);

            // 如果是新消息，额外发送一个 new_message 类型的通知
            if (action === 'insert' || action === 'new_message') {
                const messageNotification = {
                    type: 'new_message',
                    sessionId,
                    data: changeInfo,
                    timestamp: Date.now(),
                };
                this.broadcast(messageNotification, sessionId);
            }
        } catch (e) {
            console.error('处理数据库变更失败:', e);
        }
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

    // 手动触发会话更新推送
    public pushSessionUpdate(sessionId: string, update: any): void {
        const notification = {
            type: 'session_update',
            sessionId,
            data: update,
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
