#!/usr/bin/env bash
# 配布用 ZIP を作る。展開先が ~/.claude/skills/ になるよう skills/ の中身を root に置く。
set -euo pipefail

cd "$(dirname "$0")"
OUT="dist/claude-skills.zip"

rm -rf dist
mkdir -p dist
# -x で .DS_Store 等を除く。受け取った側の ~/.claude/skills/ に不要なものを撒かない
(cd skills && zip -qr "../$OUT" . -x '.*' '*/.*')

echo "$OUT"
unzip -l "$OUT"
