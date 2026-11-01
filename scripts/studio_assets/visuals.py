"""Visual elements for the Studio library, drawn here as SVG in SLOT1's own flat-ink style (deep ink
outlines, flat fills, hard offset shadows, the site's gold / coral / apricot / ivory palette) and
rasterized to PNG. No game artwork, logos or fonts: titles use Passion One and labels Barlow
Condensed, both SIL OFL."""
from __future__ import annotations

import math
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
from fontTools.ttLib import TTFont

INK = "#140715"
IVORY = "#fbf4ea"
GOLD = "#ffc94d"
CORAL = "#ff4f87"
APRICOT = "#ffad72"
GREEN = "#9fe38f"
BLUE = "#7fb2ff"
PURPLE = "#1a0822"
PLUM = "#3a1240"
RED = "#ff3b3b"
POSTER = "Passion One"
LABEL = "Barlow Condensed"


@dataclass
class Element:
    id: str
    kind: str  # sticker | overlay | frame | transition
    category: str
    name: str
    tags: list[str]
    width: int
    height: int
    svg: Callable[[], str]
    quantize: bool = True
    extra: dict = field(default_factory=dict)


CATALOG: list[Element] = []


def element(kind: str, category: str, slug: str, name: str, tags: list[str], w: int, h: int, quantize: bool = True, **extra):
    def wrap(fn: Callable[[], str]):
        prefix = {"sticker": "sticker", "overlay": "overlay", "frame": "frame", "transition": "transition"}[kind]
        eid = f"{prefix}/{category}/{slug}" if kind == "sticker" else f"{prefix}/{slug}"
        CATALOG.append(Element(eid, kind, category, name, tags, w, h, fn, quantize, extra))
        return fn

    return wrap


# ------------------------------------------------------------------------------------------------
# Fonts (for measuring text) and SVG helpers
# ------------------------------------------------------------------------------------------------

_FONTS: dict[tuple[str, int], TTFont] = {}
FONT_DIR: Path | None = None


def set_font_dir(d: Path) -> None:
    global FONT_DIR
    FONT_DIR = d


def _font(family: str, weight: int) -> TTFont:
    key = (family, weight)
    if key not in _FONTS:
        assert FONT_DIR is not None
        name = {("Passion One", 900): "PassionOne-Black.ttf", ("Passion One", 700): "PassionOne-Bold.ttf", ("Barlow Condensed", 800): "BarlowCondensed-800.ttf", ("Barlow Condensed", 700): "BarlowCondensed-700.ttf"}[key]
        _FONTS[key] = TTFont(FONT_DIR / name)
    return _FONTS[key]


def text_width(txt: str, size: float, family: str = POSTER, weight: int = 900, spacing: float = 0.0) -> float:
    f = _font(family, weight)
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    upm = f["head"].unitsPerEm
    w = 0
    for ch in txt:
        g = cmap.get(ord(ch))
        w += hmtx[g][0] if g else upm * 0.5
    return w * size / upm + spacing * size * max(0, len(txt) - 1)


def svg_doc(w: int, h: int, body: str, defs: str = "") -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><defs>{defs}</defs>{body}</svg>'


def text(x, y, s, size, fill=GOLD, family=POSTER, weight=900, stroke=INK, sw=None, anchor="middle", italic=False, spacing=0.0, opacity=1.0, extra=""):
    sw = size * 0.12 if sw is None else sw
    style = "italic" if italic else "normal"
    ls = f' letter-spacing="{spacing * size:.2f}"' if spacing else ""
    st = f' stroke="{stroke}" stroke-width="{sw:.2f}" stroke-linejoin="round" paint-order="stroke"' if stroke else ""
    esc = s.replace("&", "&amp;").replace("<", "&lt;")
    return f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" font-family="{family}" font-weight="{weight}" font-style="{style}" font-size="{size:.1f}" fill="{fill}"{st}{ls} opacity="{opacity}" {extra}>{esc}</text>'


def shadowed(shape: str, dx=7, dy=9, color=INK) -> str:
    """shape is an SVG fragment; draws a hard offset copy behind it, recolored to `color`."""
    import re

    copy = re.sub(r'fill="(?!none)[^"]*"', f'fill="{color}"', shape)
    copy = re.sub(r'stroke="(?!none)[^"]*"', f'stroke="{color}"', copy)
    copy = re.sub(r'(fill|stroke)-opacity="[^"]*"', "", copy)
    return f'<g transform="translate({dx},{dy})">{copy}</g>{shape}'


def rrect(x, y, w, h, r, fill, stroke=INK, sw=8, extra=""):
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{r:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>'


def poly(points, fill, stroke=INK, sw=8, extra=""):
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" {extra}/>'


def path(d, fill, stroke=INK, sw=8, extra=""):
    return f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round" stroke-linecap="round" {extra}/>'


def circle(cx, cy, r, fill, stroke=INK, sw=8, extra=""):
    return f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>'


def star_points(cx, cy, ro, ri, n=5, rot=-90.0):
    pts = []
    for k in range(n * 2):
        r = ro if k % 2 == 0 else ri
        a = math.radians(rot + k * 180 / n)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def burst_points(cx, cy, ro, ri, n=14, seed=0, jitter=0.12):
    r_ = np.random.default_rng(seed)
    pts = []
    for k in range(n * 2):
        r = (ro if k % 2 == 0 else ri) * (1 + r_.uniform(-jitter, jitter))
        a = math.radians(-90 + k * 180 / n + r_.uniform(-4, 4))
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def halftone_pattern(pid: str, color: str, cell: float = 14, r: float = 3.2, opacity: float = 1.0) -> str:
    return (
        f'<pattern id="{pid}" width="{cell}" height="{cell}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
        f'<circle cx="{cell / 2}" cy="{cell / 2}" r="{r}" fill="{color}" opacity="{opacity}"/></pattern>'
    )


def banner_plate(txt: str, size: float, fill: str, plate: str | None, w_pad=60, h=None, sub: str | None = None, tilt=-3.0, spacing=0.02):
    """A result banner: big poster word on an optional tilted ink plate."""
    tw = text_width(txt, size, spacing=spacing)
    W = int(tw + w_pad * 2 + 30)
    H = int(h or size * 1.35 + (size * 0.5 if sub else 0) + 40)
    body = ""
    cx, cy = W / 2, H / 2 + size * 0.33 - (size * 0.22 if sub else 0)
    if plate:
        pw, ph = tw + w_pad * 1.6, size * 1.05 + (size * 0.5 if sub else 0)
        px, py = W / 2 - pw / 2, H / 2 - ph / 2
        body += f'<g transform="rotate({tilt} {W / 2} {H / 2})">{shadowed(rrect(px, py, pw, ph, 10, plate, INK, 9), 9, 11)}</g>'
    body += text(cx, cy, txt, size, fill, spacing=spacing)
    if sub:
        body += text(cx, cy + size * 0.62, sub, size * 0.32, IVORY, LABEL, 800, INK, size * 0.05, spacing=0.08)
    return svg_doc(W, H, body), W, H


# ------------------------------------------------------------------------------------------------
# HUD
# ------------------------------------------------------------------------------------------------

def _wanted(n_on: int) -> str:
    W, H = 620, 140
    body = ""
    for k in range(5):
        cx = 66 + k * 122
        pts = star_points(cx, 72, 54, 23)
        on = k < 5 - (5 - n_on)
        body += shadowed(poly(pts, GOLD if on else "none", INK, 9 if on else 8, "" if on else f'stroke-opacity="1"'), 5, 7) if on else poly(pts, PURPLE, IVORY, 6, 'fill-opacity="0.35" stroke-opacity="0.85"')
    return svg_doc(W, H, body)


for _n in range(6):
    element("sticker", "hud", f"wanted-stars-{_n}", f"Wanted stars ({_n} of 5)", ["hud", "stars", "wanted", "police", "chase", "level"], 620, 140)(lambda _n=_n: _wanted(_n))


def _radar(blips: bool) -> str:
    S = 420
    c = S / 2
    body = shadowed(circle(c, c, 180, PURPLE, INK, 12, 'fill-opacity="0.82"'), 6, 8)
    body += f'<clipPath id="rc"><circle cx="{c}" cy="{c}" r="172"/></clipPath>'
    grid = "".join(f'<line x1="{c - 180}" y1="{c + o}" x2="{c + 180}" y2="{c + o}" stroke="{IVORY}" stroke-opacity="0.18" stroke-width="3"/>' for o in (-120, -60, 0, 60, 120))
    grid += "".join(f'<line x1="{c + o}" y1="{c - 180}" x2="{c + o}" y2="{c + 180}" stroke="{IVORY}" stroke-opacity="0.18" stroke-width="3"/>' for o in (-120, -60, 0, 60, 120))
    roads = f'<path d="M{c - 170},{c + 60} C{c - 60},{c + 20} {c + 20},{c + 90} {c + 170},{c + 30}" fill="none" stroke="{APRICOT}" stroke-width="10" stroke-opacity="0.9"/>'
    roads += f'<path d="M{c - 40},{c - 170} L{c - 10},{c + 170}" fill="none" stroke="{IVORY}" stroke-width="7" stroke-opacity="0.55"/>'
    body += f'<g clip-path="url(#rc)">{grid}{roads}</g>'
    body += poly([(c, c - 26), (c + 18, c + 20), (c, c + 10), (c - 18, c + 20)], IVORY, INK, 5)
    if blips:
        for x, y in ((c + 70, c - 60), (c - 90, c + 30), (c + 30, c + 110)):
            body += circle(x, y, 14, CORAL, INK, 5)
    body += circle(c, c - 180, 26, IVORY, INK, 6) + text(c, c - 170, "N", 30, INK, LABEL, 800, None)
    return svg_doc(S, S, body)


element("sticker", "hud", "radar-frame", "Radar (empty)", ["hud", "radar", "minimap", "map", "gps"], 420, 420)(lambda: _radar(False))
element("sticker", "hud", "radar-blips", "Radar with blips", ["hud", "radar", "minimap", "map", "targets", "blips"], 420, 420)(lambda: _radar(True))


def _cash(txt: str) -> str:
    size = 110
    tw = text_width(txt, size, LABEL, 800)
    W, H = int(tw + 70), 170
    body = text(W / 2, 128, txt, size, CORAL if txt.startswith("-") else GREEN, LABEL, 800, INK, 14, italic=True)
    return svg_doc(W, H, body)


for slug, txt, nm in (("cash-plus-1k", "+$1,000", "Cash +$1,000"), ("cash-plus-50k", "+$50,000", "Cash +$50,000"), ("cash-million", "$1,000,000", "Cash $1,000,000"), ("cash-minus", "-$500", "Cash -$500")):
    element("sticker", "hud", slug, nm, ["hud", "money", "cash", "dollars", "score", "reward"], 0, 0)(lambda txt=txt: _cash(txt))


def _bar(fill_frac: float, color: str, label: str) -> str:
    W, H = 640, 120
    body = shadowed(rrect(20, 34, 590, 52, 8, PURPLE, INK, 9, 'fill-opacity="0.85"'), 6, 8)
    body += rrect(30, 44, 570 * fill_frac, 32, 4, color, "none", 0)
    body += rrect(30, 44, 570 * fill_frac, 10, 3, IVORY, "none", 0, 'fill-opacity="0.35"')
    body += text(40, 30, label, 30, IVORY, LABEL, 800, INK, 6, anchor="start", spacing=0.08)
    return svg_doc(W, H, body)


element("sticker", "hud", "health-bar-full", "Health bar (full)", ["hud", "health", "bar", "life", "full"], 640, 120)(lambda: _bar(1.0, GREEN, "HEALTH"))
element("sticker", "hud", "health-bar-low", "Health bar (low)", ["hud", "health", "bar", "low", "danger", "dying"], 640, 120)(lambda: _bar(0.18, CORAL, "HEALTH"))
element("sticker", "hud", "armor-bar", "Armor bar", ["hud", "armor", "shield", "bar"], 640, 120)(lambda: _bar(0.85, BLUE, "ARMOR"))


def _ammo() -> str:
    W, H = 420, 150
    body = shadowed(rrect(20, 24, 370, 100, 12, PURPLE, INK, 9, 'fill-opacity="0.85"'), 6, 8)
    for k in range(6):
        x = 46 + k * 26
        body += path(f"M{x},104 L{x},66 Q{x + 9},40 {x + 18},66 L{x + 18},104 Z", GOLD, INK, 4)
    body += text(300, 98, "30/90", 52, IVORY, LABEL, 800, INK, 7)
    return svg_doc(W, H, body)


element("sticker", "hud", "ammo-plate", "Ammo counter", ["hud", "ammo", "bullets", "weapon", "counter"], 420, 150)(_ammo)


# ------------------------------------------------------------------------------------------------
# Phone
# ------------------------------------------------------------------------------------------------

def _phone_bubble() -> str:
    W, H = 760, 230
    body = shadowed(rrect(24, 24, 700, 170, 34, IVORY, INK, 9), 7, 9)
    body += circle(108, 109, 52, CORAL, INK, 7) + text(108, 128, "S1", 46, IVORY, POSTER, 900, INK, 6)
    body += text(184, 92, "NEW MESSAGE", 34, CORAL, LABEL, 800, None, anchor="start", spacing=0.06)
    body += text(184, 146, "Meet me at the docks. Bring the car.", 40, INK, LABEL, 700, None, anchor="start")
    return svg_doc(W, H, body)


def _incoming_call() -> str:
    W, H = 520, 640
    body = shadowed(rrect(24, 24, 460, 580, 46, PURPLE, INK, 10), 8, 10)
    body += circle(254, 210, 92, APRICOT, INK, 8) + text(254, 244, "?", 110, INK, POSTER, 900, None)
    body += text(254, 360, "INCOMING CALL", 44, IVORY, LABEL, 800, None, spacing=0.06)
    body += text(254, 410, "Unknown number", 34, IVORY, LABEL, 700, None, opacity=0.7)
    body += circle(150, 510, 50, CORAL, INK, 7) + path("M128,500 q22,-14 44,0 l-6,14 q-16,-8 -32,0 z", IVORY, INK, 3)
    body += circle(358, 510, 50, GREEN, INK, 7) + path("M336,520 q22,14 44,0 l-6,-14 q-16,8 -32,0 z", IVORY, INK, 3)
    return svg_doc(W, H, body)


def _notif_banner() -> str:
    W, H = 900, 170
    body = shadowed(rrect(20, 20, 840, 120, 22, PURPLE, INK, 8, 'fill-opacity="0.92"'), 6, 8)
    body += rrect(44, 44, 72, 72, 16, GOLD, INK, 6) + text(80, 98, "!", 58, INK, POSTER, 900, None)
    body += text(140, 72, "SLOT1", 30, GOLD, LABEL, 800, None, anchor="start", spacing=0.08)
    body += text(140, 116, "You've got a new contact.", 40, IVORY, LABEL, 700, None, anchor="start")
    return svg_doc(W, H, body)


def _achievement() -> str:
    W, H = 900, 190
    body = shadowed(rrect(20, 20, 840, 140, 70, INK, GOLD, 8), 6, 8)
    body += circle(96, 90, 52, GOLD, INK, 7)
    body += path("M74,62 h44 v22 q0,26 -22,30 q-22,-4 -22,-30 z M86,118 h20 v12 h12 v8 h-44 v-8 h12 z", INK, INK, 2)
    body += text(176, 80, "ACHIEVEMENT UNLOCKED", 30, GOLD, LABEL, 800, None, anchor="start", spacing=0.1)
    body += text(176, 128, "First clip shared", 46, IVORY, LABEL, 800, None, anchor="start")
    return svg_doc(W, H, body)


element("sticker", "phone", "text-bubble", "Text message", ["phone", "text", "message", "sms", "chat", "notification"], 760, 230)(_phone_bubble)
element("sticker", "phone", "incoming-call", "Incoming call", ["phone", "call", "ringing", "contact"], 520, 640)(_incoming_call)
element("sticker", "phone", "notification-banner", "Notification banner", ["phone", "notification", "banner", "alert", "popup"], 900, 170)(_notif_banner)
element("sticker", "phone", "achievement-toast", "Achievement toast", ["phone", "achievement", "trophy", "unlock", "award"], 900, 190)(_achievement)


# ------------------------------------------------------------------------------------------------
# Mission cards and result banners (our own words and styling)
# ------------------------------------------------------------------------------------------------

def _title_plate() -> str:
    W, H = 1400, 260
    body = f'<g transform="rotate(-2 {W / 2} {H / 2})">{shadowed(rrect(60, 50, 1280, 150, 6, GOLD, INK, 10), 10, 12)}</g>'
    body += f'<rect x="110" y="96" width="1180" height="10" fill="{INK}" opacity="0.25" transform="rotate(-2 {W / 2} {H / 2})"/>'
    return svg_doc(W, H, body)


def _objective() -> str:
    W, H = 1400, 200
    body = shadowed(rrect(40, 40, 1300, 110, 6, PURPLE, INK, 8, 'fill-opacity="0.88"'), 6, 8)
    body += rrect(40, 40, 22, 110, 3, GOLD, INK, 6)
    body += text(96, 84, "OBJECTIVE", 30, GOLD, LABEL, 800, None, anchor="start", spacing=0.12)
    body += f'<rect x="96" y="104" width="760" height="10" rx="5" fill="{IVORY}" opacity="0.35"/>'
    return svg_doc(W, H, body)


element("sticker", "mission", "title-plate", "Mission title plate (blank)", ["mission", "title", "card", "plate", "gold", "blank"], 1400, 260)(_title_plate)
element("sticker", "mission", "objective-lower-third", "Objective lower third (blank)", ["mission", "objective", "lower-third", "subtitle", "blank"], 1400, 200)(_objective)

for slug, word, fill, plate, sub, tags in (
    ("banner-mission-complete", "MISSION COMPLETE", GOLD, None, None, ["win", "success", "complete", "passed"]),
    ("banner-mission-failed", "MISSION FAILED", CORAL, None, None, ["fail", "lose", "failed"]),
    ("banner-wasted", "WASTED", IVORY, CORAL, None, ["dead", "death", "fail", "wasted"]),
    ("banner-busted", "BUSTED", IVORY, BLUE, None, ["arrested", "police", "caught", "busted"]),
    ("banner-gg", "GG", GOLD, PLUM, "GOOD GAME", ["gg", "good-game", "win"]),
    ("banner-clutch", "CLUTCH", GOLD, INK, None, ["clutch", "hype", "win", "save"]),
    ("banner-no-way", "NO WAY!", IVORY, CORAL, None, ["no-way", "shock", "reaction", "hype"]),
    ("banner-new-record", "NEW RECORD", GOLD, PLUM, "PERSONAL BEST", ["record", "best", "score", "win"]),
):
    element("sticker", "mission", slug, f"Banner: {word.title()}", ["banner", "result", *tags], 0, 0)(
        lambda word=word, fill=fill, plate=plate, sub=sub: banner_plate(word, 150 if len(word) < 9 else 120, fill, plate, sub=sub)[0]
    )


# ------------------------------------------------------------------------------------------------
# Annotations
# ------------------------------------------------------------------------------------------------

def _arrow(color: str) -> str:
    W, H = 520, 260
    pts = [(30, 100), (300, 100), (300, 40), (480, 130), (300, 220), (300, 160), (30, 160)]
    return svg_doc(W, H, shadowed(poly(pts, color, INK, 10), 8, 10))


def _arrow_curved(color: str) -> str:
    W, H = 520, 420
    d = "M60,360 C80,180 220,90 380,110 L372,52 L486,150 L360,230 L368,172 C250,160 150,230 140,370 Z"
    return svg_doc(W, H, shadowed(path(d, color, INK, 10), 8, 10))


for c, nm in ((CORAL, "coral"), (GOLD, "gold"), (IVORY, "ivory")):
    element("sticker", "annotate", f"arrow-{nm}", f"Arrow ({nm})", ["arrow", "point", "look", "pointer", nm], 520, 260)(lambda c=c: _arrow(c))
for c, nm in ((CORAL, "coral"), (GOLD, "gold")):
    element("sticker", "annotate", f"arrow-curved-{nm}", f"Curved arrow ({nm})", ["arrow", "curved", "point", "look", nm], 520, 420)(lambda c=c: _arrow_curved(c))


def _hand_circle(color: str, seed: int) -> str:
    W, H = 560, 440
    r = np.random.default_rng(seed)
    pts = []
    for k in range(64):
        a = k / 64 * 2 * math.pi * 1.12
        rx, ry = 240 * (1 + r.uniform(-0.03, 0.03)), 175 * (1 + r.uniform(-0.03, 0.03))
        pts.append((280 + rx * math.cos(a - 0.4), 220 + ry * math.sin(a - 0.4)))
    d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    under = f'<path d="{d}" fill="none" stroke="{INK}" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>'
    over = f'<path d="{d}" fill="none" stroke="{color}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>'
    return svg_doc(W, H, under + over)


element("sticker", "annotate", "circle-coral", "Hand-drawn circle (coral)", ["circle", "highlight", "look", "mark"], 560, 440)(lambda: _hand_circle(CORAL, 7001))
element("sticker", "annotate", "circle-gold", "Hand-drawn circle (gold)", ["circle", "highlight", "look", "mark"], 560, 440)(lambda: _hand_circle(GOLD, 7002))
element("sticker", "annotate", "ring-dashed", "Target ring (dashed)", ["ring", "target", "focus", "highlight", "crosshair"], 400, 400)(
    lambda: svg_doc(400, 400, f'<circle cx="200" cy="200" r="170" fill="none" stroke="{INK}" stroke-width="26"/><circle cx="200" cy="200" r="170" fill="none" stroke="{GOLD}" stroke-width="14" stroke-dasharray="42 24"/>'
                    + "".join(f'<line x1="{200 + 120 * math.cos(a)}" y1="{200 + 120 * math.sin(a)}" x2="{200 + 196 * math.cos(a)}" y2="{200 + 196 * math.sin(a)}" stroke="{INK}" stroke-width="16"/><line x1="{200 + 124 * math.cos(a)}" y1="{200 + 124 * math.sin(a)}" x2="{200 + 192 * math.cos(a)}" y2="{200 + 192 * math.sin(a)}" stroke="{IVORY}" stroke-width="7"/>' for a in (0, math.pi / 2, math.pi, 3 * math.pi / 2)))
)


def _callout(left: bool) -> str:
    W, H = 640, 330
    if left:
        d = "M40,40 H600 V230 H200 L110,300 L130,230 H40 Z"
    else:
        d = "M40,40 H600 V230 H510 L530,300 L440,230 H40 Z"
    return svg_doc(W, H, shadowed(path(d, IVORY, INK, 10), 8, 10))


element("sticker", "annotate", "callout-left", "Callout box (left tail)", ["callout", "box", "note", "label", "caption"], 640, 330)(lambda: _callout(True))
element("sticker", "annotate", "callout-right", "Callout box (right tail)", ["callout", "box", "note", "label", "caption"], 640, 330)(lambda: _callout(False))


def _speech(shout: bool) -> str:
    W, H = 620, 460
    if shout:
        pts = burst_points(310, 210, 270, 190, 16, 7011, 0.08)
        shape = poly(pts, IVORY, INK, 10)
    else:
        shape = path("M310,40 C480,40 580,110 580,200 C580,290 480,350 330,350 L250,430 L262,346 C130,330 40,280 40,200 C40,110 140,40 310,40 Z", IVORY, INK, 10)
    return svg_doc(W, H, shadowed(shape, 8, 10))


element("sticker", "annotate", "speech-bubble", "Speech bubble", ["speech", "bubble", "talk", "say", "comic"], 620, 460)(lambda: _speech(False))
element("sticker", "annotate", "speech-bubble-shout", "Shout bubble", ["speech", "bubble", "shout", "yell", "comic"], 620, 460)(lambda: _speech(True))


def _thought() -> str:
    W, H = 620, 480
    blobs = [(310, 190, 200, 130), (190, 160, 110, 90), (430, 150, 110, 90), (250, 260, 120, 80), (400, 260, 120, 80)]
    under = "".join(f'<ellipse cx="{x}" cy="{y}" rx="{rx + 8}" ry="{ry + 8}" fill="{INK}"/>' for x, y, rx, ry in blobs)
    over = "".join(f'<ellipse cx="{x}" cy="{y}" rx="{rx - 2}" ry="{ry - 2}" fill="{IVORY}"/>' for x, y, rx, ry in blobs)
    tails = circle(170, 390, 26, IVORY, INK, 8) + circle(120, 440, 15, IVORY, INK, 7)
    return svg_doc(W, H, f'<g transform="translate(8,10)">{under}</g>{under}{over}{tails}')


element("sticker", "annotate", "thought-bubble", "Thought bubble", ["thought", "bubble", "think", "comic", "idea"], 620, 480)(_thought)
element("sticker", "annotate", "scribble-underline", "Scribble underline", ["underline", "scribble", "highlight", "mark"], 700, 140)(
    lambda: svg_doc(700, 140, f'<path d="M30,90 C150,40 260,120 370,70 S600,40 670,80" fill="none" stroke="{INK}" stroke-width="30" stroke-linecap="round"/><path d="M30,90 C150,40 260,120 370,70 S600,40 670,80" fill="none" stroke="{CORAL}" stroke-width="16" stroke-linecap="round"/>')
)
element("sticker", "annotate", "x-mark", "X mark", ["x", "cross", "wrong", "no", "fail"], 360, 360)(
    lambda: svg_doc(360, 360, shadowed(poly([(60, 100), (100, 60), (180, 140), (260, 60), (300, 100), (220, 180), (300, 260), (260, 300), (180, 220), (100, 300), (60, 260), (140, 180)], CORAL, INK, 10), 8, 10))
)
element("sticker", "annotate", "check-mark", "Check mark", ["check", "tick", "yes", "correct", "done"], 380, 340)(
    lambda: svg_doc(380, 340, shadowed(poly([(40, 190), (90, 140), (150, 200), (300, 50), (350, 100), (150, 300)], GREEN, INK, 10), 8, 10))
)


# ------------------------------------------------------------------------------------------------
# Badges and countdown
# ------------------------------------------------------------------------------------------------

def _badge(label: str, bg: str, fg: str, dot: str | None = None) -> str:
    size = 64
    tw = text_width(label, size, LABEL, 800, 0.08)
    W = int(tw + 90 + (60 if dot else 0))
    H = 130
    body = shadowed(rrect(16, 16, W - 40, 88, 12, bg, INK, 8), 6, 8)
    x = 46
    if dot:
        body += circle(x + 14, 60, 16, dot, INK, 5)
        x += 50
    body += text(x, 83, label, size, fg, LABEL, 800, None, anchor="start", spacing=0.08)
    return svg_doc(W, H, body)


for slug, label, bg, fg, dot in (
    ("live", "LIVE", CORAL, IVORY, IVORY), ("rec", "REC", INK, IVORY, RED), ("new", "NEW", GOLD, INK, None),
    ("replay", "REPLAY", PLUM, IVORY, None), ("slow-mo", "SLOW-MO", BLUE, INK, None), ("speed-2x", "2X SPEED", APRICOT, INK, None), ("clip", "CLIP", IVORY, INK, CORAL),
):
    element("sticker", "badge", slug, f"Badge: {label.title()}", ["badge", "label", slug.replace("-", " "), label.lower()], 0, 0)(lambda label=label, bg=bg, fg=fg, dot=dot: _badge(label, bg, fg, dot))

for slug, label in (("3", "3"), ("2", "2"), ("1", "1"), ("go", "GO!")):
    element("sticker", "countdown", f"countdown-{slug}", f"Countdown {label}", ["countdown", "timer", "race", "start", label.lower()], 0, 0)(
        lambda label=label: banner_plate(label, 260, GOLD, None, w_pad=40)[0]
    )


# ------------------------------------------------------------------------------------------------
# Reactions (drawn here, not emoji fonts)
# ------------------------------------------------------------------------------------------------

def _burst_word(word: str, color: str, bg: str, seed: int) -> str:
    W, H = 520, 460
    body = shadowed(poly(burst_points(260, 230, 220, 150, 14, seed), bg, INK, 10), 8, 10)
    body += text(260, 230 + 70, word, 200, color, POSTER, 900, INK, 18)
    return svg_doc(W, H, body)


element("sticker", "reaction", "exclamation", "Exclamation burst", ["reaction", "exclamation", "alert", "shock", "!"], 520, 460)(lambda: _burst_word("!", IVORY, CORAL, 7101))
element("sticker", "reaction", "question", "Question burst", ["reaction", "question", "confused", "what", "?"], 520, 460)(lambda: _burst_word("?", INK, GOLD, 7102))


def _skull() -> str:
    W, H = 440, 460
    head = path("M220,40 C340,40 400,120 400,210 C400,270 370,300 340,318 L340,370 L100,370 L100,318 C70,300 40,270 40,210 C40,120 100,40 220,40 Z", IVORY, INK, 10)
    eyes = f'<ellipse cx="150" cy="220" rx="46" ry="52" fill="{INK}"/><ellipse cx="290" cy="220" rx="46" ry="52" fill="{INK}"/>'
    nose = poly([(220, 270), (198, 312), (242, 312)], INK, INK, 4)
    teeth = "".join(f'<line x1="{x}" y1="330" x2="{x}" y2="370" stroke="{INK}" stroke-width="8"/>' for x in (160, 200, 240, 280))
    return svg_doc(W, H, f'<g transform="translate(8,10)"><path d="M220,40 C340,40 400,120 400,210 C400,270 370,300 340,318 L340,370 L100,370 L100,318 C70,300 40,270 40,210 C40,120 100,40 220,40 Z" fill="{INK}"/></g>' + head + eyes + nose + teeth)


def _fire() -> str:
    W, H = 420, 520
    outer = "M210,40 C250,130 350,170 350,310 C350,420 290,480 210,480 C130,480 70,420 70,310 C70,220 130,190 140,110 C170,150 180,190 175,230 C200,180 215,110 210,40 Z"
    inner = "M210,230 C235,290 285,320 285,385 C285,440 250,465 210,465 C170,465 135,440 135,390 C135,340 175,320 180,280 C195,300 200,315 198,335 C210,300 215,270 210,230 Z"
    return svg_doc(W, H, shadowed(path(outer, CORAL, INK, 10), 8, 10) + path(inner, GOLD, INK, 7))


def _hundred() -> str:
    W, H = 560, 420
    body = text(280, 260, "100", 250, CORAL, POSTER, 900, INK, 18, extra='transform="rotate(-8 280 220)"')
    body += f'<g transform="rotate(-8 280 220)"><path d="M80,300 H480" stroke="{INK}" stroke-width="30" stroke-linecap="round"/><path d="M80,300 H480" stroke="{CORAL}" stroke-width="14" stroke-linecap="round"/><path d="M110,350 H450" stroke="{INK}" stroke-width="30" stroke-linecap="round"/><path d="M110,350 H450" stroke="{CORAL}" stroke-width="14" stroke-linecap="round"/></g>'
    return svg_doc(W, H, body)


def _laugh() -> str:
    W, H = 460, 460
    face = shadowed(circle(230, 230, 190, GOLD, INK, 10), 8, 10)
    eyes = path("M120,190 Q150,150 180,190", "none", INK, 14) + path("M280,190 Q310,150 340,190", "none", INK, 14)
    mouth = path("M120,250 Q230,400 340,250 Z", INK, INK, 8) + path("M150,262 Q230,300 310,262 Z", IVORY, INK, 4)
    tears = path("M88,200 q-30,40 -10,70 q20,10 30,-20 z", BLUE, INK, 6) + path("M372,200 q30,40 10,70 q-20,10 -30,-20 z", BLUE, INK, 6)
    return svg_doc(W, H, face + eyes + mouth + tears)


def _heart() -> str:
    W, H = 460, 420
    d = "M230,380 C120,300 40,230 40,150 C40,90 90,45 150,45 C190,45 215,70 230,95 C245,70 270,45 310,45 C370,45 420,90 420,150 C420,230 340,300 230,380 Z"
    return svg_doc(W, H, shadowed(path(d, CORAL, INK, 10), 8, 10) + path("M110,120 C120,95 140,85 165,85", "none", IVORY, 14))


def _eyes() -> str:
    W, H = 520, 300
    body = ""
    for cx in (150, 370):
        body += shadowed(f'<ellipse cx="{cx}" cy="150" rx="105" ry="120" fill="{IVORY}" stroke="{INK}" stroke-width="10"/>', 6, 8)
        body += circle(cx + 30, 170, 44, INK, INK, 2) + circle(cx + 44, 154, 12, IVORY, IVORY, 1)
    return svg_doc(W, H, body)


def _money_bag() -> str:
    W, H = 440, 500
    bag = path("M220,140 C340,160 390,280 390,360 C390,440 320,470 220,470 C120,470 50,440 50,360 C50,280 100,160 220,140 Z", APRICOT, INK, 10)
    neck = path("M160,140 L120,60 C170,80 270,80 320,60 L280,140 Z", APRICOT, INK, 10)
    tie = rrect(150, 128, 140, 26, 12, CORAL, INK, 7)
    return svg_doc(W, H, f'<g transform="translate(8,10)">{path("M220,140 C340,160 390,280 390,360 C390,440 320,470 220,470 C120,470 50,440 50,360 C50,280 100,160 220,140 Z", INK, INK, 10)}</g>' + bag + neck + tie + text(220, 380, "$", 170, GREEN, LABEL, 800, INK, 14))


def _crown() -> str:
    W, H = 520, 360
    pts = [(50, 290), (40, 90), (150, 190), (260, 50), (370, 190), (480, 90), (470, 290)]
    body = shadowed(poly(pts, GOLD, INK, 10), 8, 10) + rrect(48, 270, 424, 56, 8, GOLD, INK, 10)
    for x, c in ((150, CORAL), (260, BLUE), (370, GREEN)):
        body += circle(x, 298, 15, c, INK, 5)
    return svg_doc(W, H, body)


def _siren_light() -> str:
    W, H = 420, 440
    dome = path("M80,300 C80,150 130,80 210,80 C290,80 340,150 340,300 Z", CORAL, INK, 10)
    base = rrect(50, 290, 320, 70, 10, INK, INK, 4)
    glow = "".join(f'<line x1="{210 + 150 * math.cos(a)}" y1="{180 + 150 * math.sin(a)}" x2="{210 + 200 * math.cos(a)}" y2="{180 + 200 * math.sin(a)}" stroke="{GOLD}" stroke-width="14" stroke-linecap="round"/>' for a in (-2.6, -2.0, -1.57, -1.14, -0.54))
    shine = path("M130,240 C130,170 150,130 190,115", "none", IVORY, 14)
    return svg_doc(W, H, glow + f'<g transform="translate(8,10)">{base}</g>' + dome + base + shine)


def _lightning() -> str:
    W, H = 360, 520
    pts = [(220, 30), (70, 290), (170, 290), (120, 490), (300, 210), (195, 210), (260, 30)]
    return svg_doc(W, H, shadowed(poly(pts, GOLD, INK, 10), 8, 10))


element("sticker", "reaction", "skull", "Skull", ["reaction", "skull", "dead", "rip", "fail", "wasted"], 440, 460)(_skull)
element("sticker", "reaction", "fire", "Fire", ["reaction", "fire", "hot", "lit", "hype"], 420, 520)(_fire)
element("sticker", "reaction", "hundred", "100", ["reaction", "100", "perfect", "hype", "score"], 560, 420)(_hundred)
element("sticker", "reaction", "laugh", "Laughing face", ["reaction", "laugh", "lol", "funny", "lmao"], 460, 460)(_laugh)
element("sticker", "reaction", "heart", "Heart", ["reaction", "heart", "love", "like"], 460, 420)(_heart)
element("sticker", "reaction", "eyes", "Eyes", ["reaction", "eyes", "look", "watch", "sus"], 520, 300)(_eyes)
element("sticker", "reaction", "money-bag", "Money bag", ["reaction", "money", "bag", "cash", "heist", "rich"], 440, 500)(_money_bag)
element("sticker", "reaction", "crown", "Crown", ["reaction", "crown", "king", "winner", "best"], 520, 360)(_crown)
element("sticker", "reaction", "siren-light", "Siren light", ["reaction", "siren", "police", "alert", "emergency"], 420, 440)(_siren_light)
element("sticker", "reaction", "lightning", "Lightning bolt", ["reaction", "lightning", "fast", "power", "energy"], 360, 520)(_lightning)


# ------------------------------------------------------------------------------------------------
# Overlays (full frame, mostly translucent)
# ------------------------------------------------------------------------------------------------

FW, FH = 1920, 1080
OW, OH = 1280, 720


def _scanlines() -> str:
    pat = f'<pattern id="sl" width="8" height="6" patternUnits="userSpaceOnUse"><rect width="8" height="3" fill="{INK}" opacity="0.35"/></pattern>'
    return svg_doc(FW, FH, f'<rect width="{FW}" height="{FH}" fill="url(#sl)"/>', pat)


def _vignette(strength: float, inner: float) -> str:
    g = f'<radialGradient id="vg" cx="50%" cy="50%" r="72%"><stop offset="{inner}" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="{INK}" stop-opacity="{strength}"/></radialGradient>'
    return svg_doc(OW, OH, f'<rect width="{OW}" height="{OH}" fill="url(#vg)"/>', g)


def _crt() -> str:
    g = f'<radialGradient id="vg" cx="50%" cy="50%" r="75%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="0.95" stop-color="#000" stop-opacity="0.85"/><stop offset="1" stop-color="#000" stop-opacity="1"/></radialGradient>'
    pat = f'<pattern id="sl" width="6" height="4" patternUnits="userSpaceOnUse"><rect width="6" height="2" fill="#000" opacity="0.25"/></pattern>'
    return svg_doc(OW, OH, f'<rect width="{OW}" height="{OH}" fill="url(#sl)"/><rect width="{OW}" height="{OH}" fill="url(#vg)"/>', g + pat)


def _halftone(full: bool) -> str:
    defs = halftone_pattern("ht", INK, 18, 5, 0.55)
    if full:
        return svg_doc(OW, OH, f'<rect width="{OW}" height="{OH}" fill="url(#ht)" opacity="0.5"/>', defs)
    defs += f'<radialGradient id="m" cx="100%" cy="100%" r="80%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient><mask id="mk"><rect width="{OW}" height="{OH}" fill="url(#m)"/></mask>'
    return svg_doc(OW, OH, f'<rect width="{OW}" height="{OH}" fill="url(#ht)" mask="url(#mk)"/>', defs)


def _leak(seed: int, colors: list[str]) -> str:
    r = np.random.default_rng(seed)
    defs = '<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="110"/></filter>'
    body = ""
    for k, c in enumerate(colors):
        cx = r.uniform(0, OW) if k else r.choice([0, OW])
        cy = r.uniform(0, OH)
        body += f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{r.uniform(260, 520):.0f}" ry="{r.uniform(180, 380):.0f}" fill="{c}" opacity="{r.uniform(0.45, 0.75):.2f}"/>'
    return svg_doc(OW, OH, f'<g filter="url(#b)">{body}</g>', defs)


GW, GH = 960, 540


def _grain() -> str:
    defs = '<filter id="n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 1.1 -0.45"/></filter>'
    return svg_doc(GW, GH, f'<rect width="{GW}" height="{GH}" filter="url(#n)"/>', defs)


def _vhs_noise() -> str:
    r = np.random.default_rng(7301)
    body = ""
    for k in range(26):
        y = r.uniform(0, OH)
        h = r.uniform(2, 14)
        body += f'<rect x="0" y="{y:.0f}" width="{OW}" height="{h:.0f}" fill="{IVORY}" opacity="{r.uniform(0.04, 0.16):.2f}"/>'
    for k in range(6):
        y = r.uniform(0, OH)
        body += f'<rect x="{r.uniform(-200, 400):.0f}" y="{y:.0f}" width="{r.uniform(300, 900):.0f}" height="4" fill="{CORAL}" opacity="0.25"/>'
    return svg_doc(OW, OH, body)


def _dust() -> str:
    r = np.random.default_rng(7401)
    body = ""
    for k in range(160):
        body += f'<circle cx="{r.uniform(0, OW):.0f}" cy="{r.uniform(0, OH):.0f}" r="{r.uniform(0.8, 3.2):.1f}" fill="{IVORY}" opacity="{r.uniform(0.25, 0.7):.2f}"/>'
    for k in range(10):
        x = r.uniform(0, OW)
        body += f'<path d="M{x:.0f},{r.uniform(0, OH * 0.4):.0f} q{r.uniform(-20, 20):.0f},{r.uniform(80, 200):.0f} {r.uniform(-10, 10):.0f},{r.uniform(200, 420):.0f}" stroke="{IVORY}" stroke-width="{r.uniform(1, 2.2):.1f}" fill="none" opacity="{r.uniform(0.2, 0.5):.2f}"/>'
    return svg_doc(OW, OH, body)


def _sunset_wash() -> str:
    g = f'<linearGradient id="sw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{CORAL}" stop-opacity="0.38"/><stop offset="0.55" stop-color="{APRICOT}" stop-opacity="0.12"/><stop offset="1" stop-color="{PURPLE}" stop-opacity="0.45"/></linearGradient>'
    return svg_doc(OW, OH, f'<rect width="{OW}" height="{OH}" fill="url(#sw)"/>', g)


def _rain_streaks() -> str:
    r = np.random.default_rng(7501)
    body = ""
    for k in range(260):
        x, y = r.uniform(-100, OW), r.uniform(-100, OH)
        ln = r.uniform(20, 70)
        body += f'<line x1="{x:.0f}" y1="{y:.0f}" x2="{x + ln * 0.25:.0f}" y2="{y + ln:.0f}" stroke="{IVORY}" stroke-width="{r.uniform(1, 2.4):.1f}" opacity="{r.uniform(0.15, 0.45):.2f}" stroke-linecap="round"/>'
    return svg_doc(OW, OH, body)


element("overlay", "texture", "scanlines", "Scanlines", ["overlay", "scanlines", "retro", "crt", "tv"], FW, FH, False)(_scanlines)
element("overlay", "texture", "crt-screen", "CRT screen", ["overlay", "crt", "tv", "retro", "vignette"], OW, OH, False)(_crt)
element("overlay", "texture", "vignette-dark", "Vignette (dark)", ["overlay", "vignette", "dark", "focus", "cinematic"], OW, OH, False)(lambda: _vignette(0.85, 0.45))
element("overlay", "texture", "vignette-soft", "Vignette (soft)", ["overlay", "vignette", "soft", "subtle"], OW, OH, False)(lambda: _vignette(0.5, 0.6))
element("overlay", "texture", "halftone-dots", "Halftone dots", ["overlay", "halftone", "comic", "dots", "print"], OW, OH, True)(lambda: _halftone(True))
element("overlay", "texture", "halftone-corner", "Halftone corner", ["overlay", "halftone", "comic", "corner", "print"], OW, OH, True)(lambda: _halftone(False))
element("overlay", "light", "light-leak-warm-01", "Light leak (warm 1)", ["overlay", "light-leak", "warm", "film", "sunset"], OW, OH, False)(lambda: _leak(7601, [APRICOT, CORAL, GOLD]))
element("overlay", "light", "light-leak-warm-02", "Light leak (warm 2)", ["overlay", "light-leak", "warm", "film"], OW, OH, False)(lambda: _leak(7602, [GOLD, APRICOT]))
element("overlay", "light", "light-leak-warm-03", "Light leak (warm 3)", ["overlay", "light-leak", "warm", "glow"], OW, OH, False)(lambda: _leak(7603, [CORAL, APRICOT, CORAL]))
element("overlay", "light", "light-leak-neon-01", "Light leak (neon 1)", ["overlay", "light-leak", "neon", "night", "vice"], OW, OH, False)(lambda: _leak(7604, [CORAL, BLUE, "#b06cff"]))
element("overlay", "light", "light-leak-neon-02", "Light leak (neon 2)", ["overlay", "light-leak", "neon", "night"], OW, OH, False)(lambda: _leak(7605, ["#b06cff", CORAL]))
element("overlay", "texture", "film-grain", "Film grain", ["overlay", "grain", "film", "noise", "texture"], GW, GH, False, gray_alpha=True)(_grain)
element("overlay", "texture", "vhs-noise", "VHS noise bars", ["overlay", "vhs", "noise", "retro", "glitch", "tape"], OW, OH, False)(_vhs_noise)
element("overlay", "texture", "dust-scratches", "Dust and scratches", ["overlay", "dust", "scratches", "film", "old"], OW, OH, False)(_dust)
element("overlay", "light", "sunset-wash", "Sunset color wash", ["overlay", "sunset", "color", "wash", "golden-hour", "grade"], OW, OH, False)(_sunset_wash)
element("overlay", "weather", "rain-streaks", "Rain streaks", ["overlay", "rain", "weather", "storm", "streaks"], OW, OH, False)(_rain_streaks)


# ------------------------------------------------------------------------------------------------
# Frames (full frame, transparent middle)
# ------------------------------------------------------------------------------------------------

def _frame_vhs() -> str:
    c = IVORY
    br = "".join(
        f'<path d="M{x},{y + dy * 90} L{x},{y} L{x + dx * 140},{y}" fill="none" stroke="{c}" stroke-width="10" opacity="0.9"/>'
        for x, y, dx, dy in ((80, 80, 1, 1), (FW - 80, 80, -1, 1), (80, FH - 80, 1, -1), (FW - 80, FH - 80, -1, -1))
    )
    body = br + circle(150, 150, 18, RED, "none", 0) + text(184, 166, "REC", 52, c, LABEL, 800, None, anchor="start", spacing=0.08)
    body += text(FW - 150, 166, "PLAY ▶", 52, c, LABEL, 800, None, anchor="end", spacing=0.08)
    body += text(150, FH - 130, "SP  00:14:27", 52, c, LABEL, 800, None, anchor="start", spacing=0.08)
    return svg_doc(FW, FH, body)


def _frame_polaroid() -> str:
    d = f"M0,0 H{FW} V{FH} H0 Z M110,90 H{FW - 110} V{FH - 230} H110 Z"
    body = f'<path d="{d}" fill="{IVORY}" fill-rule="evenodd"/><rect x="110" y="90" width="{FW - 220}" height="{FH - 320}" fill="none" stroke="{INK}" stroke-width="6" opacity="0.25"/>'
    return svg_doc(FW, FH, body)


def _frame_neon(color: str) -> str:
    defs = '<filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="14"/></filter>'
    rect = f'<rect x="70" y="70" width="{FW - 140}" height="{FH - 140}" rx="36" fill="none" stroke="{color}" stroke-width="22"/>'
    core = f'<rect x="70" y="70" width="{FW - 140}" height="{FH - 140}" rx="36" fill="none" stroke="#fff" stroke-width="6" opacity="0.85"/>'
    return svg_doc(FW, FH, f'<g filter="url(#glow)" opacity="0.95">{rect}</g>{rect}{core}', defs)


def _frame_phone() -> str:
    W, H = 1080, 1920
    d = f"M0,0 H{W} V{H} H0 Z M90,120 H{W - 90} V{H - 120} H90 Z"
    body = f'<path d="{d}" fill="{INK}" fill-rule="evenodd" opacity="0.92"/>'
    body += f'<rect x="60" y="80" width="{W - 120}" height="{H - 160}" rx="110" fill="none" stroke="{IVORY}" stroke-width="10" opacity="0.6"/>'
    body += rrect(W / 2 - 150, 100, 300, 50, 25, INK, IVORY, 4, 'stroke-opacity="0.3"')
    return svg_doc(W, H, body)


def _frame_tv() -> str:
    d = f'M0,0 H{FW} V{FH} H0 Z M210,120 Q{FW / 2},90 {FW - 210},120 Q{FW - 170},{FH / 2} {FW - 210},{FH - 160} Q{FW / 2},{FH - 130} 210,{FH - 160} Q170,{FH / 2} 210,120 Z'
    body = f'<path d="{d}" fill="{PLUM}" fill-rule="evenodd" stroke="{INK}" stroke-width="10"/>'
    body += f'<path d="M210,120 Q{FW / 2},90 {FW - 210},120 Q{FW - 170},{FH / 2} {FW - 210},{FH - 160} Q{FW / 2},{FH - 130} 210,{FH - 160} Q170,{FH / 2} 210,120 Z" fill="none" stroke="{INK}" stroke-width="24"/>'
    for k in range(3):
        body += circle(FW - 100, 300 + k * 140, 36, GOLD if k == 0 else IVORY, INK, 7)
    return svg_doc(FW, FH, body)


def _frame_comic() -> str:
    d = f"M0,0 H{FW} V{FH} H0 Z M60,70 L{FW - 50},50 L{FW - 70},{FH - 60} L50,{FH - 80} Z"
    body = f'<path d="{d}" fill="{IVORY}" fill-rule="evenodd"/><path d="M60,70 L{FW - 50},50 L{FW - 70},{FH - 60} L50,{FH - 80} Z" fill="none" stroke="{INK}" stroke-width="22" stroke-linejoin="round"/>'
    return svg_doc(FW, FH, body)


def _frame_film() -> str:
    body = f'<rect x="0" y="0" width="{FW}" height="110" fill="{INK}"/><rect x="0" y="{FH - 110}" width="{FW}" height="110" fill="{INK}"/>'
    for x in range(30, FW, 110):
        body += rrect(x, 30, 60, 46, 8, IVORY, "none", 0, 'fill-opacity="0.85"') + rrect(x, FH - 76, 60, 46, 8, IVORY, "none", 0, 'fill-opacity="0.85"')
    return svg_doc(FW, FH, body)


def _frame_corners(color: str, stars: bool) -> str:
    body = ""
    for x, y, dx, dy in ((70, 70, 1, 1), (FW - 70, 70, -1, 1), (70, FH - 70, 1, -1), (FW - 70, FH - 70, -1, -1)):
        d = f"M{x},{y + dy * 160} L{x},{y} L{x + dx * 240},{y}"
        body += f'<path d="{d}" fill="none" stroke="{INK}" stroke-width="30" stroke-linecap="square"/><path d="{d}" fill="none" stroke="{color}" stroke-width="16" stroke-linecap="square"/>'
    if stars:
        for k in range(5):
            body += poly(star_points(FW - 420 + k * 70, 150, 26, 11), GOLD if k < 2 else "none", INK if k < 2 else IVORY, 5 if k < 2 else 4)
        body += circle(240, FH - 240, 110, PURPLE, IVORY, 8, 'fill-opacity="0.5" stroke-opacity="0.8"')
    return svg_doc(FW, FH, body)


element("frame", "frame", "vhs", "VHS camcorder", ["frame", "vhs", "camcorder", "retro", "rec", "tape"], FW, FH)(_frame_vhs)
element("frame", "frame", "polaroid", "Instant photo", ["frame", "photo", "instant", "polaroid", "border"], FW, FH)(_frame_polaroid)
element("frame", "frame", "neon-coral", "Neon border (coral)", ["frame", "neon", "border", "glow", "night"], FW, FH, False)(lambda: _frame_neon(CORAL))
element("frame", "frame", "neon-gold", "Neon border (gold)", ["frame", "neon", "border", "glow", "gold"], FW, FH, False)(lambda: _frame_neon(GOLD))
element("frame", "frame", "phone-vertical", "Phone screen (vertical)", ["frame", "phone", "vertical", "tiktok", "shorts", "9:16"], 1080, 1920)(_frame_phone)
element("frame", "frame", "crt-tv", "CRT TV", ["frame", "tv", "crt", "retro", "news", "broadcast"], FW, FH)(_frame_tv)
element("frame", "frame", "comic-panel", "Comic panel", ["frame", "comic", "panel", "border", "ink"], FW, FH)(_frame_comic)
element("frame", "frame", "film-strip", "Film strip", ["frame", "film", "strip", "cinema", "movie"], FW, FH)(_frame_film)
element("frame", "frame", "corner-brackets", "Corner brackets", ["frame", "corners", "brackets", "focus", "minimal"], FW, FH)(lambda: _frame_corners(IVORY, False))
element("frame", "frame", "hud-corners", "HUD corners", ["frame", "hud", "game", "stars", "radar", "corners"], FW, FH)(lambda: _frame_corners(GOLD, True))


# ------------------------------------------------------------------------------------------------
# Transitions: full-frame graphics the editor animates across a cut (suggested motion in tags)
# ------------------------------------------------------------------------------------------------

def _t_ink_swipe() -> str:
    pts = [(-200, FH + 100), (900, -100), (1500, -100), (400, FH + 100)]
    lines = "".join(f'<line x1="{1520 + k * 70}" y1="{-50 + k * 30}" x2="{420 + k * 70}" y2="{FH + 150 + k * 30}" stroke="{INK}" stroke-width="{18 - k * 3}"/>' for k in range(5))
    return svg_doc(FW, FH, poly(pts, INK, INK, 2) + lines + f'<polygon points="{" ".join(f"{x},{y}" for x, y in [(860, -100), (920, -100), (-120, FH + 100), (-180, FH + 100)])}" fill="{GOLD}"/>')


def _t_flash(color: str) -> str:
    g = f'<radialGradient id="f" cx="50%" cy="50%" r="70%"><stop offset="0" stop-color="{color}" stop-opacity="1"/><stop offset="0.6" stop-color="{color}" stop-opacity="0.85"/><stop offset="1" stop-color="{color}" stop-opacity="0"/></radialGradient>'
    return svg_doc(OW, OH, f'<rect width="{OW}" height="{OH}" fill="url(#f)"/>', g)


def _t_glitch() -> str:
    r = np.random.default_rng(7701)
    body = ""
    for k in range(34):
        y = r.uniform(0, FH)
        h = r.uniform(10, 90)
        x = r.uniform(-300, 600)
        w = r.uniform(600, 1800)
        c = r.choice([CORAL, BLUE, GOLD, IVORY, INK])
        body += f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" fill="{c}" opacity="{r.uniform(0.55, 1):.2f}"/>'
    return svg_doc(FW, FH, body)


def _t_halftone() -> str:
    defs = halftone_pattern("h", CORAL, 30, 11) + f'<linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.35" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient><mask id="m"><rect width="{FW}" height="{FH}" fill="url(#g)"/></mask>'
    return svg_doc(FW, FH, f'<rect width="{FW}" height="{FH}" fill="url(#h)" mask="url(#m)"/><rect x="{FW * 0.62}" width="{FW * 0.38}" height="{FH}" fill="{CORAL}"/>', defs)


def _t_starburst() -> str:
    return svg_doc(FW, FH, poly(burst_points(FW / 2, FH / 2, 1250, 700, 22, 7801, 0.1), GOLD, INK, 24) + poly(burst_points(FW / 2, FH / 2, 700, 420, 18, 7802, 0.1), CORAL, INK, 18))


def _t_neon_streak() -> str:
    defs = '<filter id="g" x="-10%" y="-200%" width="120%" height="500%"><feGaussianBlur stdDeviation="22"/></filter>'
    streak = f'<path d="M-100,{FH * 0.62} C{FW * 0.3},{FH * 0.45} {FW * 0.6},{FH * 0.55} {FW + 100},{FH * 0.35}" stroke="{CORAL}" stroke-width="60" fill="none"/>'
    core = f'<path d="M-100,{FH * 0.62} C{FW * 0.3},{FH * 0.45} {FW * 0.6},{FH * 0.55} {FW + 100},{FH * 0.35}" stroke="#fff" stroke-width="14" fill="none"/>'
    return svg_doc(FW, FH, f'<g filter="url(#g)">{streak}</g>{streak}{core}', defs)


def _t_speed_lines() -> str:
    r = np.random.default_rng(7901)
    body = ""
    cx, cy = FW / 2, FH / 2
    for k in range(90):
        a = r.uniform(0, 2 * math.pi)
        r0 = r.uniform(380, 560)
        w = r.uniform(0.006, 0.02)
        p = [(cx + r0 * math.cos(a), cy + r0 * math.sin(a)), (cx + 1500 * math.cos(a - w), cy + 1500 * math.sin(a - w)), (cx + 1500 * math.cos(a + w), cy + 1500 * math.sin(a + w))]
        body += f'<polygon points="{" ".join(f"{x:.0f},{y:.0f}" for x, y in p)}" fill="{INK}"/>'
    return svg_doc(FW, FH, body)


def _t_paper_tear() -> str:
    r = np.random.default_rng(8001)
    xs = np.linspace(0, FH, 40)
    edge = [(FW * 0.45 + r.uniform(-40, 40), y) for y in xs]
    pts = [(FW + 50, -50)] + [(x, y) for x, y in edge] + [(FW + 50, FH + 50)]
    shadow_pts = [(x - 18, y + 8) for x, y in pts]
    return svg_doc(FW, FH, poly(shadow_pts, INK, INK, 2, 'fill-opacity="0.45"') + poly(pts, IVORY, INK, 8))


def _t_smoke() -> str:
    defs = '<filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="60"/></filter>'
    r = np.random.default_rng(8101)
    body = "".join(f'<circle cx="{r.uniform(-100, FW + 100):.0f}" cy="{r.uniform(-100, FH + 100):.0f}" r="{r.uniform(200, 420):.0f}" fill="{r.choice([IVORY, "#d8cfc4", "#bdb3a8"])}" opacity="{r.uniform(0.6, 0.95):.2f}"/>' for _ in range(26))
    return svg_doc(GW, GH, f'<g transform="scale(0.5)" filter="url(#b)">{body}</g>', defs)


element("transition", "transition", "ink-swipe", "Ink swipe", ["transition", "swipe", "ink", "wipe", "motion:slide-left"], FW, FH)(_t_ink_swipe)
element("transition", "transition", "gold-flash", "Gold flash", ["transition", "flash", "gold", "burst", "motion:fade"], OW, OH, False)(lambda: _t_flash(GOLD))
element("transition", "transition", "white-flash", "White flash", ["transition", "flash", "white", "camera", "motion:fade"], OW, OH, False)(lambda: _t_flash("#ffffff"))
element("transition", "transition", "glitch-slabs", "Glitch slabs", ["transition", "glitch", "digital", "error", "motion:shake"], FW, FH)(_t_glitch)
element("transition", "transition", "halftone-wipe", "Halftone wipe", ["transition", "halftone", "comic", "wipe", "motion:slide-left"], FW, FH)(_t_halftone)
element("transition", "transition", "star-burst", "Star burst", ["transition", "burst", "comic", "pop", "motion:zoom"], FW, FH)(_t_starburst)
element("transition", "transition", "neon-streak", "Neon streak", ["transition", "neon", "light", "streak", "motion:slide-right"], FW, FH, False)(_t_neon_streak)
element("transition", "transition", "speed-lines", "Speed lines", ["transition", "speed", "zoom", "anime", "comic", "motion:zoom"], FW, FH)(_t_speed_lines)
element("transition", "transition", "paper-tear", "Paper tear", ["transition", "paper", "tear", "reveal", "motion:slide-left"], FW, FH)(_t_paper_tear)
element("transition", "transition", "smoke-wipe", "Smoke wipe", ["transition", "smoke", "fog", "soft", "motion:fade"], GW, GH, False)(_t_smoke)


# ------------------------------------------------------------------------------------------------
# Rasterizing
# ------------------------------------------------------------------------------------------------

def rasterize(svg: str, out: Path, fontconfig: Path, quantize: bool, trim: bool = False, gray_alpha: bool = False, scale: float = 1.0) -> tuple[int, int]:
    from PIL import Image

    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.svg"
        src.write_text(svg)
        tmp = Path(td) / "out.png"
        env = {**os.environ, "FONTCONFIG_FILE": str(fontconfig)}
        args = ["rsvg-convert", "-f", "png", "-o", str(tmp)]
        if scale != 1.0:
            args += ["-z", str(scale)]
        subprocess.run(args + [str(src)], check=True, env=env)
        im = Image.open(tmp).convert("RGBA")
        # Stickers: trim fully transparent margins (keeps a small pad). Full-frame elements keep
        # their canvas, because where things sit inside the frame matters.
        if trim:
            bbox = im.getchannel("A").getbbox()
            if bbox:
                pad = 6
                bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(im.width, bbox[2] + pad), min(im.height, bbox[3] + pad))
                im = im.crop(bbox)
        if gray_alpha:
            la = im.convert("LA")
            a = la.getchannel("A").point(lambda v: (v // 16) * 16)
            la.putalpha(a)
            la.save(out, optimize=True, compress_level=9)
        elif quantize:
            q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
            q.save(out, optimize=True)
        else:
            im.save(out, optimize=True, compress_level=9)
        return im.width, im.height
