# CodeSync

A browser-based code editor where a whole room types in the same file, with live cursors, chat, version history, AI code review, sandboxed execution and an online judge.

## Overview

CodeSync lets a group edit the same project at once in the browser. Edits merge through a CRDT, so nobody waits on a lock and work typed offline syncs on reconnect. Around the editor sit room chat, comments pinned to code, a timeline of snapshots you can restore, AI review, and a judge for practice problems and contests.

The server treats every client as hostile. Each document update is checked after it is applied and repaired if it breaks a rule, viewers cannot write, and user code runs in throwaway containers on a separate machine from the database.

> The sandbox attack suite passes under runc and gVisor, but CodeSync has not been run in production yet. See the [security report](docs/security/report.md) for what is proven and what is not.

---

## Architecture Overview

```mermaid
graph TD
    subgraph "Browser"
    A[React + Monaco Editor] --> B[Yjs Document]
    end

    subgraph "Application Host"
    C[Nginx] --> D(API - Fastify + Prisma)
    C --> E(Collab Server - Yjs)
    D --> F[(PostgreSQL 16)]
    E --> F
    D --> G[(Redis 7 - Log, Pub/Sub, Locks, Queues)]
    E --> G
    end

    subgraph "Separate Executor Host"
    H{BullMQ Workers} --> I[gVisor Sandboxes]
    H --> J[Static Analyzers + Claude Review]
    end

    A -->|HTTPS| C
    B -->|WebSocket| C
    G -->|Jobs| H
    H -->|Results| D

    classDef io fill:#f9f0ff,stroke:#8a2be2,stroke-width:2px,color:#000;
    classDef core fill:#e1f5fe,stroke:#0288d1,stroke-width:2px,color:#000;
    classDef logic fill:#e8f5e9,stroke:#388e3c,stroke-width:2px,color:#000;

    class A,B,C io;
    class D,E,F,G core;
    class H,I,J logic;
```

- Every project is one Yjs document. The API and collab servers share it through Redis, and PostgreSQL holds compacted state.
- Executor workers pull jobs from Redis and report to the API. They run on their own machine, so a sandbox escape does not reach the database.

---

## Features

|                               |                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Real-Time Editing**         | Monaco with Yjs. Concurrent edits merge, and offline edits sync on reconnect                            |
| **Live Presence**             | Remote cursors and selections, online list, activity status, and follow another user across files        |
| **Workspace**                 | File tree with drag-to-move, tabs, split view, resizable panels, and light and dark themes              |
| **Rooms and Roles**           | Owner, editor and viewer roles, invite links, room locking, and templates for four languages            |
| **Room Chat**                 | Markdown, @mentions, typing indicators, unread counts, owner moderation and a profanity filter          |
| **Inline Comments**           | Threads pinned to code with Yjs relative positions, so they stay on the right line as others edit       |
| **Version History**           | Snapshots every 5 minutes and on each successful run, named checkpoints, side-by-side diff, and restore |
| **Blame View**                | Author names beside the code, from Yjs client ids                                                       |
| **Sandboxed Execution**       | Python, C++, Java and JavaScript in one-use containers, with live terminal output                       |
| **AI Code Review**            | Static analyzers plus Claude, with findings marked in the editor and one-click fixes                    |
| **Online Judge**              | Problems, verdict tables, leaderboards, contests with a freeze, and plagiarism checks                   |
| **Keyboard Friendly**         | Vim and Emacs keys, keyboard file actions, and an accessibility scan on the main pages                  |
| **Phone View**                | Read-only code and chat on small screens                                                                |
| **Monitoring**                | Prometheus metrics and a Grafana dashboard                                                              |

---

## Tech Stack

| Component        | Technology                                                                     |
| ---------------- | ------------------------------------------------------------------------------ |
| Frontend         | React 18, TypeScript, Vite, Tailwind, Zustand, React Query                     |
| Editor           | Monaco, y-monaco, xterm.js                                                     |
| Collaboration    | Node.js, Yjs, y-protocols, WebSockets                                          |
| API              | Fastify 5, Prisma 7, Zod, Argon2id, JWT with rotating refresh tokens           |
| Data             | PostgreSQL 16, Redis 7                                                         |
| Execution        | Python 3.12, Docker Engine API, gVisor, BullMQ                                 |
| AI Review        | Claude behind an abstract client, plus Ruff, ESLint, cppcheck, PMD and lizard  |
| Testing          | Vitest, Playwright, axe, Pytest, k6                                            |
| Quality and CI   | oxlint, Ruff, mypy, GitHub Actions                                             |
| Deployment       | Docker Compose, Nginx, Let's Encrypt, Prometheus, Grafana                      |

---

## Project Structure

```
CodeSync/
├── apps/
│   ├── api/              # REST API: auth, rooms, files, runs, judge, history, chat
│   ├── collab/           # WebSocket server: sync, presence, chat, snapshots
│   └── web/              # React app, with Playwright tests in e2e/
├── packages/
│   ├── collab-client/    # Browser session, presence, comment anchors
│   ├── db/               # Prisma schema, migrations, snapshot capture
│   └── shared/           # Types and limits shared across services
├── services/
│   └── executor/         # Python workers, sandbox, judge, AI review
├── infra/
│   ├── compose/          # Dev, production and executor stacks
│   ├── deploy/           # Server setup wizard
│   ├── monitoring/       # Prometheus and Grafana
│   └── nginx/            # Reverse proxy, HTTPS, security headers
├── loadtest/             # k6 scripts, local driver, results
├── docs/                 # Architecture, security, deployment, viva guide, paper outline
└── .github/workflows/    # CI and integration tests
```

---

## Setup and Installation

### Prerequisites

- Node.js 22.12+ with Corepack
- Docker
- Python 3.12, only for the executor

### Quick Start

Ten commands, in a POSIX shell. The last three each need their own terminal.

```bash
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

Before starting the servers, fill in the secrets in both `.env` files, using the same `COLLAB_TOKEN_SECRET` in each.

Open <http://localhost:5173>. Verification email lands in Mailpit at <http://localhost:8025>.

To run code, build the sandbox images and start a worker. See the [executor README](services/executor/README.md).

---

## Running the Tests

```bash
pnpm lint
pnpm typecheck
pnpm test                             # API, collab and web. PostgreSQL is embedded
pnpm --filter @codesync/web test:e2e  # Two real browsers editing together
cd services/executor && .venv/bin/pytest -m "not docker and not redis"
```

To run the workspace browser tests against the production bundle:

```bash
E2E_PRODUCTION=1 pnpm --filter @codesync/web exec playwright test e2e/workspace.spec.ts
```

---

## Load Test Results

Measured on one laptop with the load generator beside the server and an in-memory stand-in for Redis and PostgreSQL. Each row is a single run, so treat these as preliminary. Full results are in [REPORT.md](loadtest/results/REPORT.md).

| Users | Keys/s each | p50    | p95    | p99    | Delivered |
| ----- | ----------- | ------ | ------ | ------ | --------- |
| 20    | 3           | 1 ms   | 2 ms   | 3 ms   | 100%      |
| 100   | 3           | 3 ms   | 9 ms   | 13 ms  | 100%      |
| 500   | 1           | 12 ms  | 39 ms  | 71 ms  | 100%      |
| 200   | 5           | 16 ms  | 317 ms | 685 ms | 100%      |

The k6 tests have not been run yet. See [loadtest/README.md](loadtest/README.md).

---

## Deployment

The [deployment guide](docs/deployment.md) covers pushing to GitHub and going online. On an Ubuntu server, this wizard walks through every step:

```bash
sudo bash infra/deploy/setup-server.sh
```

One server runs everything except code execution, judging and AI review, which stay off until a separate executor host exists. Never run sandboxes on the same machine as the database.

| Variable                                      | Used by               | Required           | Purpose                                                    |
| --------------------------------------------- | --------------------- | ------------------ | ---------------------------------------------------------- |
| `DATABASE_URL`                                | API, collab           | Yes                | PostgreSQL connection                                      |
| `REDIS_URL`                                   | API, collab, executor | Yes                | Redis connection                                           |
| `PORT`                                        | API, collab           | No                 | 3000 and 4000 by default                                   |
| `ACCESS_TOKEN_SECRET`                         | API                   | Yes                | Signs access tokens, 32 characters or more                 |
| `COLLAB_TOKEN_SECRET`                         | API, collab           | Yes                | Signs collab tokens, same value in both                    |
| `INVITE_TOKEN_SECRET`                         | API                   | Yes                | Signs invite links                                         |
| `OAUTH_STATE_SECRET`                          | API                   | Yes                | Signs the OAuth state cookie                               |
| `INTERNAL_SERVICE_TOKEN`                      | API, executor         | Yes                | Authenticates worker callbacks                             |
| `PUBLIC_WEB_URL`                              | API                   | Yes                | Base of links in email, and the allowed origin             |
| `PUBLIC_API_URL`                              | API                   | Yes                | Base of OAuth callbacks                                    |
| `SMTP_URL`, `MAIL_FROM`                       | API                   | Yes                | Outgoing mail                                              |
| `COOKIE_SECURE`                               | API                   | Yes in production  | `false` only for local http                                |
| `TRUST_PROXY_HOPS`                            | API                   | Yes behind a proxy | 1 behind Nginx, otherwise 0                                |
| `EXECUTION_ENABLED`                           | API                   | No                 | `false` refuses runs, submissions and reviews              |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`    | API                   | No                 | GitHub sign-in                                             |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`    | API                   | No                 | Google sign-in                                             |
| `ALLOWED_ORIGINS`                             | Collab                | Yes                | Comma-separated origins allowed to open sockets            |
| `LOG_LEVEL`                                   | API, collab           | No                 | `info` by default                                          |
| `API_URL`                                     | Executor              | Yes                | Where workers report results                               |
| `ANTHROPIC_API_KEY`                           | Executor              | No                 | Without it, reviews use static analyzers only              |
| `EXECUTOR_SLOTS`, `EXECUTOR_RESERVED_FOR_RUN` | Executor              | No                 | Sandboxes at once, and those kept for runs                 |
| `SANDBOX_RUNTIME`                             | Executor              | No                 | `runsc` by default                                         |
| `SANDBOX_REQUIRE_GVISOR`                      | Executor              | Yes in production  | `true` refuses to start without gVisor                     |
| `SANDBOX_POOL_SIZE`                           | Executor              | No                 | Warm containers                                            |
| `METRICS_HOST`, `METRICS_PORT`                | Executor              | No                 | Prometheus endpoint                                        |

`VITE_API_TARGET` and `VITE_COLLAB_TARGET` point the web dev server at other backends.

---

## Troubleshooting

| Symptom                                    | Cause and fix                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| The badge stays on Reconnecting            | The collab server is down, or `ALLOWED_ORIGINS` does not include the page's origin                |
| Signed out on every reload over plain http | `COOKIE_SECURE` must be `false` for local http                                                    |
| Sign-in refused with a 403                 | `PUBLIC_WEB_URL` must match the page's origin exactly                                             |
| "You no longer have access"                | The socket closed with 4403 because the user was removed or the room deleted                      |
| Editors see different text after deploying | Two copies of Yjs were bundled. Keep `dedupe` in `vite.config.ts`                                 |
| Vite runs out of memory                    | Keep `monaco-editor` in `optimizeDeps.exclude`                                                    |
| Vim or Emacs keys do nothing               | Keep the `monaco-vim` and `monaco-emacs` aliases in `vite.config.ts`                              |
| Runs stay queued                           | No worker is running, or it cannot reach Redis. Check `codesync_workers_active`                   |
| The worker refuses to start                | `SANDBOX_REQUIRE_GVISOR=true` and `runsc` is not installed                                        |
| Browser test ports are in use              | An earlier test stack is still running. Stop it, or set `E2E_PORT_OFFSET=100` to use other ports  |
| Tests fail to start on Node 20             | Vitest needs Node 22.12 or later                                                                  |

---

## Known Limitations

- The stack has not been started on a real server yet, so Nginx, HTTPS and the setup wizard are unproven. CI, including real Redis and the sandbox attack suite, passes.
- Passing the attack suite shows those attacks are contained, not that no other attack works.
- The AI review has only been measured with static analyzers alone: 48% recall and 86% precision. The model evaluation needs an API key.
- A one-server deployment has no code execution, judging or AI review, because sandboxes must not share a machine with the database.
- Blame does not credit deletions, and Yjs client ids are unsigned, so it shows who probably wrote a line. It is not evidence.
- Restoring a snapshot is undone with a button, not Ctrl+Z, because Yjs undo only tracks a user's own edits.
- Pushing a snapshot to GitHub is not built. Zip export is.
- Accessibility has passed an automated scan and keyboard tests, but no one has tested it with a screen reader.

---

## Deep Codebase Analysis

| File or Folder                         | Purpose / Details                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/collab/src/rooms/room.ts`        | One open document: sync, the post-apply guard, compaction, chat and timed snapshots   |
| `apps/collab/src/server.ts`            | WebSocket upgrades, token checks, rate limits and the metrics endpoint                |
| `apps/api/src/collab/bridge.ts`        | The API's side of the shared document, including the tree lock and restore writes     |
| `apps/api/src/modules/history.ts`      | Snapshots, restore, blame and zip export                                              |
| `apps/api/src/modules/auth/`           | Sign-up, refresh rotation, reuse detection, CSRF and OAuth with PKCE                  |
| `packages/db/src/snapshots.ts`         | Snapshot capture and pruning, shared by the API and collab servers                    |
| `packages/collab-client/src/`          | Session setup, presence tracking, comment anchors and review fixes                    |
| `apps/web/src/lib/api.ts`              | API client with single-flight token refresh across tabs                               |
| `apps/web/src/features/workspace/`     | The editor screen and its panels                                                      |
| `services/executor/src/executor/`      | Sandbox, warm pool, judge, analyzers and review                                       |
| `services/executor/tests/security/`    | The sandbox attack suite                                                              |

### Documentation

| Topic                                 | Document                                                 |
| ------------------------------------- | -------------------------------------------------------- |
| Collaboration                         | [collab.md](docs/architecture/collab.md)                 |
| Authentication                        | [auth.md](docs/architecture/auth.md)                     |
| REST API                              | [rest-api.md](docs/architecture/rest-api.md)             |
| Execution queue                       | [execution-queue.md](docs/architecture/execution-queue.md) |
| AI review                             | [ai-review.md](docs/architecture/ai-review.md)           |
| Version history                       | [version-history.md](docs/architecture/version-history.md) |
| Security                              | [report.md](docs/security/report.md)                     |
| Deployment                            | [deployment.md](docs/deployment.md)                      |
| Load tests                            | [loadtest/README.md](loadtest/README.md)                 |
| Run, test and trade-offs per feature  | [viva-guide.md](docs/viva-guide.md)                      |
| Paper outline                         | [ieee-outline.md](docs/paper/ieee-outline.md)            |

---

## License

MIT - see [LICENSE](LICENSE).
