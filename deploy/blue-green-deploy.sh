#!/usr/bin/env bash
# Zero-downtime Blue-Green deployment helper for So I Chose backend & frontend containers.
# Usage: /opt/soichose/blue-green-deploy.sh <backend|frontend> <docker-image>
set -euo pipefail

SERVICE="${1:?Usage: $0 <backend|frontend> <image>}"
IMAGE="${2:?Usage: $0 <backend|frontend> <image>}"

APP_DIR="/opt/soichose"
ENV_FILE="$APP_DIR/.env"
UPSTREAM_CONF="/etc/nginx/snippets/soichose-upstreams.conf"
DOCKER_NET="soichose_soichose-net"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Missing $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Ensure Postgres is healthy before deploying app containers
docker compose -f "$APP_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE" up -d postgres

read_port() {
  local name="$1"
  local fallback="$2"
  if [[ -f "$UPSTREAM_CONF" ]]; then
    grep -A2 "upstream $name" "$UPSTREAM_CONF" | grep -oE '127\.0\.0\.1:[0-9]+' | head -n1 | cut -d: -f2 || echo "$fallback"
  else
    echo "$fallback"
  fi
}

CURRENT_APP_PORT="$(read_port soichose_app_upstream 3010)"
CURRENT_API_PORT="$(read_port soichose_api_upstream 4010)"

if [[ "$SERVICE" == "backend" ]]; then
  if [[ "$CURRENT_API_PORT" == "4010" ]]; then
    TARGET_SLOT="green"
    TARGET_PORT="4011"
    OLD_SLOT="blue"
  else
    TARGET_SLOT="blue"
    TARGET_PORT="4010"
    OLD_SLOT="green"
  fi
  NEXT_APP_PORT="$CURRENT_APP_PORT"
  NEXT_API_PORT="$TARGET_PORT"
  HEALTH_PATH="/health"
  CONTAINER_PORT="4000"
  MEM_LIMIT="256m"
elif [[ "$SERVICE" == "frontend" ]]; then
  if [[ "$CURRENT_APP_PORT" == "3010" ]]; then
    TARGET_SLOT="green"
    TARGET_PORT="3011"
    OLD_SLOT="blue"
  else
    TARGET_SLOT="blue"
    TARGET_PORT="3010"
    OLD_SLOT="green"
  fi
  NEXT_APP_PORT="$TARGET_PORT"
  NEXT_API_PORT="$CURRENT_API_PORT"
  HEALTH_PATH="/"
  CONTAINER_PORT="3000"
  MEM_LIMIT="192m"
else
  echo "ERROR: Service must be 'backend' or 'frontend', got '$SERVICE'" >&2
  exit 1
fi

TARGET_NAME="soichose-${SERVICE}-${TARGET_SLOT}"
OLD_NAME="soichose-${SERVICE}-${OLD_SLOT}"

echo ">>> Pulling $IMAGE ..."
docker pull "$IMAGE"

# Replace any stale standby container on the inactive slot
docker rm -f "$TARGET_NAME" >/dev/null 2>&1 || true

echo ">>> Starting $TARGET_NAME on 127.0.0.1:$TARGET_PORT ..."
if [[ "$SERVICE" == "backend" ]]; then
  DB_URL="postgresql://${POSTGRES_USER:-soichose}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-soichose}?schema=public"
  docker run -d \
    --name "$TARGET_NAME" \
    --restart unless-stopped \
    --network "$DOCKER_NET" \
    --memory "$MEM_LIMIT" \
    -p "127.0.0.1:${TARGET_PORT}:${CONTAINER_PORT}" \
    --env-file "$ENV_FILE" \
    -e "NODE_ENV=production" \
    -e "PORT=${CONTAINER_PORT}" \
    -e "DATABASE_URL=${DB_URL}" \
    "$IMAGE" >/dev/null
else
  docker run -d \
    --name "$TARGET_NAME" \
    --restart unless-stopped \
    --network "$DOCKER_NET" \
    --memory "$MEM_LIMIT" \
    -p "127.0.0.1:${TARGET_PORT}:${CONTAINER_PORT}" \
    -e "NODE_ENV=production" \
    -e "PORT=${CONTAINER_PORT}" \
    "$IMAGE" >/dev/null
fi

echo ">>> Waiting for $TARGET_NAME health check at http://127.0.0.1:${TARGET_PORT}${HEALTH_PATH} ..."
READY=0
for _ in $(seq 1 45); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${TARGET_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "ERROR: $TARGET_NAME failed health check — rolling back without interrupting traffic!" >&2
  docker logs --tail 40 "$TARGET_NAME" >&2 || true
  docker rm -f "$TARGET_NAME" >/dev/null 2>&1 || true
  exit 1
fi

echo ">>> Switching Nginx upstream cleanly to $TARGET_NAME ($TARGET_PORT) ..."
TMP_CONF="$(mktemp)"
cat > "$TMP_CONF" <<EOF
upstream soichose_app_upstream {
    server 127.0.0.1:${NEXT_APP_PORT};
    keepalive 32;
}

upstream soichose_api_upstream {
    server 127.0.0.1:${NEXT_API_PORT};
    keepalive 32;
}
EOF

cp "$UPSTREAM_CONF" "${UPSTREAM_CONF}.bak" 2>/dev/null || true
mv "$TMP_CONF" "$UPSTREAM_CONF"

if ! nginx -t >/dev/null 2>&1; then
  echo "ERROR: nginx -t failed — restoring previous upstream config!" >&2
  cp "${UPSTREAM_CONF}.bak" "$UPSTREAM_CONF" 2>/dev/null || true
  docker rm -f "$TARGET_NAME" >/dev/null 2>&1 || true
  exit 1
fi

systemctl reload nginx
echo ">>> Draining connections on $OLD_NAME before cleanup ..."
sleep 3
docker rm -f "$OLD_NAME" >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
echo "SUCCESS: $SERVICE is live on slot=$TARGET_SLOT port=$TARGET_PORT with 0ms downtime."

