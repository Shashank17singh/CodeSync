#!/usr/bin/env bash
set -e

# Render provides $PORT (typically 10000). Default to 10000 if not present.
export PORT="${PORT:-10000}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

echo "Starting in-container Redis server..."
redis-server --daemonize yes --bind 127.0.0.1 --port 6379

echo "Configuring Nginx reverse proxy for port ${PORT}..."
envsubst '${PORT}' < /etc/nginx/templates/codesync.conf.template > /etc/nginx/conf.d/codesync.conf

echo "Starting Nginx daemon..."
nginx

echo "Starting CodeSync REST API (Fastify) on internal port 3000..."
cd /app/api
PORT=3000 node dist/index.js &
API_PID=$!

echo "Starting CodeSync Collaboration Server (Yjs WebSocket) on internal port 4000..."
cd /app/collab
PORT=4000 node dist/index.js &
COLLAB_PID=$!

echo "CodeSync backend is fully operational on port ${PORT}!"
wait -n $API_PID $COLLAB_PID
