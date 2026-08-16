# ai-service

**WeChat Work AI customer-service core — single-Expert hybrid RAG with FAISS + SQLite FTS5.**

NestJS backend that turns a knowledge base into an answer engine: documents are
ingested into a hybrid FAISS (dense) + SQLite FTS5 (sparse) retrieval stack,
fused with RRF and routed to a single Expert answer model through an evidence
gate and citation validation. It plugs into WeChat Work (corporate app callbacks
and zone callbacks), persists chat records, and ships a chat/admin web UI.

[中文版 README](README.zh-CN.md)

## Features

- Single Expert answer pipeline — no normal/expert mode switching or second model
- WeChat Work corporate-app and zone callback handling
- Callback timestamp validation, replay protection, token refresh, log redaction
- Persistent, idempotent chat-record sync with lossless concurrent flush
- PDF, DOCX, Markdown, and TXT document upload and management
- Parallel FAISS dense + SQLite FTS5 sparse retrieval
- RRF fusion, optional reranker, parent-block expansion, context budget, document diversity control
- Weak-evidence refusal and citation-ID validation
- Redis session order lock, versioned retrieval cache, atomic index generation
- Health checks, offline RAG evaluation, GitHub Actions, non-root Docker image

## Quick Start

**Prerequisites**

- Node.js 22, npm 10
- Redis
- SQLite with FTS5/trigram support
- FAISS native dependencies

On Linux, building FAISS usually needs:

```bash
sudo apt-get install build-essential cmake libopenblas-dev
```

**Install & run**

```bash
npm ci
cp .env.example .env
npm run start:dev
```

At minimum configure:

```bash
REDIS_URL=redis://localhost:6379
EXPERT_API_KEY=replace-me
EXPERT_API_BASE_URL=https://api.example.com/v1
EXPERT_MODEL=your-expert-model
EMBEDDING_API_KEY=replace-me
EMBEDDING_API_BASE_URL=https://api.example.com/v1
EMBEDDING_MODEL=text-embedding-v3
```

`ADMIN_API_KEY` is also required in production. Never commit `.env`, Tokens,
API keys, or WeChat secrets to Git.

For production:

```bash
npm run build
npm run start:prod   # node dist/main.js
```

## Common Commands

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run eval:rag
node scripts/native-smoke.js
```

`npm run eval:rag` uses `evaluation/rag-eval.jsonl` for deterministic offline
evaluation and does not call any model, embedding service, Redis, or the network.

## Docker

```bash
docker build -t ai-service .
docker run --rm -p 3031:3031 \
  --env-file .env \
  -v ai-service-data:/app/data \
  -v ai-service-uploads:/app/uploads \
  ai-service
```

The runtime image runs as the non-root `node` user and uses `tini` for signals.

## Configuration

Key environment variables (full list in [.env.example](.env.example)):

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port (default `3031`) |
| `ADMIN_API_KEY` | Required in production; protects admin and destructive routes |
| `REDIS_URL` | Redis connection string |
| `EXPERT_API_KEY` / `EXPERT_API_BASE_URL` / `EXPERT_MODEL` | Single Expert answer model |
| `EMBEDDING_API_KEY` / `EMBEDDING_API_BASE_URL` / `EMBEDDING_MODEL` | Retrieval embedding model |
| `WORK_WEIXIN_*` | WeChat Work app and zone callback configuration |
| `SWAGGER_ENABLED` | Enable Swagger (default off in production) |

## Web UI

Open `/` after startup. The chat view includes a knowledge-base console that can
upload PDF/DOCX/Markdown/TXT, set category and tags, view document/index status,
delete documents, and rebuild or clear the knowledge base. Admin actions are
protected by the `x-admin-key` header; the browser keeps the operator key only
for the current session.

## API

Public endpoints:

```text
POST /chat
GET  /health
GET  /health/live
GET  /health/liveness
GET  /work-weixin/callback
POST /work-weixin/callback
```

RAG and knowledge-base management:

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

- `/knowledge-base/retrieve` only retrieves — it does not call the Expert model.
- `/knowledge-base/answer` returns the answer, citations, refusal status, active generation, and latency.
- Protected routes require `x-admin-key: <ADMIN_API_KEY>`.
- Zone internal callbacks require `x-weixin-sync-token: <WORK_WEIXIN_SYNC_TOKEN>`.

Health checks:

```text
GET /health/live
GET /health/ready
```

Liveness does not depend on external models. Readiness checks configuration,
Redis, SQLite, FTS5, data-directory write access, and the active FAISS
generation; `/health/ready` requires admin auth.

## Project Structure

```text
src/rag/                 RAG storage, indexing, retrieval, fusion, context, evaluation
src/knowledge-base/      Document management & WeChat record sync
src/work-weixin/         WeChat Work protocol, callbacks, proactive messages
src/generation/          Single Expert answer client
src/health/              liveness / readiness probes
src/chat/                Chat endpoint
src/common/security/     Admin & internal-callback guards
public/                  Chat and document-management UI
evaluation/              Offline evaluation data
test/                    HTTP e2e
```

## License

MIT License — see [LICENSE](LICENSE).
