#!/bin/sh
# Makes the looping README preview from the rendered video, 960 px wide, no sound: about eleven seconds that tell the
# story by themselves. One stretch from each of four scenes (open, paint, fill, work together), each with its caption.
# usage: sh scripts/preview.sh [video] [output.webp]      (needs ffmpeg and Python with Pillow)
# ffmpeg cuts the frames and Pillow writes the animation, because Pillow can ask for a full frame every second or so.
# Without that the encoder keeps patching the first frame and faint blocks of earlier scenes stay in the background.
set -e
cd "$(dirname "$0")/.."
IN="${1:-../docs/assets/launch.mp4}"
OUT="${2:-../docs/assets/launch.webp}"
FPS="${FPS:-12}"
TMP="$(mktemp -d)"
ffmpeg -y -loglevel error -i "$IN" -vf "${CUT:-select='between(t,0.5,1.9)+between(t,3.1,4.1)+between(t,5.1,6.9)+between(t,9.7,12.1)+between(t,14.3,15.9)+between(t,19.5,22.5)',setpts=N/FRAME_RATE/TB},fps=$FPS,scale=960:-2:flags=lanczos" "$TMP/%04d.png"
python3 - "$TMP" "$OUT" "$FPS" "${Q:-74}" <<'PY'
import glob, sys
from PIL import Image
tmp, out, fps, q = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
frames = [Image.open(f).convert('RGB') for f in sorted(glob.glob(tmp + '/*.png'))]
frames[0].save(out, save_all=True, append_images=frames[1:], duration=round(1000 / fps), loop=0, quality=q, method=4, kmin=9, kmax=17)
print(len(frames), 'frames,', round(len(frames) / fps, 1), 's')
PY
for f in "$TMP"/*.png; do unlink "$f"; done; rmdir "$TMP"
ls -l "$OUT"
