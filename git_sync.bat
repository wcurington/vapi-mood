@echo off
cd /d %~dp0
echo 🔍 Checking repo status...
git status -sb

echo 📥 Pulling latest changes (merge style)...
git pull --no-rebase

echo ➕ Adding new/changed files...
git add -A

echo 📝 Committing...
git commit -m "sync update on %date% %time%" || echo ✅ Nothing to commit

echo 🚀 Pushing to origin/main...
git push origin main

echo ✨ Sync complete.
pause
