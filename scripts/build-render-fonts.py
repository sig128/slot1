#!/usr/bin/env python3
"""Convert the web app's Passion One WOFF2 files (SIL OFL 1.1) to TTF for ffmpeg drawtext.

The conversion is lossless (WOFF2 decompression only): glyphs, metrics and the name table,
including the reserved font name, are unchanged. Requires fontTools and brotli:
    pip install fonttools brotli
"""
import shutil
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "apps/web/public/fonts/passion-one"
DST = ROOT / "packages/analysis/fonts"
DST.mkdir(parents=True, exist_ok=True)
for weight, name in ((900, "PassionOne-Black.ttf"), (700, "PassionOne-Bold.ttf")):
    font = TTFont(SRC / f"passion-one-latin-{weight}-normal.woff2")
    font.flavor = None
    font.save(DST / name)
    print("wrote", DST / name, font["name"].getDebugName(4))
shutil.copy(SRC / "OFL.txt", DST / "OFL.txt")
