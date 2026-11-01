# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter '@codesync/web...'
RUN pnpm --filter @codesync/shared build
RUN pnpm --filter @codesync/collab-client build
RUN pnpm --filter @codesync/web build

FROM nginx:1.29-alpine AS runtime
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80 443
