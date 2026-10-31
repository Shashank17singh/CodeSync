# CodeSync

Real-time collaborative code editor with sandboxed execution, AI review and an online judge.

Built so far: database schema and the collaboration server. See
[docs/architecture/collab.md](docs/architecture/collab.md).

## Setup

Requires Node.js 20.19 or later, Docker, and Corepack (`corepack enable`).

```sh
corepack pnpm install
docker compose -f infra/compose/docker-compose.dev.yml up -d
cp apps/collab/.env.example apps/collab/.env
DATABASE_URL=postgresql://codesync:codesync@localhost:5432/codesync \
  corepack pnpm --filter @codesync/db migrate:deploy
corepack pnpm build
```

Set `COLLAB_TOKEN_SECRET` in `apps/collab/.env`, then start the server:

```sh
corepack pnpm --filter @codesync/collab dev
curl http://localhost:4000/healthz
```

## Testing

```sh
corepack pnpm --filter @codesync/collab test
```

Tests use an in-memory stand-in for Redis and PostgreSQL. To also run the storage adapters against
real services:

```sh
TEST_REDIS_URL=redis://localhost:6379 \
TEST_DATABASE_URL=postgresql://codesync:codesync@localhost:5432/codesync \
  corepack pnpm --filter @codesync/collab test
```

Keep `prisma` pinned to 7.10.1. npm's `latest` tag currently points to an 8.0 release candidate.
