# Multi-stage Docker build for CodeSync Unified Backend
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo

RUN corepack enable
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @codesync/shared build
RUN pnpm --filter @codesync/db build
RUN pnpm --filter @codesync/api build
RUN pnpm --filter @codesync/collab build
RUN pnpm --filter @codesync/api deploy --prod /app/api
RUN pnpm --filter @codesync/collab deploy --prod /app/collab

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    redis-server \
    nginx \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/api /app/api
COPY --from=build /app/collab /app/collab

RUN rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf
RUN mkdir -p /etc/nginx/templates
COPY infra/render/codesync.conf.template /etc/nginx/templates/codesync.conf.template
COPY infra/render/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 10000

CMD ["/app/start.sh"]
