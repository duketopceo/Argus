#!/usr/bin/env bash
# finish.sh — package rendered masters into deliverables.
#   X deliverables:      H.264 High yuv420p re-encodes (masters already are;
#                        we re-tag + faststart for upload) at 16:9 and 1:1.
#   Posters/thumbnails:  -ss stills at 1920x1080 and 1200x675 (OG/changelog hero).
#   README loop:         960px-wide silent MP4 + gifski GIF fallback (<=3MB).
# Usage: ./scripts/finish.sh [outdir]   (default launch/out/final)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=out
DST="${1:-out/final}"
mkdir -p "$DST"

enc() { # in, out
  ffmpeg -y -loglevel error -i "$1" \
    -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 \
    -movflags +faststart -an "$2"
}

enc "$SRC/argus-launch-16x9.mp4" "$DST/argus-witness-16x9.mp4"
enc "$SRC/argus-launch-1x1.mp4" "$DST/argus-witness-1x1.mp4"

# Posters — the claim + mark frame (t=1.55s) is the meaningful still.
for src in argus-launch-16x9 argus-launch-1x1; do
  ffmpeg -y -loglevel error -ss 1.55 -i "$SRC/$src.mp4" -frames:v 1 \
    "$DST/poster-$src.png"
done
ffmpeg -y -loglevel error -i "$DST/poster-argus-launch-16x9.png" \
  -vf scale=1200:675 "$DST/thumb-1200x675.png"

# README loop — 960px silent MP4 + gifski fallback.
ffmpeg -y -loglevel error -i "$SRC/readme-loop-src.mp4" \
  -vf scale=960:-2 -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 20 \
  -movflags +faststart -an "$DST/argus-readme-loop.mp4"
gifski --fps 30 --width 960 -o "$DST/argus-readme-loop.gif" \
  "$SRC/readme-loop-src.mp4" 2>/dev/null || \
  ffmpeg -y -loglevel error -i "$SRC/readme-loop-src.mp4" \
    -vf "fps=30,scale=960:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
    "$DST/argus-readme-loop.gif"

ls -lh "$DST"
