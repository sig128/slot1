#!/usr/bin/env bash
# Generate a fully synthetic test recording with ffmpeg (no third-party footage), used by the
# integration tests, the Playwright journey and the local ingest publish test.
#
# The video has three scenes with HUD-style text, a 2-second black screen and a silent stretch,
# so every deterministic detector (scene cuts, black screens, silence, OCR) has real input.
# It is NOT gameplay; anything SLOT1 reports about it should describe exactly what is drawn.
#
#   bash scripts/make-sample-video.sh [output.mp4]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/tests/fixtures/generated/sample-replay.mp4}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$(dirname "$OUT")"

FONT=""
for f in /usr/share/fonts/opentype/inter/Inter-Bold.otf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
         /System/Library/Fonts/Supplemental/Arial\ Bold.ttf /Library/Fonts/Arial\ Bold.ttf; do
  [ -f "$f" ] && { FONT="$f"; break; }
done
if [ -z "$FONT" ]; then echo "No usable font found for drawtext (install fonts-dejavu or Inter)." >&2; exit 1; fi

printf '%s' "Go to the docks" > "$TMP/t1.txt"
printf '%s' "SLOT1 SYNTHETIC TEST RECORDING" > "$TMP/t0.txt"
printf '%s' "Lamar: You drive like my grandma" > "$TMP/t2.txt"
printf '%s' "\$12,450" > "$TMP/t3.txt"
printf '%s' "MISSION PASSED" > "$TMP/t4.txt"
printf '%s' "Vespucci Beach" > "$TMP/t5.txt"

DT() { # drawtext with a text FILE (no escaping issues)
  echo "drawtext=fontfile='$FONT':textfile='$1':fontsize=$2:fontcolor=white:x=$3:y=$4:box=1:boxcolor=black@0.55:boxborderw=14"
}

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=1280x720:r=30:d=12" \
  -f lavfi -i "color=c=black:s=1280x720:r=30:d=2" \
  -f lavfi -i "testsrc=s=1280x720:r=30:d=12" \
  -f lavfi -i "smptehdbars=s=1280x720:r=30:d=12" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=20" \
  -f lavfi -i "anullsrc=r=48000:cl=mono:d=12" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=6" \
  -filter_complex "\
[0:v]$(DT "$TMP/t0.txt" 30 '(w-text_w)/2' 40),$(DT "$TMP/t1.txt" 44 '(w-text_w)/2' 'h*0.82')[v0];\
[2:v]$(DT "$TMP/t2.txt" 40 '(w-text_w)/2' 'h*0.84'),$(DT "$TMP/t3.txt" 44 'w-text_w-40' 40)[v2];\
[3:v]$(DT "$TMP/t4.txt" 84 '(w-text_w)/2' '(h-text_h)/2'),$(DT "$TMP/t5.txt" 34 'w-text_w-40' 'h*0.88')[v3];\
[v0][1:v][v2][v3]concat=n=4:v=1:a=0,format=yuv420p[v];\
[5:a]aformat=sample_rates=48000:channel_layouts=mono[sil];\
[4:a]aformat=sample_rates=48000:channel_layouts=mono[a1];\
[6:a]aformat=sample_rates=48000:channel_layouts=mono[a2];\
[a1][sil][a2]concat=n=3:v=0:a=1,apad=whole_dur=38[a]" \
  -map "[v]" -map "[a]" -t 38 -c:v libx264 -preset veryfast -crf 20 -g 60 -c:a aac -b:a 128k -movflags +faststart "$OUT"

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
