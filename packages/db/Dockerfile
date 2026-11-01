# One-shot job that applies migrations. Build from the repository root.
FROM node:22-slim
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter '@codesync/db...'
USER node
CMD ["pnpm", "--filter", "@codesync/db", "migrate:deploy"]
