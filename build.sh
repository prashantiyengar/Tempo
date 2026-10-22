#!/usr/bin/env bash
# Builds dist/chrome and dist/firefox folders + zip packages.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
for b in chrome firefox; do
  mkdir -p "dist/$b"
  cp -r src/* "dist/$b/"
  cp "platform/manifest.$b.json" "dist/$b/manifest.json"
  # One-click sign-in on Chrome: add the oauth2 block when a Chrome client ID is configured in src/js/config.js
  CID=$(sed -n "s/^export const CHROME_CLIENT_ID = '\(.*\)';/\1/p" src/js/config.js)
  if [ "$b" = chrome ] && [ -n "$CID" ]; then
    python3 - "dist/$b/manifest.json" "$CID" <<'PY'
import json, sys
p, cid = sys.argv[1], sys.argv[2]
m = json.load(open(p))
m["oauth2"] = {"client_id": cid, "scopes": ["https://www.googleapis.com/auth/calendar", "openid", "email"]}
json.dump(m, open(p, "w"), indent=2)
PY
  fi
  (cd "dist/$b" && zip -qr "../tempo-calendar-$b.zip" .)
done
# ---- Web app (installable PWA for phones and any browser) ----
mkdir -p dist/web
cp -r src/* dist/web/
mv dist/web/app.html dist/web/index.html
cp platform/web/manifest.webmanifest dist/web/
cp platform/web/icons/* dist/web/icons/
python3 - <<'PY'
import os, json, time, re
root = 'dist/web'
idx = open(f'{root}/index.html').read()
head = """  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Tempo">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://upload.wikimedia.org; connect-src 'self' https://www.googleapis.com https://openidconnect.googleapis.com https://oauth2.googleapis.com https://graph.microsoft.com https://api.open-meteo.com https://geocoding-api.open-meteo.com https://commons.wikimedia.org https://icanhazdadjoke.com https://api.apiverve.com https://horoscope-app-api.vercel.app; object-src 'none'; base-uri 'self'; form-action 'self'">
"""
idx = idx.replace('<link rel="icon"', head + '  <link rel="icon"', 1)
open(f'{root}/index.html', 'w').write(idx)
assets = []
for d, _, files in os.walk(root):
    for f in files:
        p = os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
        if p not in ('sw.js',) and not p.endswith('.txt'): assets.append(p)
sw = open('platform/web/sw.js').read().replace('__BUILD__', time.strftime('%Y%m%d%H%M%S')).replace('__ASSETS__', json.dumps(sorted(assets)))
open(f'{root}/sw.js', 'w').write(sw)
PY
(cd dist/web && zip -qr ../tempo-calendar-web.zip .)
echo "Built dist/chrome, dist/firefox, dist/web and zips"
