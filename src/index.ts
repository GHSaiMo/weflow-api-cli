/**
 * WeFlow API CLI - 主入口
 * 微信聊天记录 HTTP API 和 WebSocket 实时推送服务
 */
import { getConfig } from './config.js';
import { getWcdbCore } from './wcdbCore.js';
import { getHttpService } from './httpService.js';
import { getWsService } from './wsService.js';

async function main(): Promise<void> {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                    WeFlow API CLI                          ║');
    console.log('║      微信聊天记录 HTTP API 和 WebSocket 实时推送服务        ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    // 加载配置
    const config = getConfig();
    console.log('📋 配置信息:');
    console.log(`   数据库路径: ${config.dbPath}`);
    console.log(`   微信ID: ${config.myWxid}`);
    console.log(`   HTTP API: http://${config.httpHost}:${config.httpPort}`);
    console.log(`   WebSocket: ws://${config.wsHost}:${config.wsPort}`);
    console.log('');

    // 初始化 WCDB
    console.log('🔌 正在连接数据库...');
    const wcdb = getWcdbCore();

    const connected = await wcdb.open(config.dbPath, config.decryptKey, config.myWxid);
    if (!connected) {
        console.error('❌ 数据库连接失败');
        console.error('   请检查:');
        console.error('   1. DB_PATH 是否正确指向 xwechat_files 目录');
        console.error('   2. DECRYPT_KEY 是否正确');
        console.error('   3. MY_WXID 是否正确');
        console.error('   4. resources 目录是否包含必要的 DLL 文件');
        process.exit(1);
    }
    console.log('✅ 数据库连接成功');

    // 启动 HTTP API 服务
    console.log('');
    console.log('🚀 正在启动服务...');

    const httpService = getHttpService();
    const httpResult = await httpService.start();
    if (!httpResult.success) {
        console.error('❌ HTTP API 服务启动失败:', httpResult.error);
        wcdb.shutdown();
        process.exit(1);
    }

    // 启动 WebSocket 服务
    const wsService = getWsService();
    const wsResult = await wsService.start();
    if (!wsResult.success) {
        console.error('❌ WebSocket 服务启动失败:', wsResult.error);
        await httpService.stop();
        wcdb.shutdown();
        process.exit(1);
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('📖 API 文档:');
    console.log('');
    console.log('   HTTP API 接口:');
    console.log(`   GET http://${config.httpHost}:${config.httpPort}/health`);
    console.log('       - 健康检查');
    console.log('');
    console.log(`   GET http://${config.httpHost}:${config.httpPort}/api/v1/sessions`);
    console.log('       - 获取会话列表');
    console.log('       - 参数: keyword, limit');
    console.log('');
    console.log(`   GET http://${config.httpHost}:${config.httpPort}/api/v1/messages`);
    console.log('       - 获取消息列表');
    console.log('       - 参数: talker(必填), limit, offset, start, end, chatlab');
    console.log('');
    console.log(`   GET http://${config.httpHost}:${config.httpPort}/api/v1/contacts`);
    console.log('       - 获取联系人列表');
    console.log('       - 参数: keyword, limit');
    console.log('');
    console.log('   WebSocket 接口:');
    console.log(`   ws://${config.wsHost}:${config.wsPort}`);
    console.log('       - 连接后发送 { "type": "subscribe_all" } 订阅所有会话更新');
    console.log('       - 或发送 { "type": "subscribe", "sessions": ["wxid_xxx"] } 订阅特定会话');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('按 Ctrl+C 停止服务');
    console.log('');

    // 优雅关闭
    const shutdown = async () => {
        console.log('');
        console.log('正在关闭服务...');
        await wsService.stop();
        await httpService.stop();
        wcdb.shutdown();
        console.log('👋 服务已停止');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // 保持进程运行
    await new Promise(() => { });
}

main().catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
});
