# ai-service

**企业微信 AI 客户服务核心——基于 FAISS + SQLite FTS5 的单一 Expert 混合 RAG。**

基于 NestJS 的后端服务，将知识库转化为可回答问题的答案引擎：文档被摄入到
FAISS（稠密）+ SQLite FTS5（稀疏）混合检索栈中，通过 RRF 融合，并在证据闸门
与引用校验后路由到唯一的 Expert 回答模型。服务接入企业微信（普通应用回调与
专区回调）、持久化聊天记录，并提供聊天与管理 Web 界面。

[English README](README.md)

## 核心能力

- 单一 Expert 回答链路，不存在 normal/expert 模式切换或第二个回答模型
- 企业微信普通应用回调与专区回调
- 回调时间戳校验、重放保护、Token 刷新和日志脱敏
- 企业微信聊天记录持久化、幂等同步和无损并发 flush
- PDF、DOCX、Markdown、TXT 文档上传和管理
- FAISS 稠密检索与 SQLite FTS5 稀疏检索并行执行
- RRF 融合、可选 reranker、父块展开、上下文预算和文档多样性控制
- 弱证据拒答和引用 ID 校验
- Redis 会话顺序锁、版本化检索缓存和原子索引 generation
- 健康检查、离线 RAG 评测、GitHub Actions 和非 root Docker 镜像

## 快速开始

**环境要求**

- Node.js 22、npm 10
- Redis
- 支持 FTS5/trigram 的 SQLite
- FAISS 原生依赖

Linux 上构建 FAISS 通常需要：

```bash
sudo apt-get install build-essential cmake libopenblas-dev
```

**安装与启动**

```bash
npm ci
cp .env.example .env
npm run start:dev
```

至少配置：

```bash
REDIS_URL=redis://localhost:6379
EXPERT_API_KEY=replace-me
EXPERT_API_BASE_URL=https://api.example.com/v1
EXPERT_MODEL=your-expert-model
EMBEDDING_API_KEY=replace-me
EMBEDDING_API_BASE_URL=https://api.example.com/v1
EMBEDDING_MODEL=text-embedding-v3
```

生产环境还必须设置 `ADMIN_API_KEY`。不要把 `.env`、Token、API Key 或企业
微信密钥提交到 Git。

生产部署：

```bash
npm run build
npm run start:prod   # node dist/main.js
```

## 常用命令

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run eval:rag
node scripts/native-smoke.js
```

`npm run eval:rag` 使用 `evaluation/rag-eval.jsonl` 做确定性离线评测，不访问
模型、Embedding、Redis 或网络。

## Docker

```bash
docker build -t ai-service .
docker run --rm -p 3031:3031 \
  --env-file .env \
  -v ai-service-data:/app/data \
  -v ai-service-uploads:/app/uploads \
  ai-service
```

运行镜像使用非 root `node` 用户，并通过 `tini` 处理信号。

## 配置

主要环境变量（完整列表见 [.env.example](.env.example)）：

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口（默认 `3031`） |
| `ADMIN_API_KEY` | 生产环境必需；保护管理与破坏性路由 |
| `REDIS_URL` | Redis 连接字符串 |
| `EXPERT_API_KEY` / `EXPERT_API_BASE_URL` / `EXPERT_MODEL` | 唯一 Expert 回答模型 |
| `EMBEDDING_API_KEY` / `EMBEDDING_API_BASE_URL` / `EMBEDDING_MODEL` | 检索 Embedding 模型 |
| `WORK_WEIXIN_*` | 企业微信应用与专区回调配置 |
| `SWAGGER_ENABLED` | 启用 Swagger（生产默认关闭） |

## Web 入口

启动后打开 `/`。聊天界面包含知识库入口，可上传 PDF/DOCX/Markdown/TXT、设置
category 和 tags、查看文档及索引状态、删除文档、重建或清空知识库。管理操作
通过 `x-admin-key` 鉴权；浏览器只在当前会话内保存操作员输入的 key。

## API

公开接口：

```text
POST /chat
GET  /health
GET  /health/live
GET  /health/liveness
GET  /work-weixin/callback
POST /work-weixin/callback
```

RAG 与知识库管理接口：

```text
POST   /knowledge-base/retrieve
POST   /knowledge-base/answer
POST   /knowledge-base/search
POST   /knowledge-base/add
GET    /knowledge-base/stats
GET    /knowledge-base/documents
DELETE /knowledge-base/document
DELETE /knowledge-base/clear
POST   /knowledge-base/rebuild
```

- `/knowledge-base/retrieve` 只检索，不调用 Expert 模型。
- `/knowledge-base/answer` 返回回答、引用、拒答状态、活动 generation 和耗时。
- 受保护路由需要 `x-admin-key: <ADMIN_API_KEY>`。
- 专区内部回调需要 `x-weixin-sync-token: <WORK_WEIXIN_SYNC_TOKEN>`。

健康检查：

```text
GET /health/live
GET /health/ready
```

Liveness 不依赖外部模型。Readiness 检查配置、Redis、SQLite、FTS5、数据目录
写权限和活动 FAISS generation；`/health/ready` 需要管理员鉴权。

## 项目结构

```text
src/rag/                 RAG 存储、索引、检索、融合、上下文和评测
src/knowledge-base/      文档管理与企业微信记录同步
src/work-weixin/         企业微信协议、回调和主动消息
src/generation/          唯一 Expert 回答客户端
src/health/              liveness / readiness
src/chat/                聊天端点
src/common/security/     管理员与内部回调守卫
public/                  聊天与文档管理界面
evaluation/              离线评测数据
test/                    HTTP e2e
```

## 许可证

MIT License — 见 [LICENSE](LICENSE)。
