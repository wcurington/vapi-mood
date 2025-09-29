#!/bin/bash
# ---------------------------------------------------------
# Watch-deploy Script
# Uses chokidar-cli to auto-deploy on file save
# ---------------------------------------------------------

SERVER_IP="<your_server_ip>"    # 🔥 replace with your VPS IP
SERVER_DIR="/opt/vps_spinup_kit"

# Ensure chokidar-cli is installed
if ! command -v chokidar &> /dev/null; then
  echo "Installing chokidar-cli..."
  npm install -g chokidar-cli
fi

echo "👀 Watching for changes in project files..."
chokidar "!(node_modules)/**/*.{js,json,md,csv}" -c "
  echo '📦 Change detected, deploying...' && \
  git add . && \
  git commit -m 'Auto-deploy on save: \$(date +'%Y-%m-%d %H:%M:%S')' || true && \
  git push && \
  ssh root@$SERVER_IP \"
    set -e
    cd $SERVER_DIR && \
    git pull && \
    docker compose down && \
    docker compose up -d --build && \
    docker compose ps
  \"
"
