#!/usr/bin/env bash
# qc.sh — mechanical QC gate per craft-and-launch-research.md §C.4.
# Checks: H.264 High yuv420p, 60 fps, <140s, audio loudness when an audio
# stream exists (-14 LUFS / -1 dBTP target — reported, not hard-failed),
# plus an 8-frame contact sheet to eyeball for secrets/notifications.
# Usage: ./scripts/qc.sh <file.mp4>
set -euo pipefail
f="$1"
fail=0
chk() { # label, expected, actual
  if [ "$2" = "$3" ]; then echo "PASS $1: $3";
  else echo "FAIL $1: want $2, got $3"; fail=1; fi
}

probe() { ffprobe -v error -select_streams v:0 -show_entries "stream=$1" -of csv=p=0 "$f"; }

chk codec h264 "$(probe codec_name)"
chk pix_fmt yuv420p "$(probe pix_fmt)"
chk profile High "$(probe profile)"
chk fps 60 "$(probe r_frame_rate | cut -d/ -f1)"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
awk -v d="$dur" 'BEGIN{exit !(d<140)}' && echo "PASS duration: ${dur}s" || { echo "FAIL duration: ${dur}s >= 140"; fail=1; }
w=$(probe width); h=$(probe height)
echo "INFO geometry: ${w}x${h}"

# Audio: silent-first is valid (Q11 foley-only). If a stream exists, measure.
if ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$f" | grep -q .; then
  echo "INFO audio present — loudnorm analysis (target -14 LUFS / -1 dBTP):"
  ffmpeg -nostats -i "$f" -af loudnorm=I=-14:TP=-1:LRA=11:print_format=summary -f null - 2>&1 | tail -12
else
  echo "PASS audio: none (silent-first)"
fi

dir="$(dirname "$f")/qc-$(basename "$f" .mp4)"
mkdir -p "$dir"
n=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$f")
for i in 0 1 2 3 4 5 6 7; do
  fr=$(( i * (n / 8) + 10 ))
  ffmpeg -y -loglevel error -i "$f" -vf "select=eq(n\,$fr)" -frames:v 1 "$dir/contact-$i.png"
done
echo "contact sheet -> $dir (check for secrets, notifications, personal tooling)"

exit $fail
