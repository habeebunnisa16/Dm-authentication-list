#!/bin/sh
# DM authentication check: run ./start.sh to start. Needs Node.js 18 or newer (https://nodejs.org).
set -e
cd "$(dirname "$0")/backend"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"; then
  echo "Node.js 18 or newer is required. You have $(node -v). Install the LTS version from https://nodejs.org."
  exit 1
fi

# Packages are included in the shared copy; install them only when they are missing
if [ ! -d node_modules/express ]; then
  echo "Installing packages..."
  npm install --omit=dev --no-audit --no-fund
fi

PORT=$(node scripts/setup.js)
echo "Starting on http://localhost:$PORT  (Ctrl+C to stop)"
( sleep 2
  if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT" >/dev/null 2>&1
  fi ) &
exec node src/server.js
