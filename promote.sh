#!/bin/bash
# promote.sh — unified promotion + deployment script

set -e

echo "📦 Promoting latest server and flow builds..."

# Find latest server and build_flow files
SERVER_FILE=$(ls -t server_v*.js | head -n1)
FLOW_FILE=$(ls -t build_flow_v*.js | head -n1)

echo "Promoting $SERVER_FILE -> server.js"
cp "$SERVER_FILE" server.js

echo "Promoting $FLOW_FILE -> build_flow.js"
cp "$FLOW_FILE" build_flow.js

# Rebuild flows
echo "Regenerating flows/flows_alex_sales.json"
node build_flow.js

# Commit & push
echo "Committing and pushing to git..."
git add .
git commit -m "Promote $SERVER_FILE + $FLOW_FILE" || true
git push origin main

# Restart PM2
echo "🔄 Restarting PM2 process: alex-backend"
pm2 restart ecosystem.config.js --only alex-backend || pm2 restart alex-backend || true

echo "✅ Promotion complete."
