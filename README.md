# ai-service

企业微信 AI 客服核心服务。系统只保留一个 Expert 回答模型，并使用
FAISS + SQLite FTS5 混合检索、RRF 融合、父子分块、证据闸门和引用校验
组成完整 RAG 链路。

## 核心能力

- 单 Expert 回答链路，不存在 normal/expert 模式切换或第二个回答模型
- 企业微信普通应用回调与专区回调
- 回调时间戳校验、重放保护、Token 刷新和日志脱敏
- 企业微信聊天记录持久化、幂等同步和无损并发 flush
- PDF、DOCX、Markdown、TXT 文档上传和管理
- FAISS 稠密检索与 SQLite FTS5 稀疏检索并行执行
- RRF 融合、可选 reranker、父块展开、上下文预算和文档多样性控制
- 弱证据拒答和引用 ID 校验
- Redis 会话顺序锁、版本化检索缓存和原子索引 generation
- 健康检查、离线 RAG 评测、GitHub Actions 和非 root Docker 镜像

## RAG 流程

```text
文档 -> 结构化父子分块 -> SQLite 权威存储
                         |-> FTS5 BM25
                         |-> FAISS dense

问题 -> dense + sparse -> RRF -> optional rerank
     -> parent expansion -> context packing -> evidence gate
     -> single Expert generation -> citation validation
```

SQLite 保存文档、版本、块、标签、索引 generation 和 tombstone。FAISS 与
FTS5 是可重建索引；Redis 只保存会话、锁、重放记录和缓存。

## 环境要求

- Node.js 22
- npm 10
- Redis
- 支持 FTS5/trigram 的 SQLite
- FAISS 原生依赖

Linux 构建 FAISS 通常需要：

```bash
sudo apt-get install build-essential cmake libopenblas-dev
```

## 快速开始

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

## Web 入口

启动后打开 `/`。聊天界面包含知识库入口，可执行：

- 上传 PDF、DOCX、Markdown、TXT
- 设置 category 和 tags
- 查看文档及索引状态
- 删除文档
- 重建或清空知识库

管理操作通过 `x-admin-key` 鉴权；浏览器只在当前会话内保存操作员输入的 key。

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

`/knowledge-base/retrieve` 只检索，不调用 Expert。`/knowledge-base/answer`
返回回答、引用、拒答状态、活动 generation 和耗时。

受保护接口需要：

```text
x-admin-key: <ADMIN_API_KEY>
```

专区内部回调需要：

```text
x-weixin-sync-token: <WORK_WEIXIN_SYNC_TOKEN>
```

生产环境默认关闭 Swagger。确需启用时设置 `SWAGGER_ENABLED=true` 并继续使用
网关或网络层访问控制。

## 健康检查

```text
GET /health/live
GET /health/ready
```

Liveness 不依赖外部模型。Readiness 检查配置、Redis、SQLite、FTS5、数据目录
写权限和活动 FAISS generation；`/health/ready` 需要管理员鉴权。

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

## 主要目录

```text
src/rag/                 RAG 存储、索引、检索、融合、上下文和评测
src/knowledge-base/      文档管理与企业微信记录同步
src/work-weixin/         企业微信协议、回调和主动消息
src/generation/          唯一 Expert 回答客户端
src/health/              liveness/readiness
public/                  聊天与文档管理界面
evaluation/              离线评测数据
test/                    HTTP e2e
```

## 安全边界

- 外部请求不能指定上游 API key、provider URL 或模型
- 管理、同步、主动发送和破坏性路由默认拒绝未鉴权访问
- 上传限制为 25 MiB，并校验扩展名和 MIME 类型
- 回调签名、时间戳和重放 ID 在触发 AI 或副作用前校验
- 日志不输出 Token、API Key、完整消息或解密载荷
- SQLite 查询使用参数绑定，文件名经过规范化
