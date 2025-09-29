#!/bin/bash
# ---------------------------------------------------------
# Post-commit Hook: Auto-deploy to VPS after each commit
# ---------------------------------------------------------

SERVER_IP="<your_server_ip>"    # 🔥 replace with your VPS IP
SERVER_DIR="/opt/vps_spinup_kit"

echo "📦 Auto-deploy triggered after commit..."
git push

ssh root@$SERVER_IP "
  set -e
  cd $SERVER_DIR && \
  git pull && \
  docker compose down && \
  docker compose up -d --build && \
  docker compose ps
"

echo "✅ Auto-deploy complete after commit."
