#!/usr/bin/env bash
set -euo pipefail

# Move to repo root (one level up from this script)
cd "$(dirname "$0")/.."

npm --prefix web run build:static

# kill anything already on 8080 (ignore error if none)
kill -9 $(lsof -ti tcp:8080) 2>/dev/null || true

# start server in background
node server.js &

# (optional) small delay so server has time to start
sleep 2
cmd.exe /C start "" "http://localhost:8080/checkout/?u=dev&t=dev"
