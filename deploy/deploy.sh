#!/usr/bin/env bash
set -euo pipefail

# Deploy BubbleBIM Clean pe Hetzner:
#  1) build Clean pe Mac (auth + cloud API)
#  2) rsync pe server
#  3) docker compose up

SERVER="${DEPLOY_SERVER:-root@YOUR_SERVER_IP}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/bubblebim}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Build Clean pe Mac (VITE_API_URL=/api)..."
cd "${ROOT}"
export VITE_BASE_URL=/
export VITE_API_URL=/api
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
pnpm build:clean

if [[ -L "${ROOT}/dist-clean-lite/board_game/scanner.html" ]] || [[ ! -f "${ROOT}/dist-clean-lite/board_game/scanner.html" ]]; then
  mkdir -p "${ROOT}/dist-clean-lite/board_game"
  if [[ -f "${ROOT}/backend/board_game/scanner.html" ]]; then
    cp "${ROOT}/backend/board_game/scanner.html" "${ROOT}/dist-clean-lite/board_game/scanner.html"
  fi
fi

echo "→ Sync către ${SERVER}:${REMOTE_DIR}"
rsync -avz --delete --copy-links \
  --exclude deploy/.env \
  --exclude deploy/.env.deploy \
  --exclude deploy/data \
  --exclude node_modules \
  --exclude .git \
  --exclude .pnpm-store \
  --exclude .DS_Store \
  --exclude dist \
  --exclude dist-lite \
  --exclude dist-minimal \
  --exclude dist-electron \
  --exclude apps/clean-lite/Users \
  --exclude BubbleGraphApp \
  --exclude 'Ultimate Stylized Nature' \
  --exclude backend/venv \
  --exclude backend/.venv \
  --exclude backend/__pycache__ \
  --exclude backend/uploads \
  --exclude backend/backups \
  --exclude backend/data \
  --exclude '**/*.tsbuildinfo' \
  "${ROOT}/" "${SERVER}:${REMOTE_DIR}/"

echo "→ Start containere pe server"
ssh "${SERVER}" "cd ${REMOTE_DIR}/deploy && \
  mkdir -p data/backups data/uploads data/auth && \
  if [ ! -f data/bubble_graph.json ]; then \
    cp ../backend/bubble_graph.json data/bubble_graph.json 2>/dev/null || \
      echo '{\"nodes\":[],\"edges\":[],\"buildingAxes\":{\"xValues\":[],\"yValues\":[]}}' > data/bubble_graph.json; \
  fi && \
  if [ ! -f data/materials.yaml ]; then \
    cp ../backend/materials.yaml data/materials.yaml; \
  fi && \
  if [ ! -f .env ]; then \
    cp .env.example .env; \
    sed -i \"s|^JWT_SECRET=.*|JWT_SECRET=\$(openssl rand -hex 32)|\" .env || true; \
    echo '→ Creat deploy/.env'; \
  fi && \
  docker compose up -d --build"

echo ""
echo "→ Gata:"
echo "    https://bbim.ciuntucbimstudio.ro"
echo "    Admin default: vezi ADMIN_USERNAME / ADMIN_PASSWORD în deploy/.env"
echo ""
