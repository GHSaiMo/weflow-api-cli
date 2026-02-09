/**
 * WeFlow API CLI - WCDB Core 服务
 * 封装 WCDB DLL 的调用，提供数据库操作接口
 * 基于原项目 electron/services/wcdbCore.ts 简化实现
 */
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'fs';
import { getConfig } from './config.js';

interface WcdbResult<T = any> {
    success: boolean;
    data?: T;
    error?: string;
}

export class WcdbCore {
    private resourcesPath: string;
    private logEnabled: boolean;
    private logDir: string;
    private lib: any = null;
    private koffi: any = null;
    private initialized = false;
    private handle: number | null = null;
    private currentPath: string | null = null;
    private currentKey: string | null = null;
    private currentWxid: string | null = null;

    // DLL 函数引用
    private wcdbInit: any = null;
    private wcdbShutdown: any = null;
    private wcdbOpenAccount: any = null;
    private wcdbCloseAccount: any = null;
    private wcdbSetMyWxid: any = null;
    private wcdbFreeString: any = null;
    private wcdbGetSessions: any = null;
    private wcdbGetMessages: any = null;
    private wcdbGetNewMessages: any = null;
    private wcdbGetMessageCount: any = null;
    private wcdbGetDisplayNames: any = null;
    private wcdbGetAvatarUrls: any = null;
    private wcdbGetContact: any = null;
    private wcdbGetGroupMembers: any = null;
    private wcdbGetGroupNicknames: any = null;
    private wcdbOpenMessageCursor: any = null;
    private wcdbFetchMessageBatch: any = null;
    private wcdbCloseMessageCursor: any = null;
    private wcdbExecQuery: any = null;
    private wcdbListMessageDbs: any = null;
    private wcdbListMediaDbs: any = null;
    private wcdbStartMonitorPipe: any = null;
    private wcdbStopMonitorPipe: any = null;

    private monitorCallback: ((type: string, json: string) => void) | null = null;
    private monitorPipeClient: any = null;

    constructor() {
        const config = getConfig();
        this.resourcesPath = config.resourcesPath;
        this.logEnabled = config.logEnabled;
        this.logDir = config.logDir;
    }

    private writeLog(message: string, force = false): void {
        if (!force && !this.logEnabled) return;
        const line = `[${new Date().toISOString()}] ${message}`;
        console.log(line);
        try {
            if (!existsSync(this.logDir)) {
                mkdirSync(this.logDir, { recursive: true });
            }
            appendFileSync(join(this.logDir, 'wcdb.log'), line + '\n', { encoding: 'utf8' });
        } catch { }
    }

    private getDllPath(): string {
        const candidates = [
            join(this.resourcesPath, 'wcdb_api.dll'),
            join(process.cwd(), 'resources', 'wcdb_api.dll'),
        ];

        for (const path of candidates) {
            if (existsSync(path)) return path;
        }

        return candidates[0];
    }

    private findSessionDb(dir: string, depth = 0): string | null {
        if (depth > 5) return null;

        try {
            const entries = readdirSync(dir);

            for (const entry of entries) {
                if (entry.toLowerCase() === 'session.db') {
                    const fullPath = join(dir, entry);
                    if (statSync(fullPath).isFile()) {
                        return fullPath;
                    }
                }
            }

            for (const entry of entries) {
                const fullPath = join(dir, entry);
                try {
                    if (statSync(fullPath).isDirectory()) {
                        const found = this.findSessionDb(fullPath, depth + 1);
                        if (found) return found;
                    }
                } catch { }
            }
        } catch (e) {
            this.writeLog(`查找 session.db 失败: ${e}`);
        }

        return null;
    }

    private resolveDbStoragePath(basePath: string, wxid: string): string | null {
        if (!basePath) return null;
        const normalized = basePath.replace(/[\\/]+$/, '');

        if (normalized.toLowerCase().endsWith('db_storage') && existsSync(normalized)) {
            return normalized;
        }

        const direct = join(normalized, 'db_storage');
        if (existsSync(direct)) {
            return direct;
        }

        if (wxid) {
            const viaWxid = join(normalized, wxid, 'db_storage');
            if (existsSync(viaWxid)) {
                return viaWxid;
            }

            try {
                const entries = readdirSync(normalized);
                const lowerWxid = wxid.toLowerCase();
                const candidates = entries.filter((entry) => {
                    const entryPath = join(normalized, entry);
                    try {
                        if (!statSync(entryPath).isDirectory()) return false;
                    } catch {
                        return false;
                    }
                    const lowerEntry = entry.toLowerCase();
                    return lowerEntry === lowerWxid || lowerEntry.startsWith(`${lowerWxid}_`);
                });

                for (const entry of candidates) {
                    const candidate = join(normalized, entry, 'db_storage');
                    if (existsSync(candidate)) {
                        return candidate;
                    }
                }
            } catch { }
        }

        return null;
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;

        try {
            this.koffi = (await import('koffi')).default;
            const dllPath = this.getDllPath();

            if (!existsSync(dllPath)) {
                this.writeLog(`WCDB DLL 不存在: ${dllPath}`, true);
                return false;
            }

            this.writeLog(`加载 DLL: ${dllPath}`);

            // 预加载依赖 DLL
            const dllDir = dirname(dllPath);
            const wcdbCorePath = join(dllDir, 'WCDB.dll');
            if (existsSync(wcdbCorePath)) {
                try {
                    this.koffi.load(wcdbCorePath);
                    this.writeLog('预加载 WCDB.dll 成功');
                } catch (e) {
                    this.writeLog(`预加载 WCDB.dll 失败: ${e}`);
                }
            }

            const sdl2Path = join(dllDir, 'SDL2.dll');
            if (existsSync(sdl2Path)) {
                try {
                    this.koffi.load(sdl2Path);
                    this.writeLog('预加载 SDL2.dll 成功');
                } catch (e) {
                    this.writeLog(`预加载 SDL2.dll 失败: ${e}`);
                }
            }

            this.lib = this.koffi.load(dllPath);

            // 定义函数
            this.wcdbInit = this.lib.func('int32 wcdb_init()');
            this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()');
            this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)');
            this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)');
            this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)');
            this.wcdbGetSessions = this.lib.func('int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)');
            this.wcdbGetMessages = this.lib.func('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)');
            this.wcdbGetMessageCount = this.lib.func('int32 wcdb_get_message_count(int64 handle, const char* username, _Out_ int32* outCount)');
            this.wcdbGetDisplayNames = this.lib.func('int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)');
            this.wcdbGetAvatarUrls = this.lib.func('int32 wcdb_get_avatar_urls(int64 handle, const char* usernamesJson, _Out_ void** outJson)');
            this.wcdbGetContact = this.lib.func('int32 wcdb_get_contact(int64 handle, const char* username, _Out_ void** outJson)');
            this.wcdbOpenMessageCursor = this.lib.func('int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)');
            this.wcdbFetchMessageBatch = this.lib.func('int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)');
            this.wcdbCloseMessageCursor = this.lib.func('int32 wcdb_close_message_cursor(int64 handle, int64 cursor)');
            this.wcdbExecQuery = this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)');
            this.wcdbListMessageDbs = this.lib.func('int32 wcdb_list_message_dbs(int64 handle, _Out_ void** outJson)');
            this.wcdbListMediaDbs = this.lib.func('int32 wcdb_list_media_dbs(int64 handle, _Out_ void** outJson)');

            try {
                this.wcdbSetMyWxid = this.lib.func('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)');
            } catch {
                this.wcdbSetMyWxid = null;
            }

            try {
                this.wcdbGetGroupMembers = this.lib.func('int32 wcdb_get_group_members(int64 handle, const char* chatroomId, _Out_ void** outJson)');
            } catch {
                this.wcdbGetGroupMembers = null;
            }

            try {
                this.wcdbGetGroupNicknames = this.lib.func('int32 wcdb_get_group_nicknames(int64 handle, const char* chatroomId, _Out_ void** outJson)');
            } catch {
                this.wcdbGetGroupNicknames = null;
            }

            // Monitor pipe functions
            try {
                this.wcdbStartMonitorPipe = this.lib.func('int32 wcdb_start_monitor_pipe()');
                this.wcdbStopMonitorPipe = this.lib.func('void wcdb_stop_monitor_pipe()');
                this.writeLog('Monitor pipe functions loaded');
            } catch {
                this.wcdbStartMonitorPipe = null;
                this.wcdbStopMonitorPipe = null;
            }

            // 初始化 WCDB
            const initResult = this.wcdbInit();
            if (initResult !== 0) {
                this.writeLog(`WCDB 初始化失败: ${initResult}`, true);
                return false;
            }

            this.initialized = true;
            this.writeLog('WCDB 初始化成功');
            return true;
        } catch (e) {
            this.writeLog(`WCDB 初始化异常: ${e}`, true);
            return false;
        }
    }

    async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
        try {
            if (!this.initialized) {
                const initOk = await this.initialize();
                if (!initOk) return false;
            }

            if (
                this.handle !== null &&
                this.currentPath === dbPath &&
                this.currentKey === hexKey &&
                this.currentWxid === wxid
            ) {
                return true;
            }

            if (this.handle !== null) {
                this.close();
            }

            const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid);
            this.writeLog(`open dbPath=${dbPath} wxid=${wxid} dbStorage=${dbStoragePath || 'null'}`);

            if (!dbStoragePath || !existsSync(dbStoragePath)) {
                this.writeLog(`数据库目录不存在: ${dbPath}`, true);
                return false;
            }

            const sessionDbPath = this.findSessionDb(dbStoragePath);
            this.writeLog(`sessionDb=${sessionDbPath || 'null'}`);

            if (!sessionDbPath) {
                this.writeLog('未找到 session.db 文件', true);
                return false;
            }

            const handleOut = [0];
            const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut);

            if (result !== 0) {
                this.writeLog(`打开数据库失败: ${result}`, true);
                return false;
            }

            this.handle = handleOut[0];
            this.currentPath = dbPath;
            this.currentKey = hexKey;
            this.currentWxid = wxid;

            if (this.handle <= 0) {
                this.writeLog('无效的数据库句柄', true);
                return false;
            }

            // 设置 myWxid
            if (this.wcdbSetMyWxid) {
                this.wcdbSetMyWxid(this.handle, wxid);
            }

            this.writeLog(`数据库打开成功, handle=${this.handle}`);
            return true;
        } catch (e) {
            this.writeLog(`打开数据库异常: ${e}`, true);
            return false;
        }
    }

    close(): void {
        if (this.handle !== null) {
            try {
                this.wcdbCloseAccount(this.handle);
            } catch { }
            this.handle = null;
            this.currentPath = null;
            this.currentKey = null;
            this.currentWxid = null;
        }
    }

    shutdown(): void {
        this.stopMonitor();
        this.close();
        if (this.wcdbShutdown) {
            try {
                this.wcdbShutdown();
            } catch { }
        }
        this.initialized = false;
    }

    isConnected(): boolean {
        return this.initialized && this.handle !== null;
    }

    private decodeJsonPtr(outPtr: any): string | null {
        if (!outPtr) return null;
        try {
            const jsonStr = this.koffi.decode(outPtr, 'char', -1);
            this.wcdbFreeString(outPtr);
            return jsonStr;
        } catch (e) {
            try {
                this.wcdbFreeString(outPtr);
            } catch { }
            return null;
        }
    }

    // Monitor 功能
    startMonitor(callback: (type: string, json: string) => void): boolean {
        if (!this.wcdbStartMonitorPipe) {
            this.writeLog('startMonitor: wcdbStartMonitorPipe not available');
            return false;
        }

        try {
            const result = this.wcdbStartMonitorPipe();
            if (result !== 0) {
                this.writeLog(`startMonitor: wcdbStartMonitorPipe failed with ${result}`);
                return false;
            }

            this.monitorCallback = callback;

            // 使用命名管道连接
            import('net').then((net) => {
                const PIPE_PATH = '\\\\.\\pipe\\weflow_monitor';

                setTimeout(() => {
                    this.monitorPipeClient = net.createConnection(PIPE_PATH, () => {
                        this.writeLog('Monitor pipe connected');
                    });

                    let buffer = '';
                    this.monitorPipeClient.on('data', (data: Buffer) => {
                        buffer += data.toString('utf8');
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (line.trim() && this.monitorCallback) {
                                try {
                                    const parsed = JSON.parse(line);
                                    this.monitorCallback(parsed.action || 'update', line);
                                } catch {
                                    this.monitorCallback('update', line);
                                }
                            }
                        }
                    });

                    this.monitorPipeClient.on('error', (err: Error) => {
                        this.writeLog(`Monitor pipe error: ${err.message}`);
                    });

                    this.monitorPipeClient.on('close', () => {
                        this.writeLog('Monitor pipe closed');
                        this.monitorPipeClient = null;
                    });
                }, 100);
            });

            this.writeLog('Monitor started via named pipe IPC');
            return true;
        } catch (e) {
            this.writeLog(`startMonitor failed: ${e}`);
            return false;
        }
    }

    stopMonitor(): void {
        if (this.monitorPipeClient) {
            this.monitorPipeClient.destroy();
            this.monitorPipeClient = null;
        }
        if (this.wcdbStopMonitorPipe) {
            try {
                this.wcdbStopMonitorPipe();
            } catch { }
        }
        this.monitorCallback = null;
    }

    // ===== 数据库查询方法 =====

    async getSessions(): Promise<WcdbResult<any[]>> {
        if (!this.isConnected()) {
            return { success: false, error: '数据库未连接' };
        }

        try {
            const outPtr = [null as any];
            const result = this.wcdbGetSessions(this.handle, outPtr);

            if (result !== 0) {
                return { success: false, error: `获取会话失败: ${result}` };
            }

            const jsonStr = this.decodeJsonPtr(outPtr[0]);
            if (!jsonStr) {
                return { success: false, error: '解析会话数据失败' };
            }

            const sessions = JSON.parse(jsonStr);
            return { success: true, data: sessions };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    async getDisplayNames(usernames: string[]): Promise<WcdbResult<Record<string, string>>> {
        if (!this.isConnected()) {
            return { success: false, error: '数据库未连接' };
        }

        try {
            const outPtr = [null as any];
            const result = this.wcdbGetDisplayNames(this.handle, JSON.stringify(usernames), outPtr);

            if (result !== 0) {
                return { success: false, error: `获取昵称失败: ${result}` };
            }

            const jsonStr = this.decodeJsonPtr(outPtr[0]);
            if (!jsonStr) {
                return { success: false, error: '解析昵称数据失败' };
            }

            const map = JSON.parse(jsonStr);
            return { success: true, data: map };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    async openMessageCursor(
        sessionId: string,
        batchSize: number,
        ascending: boolean,
        beginTimestamp: number,
        endTimestamp: number
    ): Promise<WcdbResult<number>> {
        if (!this.isConnected()) {
            return { success: false, error: '数据库未连接' };
        }

        try {
            const cursorOut = [0n];
            const result = this.wcdbOpenMessageCursor(
                this.handle,
                sessionId,
                batchSize,
                ascending ? 1 : 0,
                beginTimestamp,
                endTimestamp,
                cursorOut
            );

            if (result !== 0) {
                return { success: false, error: `打开消息游标失败: ${result}` };
            }

            return { success: true, data: Number(cursorOut[0]) };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    async fetchMessageBatch(cursor: number): Promise<WcdbResult<{ rows: any[]; hasMore: boolean }>> {
        if (!this.isConnected()) {
            return { success: false, error: '数据库未连接' };
        }

        try {
            const outPtr = [null as any];
            const hasMoreOut = [0];
            const result = this.wcdbFetchMessageBatch(this.handle, cursor, outPtr, hasMoreOut);

            if (result !== 0) {
                return { success: false, error: `获取消息批次失败: ${result}` };
            }

            const jsonStr = this.decodeJsonPtr(outPtr[0]);
            if (!jsonStr) {
                return { success: true, data: { rows: [], hasMore: false } };
            }

            const rows = JSON.parse(jsonStr);
            return { success: true, data: { rows, hasMore: hasMoreOut[0] === 1 } };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    async closeMessageCursor(cursor: number): Promise<WcdbResult<void>> {
        if (!this.isConnected()) {
            return { success: false, error: '数据库未连接' };
        }

        try {
            this.wcdbCloseMessageCursor(this.handle, cursor);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    async getGroupNicknames(chatroomId: string): Promise<WcdbResult<Record<string, string>>> {
        if (!this.isConnected() || !this.wcdbGetGroupNicknames) {
            return { success: false, error: '数据库未连接或功能不可用' };
        }

        try {
            const outPtr = [null as any];
            const result = this.wcdbGetGroupNicknames(this.handle, chatroomId, outPtr);

            if (result !== 0) {
                return { success: false, error: `获取群昵称失败: ${result}` };
            }

            const jsonStr = this.decodeJsonPtr(outPtr[0]);
            if (!jsonStr) {
                return { success: true, data: {} };
            }

            const nicknames = JSON.parse(jsonStr);
            return { success: true, data: nicknames };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }

    async execQuery(kind: string, path: string | null, sql: string): Promise<WcdbResult<any[]>> {
        if (!this.isConnected()) {
            return { success: false, error: '数据库未连接' };
        }

        try {
            const outPtr = [null as any];
            const result = this.wcdbExecQuery(this.handle, kind, path || '', sql, outPtr);

            if (result !== 0) {
                return { success: false, error: `执行查询失败: ${result}` };
            }

            const jsonStr = this.decodeJsonPtr(outPtr[0]);
            if (!jsonStr) {
                return { success: true, data: [] };
            }

            const rows = JSON.parse(jsonStr);
            return { success: true, data: rows };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }
}

// 单例实例
let wcdbInstance: WcdbCore | null = null;

export function getWcdbCore(): WcdbCore {
    if (!wcdbInstance) {
        wcdbInstance = new WcdbCore();
    }
    return wcdbInstance;
}
