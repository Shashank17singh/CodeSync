# Build from the repository root: docker build -f apps/collab/Dockerfile .
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter '@codesync/collab...'
RUN pnpm --filter '@codesync/collab...' build
RUN pnpm --filter @codesync/collab deploy --prod /app

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app .
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
