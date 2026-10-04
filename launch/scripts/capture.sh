#!/usr/bin/env bash
# capture.sh — produce the real captures the launch video needs.
# VHS terminal tapes via the repo's staged, key-free demo env (R27/R32),
# plus the U14 evidence report rendered from the mixed-four-lane fixture.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm run build
npm run demo:record -- init
npm run demo:record -- run-cache-hit
npm run demo:record -- verify
node launch/scripts/render-report.mjs

mkdir -p launch/public/captures
cp argus-reviewer-report/demo/{init,run-cache-hit,verify}.mp4 launch/public/captures/
echo "captures -> launch/public/captures/"
