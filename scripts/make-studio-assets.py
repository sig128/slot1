#!/usr/bin/env python3
"""Build SLOT1's Studio library: sound effects, music loops, ambience beds and visual elements.

Everything is generated from code (synthesis and SVG drawing), so the library is original and
reproducible. Output: packages/analysis/studio-assets/{sfx,music,ambience,elements}/... plus
manifest.json (the StudioAssetManifest contract) and waveforms.json (preview peaks).

Requirements: Python 3.11+, numpy, scipy, Pillow, fontTools + brotli, ffmpeg (with the native
AAC encoder) and rsvg-convert (librsvg). Run from the repository root:

    python3 scripts/make-studio-assets.py            # everything
    python3 scripts/make-studio-assets.py --only sfx # one family: sfx | music | ambience | elements
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from studio_assets import ambience, music, sfx, visuals  # noqa: E402
from studio_assets.audio_core import SR, encode_m4a, normalize, trim_tail, waveform_peaks  # noqa: E402

OUT = ROOT / "packages/analysis/studio-assets"
LICENSE = "Original (SLOT1)"

# Loudness targets (LUFS): effects by their loudest 400 ms, beds and loops over their whole length.
SFX_TARGET = -16.0
MUSIC_TARGET = -16.0
AMBIENCE_TARGET = -24.0


def prepare_fonts(tmp: Path) -> Path:
    """Convert the OFL web fonts to TTF in a temp folder and point fontconfig at it."""
    from fontTools.ttLib import TTFont

    fonts = tmp / "fonts"
    fonts.mkdir()
    barlow = next((ROOT / "node_modules/.pnpm").glob("@fontsource+barlow-condensed@*/node_modules/@fontsource/barlow-condensed/files"))
    for w in (700, 800):
        f = TTFont(barlow / f"barlow-condensed-latin-{w}-normal.woff2")
        f.flavor = None
        f.save(fonts / f"BarlowCondensed-{w}.ttf")
    for n in ("PassionOne-Black.ttf", "PassionOne-Bold.ttf"):
        shutil.copy(ROOT / "packages/analysis/fonts" / n, fonts / n)
    conf = tmp / "fonts.conf"
    conf.write_text(
        f'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>{fonts}</dir>'
        f'<cachedir>{tmp / "fc-cache"}</cachedir><include ignore_missing="yes">/etc/fonts/fonts.conf</include></fontconfig>'
    )
    visuals.set_font_dir(fonts)
    return conf


def is_really_stereo(y) -> bool:
    if y.ndim == 1:
        return False
    diff = abs(y[0] - y[1]).mean()
    return diff > 0.02 * (abs(y).mean() + 1e-9)


def build_sfx(entries: list, peaks: dict) -> None:
    for s in sfx.CATALOG:
        y = s.make()
        y = trim_tail(normalize(y, SFX_TARGET, "momentary"))
        stereo = is_really_stereo(y)
        rel = Path(s.id.removeprefix("sfx/") + ".m4a")
        encode_m4a(y, OUT / "sfx" / rel, 80 if stereo else 56, 2 if stereo else 1)
        entries.append({
            "id": s.id, "kind": "sfx", "category": s.category, "name": s.name, "tags": s.tags,
            "durationMs": int(round(y.shape[-1] / SR * 1000)), "loop": False, "file": f"sfx/{rel.as_posix()}", "license": LICENSE,
        })
        peaks[s.id] = waveform_peaks(y)


def build_music(entries: list, peaks: dict) -> None:
    for lp in music.LOOPS:
        y = music.render_loop(lp)
        y = normalize(y, MUSIC_TARGET, "integrated")
        rel = Path(f"{lp.genre}/{lp.slug}.m4a")
        encode_m4a(y, OUT / "music" / rel, 112, 2)
        mid = f"music/{lp.genre}/{lp.slug}"
        entries.append({
            "id": mid, "kind": "music", "category": lp.genre, "name": f"{lp.name} ({int(lp.bpm)} BPM)", "tags": [*lp.tags, f"{int(lp.bpm)}bpm", "loop"],
            "durationMs": int(round(y.shape[-1] / SR * 1000)), "loop": True, "file": f"music/{rel.as_posix()}", "license": LICENSE,
        })
        peaks[mid] = waveform_peaks(y)


def build_ambience(entries: list, peaks: dict) -> None:
    for b in ambience.BEDS:
        y = ambience.render_bed(b)
        y = normalize(y, AMBIENCE_TARGET, "integrated")
        rel = Path(f"{b.slug}.m4a")
        encode_m4a(y, OUT / "ambience" / rel, 64, 2)
        aid = f"ambience/{b.slug}"
        entries.append({
            "id": aid, "kind": "ambience", "category": "ambience", "name": b.name, "tags": [*b.tags, "loop", "background"],
            "durationMs": int(round(y.shape[-1] / SR * 1000)), "loop": True, "file": f"ambience/{rel.as_posix()}", "license": LICENSE,
        })
        peaks[aid] = waveform_peaks(y)


def build_elements(entries: list, fontconf: Path) -> None:
    folder = {"sticker": "stickers", "overlay": "overlays", "frame": "frames", "transition": "transitions"}
    for e in visuals.CATALOG:
        rest = e.id.split("/", 1)[1]
        rel = Path("elements") / folder[e.kind] / f"{rest}.png"
        w, h = visuals.rasterize(e.svg(), OUT / rel, fontconf, e.quantize, trim=e.kind == "sticker", gray_alpha=bool(e.extra.get("gray_alpha")))
        item = {"id": e.id, "kind": e.kind, "category": e.category, "name": e.name, "tags": e.tags, "loop": False,
                "width": w, "height": h, "file": rel.as_posix(), "license": LICENSE}
        if e.kind == "transition":
            item["durationMs"] = 600
        entries.append(item)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["sfx", "music", "ambience", "elements"])
    args = ap.parse_args()
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    peaks_path = OUT / "waveforms.json"
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"version": 1, "assets": []}
    old_peaks = json.loads(peaks_path.read_text()) if peaks_path.exists() else {}
    families = [args.only] if args.only else ["sfx", "music", "ambience", "elements"]
    kinds_of = {"sfx": {"sfx"}, "music": {"music"}, "ambience": {"ambience"}, "elements": {"sticker", "overlay", "frame", "transition"}}
    drop = set().union(*(kinds_of[f] for f in families))
    entries = [a for a in old["assets"] if a["kind"] not in drop]
    peaks = {k: v for k, v in old_peaks.items() if not any(k.startswith(p + "/") for p in drop)}
    for f in families:
        sub = {"sfx": ["sfx"], "music": ["music"], "ambience": ["ambience"], "elements": ["elements"]}[f]
        for s in sub:
            if (OUT / s).exists():
                shutil.rmtree(OUT / s)
    with tempfile.TemporaryDirectory() as td:
        fontconf = prepare_fonts(Path(td))
        if "sfx" in families:
            build_sfx(entries, peaks)
        if "music" in families:
            build_music(entries, peaks)
        if "ambience" in families:
            build_ambience(entries, peaks)
        if "elements" in families:
            build_elements(entries, fontconf)
    entries.sort(key=lambda a: a["id"])
    manifest_path.write_text(json.dumps({"version": 1, "assets": entries}, indent=1, ensure_ascii=False) + "\n")
    peaks_path.write_text(json.dumps(dict(sorted(peaks.items())), separators=(",", ":")) + "\n")
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    by_kind: dict[str, int] = {}
    for a in entries:
        by_kind[a["kind"]] = by_kind.get(a["kind"], 0) + 1
    print(f"{len(entries)} assets {by_kind}, {total / 1e6:.2f} MB, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
