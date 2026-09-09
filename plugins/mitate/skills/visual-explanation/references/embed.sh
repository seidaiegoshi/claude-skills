#!/usr/bin/env bash
# 画像を縮小・JPEG 化して <img src="data:..."> 1行を出力する。
# Artifact は CSP で外部ホストの画像を読めないため、data: URI で埋め込むしかない。
set -euo pipefail

src=${1:?使い方: embed.sh <画像> [--width 1200] [--quality 70] [--alt 説明]}
shift
width=1200
quality=70
alt=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --width) width=$2; shift 2 ;;
    --quality) quality=$2; shift 2 ;;
    --alt) alt=$2; shift 2 ;;
    *) echo "不明な引数: $1" >&2; exit 1 ;;
  esac
done

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
sips -s format jpeg -s formatOptions "$quality" -Z "$width" "$src" --out "$tmpdir/shot.jpg" >/dev/null

printf '<img data-zoom alt="%s" src="data:image/jpeg;base64,%s">\n' "$alt" "$(base64 -i "$tmpdir/shot.jpg" | tr -d '\n')"
echo "embed: $src -> $(du -h "$tmpdir/shot.jpg" | cut -f1)" >&2
