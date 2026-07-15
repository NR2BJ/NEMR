#!/usr/bin/env bash
# Downloads NetEaseMusicWorld++ from the Chrome Web Store and unpacks it so
# Chrome can load it with --load-extension. Runs at image build time, so it
# leans on node (always present in the Playwright base) rather than python.
set -euo pipefail

EXT_ID="${EXT_ID:-ibglohpjgdhkmhmfpdibjgmjjmccafmh}"
OUT_DIR="${OUT_DIR:-./ext}"
TMP="$(mktemp -d -t nemr-ext-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

URL="https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=120&x=id%3D${EXT_ID}%26uc"

echo "[nemr] downloading extension ${EXT_ID}"
curl -fsSL -o "$TMP/ext.crx" "$URL"

SIZE=$(wc -c < "$TMP/ext.crx")
if [ "$SIZE" -lt 1000 ]; then
  echo "[nemr] got only ${SIZE} bytes — the store probably rejected the request." >&2
  exit 1
fi

# A .crx is a signed header followed by a plain zip. Strip everything before the
# first zip local-file signature so unzip gets a clean archive.
node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(process.argv[1]);
  const off = raw.indexOf(Buffer.from("PK\x03\x04", "binary"));
  if (off < 0) { console.error("no zip payload inside crx"); process.exit(1); }
  fs.writeFileSync(process.argv[2], raw.subarray(off));
  console.error(`[nemr] stripped ${off} byte crx header`);
' "$TMP/ext.crx" "$TMP/ext.zip"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
unzip -q "$TMP/ext.zip" -d "$OUT_DIR"

if [ ! -f "$OUT_DIR/manifest.json" ]; then
  echo "[nemr] no manifest.json in $OUT_DIR — unpack failed." >&2
  exit 1
fi

echo "[nemr] unpacked into $OUT_DIR"
grep -E '"version"' "$OUT_DIR/manifest.json" | head -1
