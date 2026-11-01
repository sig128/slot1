#!/usr/bin/env bash
# Publish a looping test recording to a SLOT1 ingest source, like OBS or a capture device would.
# Create the source in Studio first (label it TEST) and pass the publish URL it shows once:
#   scripts/publish-test-stream.sh 'rtmp://127.0.0.1:1935/live/<name>?key=<key>' [video.mp4]
# The stream stays labeled TEST / REPLAY in SLOT1; it is never presented as live gameplay.
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:?publish URL from Studio}"
video="${2:-tests/fixtures/generated/sample-replay.mp4}"
[ -f "$video" ] || bash scripts/make-sample-video.sh >/dev/null
exec ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -i "$video" \
  -c:v libx264 -preset veryfast -tune zerolatency -g 60 -pix_fmt yuv420p -b:v 2500k \
  -c:a aac -b:a 128k -ar 44100 -f flv "$url"
