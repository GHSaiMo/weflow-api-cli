/**
 * WeFlow API CLI - 配置服务
 * 从 .env 文件读取配置
 */
import { config } from 'dotenv';
import { resolve } from 'path';

// 加载 .env 文件
config({ path: resolve(process.cwd(), '.env') });

export interface AppConfig {
    // 数据库相关
    dbPath: string;
    decryptKey: string;
    myWxid: string;

    // HTTP API
    httpPort: number;
    httpHost: string;

    // WebSocket
    wsPort: number;
    wsHost: string;
    wsPollingIntervalMs: number;
    wsCheckDebounceMs: number;
    wsMonitorConnectTimeoutMs: number;
    wsWildcardRecentSessionLimit: number;
    wsSessionProbeBatchSize: number;
    wsDirectSessionCheckEnabled: boolean;

    // 日志
    logEnabled: boolean;
    logDir: string;

    // 资源路径
    resourcesPath: string;

    // macOS 数据同步
    dbWatchEventDebounceMs: number;
    dbSyncMinIntervalMs: number;

    // macOS DLL 模式
    dllEnabled: boolean;
    wcdbResourcesPath: string;
}

function parseIntWithMin(raw: string | undefined, fallback: number, min: number): number {
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return fallback;
    if (parsed < min) return min;
    return parsed;
}

export function loadConfig(): AppConfig {
    const dbPath = process.env.DB_PATH || '';
    const decryptKey = process.env.DECRYPT_KEY || '';
    const myWxid = process.env.MY_WXID || '';

    if (!dbPath || !decryptKey || !myWxid) {
        console.error('❌ 配置错误: 请在 .env 文件中配置 DB_PATH, DECRYPT_KEY, MY_WXID');
        console.error('   可参考 .env.example 文件');
        process.exit(1);
    }

    return {
        dbPath,
        decryptKey,
        myWxid,
        httpPort: parseInt(process.env.HTTP_PORT || '5031', 10),
        httpHost: process.env.HTTP_HOST || '127.0.0.1',
        wsPort: parseInt(process.env.WS_PORT || '5032', 10),
        wsHost: process.env.WS_HOST || '127.0.0.1',
        wsPollingIntervalMs: parseIntWithMin(process.env.WS_POLLING_INTERVAL_MS, 300, 50),
        wsCheckDebounceMs: parseIntWithMin(process.env.WS_CHECK_DEBOUNCE_MS, 20, 0),
        wsMonitorConnectTimeoutMs: parseIntWithMin(process.env.WS_MONITOR_CONNECT_TIMEOUT_MS, 1200, 100),
        wsWildcardRecentSessionLimit: parseIntWithMin(process.env.WS_WILDCARD_RECENT_SESSION_LIMIT, 20, 1),
        wsSessionProbeBatchSize: parseIntWithMin(process.env.WS_SESSION_PROBE_BATCH_SIZE, 10, 1),
        wsDirectSessionCheckEnabled: process.env.WS_DIRECT_SESSION_CHECK_ENABLED !== 'false',
        logEnabled: process.env.LOG_ENABLED === 'true',
        logDir: process.env.LOG_DIR || './logs',
        resourcesPath: process.env.RESOURCES_PATH || './resources',
        dbWatchEventDebounceMs: parseIntWithMin(process.env.DB_WATCH_EVENT_DEBOUNCE_MS, 30, 0),
        dbSyncMinIntervalMs: parseIntWithMin(process.env.DB_SYNC_MIN_INTERVAL_MS, 100, 0),
        dllEnabled: process.env.WCDB_DLL_ENABLED === 'true',
        wcdbResourcesPath: process.env.WCDB_RESOURCES_PATH || '',
    };
}

// 单例配置
let configInstance: AppConfig | null = null;

export function getConfig(): AppConfig {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}
