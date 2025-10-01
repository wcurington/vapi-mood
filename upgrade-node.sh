#!/bin/bash
set -e

echo "🚀 Starting Node.js upgrade to v20..."

# Step 1: Remove old Node.js, npm, and libnode-dev
echo "🧹 Removing old Node.js and libnode-dev..."
apt remove -y nodejs npm libnode-dev || true
apt purge -y nodejs npm libnode-dev || true
apt autoremove -y || true

# Step 2: Clean apt cache
echo "🗑️ Clearing apt cache..."
rm -rf /var/cache/apt/archives/*

# Step 3: Add NodeSource for Node 20
echo "📦 Adding NodeSource for Node 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

# Step 4: Install Node.js v20
echo "⬇️ Installing Node.js v20..."
apt install -y nodejs

# Step 5: Verify installation
echo "✅ Node.js version:"
node -v
echo "✅ npm version:"
npm -v

# Step 6: Reinstall dependencies
if [ -d "/opt/vps_spinup_kit" ]; then
  echo "📂 Reinstalling project dependencies..."
  cd /opt/vps_spinup_kit
  rm -rf node_modules package-lock.json
  npm install
else
  echo "⚠️ Warning: /opt/vps_spinup_kit not found, skipping dependency reinstall."
fi

echo "🎉 Node.js upgrade complete!"
