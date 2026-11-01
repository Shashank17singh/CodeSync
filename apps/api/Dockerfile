# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter '@codesync/api...'
RUN pnpm --filter '@codesync/api...' build
RUN pnpm --filter @codesync/api deploy --prod /app

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app .
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
