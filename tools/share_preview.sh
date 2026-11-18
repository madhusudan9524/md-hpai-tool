#!/bin/sh
# Put a private preview of the map on Cloudflare Pages, to share with a few people.
# Uploads only the website (index.html, css, js, data) — never the worker/ folder or its secrets.
# Run from the project folder:   sh tools/share_preview.sh
set -e
cd "$(dirname "$0")/.."
OUT="${TMPDIR:-/tmp}/md-hpai-preview"
rm -rf "$OUT" && mkdir -p "$OUT"
cp index.html "$OUT/" && cp -R css js data "$OUT/"
echo "Uploading the map (website files only)…"
npx wrangler pages project create md-hpai-preview --production-branch main >/dev/null 2>&1 || true
npx wrangler pages deploy "$OUT" --project-name md-hpai-preview --branch preview --commit-dirty=true
echo ""
echo "Share this link:  https://preview.md-hpai-preview.pages.dev"
