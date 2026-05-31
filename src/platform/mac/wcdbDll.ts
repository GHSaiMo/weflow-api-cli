/**
 * WeFlow API CLI - DLL 后端
 *
 * 通过 koffi FFI 调用 WeFlow 的 libwcdb_api.dylib，
 * 绕过 better-sqlite3 解密开销，直接读取加密数据库。
 *
 * 优势：
 *   - getSessions: 0.1ms (vs better-sqlite3 解密后 ~13ms)
 *   - 内置 monitor pipe: 表级别精确通知 (vs fs.watch 文件级)
 *   - 无需解密到磁盘，零 I/O 开销
 *
 * 前提条件：
 *   - 进程名必须为 'electron'（DLL 做进程名白名单校验）
 *   - WCDB_RESOURCES_PATH 指向 WeFlow 的 resources 目录
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as net from 'net';
import { createRequire } from 'module';
import { logWithTag } from '../../logFormat.js';

// koffi 是可选依赖，ESM 需通过 createRequire 加载原生模块
const esmRequire = createRequire(import.meta.url);

export class WcdbDll {
    private lib: any = null;
    private handle: bigint = BigInt(0);
    private initialized = false;
    private connected = false;
    private koffi: any = null;

    // 绑定的 DLL 函数
    private fns: Record<string, any> = {};

    // Monitor pipe
    private monitorPipeClient: any = null;
    private monitorCallback: ((type: string, json: string) => void) | null = null;
    private monitorReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private monitorPipePath = '';

    // 当前账号路径（用于诊断 DLL -3 错误）
    private sessionDbPath = '';
    private messageDbDir = '';

    // 重连所需的凭据
    private lastOpenDbPath = '';
    private lastOpenHexKey = '';
    private lastOpenWxid = '';
    private reconnecting = false;

    /**
     * 检测 DLL 模式是否可用
     */
    static isAvailable(resourcesPath: string): boolean {
        try {
            const apiPath = WcdbDll.getApiDylibPath(resourcesPath);
            const wcdbPath = WcdbDll.getWcdbDylibPath(resourcesPath);
            return existsSync(apiPath) && existsSync(wcdbPath);
        } catch {
            return false;
        }
    }

    private static getApiDylibPath(resourcesPath: string): string {
        // 优先: resources/macos/libwcdb_api.dylib
        const macosPath = join(resourcesPath, 'macos', 'libwcdb_api.dylib');
        if (existsSync(macosPath)) return macosPath;
        // 备选: resources/libwcdb_api.dylib
        return join(resourcesPath, 'libwcdb_api.dylib');
    }

    private static getWcdbDylibPath(resourcesPath: string): string {
        const macosPath = join(resourcesPath, 'macos', 'libWCDB.dylib');
        if (existsSync(macosPath)) return macosPath;
        return join(resourcesPath, 'libWCDB.dylib');
    }

    /**
     * 初始化 DLL 并绑定所有函数
     */
    async initialize(resourcesPath: string): Promise<boolean> {
        if (this.initialized) return true;

        try {
            this.koffi = esmRequire('koffi');
        } catch (e) {
            logWithTag('WcdbDll', 'koffi 模块未安装:', 'error', e);
            return false;
        }

        try {
            // 加载依赖库
            const wcdbPath = WcdbDll.getWcdbDylibPath(resourcesPath);
            if (existsSync(wcdbPath)) {
                this.koffi.load(wcdbPath);
            }

            // 加载主 API 库
            const apiPath = WcdbDll.getApiDylibPath(resourcesPath);
            this.lib = this.koffi.load(apiPath);

            // InitProtection
            const InitProtection = this.lib.func('int32 InitProtection(const char* resourcePath)');
            const protRc = InitProtection(resourcesPath);
            if (protRc !== 0) {
                logWithTag('WcdbDll', `InitProtection 失败 (code=${protRc})`, 'error');
                return false;
            }

            // 绑定所有函数
            this.bindFunctions();

            // wcdb_init
            const initRc = this.fns.wcdb_init();
            if (initRc !== 0) {
                logWithTag('WcdbDll', `wcdb_init 失败 (code=${initRc})`, 'error');
                logWithTag('WcdbDll', '提示: 进程名必须为 "electron"，请使用 npm run start:dll 启动', 'error');
                return false;
            }

            this.initialized = true;
            return true;
        } catch (e) {
            logWithTag('WcdbDll', '初始化异常:', 'error', e);
            return false;
        }
    }

    private bindFunctions(): void {
        const fn = (sig: string) => {
            try {
                return this.lib.func(sig);
            } catch {
                return null;
            }
        };

        this.fns = {
            // 核心
            wcdb_init: this.lib.func('int32 wcdb_init()'),
            wcdb_shutdown: this.lib.func('int32 wcdb_shutdown()'),
            wcdb_open_account: this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)'),
            wcdb_close_account: this.lib.func('int32 wcdb_close_account(int64 handle)'),
            wcdb_free_string: this.lib.func('void wcdb_free_string(void* ptr)'),

            // wxid
            wcdb_set_my_wxid: fn('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)'),

            // 查询
            wcdb_get_sessions: this.lib.func('int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)'),
            wcdb_get_messages: this.lib.func('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)'),
            wcdb_get_message_count: this.lib.func('int32 wcdb_get_message_count(int64 handle, const char* username, _Out_ int32* outCount)'),
            wcdb_get_display_names: this.lib.func('int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)'),
            wcdb_get_avatar_urls: this.lib.func('int32 wcdb_get_avatar_urls(int64 handle, const char* usernamesJson, _Out_ void** outJson)'),
            wcdb_get_contact: this.lib.func('int32 wcdb_get_contact(int64 handle, const char* username, _Out_ void** outJson)'),
            wcdb_get_group_members: this.lib.func('int32 wcdb_get_group_members(int64 handle, const char* chatroomId, _Out_ void** outJson)'),
            wcdb_get_group_member_count: this.lib.func('int32 wcdb_get_group_member_count(int64 handle, const char* chatroomId, _Out_ int32* outCount)'),
            wcdb_get_group_nicknames: fn('int32 wcdb_get_group_nicknames(int64 handle, const char* chatroomId, _Out_ void** outJson)'),
            wcdb_get_group_member_counts: fn('int32 wcdb_get_group_member_counts(int64 handle, const char* chatroomIdsJson, _Out_ void** outJson)'),
            wcdb_get_message_tables: this.lib.func('int32 wcdb_get_message_tables(int64 handle, const char* sessionId, _Out_ void** outJson)'),
            wcdb_get_message_table_stats: this.lib.func('int32 wcdb_get_message_table_stats(int64 handle, const char* sessionId, _Out_ void** outJson)'),
            wcdb_get_message_meta: this.lib.func('int32 wcdb_get_message_meta(int64 handle, const char* dbPath, const char* tableName, int32 limit, int32 offset, _Out_ void** outJson)'),
            wcdb_get_message_by_id: this.lib.func('int32 wcdb_get_message_by_id(int64 handle, const char* sessionId, int32 localId, _Out_ void** outJson)'),
            wcdb_search_messages: fn('int32 wcdb_search_messages(int64 handle, const char* sessionId, const char* keyword, int32 limit, int32 offset, int32 beginTimestamp, int32 endTimestamp, _Out_ void** outJson)'),

            // 游标
            wcdb_open_message_cursor: this.lib.func('int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)'),
            wcdb_fetch_message_batch: this.lib.func('int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)'),
            wcdb_close_message_cursor: this.lib.func('int32 wcdb_close_message_cursor(int64 handle, int64 cursor)'),

            // exec
            wcdb_exec_query: this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)'),

            // Monitor
            wcdb_start_monitor_pipe: fn('int32 wcdb_start_monitor_pipe()'),
            wcdb_stop_monitor_pipe: fn('void wcdb_stop_monitor_pipe()'),
            wcdb_get_monitor_pipe_name: fn('int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)'),

            // 联系人
            wcdb_get_contact_status: fn('int32 wcdb_get_contact_status(int64 handle, const char* usernamesJson, _Out_ void** outJson)'),
            wcdb_get_contact_type_counts: fn('int32 wcdb_get_contact_type_counts(int64 handle, _Out_ void** outJson)'),
            wcdb_get_contacts_compact: fn('int32 wcdb_get_contacts_compact(int64 handle, const char* usernamesJson, _Out_ void** outJson)'),
            wcdb_get_contact_alias_map: fn('int32 wcdb_get_contact_alias_map(int64 handle, const char* usernamesJson, _Out_ void** outJson)'),
            wcdb_get_chat_room_ext_buffer: fn('int32 wcdb_get_chat_room_ext_buffer(int64 handle, const char* chatroomId, _Out_ void** outJson)'),

            // 列表
            wcdb_list_message_dbs: this.lib.func('int32 wcdb_list_message_dbs(int64 handle, _Out_ void** outJson)'),
            wcdb_list_media_dbs: this.lib.func('int32 wcdb_list_media_dbs(int64 handle, _Out_ void** outJson)'),
        };
    }

    /**
     * 打开数据库
     */
    async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
        if (!this.initialized) return false;

        this.close();

        try {
            // 优先匹配当前 wxid 所在账号，避免多账号目录命中错误 session.db
            const sessionDbPath = this.findSessionDb(dbPath, wxid);
            if (!sessionDbPath) {
                logWithTag('WcdbDll', `未找到 session.db (dbPath=${dbPath}, wxid=${wxid || ''})`, 'error');
                return false;
            }

            const messageDbDir = this.deriveMessageDbDir(sessionDbPath);
            const localMessageDbs = this.listLocalMessageDbs(messageDbDir);
            if (localMessageDbs.length === 0) {
                logWithTag('WcdbDll', `未找到可用消息库: sessionDb=${sessionDbPath}, messageDir=${messageDbDir}`, 'error');
                return false;
            }

            // 保存重连凭据
            this.lastOpenDbPath = dbPath;
            this.lastOpenHexKey = hexKey;
            this.lastOpenWxid = wxid;

            // 某些环境下 DLL 会在首次打开后偶发拿不到 message db 列表（返回 0）。
            // 这里做启动期重连自愈，避免运行时频繁出现 openMessageCursor(-3)。
            const maxOpenAttempts = 3;
            for (let attempt = 1; attempt <= maxOpenAttempts; attempt++) {
                const handleOut = [BigInt(0)];
                const rc = this.fns.wcdb_open_account(sessionDbPath, hexKey, handleOut);
                if (rc !== 0) {
                    logWithTag('WcdbDll', `wcdb_open_account 失败 (code=${rc}) sessionDb=${sessionDbPath}`, 'error');
                    return false;
                }

                this.handle = handleOut[0];
                if (this.handle <= BigInt(0)) {
                    logWithTag('WcdbDll', '无效的数据库句柄', 'error');
                    this.close();
                    return false;
                }

                // 设置 wxid
                if (wxid && this.fns.wcdb_set_my_wxid) {
                    try {
                        this.fns.wcdb_set_my_wxid(this.handle, wxid);
                    } catch { /* 静默 */ }
                }

                this.connected = true;
                this.sessionDbPath = sessionDbPath;
                this.messageDbDir = messageDbDir;

                const runtimeMessageDbCount = this.getRuntimeMessageDbCount();
                if (runtimeMessageDbCount === 0) {
                    if (attempt < maxOpenAttempts) {
                        logWithTag('WcdbDll', `wcdb_list_message_dbs 返回 0 (attempt ${attempt}/${maxOpenAttempts})，重连账号重试...`, 'warn');
                        this.close();
                        continue;
                    }
                    logWithTag('WcdbDll', `wcdb_list_message_dbs 仍为 0，放弃 DLL 模式 (messageDir=${messageDbDir})`, 'error');
                    this.close();
                    return false;
                }

                const attemptSuffix = attempt > 1 ? `, attempt=${attempt}` : '';
                logWithTag('WcdbDll', `数据库打开成功 (handle=${this.handle}${attemptSuffix})`);
                return true;
            }

            return false;
        } catch (e) {
            logWithTag('WcdbDll', '打开数据库异常:', 'error', e);
            return false;
        }
    }

    close(): void {
        if (this.connected && this.handle > BigInt(0)) {
            try {
                this.fns.wcdb_close_account(this.handle);
            } catch { /* ignore */ }
        }
        this.connected = false;
        this.handle = BigInt(0);
        this.sessionDbPath = '';
        this.messageDbDir = '';
    }

    /**
     * 重新打开数据库连接（用于从 -3 错误中恢复）
     * 执行完整的 DLL 重初始化周期：shutdown → init → open
     * 仅 close+open 不足以重置 DLL 内部的 message DB 扫描器状态
     */
    async reopen(): Promise<boolean> {
        if (!this.initialized) return false;
        if (this.reconnecting) return false;
        if (!this.lastOpenDbPath || !this.lastOpenHexKey) {
            logWithTag('WcdbDll', 'reopen 失败: 无保存的连接凭据', 'error');
            return false;
        }

        this.reconnecting = true;
        logWithTag('WcdbDll', '正在执行 DLL 完整重初始化...');

        try {
            // 1. 关闭账号连接
            this.close();

            // 2. 执行 wcdb_shutdown 重置全局状态
            try {
                this.fns.wcdb_shutdown();
            } catch { /* ignore */ }

            // 等待资源释放
            await new Promise(r => setTimeout(r, 500));

            // 3. 重新 wcdb_init
            const initRc = this.fns.wcdb_init();
            if (initRc !== 0) {
                logWithTag('WcdbDll', `reopen: wcdb_init 失败 (code=${initRc})`, 'error');
                this.initialized = false;
                return false;
            }

            // 4. 重新打开账号（内部有 3 次重试）
            const ok = await this.open(this.lastOpenDbPath, this.lastOpenHexKey, this.lastOpenWxid);
            if (ok) {
                logWithTag('WcdbDll', 'DLL 完整重初始化成功');
            } else {
                logWithTag('WcdbDll', 'DLL 重初始化后 open 仍失败', 'error');
            }
            return ok;
        } catch (e) {
            logWithTag('WcdbDll', 'reopen 异常:', 'error', e);
            return false;
        } finally {
            this.reconnecting = false;
        }
    }

    shutdown(): void {
        this.stopMonitor();
        this.close();
        if (this.initialized) {
            try { this.fns.wcdb_shutdown(); } catch { /* ignore */ }
        }
        this.initialized = false;
    }

    isConnected(): boolean {
        return this.initialized && this.connected && this.handle > BigInt(0);
    }

    // ========== 查询方法 ==========

    /**
     * 解码 DLL 返回的 JSON 指针并释放内存
     */
    private decodeJsonPtr(ptr: any): string | null {
        if (!ptr) return null;
        try {
            const json = this.koffi.decode(ptr, 'char', -1);
            this.fns.wcdb_free_string(ptr);
            return json;
        } catch {
            return null;
        }
    }

    private parseJsonResult(ptr: any): any {
        const json = this.decodeJsonPtr(ptr);
        if (!json) return null;
        try {
            return JSON.parse(json);
        } catch {
            return null;
        }
    }


    private getRuntimeMessageDbCount(): number | null {
        if (!this.isConnected() || !this.fns.wcdb_list_message_dbs) return null;

        try {
            const outJson = [null as any];
            const rc = this.fns.wcdb_list_message_dbs(this.handle, outJson);
            if (rc !== 0) return null;

            const data = this.parseJsonResult(outJson[0]);
            if (!data) return 0;

            const rows = Array.isArray(data) ? data : (data.rows || data.dbs || data.databases || []);
            return Array.isArray(rows) ? rows.length : 0;
        } catch {
            return null;
        }
    }

    private formatOpenMessageCursorError(
        rc: number,
        sessionId: string,
        beginTimestamp: number,
        endTimestamp: number
    ): string {
        if (rc !== -3) {
            return `openMessageCursor failed (${rc})`;
        }

        const details: string[] = [];
        details.push(`sessionId=${sessionId || '(empty)'}`);
        details.push(`range=[${beginTimestamp},${endTimestamp}]`);

        if (this.sessionDbPath) details.push(`sessionDb=${this.sessionDbPath}`);
        if (this.messageDbDir) details.push(`messageDir=${this.messageDbDir}`);

        const localMessageDbCount = this.listLocalMessageDbs(this.messageDbDir).length;
        details.push(`localMessageDbCount=${localMessageDbCount}`);

        const runtimeMessageDbCount = this.getRuntimeMessageDbCount();
        if (runtimeMessageDbCount !== null) {
            details.push(`runtimeMessageDbCount=${runtimeMessageDbCount}`);
        }

        details.push('请确认 DB_PATH 指向完整账号目录且包含 db_storage/message/message*.db');
        return `openMessageCursor failed (-3): ${details.join(', ')}`;
    }

    getSessions(): { success: boolean; data?: any[]; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        const outJson = [null as any];
        const rc = this.fns.wcdb_get_sessions(this.handle, outJson);
        if (rc !== 0) return { success: false, error: `wcdb_get_sessions failed (${rc})` };

        const data = this.parseJsonResult(outJson[0]);
        if (!data) return { success: false, error: 'JSON 解析失败' };

        // DLL 返回的 sessions 数组
        const sessions = Array.isArray(data) ? data : (data.sessions || []);
        return { success: true, data: sessions };
    }

    getMessages(sessionId: string, limit: number, offset: number): { success: boolean; data?: any[]; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        const outJson = [null as any];
        const rc = this.fns.wcdb_get_messages(this.handle, sessionId, limit, offset, outJson);
        if (rc !== 0) return { success: false, error: `wcdb_get_messages failed (${rc})` };

        const data = this.parseJsonResult(outJson[0]);
        if (!data) return { success: false, error: 'JSON 解析失败' };

        const messages = Array.isArray(data) ? data : (data.messages || data.rows || []);
        return { success: true, data: messages };
    }

    getDisplayNames(usernames: string[]): { success: boolean; data?: Record<string, string>; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        const outJson = [null as any];
        const rc = this.fns.wcdb_get_display_names(this.handle, JSON.stringify(usernames), outJson);
        if (rc !== 0) return { success: false, error: `wcdb_get_display_names failed (${rc})` };

        const data = this.parseJsonResult(outJson[0]);
        if (!data) return { success: false, error: 'JSON 解析失败' };
        return { success: true, data };
    }

    getGroupMembers(chatroomId: string): { success: boolean; data?: any[]; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        const outJson = [null as any];
        const rc = this.fns.wcdb_get_group_members(this.handle, chatroomId, outJson);
        if (rc !== 0) return { success: false, error: `wcdb_get_group_members failed (${rc})` };

        const data = this.parseJsonResult(outJson[0]);
        if (!data) return { success: false, error: 'JSON 解析失败' };

        const members = Array.isArray(data) ? data : (data.members || []);
        return { success: true, data: members };
    }

    getGroupNicknames(chatroomId: string): { success: boolean; data?: Record<string, string>; error?: string } {
        if (!this.isConnected() || !this.fns.wcdb_get_group_nicknames) {
            return { success: true, data: {} };
        }

        const outJson = [null as any];
        const rc = this.fns.wcdb_get_group_nicknames(this.handle, chatroomId, outJson);
        if (rc !== 0) return { success: true, data: {} };

        const data = this.parseJsonResult(outJson[0]);
        return { success: true, data: data || {} };
    }

    execQuery(kind: string, path: string | null, sql: string): { success: boolean; data?: any[]; rows?: any[]; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        const outJson = [null as any];
        const rc = this.fns.wcdb_exec_query(this.handle, kind || '', path || '', sql, outJson);
        if (rc !== 0) return { success: false, error: `wcdb_exec_query failed (${rc})` };

        const data = this.parseJsonResult(outJson[0]);
        if (!data) return { success: true, data: [] };

        const rows = Array.isArray(data) ? data : (data.rows || []);
        return { success: true, data: rows, rows };
    }

    // ========== 游标 API ==========

    openMessageCursor(
        sessionId: string,
        batchSize: number,
        ascending: boolean,
        beginTimestamp: number,
        endTimestamp: number
    ): { success: boolean; data?: number; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        const normalizedSessionId = String(sessionId || '').trim();
        const outCursor = [BigInt(0)];
        const rc = this.fns.wcdb_open_message_cursor(
            this.handle, normalizedSessionId, batchSize,
            ascending ? 1 : 0, beginTimestamp, endTimestamp,
            outCursor
        );
        if (rc !== 0) {
            return {
                success: false,
                error: this.formatOpenMessageCursorError(rc, normalizedSessionId, beginTimestamp, endTimestamp),
            };
        }

        return { success: true, data: Number(outCursor[0]) };
    }

    fetchMessageBatch(cursor: number): { success: boolean; data?: { rows: any[]; hasMore: boolean }; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        const outJson = [null as any];
        const outHasMore = [0];
        const rc = this.fns.wcdb_fetch_message_batch(this.handle, BigInt(cursor), outJson, outHasMore);
        if (rc !== 0) return { success: false, error: `fetchMessageBatch failed (${rc})` };

        const data = this.parseJsonResult(outJson[0]);
        if (!data) return { success: true, data: { rows: [], hasMore: false } };

        const rows = Array.isArray(data) ? data : (data.rows || data.messages || []);
        return { success: true, data: { rows, hasMore: outHasMore[0] !== 0 } };
    }

    closeMessageCursor(cursor: number): { success: boolean; error?: string } {
        if (!this.isConnected()) return { success: false, error: 'DLL 未连接' };

        try {
            this.fns.wcdb_close_message_cursor(this.handle, BigInt(cursor));
        } catch { /* ignore */ }
        return { success: true };
    }

    // ========== Monitor Pipe ==========

    startMonitor(callback: (type: string, json: string) => void): boolean {
        if (!this.fns.wcdb_start_monitor_pipe) {
            return false;
        }

        this.monitorCallback = callback;

        try {
            const rc = this.fns.wcdb_start_monitor_pipe();
            if (rc !== 0) {
                logWithTag('WcdbDll', `wcdb_start_monitor_pipe 失败 (code=${rc})`, 'error');
                return false;
            }

            // 获取管道名
            let pipePath = '/tmp/weflow_monitor_0';
            if (this.fns.wcdb_get_monitor_pipe_name) {
                try {
                    const namePtr = [null as any];
                    if (this.fns.wcdb_get_monitor_pipe_name(namePtr) === 0 && namePtr[0]) {
                        pipePath = this.koffi.decode(namePtr[0], 'char', -1);
                        this.fns.wcdb_free_string(namePtr[0]);
                    }
                } catch { /* ignore */ }
            }

            this.connectMonitorPipe(pipePath);
            return true;
        } catch (e) {
            logWithTag('WcdbDll', 'startMonitor 异常:', 'error', e);
            return false;
        }
    }

    private connectMonitorPipe(pipePath: string): void {
        this.monitorPipePath = pipePath;

        setTimeout(() => {
            if (!this.monitorCallback) return;

            this.monitorPipeClient = net.createConnection(this.monitorPipePath, () => {
                logWithTag('WcdbDll', `Monitor pipe 已连接: ${this.monitorPipePath}`);
            });

            let buffer = '';
            this.monitorPipeClient.on('data', (data: Buffer) => {
                const rawChunk = data.toString('utf8');
                // macOS 侧可能使用 '\0' 或无换行分隔
                const normalizedChunk = rawChunk
                    .replace(/\u0000/g, '\n')
                    .replace(/}\s*{/g, '}\n{');

                buffer += normalizedChunk;
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const parsed = JSON.parse(line);
                            this.monitorCallback?.(parsed.action || 'update', line);
                        } catch {
                            this.monitorCallback?.('update', line);
                        }
                    }
                }

                // 兜底完整 JSON
                const tail = buffer.trim();
                if (tail.startsWith('{') && tail.endsWith('}')) {
                    try {
                        const parsed = JSON.parse(tail);
                        this.monitorCallback?.(parsed.action || 'update', tail);
                        buffer = '';
                    } catch { /* 等待更多数据 */ }
                }
            });

            this.monitorPipeClient.on('error', () => { /* 静默 */ });
            this.monitorPipeClient.on('close', () => {
                this.monitorPipeClient = null;
                this.scheduleReconnect();
            });
        }, 100);
    }

    private scheduleReconnect(): void {
        if (this.monitorReconnectTimer || !this.monitorCallback) return;
        this.monitorReconnectTimer = setTimeout(() => {
            this.monitorReconnectTimer = null;
            if (this.monitorCallback && !this.monitorPipeClient) {
                this.connectMonitorPipe(this.monitorPipePath);
            }
        }, 3000);
    }

    stopMonitor(): void {
        this.monitorCallback = null;
        if (this.monitorReconnectTimer) {
            clearTimeout(this.monitorReconnectTimer);
            this.monitorReconnectTimer = null;
        }
        if (this.monitorPipeClient) {
            this.monitorPipeClient.destroy();
            this.monitorPipeClient = null;
        }
        if (this.fns.wcdb_stop_monitor_pipe) {
            try { this.fns.wcdb_stop_monitor_pipe(); } catch { /* ignore */ }
        }
    }

    isMonitorConnected(): boolean {
        return this.monitorPipeClient !== null;
    }

    // ========== 路径解析 ==========

    private findSessionDb(dbPath: string, wxid: string): string | null {
        const normalizedDbPath = resolve(dbPath);
        const normalizedWxid = String(wxid || '').trim();

        // 先做直连路径命中，避免递归扫描时拿到错误账号的 session.db
        const directCandidates = this.buildDirectSessionDbCandidates(normalizedDbPath, normalizedWxid);
        for (const p of directCandidates) {
            if (this.isFile(p)) return p;
        }

        const roots = this.buildSessionSearchRoots(normalizedDbPath, normalizedWxid);
        const found: string[] = [];
        const visited = new Set<string>();

        for (const root of roots) {
            if (!existsSync(root)) continue;
            this.collectSessionDbCandidates(root, 0, found, visited);
        }

        if (found.length === 0) return null;

        found.sort((a, b) => {
            const sa = this.scoreSessionDbCandidate(a, normalizedWxid);
            const sb = this.scoreSessionDbCandidate(b, normalizedWxid);
            if (sa !== sb) return sb - sa;
            return a.length - b.length;
        });

        return found[0];
    }

    private deriveMessageDbDir(sessionDbPath: string): string {
        return resolve(dirname(sessionDbPath), '..', 'message');
    }

    private listLocalMessageDbs(messageDbDir: string): string[] {
        if (!messageDbDir || !existsSync(messageDbDir)) return [];
        try {
            return readdirSync(messageDbDir)
                .filter((name) => /^message(?:_\d+)?\.db$/i.test(name))
                .map((name) => join(messageDbDir, name));
        } catch {
            return [];
        }
    }

    private buildDirectSessionDbCandidates(dbPath: string, wxid: string): string[] {
        const out = new Set<string>();
        const addBase = (base: string) => {
            if (!base) return;
            out.add(resolve(base, 'session.db'));
            out.add(resolve(base, 'session', 'session.db'));
            out.add(resolve(base, 'db_storage', 'session', 'session.db'));
        };

        addBase(dbPath);
        addBase(resolve(dbPath, '..'));

        if (wxid) {
            addBase(resolve(dbPath, wxid));
            addBase(resolve(dbPath, '..', wxid));
            addBase(resolve(dbPath, '..', '..', wxid));
        }

        // dbPath 自身已经是 session.db 文件时也允许直接命中
        if (dbPath.toLowerCase().endsWith('/session.db') || dbPath.toLowerCase().endsWith('\\session.db')) {
            out.add(resolve(dbPath));
        }

        return Array.from(out);
    }

    private buildSessionSearchRoots(dbPath: string, wxid: string): string[] {
        const roots = new Set<string>();
        const add = (p: string) => {
            if (!p) return;
            roots.add(resolve(p));
        };

        add(dbPath);
        add(resolve(dbPath, 'db_storage'));
        add(resolve(dbPath, '..'));
        add(resolve(dbPath, '..', 'db_storage'));

        if (wxid) {
            add(resolve(dbPath, wxid));
            add(resolve(dbPath, wxid, 'db_storage'));
            add(resolve(dbPath, '..', wxid));
            add(resolve(dbPath, '..', wxid, 'db_storage'));
        }

        return Array.from(roots);
    }

    private collectSessionDbCandidates(dir: string, depth: number, out: string[], visited: Set<string>): void {
        if (depth > 5) return;

        const normalizedDir = resolve(dir);
        if (visited.has(normalizedDir)) return;
        visited.add(normalizedDir);

        try {
            const entries = readdirSync(normalizedDir);

            for (const e of entries) {
                if (e.toLowerCase() === 'session.db') {
                    const full = join(normalizedDir, e);
                    if (this.isFile(full)) out.push(full);
                }
            }

            for (const e of entries) {
                const full = join(normalizedDir, e);
                try {
                    if (statSync(full).isDirectory()) {
                        this.collectSessionDbCandidates(full, depth + 1, out, visited);
                    }
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    private isFile(p: string): boolean {
        try {
            return existsSync(p) && statSync(p).isFile();
        } catch {
            return false;
        }
    }

    private scoreSessionDbCandidate(sessionDbPath: string, wxid: string): number {
        const normalized = sessionDbPath.replace(/\\/g, '/').toLowerCase();
        const normalizedWxid = wxid.toLowerCase();

        let score = 0;
        if (normalized.includes('/db_storage/session/session.db')) score += 500;
        if (normalizedWxid && normalized.includes(`/${normalizedWxid}/`)) score += 1000;
        if (normalized.endsWith('/session.db')) score += 50;

        // 同分时优先路径更短的候选
        score -= Math.min(200, normalized.length);
        return score;
    }
}

// 单例
let dllInstance: WcdbDll | null = null;

export function getWcdbDll(): WcdbDll {
    if (!dllInstance) {
        dllInstance = new WcdbDll();
    }
    return dllInstance;
}
