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

    // 日志
    logEnabled: boolean;
    logDir: string;

    // 资源路径
    resourcesPath: string;
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
        logEnabled: process.env.LOG_ENABLED === 'true',
        logDir: process.env.LOG_DIR || './logs',
        resourcesPath: process.env.RESOURCES_PATH || './resources',
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
