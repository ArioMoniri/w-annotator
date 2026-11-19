#!/bin/sh
# Makes the looping README preview from the rendered video: the first seconds of each part, 960 px wide, no sound.
# usage: sh scripts/preview.sh [video] [output.webp]
set -e
cd "$(dirname "$0")/.."
IN="${1:-../docs/assets/launch.mp4}"
OUT="${2:-../docs/assets/launch.webp}"
ffmpeg -y -loglevel error -i "$IN" -vf "${CUT:-select='between(t,0,2.2)+between(t,5.4,7.4)+between(t,8.6,12.6)+between(t,22.2,26.6)',setpts=N/FRAME_RATE/TB},fps=${FPS:-15},scale=960:-2:flags=lanczos" \
  -c:v libwebp_anim -lossless 0 -quality "${Q:-68}" -compression_level 4 -loop 0 -an "$OUT"
ls -l "$OUT"
