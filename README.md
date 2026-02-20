# WeFlow API CLI

微信聊天记录 HTTP API 和 WebSocket 实时推送服务。

这是 [WeFlow](https://github.com/hicccc77/WeFlow) 项目的 CLI 版本，去除了所有 UI 前端，只保留后端 API 查询接口和 WebSocket 增量推送功能。

## 功能特性

- **HTTP API**: 提供 REST 接口查询会话、消息、联系人
- **WebSocket**: 实时推送数据库变更和新消息通知
- **ChatLab 格式**: 支持标准化的 ChatLab 格式输出
- **独立运行**: 可在终端直接运行，无需 Electron

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

复制 `.env.example` 为 `.env` 并填写配置：

```bash
cp .env.example .env
```

配置项说明：

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `DB_PATH` | 微信数据目录路径 | `C:\Users\xxx\Documents\xwechat_files` |
| `DECRYPT_KEY` | 解密密钥（64位十六进制） | `abc123...` |
| `MY_WXID` | 微信ID | `wxid_xxxxxx` |
| `HTTP_PORT` | HTTP API 端口 | `5031` |
| `HTTP_HOST` | HTTP 监听地址 | `127.0.0.1` |
| `WS_PORT` | WebSocket 端口 | `5032` |
| `WS_HOST` | WebSocket 监听地址 | `127.0.0.1` |

### 3. 运行

开发模式：
```bash
npm run dev
```

生产模式：
```bash
npm run build
npm start
```

## API 文档

### HTTP API

#### 健康检查

```
GET /health
GET /api/v1/health
```

响应：
```json
{ "status": "ok" }
```

#### 获取会话列表

```
GET /api/v1/sessions?keyword=xxx&limit=100
```

参数：
- `keyword`: 搜索关键词（可选）
- `limit`: 返回数量限制，默认 100（可选）

#### 获取消息列表

```
GET /api/v1/messages?talker=wxid_xxx&limit=100&offset=0&chatlab=1
```

参数：
- `talker`: 会话ID（必填）
- `limit`: 返回数量限制，默认 100（可选）
- `offset`: 偏移量，用于分页，默认 0（可选）
- `start`: 开始时间，格式 YYYYMMDD（可选）
- `end`: 结束时间，格式 YYYYMMDD（可选）
- `chatlab`: 设为 `1` 则输出 ChatLab 格式（可选）

#### 获取联系人列表

```
GET /api/v1/contacts?keyword=xxx&limit=100
```

参数：
- `keyword`: 搜索关键词（可选）
- `limit`: 返回数量限制，默认 100（可选）

### WebSocket API

连接地址：`ws://127.0.0.1:5032`

#### 订阅所有会话更新

```json
{ "type": "subscribe_all" }
```

#### 订阅特定会话

```json
{ "type": "subscribe", "sessions": ["wxid_xxx", "xxx@chatroom"] }
```

#### 取消订阅

```json
{ "type": "unsubscribe", "sessions": ["wxid_xxx"] }
```

#### 心跳检测

```json
{ "type": "ping" }
```

响应：
```json
{ "type": "pong", "timestamp": 1234567890 }
```

#### 查询状态

```json
{ "type": "status" }
```

#### 服务端推送消息类型

1. **连接成功**
```json
{
  "type": "connected",
  "clientId": "client_1",
  "message": "Welcome to WeFlow WebSocket API",
  "timestamp": 1234567890
}
```

2. **订阅确认**
```json
{
  "type": "subscribed",
  "sessions": ["wxid_xxx", "xxx@chatroom"],
  "timestamp": 1234567890
}
```

3. **取消订阅确认**
```json
{
  "type": "unsubscribed",
  "sessions": [],
  "timestamp": 1234567890
}
```

4. **新消息通知** (与 ChatLab 格式一致)
```json
{
  "type": "new_message",
  "sessionId": "50429588654@chatroom",
  "message": {
    "sender": "wxid_xxx",
    "timestamp": 1771600187,
    "type": 25,
    "content": "消息内容",
    "platformMessageId": "6983520519095609000"
  },
  "timestamp": 1234567890
}
```

消息字段说明：
- `sender`: 发送者微信ID
- `timestamp`: 消息时间戳（秒）
- `type`: 消息类型（ChatLab 标准类型）
  - `0`: 文本
  - `1`: 图片
  - `2`: 语音
  - `3`: 视频
  - `4`: 文件
  - `5`: 表情
  - `7`: 链接
  - `8`: 位置
  - `20`: 红包
  - `21`: 转账
  - `22`: 拍一拍
  - `23`: 通话
  - `24`: 分享
  - `25`: 引用
  - `26`: 聊天记录
  - `27`: 名片
  - `80`: 系统消息
  - `81`: 撤回消息
  - `99`: 其他
- `content`: 消息内容（已解析的纯文本）
- `platformMessageId`: 平台消息ID

## 目录结构

```
weflow-api-cli/
├── src/
│   ├── index.ts        # 主入口
│   ├── config.ts       # 配置服务
│   ├── wcdbCore.ts     # WCDB 数据库服务
│   ├── httpService.ts  # HTTP API 服务
│   └── wsService.ts    # WebSocket 服务
├── resources/          # DLL 文件目录
│   ├── wcdb_api.dll
│   ├── WCDB.dll
│   ├── SDL2.dll
│   └── ...
├── .env                # 配置文件
├── .env.example        # 配置示例
├── package.json
├── tsconfig.json
└── README.md
```

## 注意事项

1. 仅支持 Windows 系统
2. 需要 Node.js 18.0.0 或更高版本
3. 需要微信 4.0 及以上版本的数据库
4. API 默认仅监听本地地址 `127.0.0.1`，不对外网开放

## 使用示例

### Python

```python
import requests

BASE_URL = "http://127.0.0.1:5031"

# 获取会话列表
sessions = requests.get(f"{BASE_URL}/api/v1/sessions").json()
print(sessions)

# 获取消息
messages = requests.get(f"{BASE_URL}/api/v1/messages", params={
    "talker": "wxid_xxx",
    "limit": 100,
    "chatlab": 1
}).json()
print(messages)
```

### JavaScript

```javascript
// HTTP API
const sessions = await fetch('http://127.0.0.1:5031/api/v1/sessions').then(r => r.json());
console.log(sessions);

// WebSocket
const ws = new WebSocket('ws://127.0.0.1:5032');
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe_all' }));
};
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('收到消息:', data);
};
```

## 致谢

- [WeFlow](https://github.com/hicccc77/WeFlow) - 原项目

## 许可证

本项目遵循原 WeFlow 项目的许可证。
