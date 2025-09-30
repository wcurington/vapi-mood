#!/bin/bash
# git_sync.sh — sanity sync script for Health America backend

set -e  # exit on first error

echo "🔍 Checking repo status..."
git status -sb

echo "📥 Pulling latest changes (merge style, safe)..."
git pull --no-rebase

echo "➕ Adding new/changed files..."
git add -A

echo "📝 Committing..."
git commit -m "sync update on $(date '+%Y-%m-%d %H:%M:%S')" || echo "✅ Nothing to commit"

echo "🚀 Pushing to origin/main..."
git push origin main

echo "✨ Sync complete."
