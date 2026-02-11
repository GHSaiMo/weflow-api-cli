/**
 * WeFlow WebSocket Tester
 * 用于测试 weflow-api-cli 项目的 WebSocket 连接
 */

class WeFlowWSTester {
    constructor() {
        this.ws = null;
        this.clientId = null;
        this.msgCount = 0;
        this.allMsgCount = 0;
        this.sessionMsgCount = 0;
        this.subscribedSessions = new Set();
        this.isSubscribedAll = false;

        this.initElements();
        this.initEventListeners();
    }

    initElements() {
        // Connection elements
        this.wsUrlInput = document.getElementById('wsUrl');
        this.connectBtn = document.getElementById('connectBtn');
        this.disconnectBtn = document.getElementById('disconnectBtn');
        this.connectionStatus = document.getElementById('connectionStatus');

        // Tab elements
        this.tabBtns = document.querySelectorAll('.tab-btn');
        this.tabContents = document.querySelectorAll('.tab-content');

        // All subscription elements
        this.subscribeAllBtn = document.getElementById('subscribeAllBtn');
        this.unsubscribeAllBtn = document.getElementById('unsubscribeAllBtn');
        this.clearAllMsgsBtn = document.getElementById('clearAllMsgsBtn');
        this.allMessagesBox = document.getElementById('allMessages');
        this.allMsgCountEl = document.getElementById('allMsgCount');

        // Specific session elements
        this.sessionIdsInput = document.getElementById('sessionIds');
        this.subscribeSessionBtn = document.getElementById('subscribeSessionBtn');
        this.unsubscribeSessionBtn = document.getElementById('unsubscribeSessionBtn');
        this.clearSessionMsgsBtn = document.getElementById('clearSessionMsgsBtn');
        this.sessionMessagesBox = document.getElementById('sessionMessages');
        this.sessionMsgCountEl = document.getElementById('sessionMsgCount');
        this.subscribedSessionsEl = document.getElementById('subscribedSessions');

        // Status elements
        this.clientIdEl = document.getElementById('clientId');
        this.wsStateEl = document.getElementById('wsState');
        this.subModeEl = document.getElementById('subMode');
        this.msgCountEl = document.getElementById('msgCount');

        // Quick action buttons
        this.pingBtn = document.getElementById('pingBtn');
        this.statusBtn = document.getElementById('statusBtn');
    }

    initEventListeners() {
        // Connection
        this.connectBtn.addEventListener('click', () => this.connect());
        this.disconnectBtn.addEventListener('click', () => this.disconnect());

        // Tabs
        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // All subscription
        this.subscribeAllBtn.addEventListener('click', () => this.subscribeAll());
        this.unsubscribeAllBtn.addEventListener('click', () => this.unsubscribeAll());
        this.clearAllMsgsBtn.addEventListener('click', () => this.clearMessages('all'));

        // Specific session
        this.subscribeSessionBtn.addEventListener('click', () => this.subscribeSessions());
        this.unsubscribeSessionBtn.addEventListener('click', () => this.unsubscribeSessions());
        this.clearSessionMsgsBtn.addEventListener('click', () => this.clearMessages('session'));

        // Quick actions
        this.pingBtn.addEventListener('click', () => this.sendPing());
        this.statusBtn.addEventListener('click', () => this.getStatus());

        // Enter key for session input
        this.sessionIdsInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.subscribeSessions();
            }
        });
    }

    connect() {
        const url = this.wsUrlInput.value.trim();
        if (!url) {
            this.showError('请输入 WebSocket 地址');
            return;
        }

        try {
            this.updateConnectionStatus('connecting');
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                console.log('WebSocket 连接已建立');
                this.updateConnectionStatus('connected');
                this.enableControls(true);
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onclose = (event) => {
                console.log('WebSocket 连接已关闭', event.code, event.reason);
                this.updateConnectionStatus('disconnected');
                this.enableControls(false);
                this.clientId = null;
                this.clientIdEl.textContent = '-';
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket 错误:', error);
                this.updateConnectionStatus('disconnected');
            };

        } catch (e) {
            console.error('连接失败:', e);
            this.showError('连接失败: ' + e.message);
            this.updateConnectionStatus('disconnected');
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close(1000, 'User disconnected');
            this.ws = null;
        }
    }

    updateConnectionStatus(status) {
        const statusDot = this.connectionStatus.querySelector('.status-dot');
        const statusText = this.connectionStatus.querySelector('.status-text');

        statusDot.className = 'status-dot ' + status;

        switch (status) {
            case 'connected':
                statusText.textContent = '已连接';
                this.wsStateEl.textContent = '已连接';
                break;
            case 'connecting':
                statusText.textContent = '连接中...';
                this.wsStateEl.textContent = '连接中...';
                break;
            case 'disconnected':
            default:
                statusText.textContent = '未连接';
                this.wsStateEl.textContent = '未连接';
                break;
        }
    }

    enableControls(enabled) {
        this.connectBtn.disabled = enabled;
        this.disconnectBtn.disabled = !enabled;
        this.wsUrlInput.disabled = enabled;

        // Subscription buttons
        this.subscribeAllBtn.disabled = !enabled;
        this.unsubscribeAllBtn.disabled = !enabled;
        this.subscribeSessionBtn.disabled = !enabled;
        this.unsubscribeSessionBtn.disabled = !enabled;
        this.sessionIdsInput.disabled = !enabled;

        // Quick actions
        this.pingBtn.disabled = !enabled;
        this.statusBtn.disabled = !enabled;
    }

    switchTab(tabName) {
        // Update tab buttons
        this.tabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // Update tab contents
        this.tabContents.forEach(content => {
            content.classList.toggle('active', content.id === `tab-${tabName}`);
        });
    }

    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('收到消息:', message);

            this.msgCount++;
            this.msgCountEl.textContent = this.msgCount;

            // Update client ID if received
            if (message.type === 'connected' && message.clientId) {
                this.clientId = message.clientId;
                this.clientIdEl.textContent = message.clientId;
            }

            // Update subscription mode
            if (message.type === 'subscribed') {
                if (message.sessions && message.sessions.includes('*')) {
                    this.isSubscribedAll = true;
                    this.subModeEl.textContent = '全部会话';
                } else if (message.sessions) {
                    message.sessions.forEach(s => this.subscribedSessions.add(s));
                    this.updateSubscribedSessionsTags();
                    this.subModeEl.textContent = `${this.subscribedSessions.size} 个会话`;
                }
            }

            if (message.type === 'unsubscribed') {
                if (!message.sessions || message.sessions.length === 0) {
                    this.isSubscribedAll = false;
                    this.subscribedSessions.clear();
                    this.subModeEl.textContent = '-';
                }
                this.updateSubscribedSessionsTags();
            }

            // Add to appropriate message box(es)
            // 判断是否是系统/状态消息
            const isSystemMessage = ['connected', 'subscribed', 'unsubscribed', 'pong', 'status', 'error'].includes(message.type);

            // 判断是否是数据消息
            const isDataMessage = ['db_change', 'new_message', 'session_update'].includes(message.type);

            // === 全部订阅标签的消息显示 ===
            // 所有消息都显示在"全部订阅"标签（方便测试和调试）
            this.addMessage('all', message);

            // === 指定会话标签的消息显示 ===
            if (this.subscribedSessions.size > 0) {
                if (isSystemMessage && ['pong', 'status', 'error', 'subscribed', 'unsubscribed'].includes(message.type)) {
                    // 显示订阅相关的系统消息
                    this.addMessage('session', message);
                } else if (isDataMessage && message.sessionId && this.subscribedSessions.has(message.sessionId)) {
                    // 显示匹配会话的数据消息
                    this.addMessage('session', message);
                }
            }

        } catch (e) {
            console.error('解析消息失败:', e, data);
        }
    }

    addMessage(target, message) {
        const box = target === 'all' ? this.allMessagesBox : this.sessionMessagesBox;

        // Remove empty state if exists
        const emptyState = box.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }

        // Create message element
        const msgEl = document.createElement('div');
        msgEl.className = `message-item type-${message.type}`;

        const time = new Date(message.timestamp || Date.now()).toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3
        });

        msgEl.innerHTML = `
            <div class="message-time">${time}</div>
            <span class="message-type">${message.type}</span>
            ${message.sessionId ? `<span class="message-type" style="margin-left: 4px; background: var(--accent-glow);">${message.sessionId}</span>` : ''}
            <div class="message-content">${this.formatMessageContent(message)}</div>
        `;

        // Add to box and scroll to bottom
        box.appendChild(msgEl);
        box.scrollTop = box.scrollHeight;

        // Update counts
        if (target === 'all') {
            this.allMsgCount++;
            this.allMsgCountEl.textContent = `${this.allMsgCount} 条消息`;
        } else {
            this.sessionMsgCount++;
            this.sessionMsgCountEl.textContent = `${this.sessionMsgCount} 条消息`;
        }

        // Limit messages to prevent memory issues
        const maxMessages = 200;
        const items = box.querySelectorAll('.message-item');
        if (items.length > maxMessages) {
            items[0].remove();
        }
    }

    formatMessageContent(message) {
        // Create a clean copy without timestamp for display
        const displayMsg = { ...message };
        delete displayMsg.timestamp;

        // Format based on message type
        switch (message.type) {
            case 'connected':
                return `🎉 ${message.message} (Client ID: ${message.clientId})`;
            case 'subscribed':
                return `✅ 已订阅: ${JSON.stringify(message.sessions)}`;
            case 'unsubscribed':
                return `🔕 已取消订阅: ${JSON.stringify(message.sessions)}`;
            case 'pong':
                return `🏓 Pong!`;
            case 'status':
                return `📊 连接数: ${message.totalClients}, 监控: ${message.monitorActive ? '运行中' : '未启动'}, 订阅: ${JSON.stringify(message.subscribedSessions)}`;
            case 'error':
                return `❌ ${message.error}`;
            case 'new_message':
            case 'db_change':
                return this.escapeHtml(JSON.stringify(message.data, null, 2));
            default:
                return this.escapeHtml(JSON.stringify(displayMsg, null, 2));
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    clearMessages(target) {
        const box = target === 'all' ? this.allMessagesBox : this.sessionMessagesBox;
        box.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📭</div>
                <p>暂无消息</p>
            </div>
        `;

        if (target === 'all') {
            this.allMsgCount = 0;
            this.allMsgCountEl.textContent = '0 条消息';
        } else {
            this.sessionMsgCount = 0;
            this.sessionMsgCountEl.textContent = '0 条消息';
        }
    }

    subscribeAll() {
        this.send({ type: 'subscribe_all' });
    }

    unsubscribeAll() {
        this.send({ type: 'unsubscribe' });
        this.isSubscribedAll = false;
        this.subModeEl.textContent = '-';
    }

    subscribeSessions() {
        const input = this.sessionIdsInput.value.trim();
        if (!input) {
            this.showError('请输入会话ID');
            return;
        }

        try {
            let sessions;

            // Try to parse as JSON array
            if (input.startsWith('[')) {
                sessions = JSON.parse(input);
            } else {
                // Treat as comma-separated list or single ID
                sessions = input.split(',').map(s => s.trim().replace(/["']/g, ''));
            }

            if (!Array.isArray(sessions) || sessions.length === 0) {
                this.showError('请输入有效的会话ID列表');
                return;
            }

            this.send({
                type: 'subscribe',
                sessions: sessions
            });

        } catch (e) {
            this.showError('会话ID格式错误，请输入如 ["wxid_xxx"] 的格式');
        }
    }

    unsubscribeSessions() {
        const sessions = Array.from(this.subscribedSessions);
        if (sessions.length > 0) {
            this.send({
                type: 'unsubscribe',
                sessions: sessions
            });
        }
        this.subscribedSessions.clear();
        this.updateSubscribedSessionsTags();
        this.subModeEl.textContent = '-';
    }

    updateSubscribedSessionsTags() {
        this.subscribedSessionsEl.innerHTML = '';

        this.subscribedSessions.forEach(session => {
            const tag = document.createElement('div');
            tag.className = 'session-tag';
            tag.innerHTML = `
                <span>${session}</span>
                <button class="remove-btn" title="移除">×</button>
            `;

            tag.querySelector('.remove-btn').addEventListener('click', () => {
                this.subscribedSessions.delete(session);
                this.send({
                    type: 'unsubscribe',
                    sessions: [session]
                });
                this.updateSubscribedSessionsTags();
                if (this.subscribedSessions.size === 0) {
                    this.subModeEl.textContent = '-';
                } else {
                    this.subModeEl.textContent = `${this.subscribedSessions.size} 个会话`;
                }
            });

            this.subscribedSessionsEl.appendChild(tag);
        });
    }

    sendPing() {
        this.send({ type: 'ping' });
    }

    getStatus() {
        this.send({ type: 'status' });
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            console.log('发送:', data);
        } else {
            this.showError('WebSocket 未连接');
        }
    }

    showError(message) {
        console.error(message);
        // You could add a toast notification here
        alert(message);
    }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.wsTester = new WeFlowWSTester();
});
