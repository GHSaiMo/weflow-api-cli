# WeFlow WebSocket Tester

一个用于测试 [weflow-api-cli](https://github.com/GHSaiMo/weflow-api-cli) 项目 WebSocket 连接的前端测试工具。

## 📋 项目简介

这是一个纯静态的 Web 应用，无需构建工具或后端服务，可以直接在浏览器中运行。主要用于：

- 🔌 测试 WebSocket 连接状态
- 📡 订阅全部会话消息更新
- 🎯 订阅指定会话的消息
- 📨 实时查看消息流
- 🏓 发送 Ping/Pong 心跳检测
- 📊 查看连接状态信息

## 📁 项目结构

```
weflow-ws/
├── index.html      # 主页面（入口文件）
├── styles.css      # 样式文件
├── app.js          # JavaScript 业务逻辑
└── README.md       # 说明文档
```

## 🚀 运行方式

### 方式一：直接打开（推荐）

由于这是纯静态项目，最简单的方式就是直接用浏览器打开 `index.html` 文件：

1. 在文件资源管理器中找到 `index.html`
2. 双击打开，或右键选择"用浏览器打开"

### 方式二：使用本地服务器（可选）

如果你需要模拟更真实的 HTTP 环境，可以使用任意本地服务器：

#### 使用 VS Code Live Server 插件

1. 在 VS Code 中安装 **Live Server** 插件
2. 右键点击 `index.html`，选择 **"Open with Live Server"**

#### 使用 Python HTTP Server

```bash
# Python 3
cd D:\Documents\weflow-ws
python -m http.server 8000

# 然后访问 http://localhost:8000
```

#### 使用 Node.js serve

```bash
# 安装 serve（如果未安装）
npm install -g serve

# 启动服务
cd D:\Documents\weflow-ws
serve .

# 然后访问 http://localhost:3000
```

#### 使用 Node.js http-server

```bash
# 安装 http-server（如果未安装）
npm install -g http-server

# 启动服务
cd D:\Documents\weflow-ws
http-server

# 然后访问 http://localhost:8080
```

## 🔧 使用说明

### 1. 连接 WebSocket

- 默认 WebSocket 地址为 `ws://127.0.0.1:5032`
- 确保 **weflow-api-cli** 后端服务已启动
- 点击 **"连接"** 按钮建立 WebSocket 连接
- 连接成功后状态指示器会变为绿色

### 2. 订阅消息

**全部订阅模式：**
- 切换到 **"全部订阅"** 标签页
- 点击 **"订阅全部更新"** 按钮
- 将接收所有会话的消息更新

**指定会话模式：**
- 切换到 **"指定会话"** 标签页
- 输入会话 ID，支持以下格式：
  - JSON 数组：`["wxid_xxx", "wxid_yyy"]`
  - 逗号分隔：`wxid_xxx, wxid_yyy`
  - 单个 ID：`wxid_xxx`
- 点击 **"订阅会话"** 按钮

### 3. 查看消息

- 消息会实时显示在消息流区域
- 不同类型的消息有不同的颜色标识
- 点击 **"清空消息"** 可以清除当前消息列表

### 4. 快捷操作

- 🏓 **Ping**：发送心跳检测
- 📋 **获取状态**：查询服务器连接状态

## 📝 消息类型说明

| 类型 | 说明 |
|------|------|
| `connected` | 连接成功通知 |
| `subscribed` | 订阅成功确认 |
| `unsubscribed` | 取消订阅确认 |
| `pong` | 心跳响应 |
| `status` | 状态信息 |
| `new_message` | 新消息通知 |
| `db_change` | 数据库变更通知 |
| `error` | 错误信息 |

## ⚠️ 前置条件

在使用本测试工具之前，请确保：

1. **weflow-api-cli** 服务已启动并运行在 `ws://127.0.0.1:5032`
2. 如使用其他端口或地址，请在连接设置中修改

## 🛠️ 技术栈

- **HTML5** - 页面结构
- **CSS3** - 样式（含玻璃态设计）
- **JavaScript (ES6+)** - 业务逻辑
- **Google Fonts (Inter)** - 字体

## 📄 许可证

本项目仅用于测试和开发用途。
