# One-shot job that applies migrations. Build from the repository root.
FROM node:22-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter '@codesync/db...'
WORKDIR /repo/packages/db
USER node
# Runs the binary directly: pnpm would try to download itself as this unprivileged user.
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]
