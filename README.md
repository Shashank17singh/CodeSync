# CodeSync

Real-time collaborative code editor with sandboxed execution, AI review and an online judge.

Built so far: database schema, the collaboration server, presence with live cursors, the rooms and
projects API, and authentication. See [collab.md](docs/architecture/collab.md),
[auth.md](docs/architecture/auth.md) and [rest-api.md](docs/architecture/rest-api.md).

## Setup

Requires Node.js 20.19 or later, Docker, and Corepack (`corepack enable`).

```sh
corepack pnpm install
docker compose -f infra/compose/docker-compose.dev.yml up -d
cp apps/collab/.env.example apps/collab/.env
cp apps/api/.env.example apps/api/.env
DATABASE_URL=postgresql://codesync:codesync@localhost:5432/codesync \
  corepack pnpm --filter @codesync/db migrate:deploy
corepack pnpm build
```

Fill in the secrets in both `.env` files, using the same `COLLAB_TOKEN_SECRET` in each, then start
the servers:

```sh
corepack pnpm --filter @codesync/api dev
corepack pnpm --filter @codesync/collab dev
curl http://localhost:3000/healthz
curl http://localhost:4000/healthz
```

Development email goes to Mailpit. Read it at <http://localhost:8025>.

## Testing

```sh
corepack pnpm --filter @codesync/collab test
```

API tests run against real PostgreSQL. They start an embedded server unless `TEST_DATABASE_URL`
points at your own migrated database:

```sh
corepack pnpm --filter @codesync/api test
```

Collab tests use an in-memory stand-in for Redis and PostgreSQL. To also run the storage adapters
against real services:

```sh
TEST_REDIS_URL=redis://localhost:6379 \
TEST_DATABASE_URL=postgresql://codesync:codesync@localhost:5432/codesync \
  corepack pnpm --filter @codesync/collab test
```

Browser tests run two isolated users against a real collab server. Playwright starts both servers
itself:

```sh
corepack pnpm build
corepack pnpm --filter @codesync/web exec playwright install chromium
corepack pnpm --filter @codesync/web test:e2e
```

Keep `prisma` pinned to 7.10.1. npm's `latest` tag currently points to an 8.0 release candidate.
