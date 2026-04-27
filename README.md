# 企业微信AI客服核心服务

基于 NestJS 的企业微信 AI 客服系统，支持普通应用消息和专区 SDK 两种模式。

## 目录

- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [API 接口](#api-接口)
- [与专区程序的协作](#与专区程序的协作)
- [技术栈](#技术栈)

---

## 系统架构

```
┌──────────────────────────────────────────────────────┐
│                   企业微信服务器                       │
└───────────┬──────────────────────┬───────────────────┘
            │                      │
            │ 普通应用消息          │ 专区调用
            ↓                      ↓
┌───────────────────┐   ┌─────────────────────────────┐
│   ai-service      │   │  专区程序                     │
│   (本服务器)       │   │  运行在企业微信专区容器内     │
│                   │   │  端口 8080                   │
│  端口 3031/3032   │   │  demoloadsdk.py + SDK (.so)  │
│                   │   └──────────┬──────────────────┘
│  /work-weixin/*   │              │
│  /spec-callback/* │←─────────────┘
│  /knowledge-base/*│   HTTP 转发解密后的数据
│  /api (Swagger)   │
└───────────────────┘
```

两种消息处理模式：

| 特性 | 普通应用模式 | 专区模式 |
|------|------------|---------|
| 入口 | /work-weixin/callback | 专区程序 → /spec-callback/* |
| 加解密 | Node.js crypto (AES-256-CBC) | 专区程序 SDK 处理 |
| 消息格式 | XML | JSON |
| 端口 | 3031/3032 | 专区 8080 → 转发到 3031 |

---

## 项目结构

```
ai-service/
├── src/
│   ├── main.ts                                # 主服务入口 (HTTP 3031 / HTTPS 3032)
│   ├── app.module.ts                          # 应用主模块
│   ├── ai-service/
│   │   ├── ai.module.ts
│   │   └── ai.service.ts                     # DeepSeek AI 集成 + 知识库 RAG
│   ├── config/
│   │   ├── prompt.ts                         # HR 专家 Prompt
│   │   └── promptTemplate.ts                 # LangChain 模板
│   ├── work-weixin/
│   │   ├── work-weixin.module.ts
│   │   ├── work-weixin.controller.ts         # 普通应用消息回调
│   │   ├── work-weixin.service.ts            # 消息加解密 + AI 处理
│   │   ├── wework-spec-callback.controller.ts # 接收专区程序转发数据
│   │   └── wework-spec-callback.service.ts   # 专区事件处理 + AI 查询
│   └── knowledge-base/
│       ├── knowledge-base.module.ts
│       ├── knowledge-base.controller.ts      # 知识库 CRUD
│       ├── knowledge-base.service.ts         # Faiss 向量存储
│       ├── weixin-sync.controller.ts         # 聊天记录同步 API
│       └── weixin-sync.service.ts            # 自动同步 + 定期重建
├── data/
│   ├── vectorstore/                          # Faiss 向量索引
│   └── weixin-sync/                          # 聊天记录同步文件
├── .env                                      # 环境变量
├── package.json
├── start.bat / start.sh                      # 一键启动
└── server.key / server.crt                   # HTTPS 证书
```

---

## 前置条件

- Node.js >= 18
- npm >= 9

---

## 快速开始

### 安装

```bash
cd ai-service
npm install
```

### 配置 .env

复制示例文件并填入真实值：

```bash
cp .env.example .env
```

```bash
# 服务端口
PORT=3031
HTTPS_PORT=3032

# DeepSeek AI
DEEPSEEK_API_KEY=sk-xxx
OPENAI_API_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat

# 企业微信
WORK_WEIXIN_ENABLED=true
WORK_WEIXIN_CORP_ID=wwXXX
WORK_WEIXIN_CORP_SECRET=xxx
WORK_WEIXIN_AGENT_ID=1000002
WORK_WEIXIN_TOKEN=xxx
WORK_WEIXIN_ENCODING_AES_KEY=xxx

# 专区配置（可选）
WORK_WEIXIN_ABILITY_ID=
WORK_WEIXIN_SYNC_TOKEN=

# HR 专家模式
HR_EXPERT_MODE=true
KNOWLEDGE_BASE_AUTO_SYNC=true
```

### 启动

```bash
# 开发模式
npm run start:dev

# 生产模式
npm run build && npm run start:prod

# 一键启动
start.bat        # Windows
./start.sh       # Linux
```

---

## API 接口

### 企业微信普通应用

```
GET  /work-weixin/callback        # 回调 URL 验证
POST /work-weixin/callback        # 接收消息
POST /work-weixin/send            # 主动发送消息
GET  /work-weixin/status          # 服务状态
POST /work-weixin/refresh-token   # 刷新 Token
```

### 专区程序回调接收

```
POST /spec-callback/wework-call   # 接收专区程序转发的 wework_call 数据
POST /spec-callback/ai-query      # 接收专区程序转发的 AI 查询
GET  /spec-callback/health        # 健康检查
```

### 知识库管理

```
POST   /knowledge-base/add        # 上传文档
POST   /knowledge-base/search     # RAG 检索
GET    /knowledge-base/stats      # 统计信息
GET    /knowledge-base/documents   # 文档列表
DELETE /knowledge-base/document    # 删除文档
DELETE /knowledge-base/clear       # 清空知识库
POST   /knowledge-base/rebuild     # 重建索引
```

### 聊天记录同步

```
POST   /weixin-knowledge-sync/start                # 启动自动同步
POST   /weixin-knowledge-sync/stop                 # 停止同步
POST   /weixin-knowledge-sync/sync-now             # 立即同步
POST   /weixin-knowledge-sync/update-knowledge-base # 手动更新知识库
GET    /weixin-knowledge-sync/status               # 同步状态
DELETE /weixin-knowledge-sync/clear-cache           # 清空缓存
```

Swagger 文档：启动后访问 `/api` 端点

---

## 与专区程序的协作

### 专区程序位置

专区程序目录 `python_demo_src_2.1.1/`

专区程序是独立的 Python 应用，上传到企业微信专区容器运行。它通过 `wwspecapisdk.so` 处理所有 SDK 协议级操作。

### 启动专区程序

```bash
# 在专区容器内
./start.sh --ai_service_url http://your-server:3031

# 调试模式
./start.sh 1 {debug_token} {access_token} --ai_service_url http://your-server:3031
```

### 交互流程

**wework_call（企业微信推送事件到专区程序）：**

```
企业微信 → 专区程序 wework_call
  → SDK 解密数据
  → 保存到本地文件
  → 异步转发解密数据到 ai-service POST /spec-callback/wework-call
  → spec_notify_app 通知应用后台
```

**corp_call func=ai_query（AI 查询）：**

```
企业微信 → 专区程序 corp_call func=ai_query
  → 转发到 ai-service POST /spec-callback/ai-query
  → ai-service 调用 DeepSeek + 知识库 RAG
  → 返回 AI 回复
  → 专区程序返回给企业微信
```

**corp_call 其他 func（SDK 原生能力）：**

```
企业微信 → 专区程序 corp_call func=sync_msg/search_chat/...
  → 专区程序直接调用 SDK 处理
  → 返回结果
```

---

## 技术栈

- NestJS 10 — 后端框架
- LangChain + DeepSeek — AI 对话 + RAG
- Faiss — 向量相似度搜索
- Node.js crypto — 企业微信消息加解密
- 企业微信专区 SDK (wwspecapisdk.so) — 专区协议处理（在专区程序中使用）
