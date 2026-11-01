# CodeSync

A browser-based collaborative code editor with sandboxed execution, chat, version history, AI code
review and an online judge. Final-year B.Tech CSE major project.

**Do not run untrusted code with this yet.** The sandbox attack suite has not been run. See
[the security report](docs/security/report.md) for what is proven and what is not.

## Architecture

```text
Browser (React, Monaco, Yjs)
   │ HTTPS and WebSocket
Nginx ──── static web app
   ├── /api ─────► API (Fastify, Prisma) ───────┐
   └── /collab ──► Collab server (Yjs) ─────────┤
                                                ├── PostgreSQL 16: rooms, users, snapshots
                                                └── Redis 7: update log, pub/sub, locks, queues
                                                        │ BullMQ
Separate host:  Executor workers (Python) ──────────────┘
                   └── gVisor sandboxes
```

- Every project is one Yjs document. Edits merge without a central lock, and the server checks each
  update after applying it, because clients are not trusted.
- The API and collab server share the document through Redis, and PostgreSQL holds compacted state.
- Executor workers pull jobs from Redis and report to the API. They run on their own machine so that
  a sandbox escape does not reach the database.

| Topic | Document |
| --- | --- |
| Collaboration | [collab.md](docs/architecture/collab.md) |
| Authentication | [auth.md](docs/architecture/auth.md) |
| REST API | [rest-api.md](docs/architecture/rest-api.md) |
| Execution queue | [execution-queue.md](docs/architecture/execution-queue.md) |
| AI review | [ai-review.md](docs/architecture/ai-review.md) |
| Version history | [version-history.md](docs/architecture/version-history.md) |
| Security | [report.md](docs/security/report.md) |
| Load tests | [loadtest/README.md](loadtest/README.md), [results](loadtest/results/REPORT.md) |
| Paper outline | [ieee-outline.md](docs/paper/ieee-outline.md) |
| Run, test and trade-offs per feature | [viva-guide.md](docs/viva-guide.md) |

## Setup in 10 commands

Requires Node.js 22.12 or later, Docker, Python 3.12 and Corepack. These commands use a POSIX shell.

```sh
corepack enable
pnpm install
docker compose -f infra/compose/docker-compose.dev.yml up -d
cp apps/api/.env.example apps/api/.env
cp apps/collab/.env.example apps/collab/.env
DATABASE_URL=postgresql://codesync:codesync@localhost:5432/codesync pnpm --filter @codesync/db migrate:deploy
pnpm build
pnpm --filter @codesync/api dev
pnpm --filter @codesync/collab dev
pnpm --filter @codesync/web dev
```

Before the last three, which each need their own terminal, fill in the secrets in both `.env` files
and use the same `COLLAB_TOKEN_SECRET` in each. Then open <http://localhost:5173>. Verification email
lands in Mailpit at <http://localhost:8025>.

To run code, build the sandbox images and start a worker. See
[the executor README](services/executor/README.md). This needs Docker.

## Tests

```sh
pnpm lint
pnpm typecheck
pnpm test                          # API, collab and web. PostgreSQL is embedded
pnpm --filter @codesync/web test:e2e
E2E_PRODUCTION=1 pnpm --filter @codesync/web test:e2e -- e2e/workspace.spec.ts   # production bundle
cd services/executor && .venv/bin/pytest -m "not docker and not redis"
```

## Deployment

1. Copy `.env.prod.example` to `.env.prod` and fill it in.
2. On the application host:
   `docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d`
3. On a separate executor host with Docker and gVisor:
   `docker compose -f infra/compose/docker-compose.executor.yml up -d`

Never run sandboxes on the same machine as the database. Grafana listens on `127.0.0.1:3001` of the
application host, so reach it through an SSH tunnel.

## Environment variables

| Variable | Used by | Required | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | API, collab | Yes | PostgreSQL connection |
| `REDIS_URL` | API, collab, executor | Yes | Redis connection |
| `PORT` | API, collab | No | 3000 and 4000 by default |
| `ACCESS_TOKEN_SECRET` | API | Yes | Signs access tokens, 32 characters or more |
| `COLLAB_TOKEN_SECRET` | API, collab | Yes | Signs collab tokens, same value in both |
| `INVITE_TOKEN_SECRET` | API | Yes | Signs invite links |
| `OAUTH_STATE_SECRET` | API | Yes | Signs the OAuth state cookie |
| `INTERNAL_SERVICE_TOKEN` | API, executor | Yes | Authenticates worker callbacks |
| `PUBLIC_WEB_URL` | API | Yes | Base of links in email, and the allowed origin |
| `PUBLIC_API_URL` | API | Yes | Base of OAuth callbacks |
| `SMTP_URL`, `MAIL_FROM` | API | Yes | Outgoing mail |
| `COOKIE_SECURE` | API | Yes in production | `false` only for local http |
| `TRUST_PROXY_HOPS` | API | Yes behind a proxy | 1 behind Nginx, otherwise 0 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | API | No | GitHub sign-in |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | API | No | Google sign-in |
| `ALLOWED_ORIGINS` | Collab | Yes | Comma-separated origins allowed to open sockets |
| `LOG_LEVEL` | API, collab | No | `info` by default |
| `API_URL` | Executor | Yes | Where workers report results |
| `ANTHROPIC_API_KEY` | Executor | No | Without it, reviews use static analyzers only |
| `EXECUTOR_SLOTS`, `EXECUTOR_RESERVED_FOR_RUN` | Executor | No | Sandboxes at once, and those kept for runs |
| `SANDBOX_RUNTIME` | Executor | No | `runsc` by default |
| `SANDBOX_REQUIRE_GVISOR` | Executor | Yes in production | `true` refuses to start without gVisor |
| `SANDBOX_POOL_SIZE` | Executor | No | Warm containers |
| `METRICS_HOST`, `METRICS_PORT` | Executor | No | Prometheus endpoint |

`VITE_API_TARGET` and `VITE_COLLAB_TARGET` point the web dev server at other backends.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The badge stays on Reconnecting | The collab server is down, or `ALLOWED_ORIGINS` does not include the page's origin |
| Signed out on every reload over plain http | `COOKIE_SECURE` must be `false` for local http |
| Sign-in refused with a 403 | `PUBLIC_WEB_URL` must match the page's origin exactly |
| "You no longer have access" | The socket closed with 4403 because the user was removed or the room deleted |
| Editors see different text after deploying | Two copies of Yjs were bundled. Keep `dedupe` in `vite.config.ts` |
| Vite runs out of memory | Keep `monaco-editor` in `optimizeDeps.exclude` |
| Vim or Emacs keys do nothing | Keep the `monaco-vim` and `monaco-emacs` aliases in `vite.config.ts` |
| Runs stay queued | No worker is running, or it cannot reach Redis. Check `codesync_workers_active` |
| The worker refuses to start | `SANDBOX_REQUIRE_GVISOR=true` and `runsc` is not installed |
| Port 4200 or 54330 in use during browser tests | An earlier test stack is still running. Stop it, or wait for it to exit |
| Tests fail to start on Node 20 | Vitest needs Node 22.12 or later |
