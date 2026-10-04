#!/usr/bin/env bash
# render.sh — render all deliverables. Requires captures on disk first
# (./scripts/capture.sh, or hand-placed mp4s in public/captures/).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out

npx remotion render src/index.ts ArgusLaunch out/argus-launch-16x9.mp4
npx remotion render src/index.ts ArgusLaunchSquare out/argus-launch-1x1.mp4
npx remotion render src/index.ts ArgusReadmeLoop out/readme-loop-src.mp4

echo "renders -> launch/out/"
