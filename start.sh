#!/usr/bin/env bash
# تشغيل مع تحميل .env لو موجود
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
[ -d node_modules ] || npm install
exec node --dns-result-order=ipv4first src/index.js
