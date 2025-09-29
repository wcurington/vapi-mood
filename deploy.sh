#!/bin/bash
# ---------------------------------------------------------
# Health America Deploy Script
# Pushes local changes and redeploys Docker stack on VPS
# ---------------------------------------------------------

# --- CONFIG ---
SERVER_IP="<your_server_ip>"   # 🔥 replace with your VPS IP
SERVER_DIR="/opt/vps_spinup_kit"

# --- STEP 1: Commit + Push ---
echo "📦 Adding and pushing changes..."
git add .
git commit -m "Deploy $(date +'%Y-%m-%d %H:%M:%S')"
git push

# --- STEP 2: SSH into VPS and redeploy ---
echo "🚀 Connecting to VPS and redeploying..."
ssh root@$SERVER_IP "
  set -e
  cd $SERVER_DIR && \
  git pull && \
  docker compose down && \
  docker compose up -d --build && \
  docker compose ps
"

echo "✅ Deployment complete."
