"""Sound effects: every sound is synthesized here (no recordings, no samples from anywhere)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .audio_core import (
    SR, as_curve, bandpass, bitcrush, brown, crackle, delay, drive, env_adsr, env_bell, env_exp, fade, fm,
    formant, glide, highpass, lowpass, mix_at, n_of, pad_to, partials, pink, reverb, rng, saw, sine, square,
    supersaw, sweep, to_stereo, triangle, tvec, white,
)


@dataclass
class Sfx:
    id: str
    category: str
    name: str
    tags: list[str]
    make: Callable[[], np.ndarray]
    extra: dict = field(default_factory=dict)


CATALOG: list[Sfx] = []


def sfx(category: str, slug: str, name: str, tags: list[str]):
    def wrap(fn: Callable[[], np.ndarray]):
        CATALOG.append(Sfx(f"sfx/{category}/{slug}", category, name, tags, fn))
        return fn

    return wrap


def note(n: float) -> float:
    """MIDI note number to Hz."""
    return 440.0 * 2 ** ((n - 69) / 12)


# ------------------------------------------------------------------------------------------------
# Whooshes and swishes
# ------------------------------------------------------------------------------------------------

def _whoosh(dur: float, f0: float, f1: float, f2: float, seed: int, peak: float = 0.55, q: float = 1.4, pan=(-0.8, 0.8), air: float = 0.0):
    n = n_of(dur)
    src = pink(dur, seed) + white(dur, seed + 1) * 0.5
    fc = np.concatenate([np.geomspace(f0, f1, int(n * peak)), np.geomspace(f1, f2, n - int(n * peak))])
    y = sweep(src, "bp", fc, q)
    if air:
        y += highpass(white(dur, seed + 2), 6000) * air * env_bell(dur, peak, 1.5)
    y *= env_bell(dur, peak, 1.6)
    return fade(to_stereo(y, np.linspace(pan[0], pan[1], n)), 0.002, 0.03)


for i, (d, f0, f1, f2) in enumerate([(0.35, 500, 3200, 900), (0.45, 400, 2600, 700), (0.3, 900, 5200, 1600), (0.5, 300, 2200, 500)]):
    sfx("whooshes", f"whoosh-short-{i + 1:02d}", f"Short whoosh {i + 1}", ["whoosh", "fast", "transition", "swipe"])(
        lambda d=d, f0=f0, f1=f1, f2=f2, i=i: _whoosh(d, f0, f1, f2, 100 + i, 0.5)
    )
for i, (d, f0, f1, f2) in enumerate([(1.1, 200, 2400, 400), (1.4, 150, 1800, 300), (0.9, 250, 3000, 600)]):
    sfx("whooshes", f"whoosh-long-{i + 1:02d}", f"Long whoosh {i + 1}", ["whoosh", "slow", "transition", "fly-by"])(
        lambda d=d, f0=f0, f1=f1, f2=f2, i=i: _whoosh(d, f0, f1, f2, 120 + i, 0.6, 1.1, air=0.25)
    )
for i, (d, f0, f1) in enumerate([(0.18, 2000, 7000), (0.22, 1500, 6000), (0.16, 2500, 8000)]):
    sfx("whooshes", f"swish-{i + 1:02d}", f"Swish {i + 1}", ["swish", "quick", "cut", "ui"])(
        lambda d=d, f0=f0, f1=f1, i=i: _whoosh(d, f0, f1, f0 * 1.2, 140 + i, 0.45, 2.2, pan=(-0.4, 0.4))
    )
for i, (d, f0, f1) in enumerate([(0.9, 300, 4000), (1.3, 200, 3200)]):
    sfx("whooshes", f"reverse-whoosh-{i + 1:02d}", f"Reverse whoosh {i + 1}", ["whoosh", "reverse", "build", "suck"])(
        lambda d=d, f0=f0, f1=f1, i=i: _whoosh(d, f0, f1, f1 * 1.05, 160 + i, 0.97, 1.2, pan=(0.6, -0.6), air=0.3)
    )


# ------------------------------------------------------------------------------------------------
# Impacts and hits
# ------------------------------------------------------------------------------------------------

def _thump(dur: float, f_hi: float, f_lo: float, decay: float, click: float, seed: int, noise_lp: float = 2500, dist: float = 1.8, verb: float = 0.0):
    pitch = glide([(0, f_hi), (0.06, f_lo * 1.2), (dur, f_lo)], dur)
    body = sine(pitch, dur) * env_exp(dur, decay)
    nz = lowpass(white(dur, seed), noise_lp) * env_exp(dur, 0.03)
    clk = highpass(white(dur, seed + 3), 3000) * env_exp(dur, 0.004) * click
    y = drive(body + nz * 0.8 + clk, dist)
    st = to_stereo(fade(y, 0.0005, 0.05))
    if verb:
        st = reverb(st, 1.2, verb, seed=seed + 9)
    return st


for i, (d, fh, fl, dec, clk) in enumerate([(0.8, 160, 42, 0.28, 0.6), (1.0, 140, 38, 0.35, 0.4), (0.7, 180, 48, 0.22, 0.8)]):
    sfx("impacts", f"heavy-hit-{i + 1:02d}", f"Heavy hit {i + 1}", ["impact", "hit", "heavy", "boom", "bass"])(
        lambda d=d, fh=fh, fl=fl, dec=dec, clk=clk, i=i: _thump(d, fh, fl, dec, clk, 200 + i, dist=2.2, verb=0.18)
    )
for i, (d, fh, fl, dec) in enumerate([(0.35, 220, 90, 0.08), (0.3, 260, 110, 0.06), (0.4, 200, 80, 0.1)]):
    sfx("impacts", f"punch-{i + 1:02d}", f"Punch {i + 1}", ["impact", "punch", "fight", "hit"])(
        lambda d=d, fh=fh, fl=fl, dec=dec, i=i: _thump(d, fh, fl, dec, 1.0, 210 + i, noise_lp=4000, dist=2.6)
    )
for i, (d, fh, fl) in enumerate([(0.6, 120, 45), (0.7, 100, 40)]):
    sfx("impacts", f"thud-{i + 1:02d}", f"Thud {i + 1}", ["impact", "thud", "soft", "body"])(
        lambda d=d, fh=fh, fl=fl, i=i: _thump(d, fh, fl, 0.18, 0.1, 220 + i, noise_lp=800, dist=1.3)
    )
for i, (d, fh, fl) in enumerate([(1.4, 170, 40), (1.6, 150, 36)]):
    sfx("impacts", f"slam-{i + 1:02d}", f"Slam {i + 1}", ["impact", "slam", "door", "big", "reverb"])(
        lambda d=d, fh=fh, fl=fl, i=i: _thump(d, fh, fl, 0.3, 0.9, 230 + i, noise_lp=5000, dist=2.4, verb=0.35)
    )


def _clang(dur: float, base: float, seed: int):
    ratios = [1.0, 2.76, 5.40, 8.93, 13.34, 2.0]
    y = partials([base * r for r in ratios], [1, 0.7, 0.5, 0.35, 0.2, 0.3], [0.9, 0.6, 0.35, 0.22, 0.12, 0.5], dur, seed)
    y += highpass(white(dur, seed), 2500) * env_exp(dur, 0.01) * 0.8
    return reverb(fade(y, 0.0005, 0.08), 1.0, 0.2, seed=seed)


for i, base in enumerate([420.0, 310.0]):
    sfx("impacts", f"metal-clang-{i + 1:02d}", f"Metal clang {i + 1}", ["impact", "metal", "clang", "ring"])(lambda base=base, i=i: _clang(1.4, base, 240 + i))


# ------------------------------------------------------------------------------------------------
# Risers and builds
# ------------------------------------------------------------------------------------------------

def _riser(dur: float, f_lo: float, f_hi: float, seed: int, tonal: float = 0.5, notes: tuple[int, ...] = (45, 52, 57), dissonant: bool = False):
    n = n_of(dur)
    nz = sweep(white(dur, seed), "hp", np.geomspace(300, 9000, n), 0.8)
    rise = np.geomspace(1, f_hi / f_lo, n)
    tone = np.zeros(n)
    for k, m in enumerate(notes):
        f = note(m) * rise
        tone += supersaw(f if not dissonant else f * (1 + 0.012 * k), dur, 3, 18, seed + k)
    tone = sweep(tone, "lp", np.geomspace(400, 9000, n), 1.2) / len(notes)
    e = np.linspace(0, 1, n) ** 2.2
    y = (nz * (1 - tonal) * 1.4 + tone * tonal) * e
    return reverb(fade(y, 0.01, 0.02), 1.4, 0.25, seed=seed)


sfx("risers", "riser-short-01", "Short riser 1", ["riser", "build", "tension", "transition"])(lambda: _riser(1.5, 1, 4, 300, 0.5))
sfx("risers", "riser-short-02", "Short riser 2", ["riser", "build", "noise", "transition"])(lambda: _riser(1.2, 1, 3, 301, 0.25))
sfx("risers", "riser-long-01", "Long riser 1", ["riser", "build", "drop", "edm"])(lambda: _riser(4.0, 1, 6, 302, 0.55))
sfx("risers", "riser-long-02", "Long riser 2", ["riser", "build", "cinematic"])(lambda: _riser(3.2, 1, 5, 303, 0.4, (40, 47, 52, 59)))
sfx("risers", "tension-riser-01", "Tension riser 1", ["riser", "tension", "dark", "horror"])(lambda: _riser(3.0, 1, 2.5, 304, 0.7, (45, 46, 51), True))
sfx("risers", "tension-riser-02", "Tension riser 2", ["riser", "tension", "suspense"])(lambda: _riser(2.4, 1, 3, 305, 0.65, (40, 41, 47), True))
sfx("risers", "noise-sweep-up-01", "Noise sweep up 1", ["riser", "noise", "sweep", "white"])(lambda: _riser(2.0, 1, 2, 306, 0.0))
sfx("risers", "noise-sweep-up-02", "Noise sweep up 2", ["riser", "noise", "sweep", "fast"])(lambda: _riser(0.9, 1, 2, 307, 0.0))


# ------------------------------------------------------------------------------------------------
# Drops and downlifters
# ------------------------------------------------------------------------------------------------

def _downlifter(dur: float, seed: int, tonal: float = 0.3):
    n = n_of(dur)
    nz = sweep(white(dur, seed), "lp", np.geomspace(12000, 200, n), 0.9)
    tone = supersaw(np.geomspace(note(64), note(40), n), dur, 3, 14, seed)
    tone = lowpass(tone, 3000)
    e = (1 - np.linspace(0, 1, n)) ** 1.5
    return reverb(fade((nz * (1 - tonal) * 1.3 + tone * tonal) * e, 0.003, 0.05), 1.6, 0.3, seed=seed)


for i, (d, t) in enumerate([(1.6, 0.2), (2.4, 0.35), (1.0, 0.0)]):
    sfx("drops", f"downlifter-{i + 1:02d}", f"Downlifter {i + 1}", ["drop", "downlifter", "fall", "transition"])(lambda d=d, t=t, i=i: _downlifter(d, 400 + i, t))


def _sub_drop(dur: float, f_hi: float, f_lo: float, seed: int):
    p = np.geomspace(f_hi, f_lo, n_of(dur))
    y = sine(p, dur) * env_exp(dur, dur * 0.45, 0.004)
    y = drive(y * 1.4, 1.6)
    return to_stereo(fade(y, 0.002, 0.2))


for i, (d, a, b) in enumerate([(2.0, 90, 28), (1.4, 110, 32), (2.8, 75, 25)]):
    sfx("drops", f"sub-drop-{i + 1:02d}", f"Sub drop {i + 1}", ["drop", "sub", "bass", "808", "boom"])(lambda d=d, a=a, b=b, i=i: _sub_drop(d, a, b, 410 + i))


# ------------------------------------------------------------------------------------------------
# Glitches and digital
# ------------------------------------------------------------------------------------------------

def _glitch(dur: float, seed: int, crush: int = 5):
    r = rng(seed)
    n = n_of(dur)
    y = np.zeros(n)
    t = 0
    while t < n:
        seg = int(r.uniform(0.01, 0.07) * SR)
        kind = r.integers(0, 4)
        d = seg / SR
        if kind == 0:
            s = square(r.uniform(80, 2400), d, r.uniform(0.1, 0.5))
        elif kind == 1:
            s = bitcrush(white(d, int(r.integers(0, 1_000_000))), int(r.integers(3, 7)), int(r.integers(2, 20)))
        elif kind == 2:
            s = saw(np.geomspace(r.uniform(200, 3000), r.uniform(50, 6000), seg), d)
        else:
            s = np.zeros(seg)
        reps = int(r.integers(1, 4))
        s = np.tile(s, reps)[: n - t]
        y[t : t + len(s)] = s * r.uniform(0.4, 1.0)
        t += len(s)
    y = bitcrush(y, crush, 2)
    return to_stereo(fade(y * 0.7, 0.001, 0.01), r.uniform(-0.5, 0.5))


for i, d in enumerate([0.4, 0.6, 0.3, 0.8, 0.5]):
    sfx("glitches", f"glitch-{i + 1:02d}", f"Glitch {i + 1}", ["glitch", "digital", "error", "stutter"])(lambda d=d, i=i: _glitch(d, 500 + i))


def _data_burst(dur: float, seed: int):
    r = rng(seed)
    n = n_of(dur)
    sym = int(0.012 * SR)
    freqs = np.repeat(r.choice([1200.0, 2200.0, 1800.0, 2600.0], n // sym + 1), sym)[:n]
    y = sine(freqs, dur) * 0.6 + bitcrush(white(dur, seed), 4, 8) * 0.15
    return to_stereo(fade(y * env_adsr(dur, 0.005, 0.05, 0.8, 0.05), 0.001, 0.02))


for i, d in enumerate([0.7, 1.1]):
    sfx("glitches", f"data-burst-{i + 1:02d}", f"Data burst {i + 1}", ["data", "modem", "digital", "hack", "computer"])(lambda d=d, i=i: _data_burst(d, 510 + i))


def _static(dur: float, seed: int):
    r = rng(seed)
    nz = white(dur, seed)
    gate = np.repeat(r.random(int(dur * 60) + 1) > 0.3, n_of(1 / 60))[: n_of(dur)]
    y = bandpass(nz, 600, 7000) * gate + crackle(dur, 400, seed, 0.8)
    return to_stereo(fade(y * env_adsr(dur, 0.01, 0.1, 0.7, 0.1), 0.002, 0.03))


for i, d in enumerate([0.5, 0.9, 1.4]):
    sfx("glitches", f"static-burst-{i + 1:02d}", f"Static burst {i + 1}", ["static", "radio", "tv", "noise", "interference"])(lambda d=d, i=i: _static(d, 520 + i))


# ------------------------------------------------------------------------------------------------
# UI blips, clicks, notifications
# ------------------------------------------------------------------------------------------------

def _click(seed: int, bright: float = 4000, dur: float = 0.05):
    y = highpass(white(dur, seed), bright) * env_exp(dur, 0.003) + sine(bright / 3, dur) * env_exp(dur, 0.006) * 0.4
    return fade(y, 0.0002, 0.005)


for i, b in enumerate([3500, 5000, 2500]):
    sfx("ui", f"click-{i + 1:02d}", f"Click {i + 1}", ["ui", "click", "button", "tap"])(lambda b=b, i=i: _click(600 + i, b))


def _blip(f0: float, f1: float, dur: float, wave: str = "sine"):
    p = glide([(0, f0), (dur * 0.6, f1), (dur, f1)], dur)
    osc = sine(p, dur) if wave == "sine" else square(p, dur, 0.3) * 0.5
    return fade(osc * env_exp(dur, dur * 0.4, 0.002), 0.001, 0.02)


sfx("ui", "blip-up-01", "Blip up 1", ["ui", "blip", "up", "positive", "select"])(lambda: _blip(600, 1200, 0.12))
sfx("ui", "blip-up-02", "Blip up 2 (retro)", ["ui", "blip", "up", "retro", "8-bit"])(lambda: _blip(500, 1500, 0.1, "square"))
sfx("ui", "blip-down-01", "Blip down 1", ["ui", "blip", "down", "back", "cancel"])(lambda: _blip(1100, 500, 0.12))
sfx("ui", "blip-down-02", "Blip down 2 (retro)", ["ui", "blip", "down", "retro", "8-bit"])(lambda: _blip(1400, 400, 0.1, "square"))


def _bell_note(f: float, dur: float, bright: float = 1.0):
    return partials([f, f * 2.0, f * 3.01, f * 4.2], [1, 0.4 * bright, 0.2 * bright, 0.08 * bright], [dur * 0.5, dur * 0.3, dur * 0.18, dur * 0.1], dur)


def _chime(notes: list[float], step: float, dur_each: float, seed: int, verb: float = 0.18):
    total = step * (len(notes) - 1) + dur_each
    y = np.zeros(n_of(total))
    for k, m in enumerate(notes):
        mix_at(y, _bell_note(note(m), dur_each), k * step)
    return reverb(fade(y, 0.001, 0.05), 0.9, verb, seed=seed)


sfx("ui", "notification-01", "Notification 1", ["ui", "notification", "chime", "alert", "message"])(lambda: _chime([76, 83], 0.09, 0.6, 620))
sfx("ui", "notification-02", "Notification 2", ["ui", "notification", "chime", "soft"])(lambda: _chime([72, 79, 84], 0.07, 0.5, 621))
sfx("ui", "notification-03", "Notification 3", ["ui", "notification", "ping", "bright"])(lambda: _chime([88, 84], 0.08, 0.45, 622))
sfx("ui", "confirm-01", "Confirm", ["ui", "confirm", "success", "ok", "positive"])(lambda: _chime([72, 76, 79], 0.06, 0.4, 623, 0.12))


def _error():
    d = 0.32
    y = (square(185, d, 0.5) + square(196, d, 0.5)) * 0.25 * env_adsr(d, 0.003, 0.05, 0.8, 0.08)
    return fade(lowpass(y, 2500), 0.001, 0.02)


sfx("ui", "error-01", "Error buzz", ["ui", "error", "wrong", "denied", "buzz"])(_error)
sfx("ui", "select-01", "Select tick", ["ui", "select", "tick", "menu"])(lambda: _blip(1800, 1800, 0.05))
sfx("ui", "hover-tick-01", "Hover tick", ["ui", "hover", "tick", "soft"])(lambda: _click(630, 7000, 0.03) * 0.6)
sfx("ui", "menu-open-01", "Menu open", ["ui", "menu", "open", "pause", "swoosh"])(
    lambda: _whoosh(0.28, 900, 4200, 2000, 631, 0.7, 1.8, pan=(0, 0)) * 0.7 + to_stereo(pad_to(_blip(700, 1400, 0.15), n_of(0.28)))
)
sfx("ui", "menu-close-01", "Menu close", ["ui", "menu", "close", "back"])(
    lambda: _whoosh(0.25, 3800, 1200, 600, 632, 0.3, 1.8, pan=(0, 0)) * 0.7 + to_stereo(pad_to(_blip(1300, 650, 0.14), n_of(0.25)))
)
sfx("ui", "countdown-beep-01", "Countdown beep", ["ui", "countdown", "beep", "timer", "race"])(
    lambda: fade(square(880, 0.16, 0.5) * 0.4 * env_adsr(0.16, 0.002, 0.02, 0.9, 0.03), 0.001, 0.01)
)
sfx("ui", "countdown-go-01", "Countdown go", ["ui", "countdown", "go", "start", "race"])(
    lambda: fade(square(1760, 0.5, 0.5) * 0.4 * env_adsr(0.5, 0.002, 0.05, 0.8, 0.15), 0.001, 0.02)
)


# ------------------------------------------------------------------------------------------------
# Cash and money
# ------------------------------------------------------------------------------------------------

def _kaching(seed: int, pitch: float = 1.0):
    d = 1.4
    y = np.zeros(n_of(d))
    mech = highpass(white(0.08, seed), 1500) * env_exp(0.08, 0.012)
    mix_at(y, mech, 0.0, 0.9)
    mix_at(y, highpass(white(0.05, seed + 1), 2500) * env_exp(0.05, 0.008), 0.05, 0.6)
    bell = partials([1318 * pitch, 2637 * pitch, 3520 * pitch, 5274 * pitch, 6600 * pitch], [1, 0.6, 0.5, 0.3, 0.2], [0.8, 0.5, 0.4, 0.25, 0.15], 1.2, seed)
    mix_at(y, bell, 0.09, 0.8)
    return reverb(fade(y, 0.0005, 0.1), 1.0, 0.15, seed=seed)


sfx("cash", "ka-ching-01", "Ka-ching 1", ["cash", "money", "register", "ka-ching", "win"])(lambda: _kaching(700))
sfx("cash", "ka-ching-02", "Ka-ching 2 (bright)", ["cash", "money", "register", "ka-ching", "win"])(lambda: _kaching(701, 1.12))


def _coin(seed: int, f: float):
    d = 0.6
    y = np.zeros(n_of(d))
    mix_at(y, partials([f, f * 1.5, f * 2.7], [1, 0.5, 0.3], [0.2, 0.12, 0.08], 0.45, seed), 0)
    mix_at(y, partials([f * 1.33, f * 2.0], [0.8, 0.4], [0.25, 0.15], 0.5, seed + 1), 0.07)
    return fade(y, 0.0005, 0.05)


sfx("cash", "coin-01", "Coin 1", ["cash", "coin", "money", "pickup", "collect"])(lambda: _coin(710, 1975))
sfx("cash", "coin-02", "Coin 2 (retro)", ["cash", "coin", "pickup", "retro", "8-bit"])(
    lambda: fade(np.concatenate([square(988, 0.07, 0.5), square(1319, 0.3, 0.5) * env_exp(0.3, 0.12)]) * 0.35, 0.001, 0.02)
)


def _counter(seed: int, ticks: int, dur: float):
    y = np.zeros(n_of(dur + 0.1))
    r = rng(seed)
    for k in range(ticks):
        tt = dur * (k / ticks) ** 0.8
        mix_at(y, _click(seed + k, r.uniform(3000, 6000), 0.03) * 0.8, tt)
    mix_at(y, _chime([84, 91], 0.06, 0.5, seed + 99, 0.1)[0][: n_of(0.6)], dur)
    return fade(y, 0.001, 0.03)


sfx("cash", "cash-counter-01", "Cash counter", ["cash", "money", "count", "score", "tally"])(lambda: _counter(720, 18, 0.9))
sfx("cash", "register-bell-01", "Register bell", ["cash", "bell", "shop", "ding"])(lambda: reverb(_bell_note(note(88), 1.2, 1.4), 1.1, 0.2, seed=721))
sfx("cash", "money-rain-01", "Money rain", ["cash", "money", "rain", "jackpot", "win"])(
    lambda: reverb(_coin_shower(731), 0.9, 0.18, seed=732)
)


def _coin_shower(seed: int):
    r = rng(seed)
    d = 1.8
    y = np.zeros(n_of(d))
    for k in range(26):
        mix_at(y, _coin(seed + k, r.uniform(1500, 2600)) * r.uniform(0.3, 0.8), r.uniform(0, 1.3))
    return y * 0.6


# ------------------------------------------------------------------------------------------------
# Sirens and alarms (synthetic)
# ------------------------------------------------------------------------------------------------

def _wail(dur: float, lo: float, hi: float, rate: float, seed: int):
    t = tvec(dur)
    f = lo + (hi - lo) * (0.5 - 0.5 * np.cos(np.pi * 2 * rate * t))
    y = triangle(f, dur) * 0.6 + sine(f * 2, dur) * 0.2
    y = drive(y * 1.4, 1.5)
    y = lowpass(y, 4500) * env_adsr(dur, 0.05, 0.1, 0.9, 0.3)
    return reverb(fade(y, 0.01, 0.05), 1.4, 0.22, seed=seed)


sfx("sirens", "siren-wail-01", "Siren wail 1", ["siren", "police", "chase", "wanted", "emergency"])(lambda: _wail(3.5, 650, 1400, 0.33, 800))
sfx("sirens", "siren-wail-02", "Siren wail 2 (far)", ["siren", "police", "distant", "city"])(
    lambda: lowpass(_wail(3.5, 600, 1300, 0.28, 801), 1800) * 0.7
)
sfx("sirens", "siren-yelp-01", "Siren yelp 1", ["siren", "yelp", "police", "chase", "fast"])(lambda: _wail(2.5, 700, 1500, 3.2, 802))
sfx("sirens", "siren-yelp-02", "Siren yelp 2", ["siren", "yelp", "urgent"])(lambda: _wail(2.0, 800, 1700, 5.0, 803))


def _alarm(dur: float, f: float, on: float, off: float):
    t = tvec(dur)
    gate = ((t % (on + off)) < on).astype(float)
    gate = lowpass(gate, 300, 1)
    y = square(f, dur, 0.5) * 0.35 * gate
    return fade(lowpass(y, 5000), 0.002, 0.03)


sfx("sirens", "alarm-beep-01", "Alarm beeps", ["alarm", "beep", "warning", "heist", "security"])(lambda: _alarm(2.0, 1000, 0.12, 0.1))
sfx("sirens", "alarm-beep-02", "Alarm beeps (slow)", ["alarm", "beep", "warning", "bomb", "timer"])(lambda: _alarm(2.4, 1500, 0.08, 0.32))


def _klaxon(dur: float, f1: float, f2: float, seed: int):
    half = dur / 4
    seq = np.concatenate([saw(f1, half), saw(f2, half), saw(f1, half), saw(f2, half)])
    y = formant(seq * 0.5, "a") + lowpass(seq, 2500) * 0.2
    y *= env_adsr(len(seq) / SR, 0.01, 0.05, 0.9, 0.1)
    return reverb(fade(drive(y, 1.6), 0.005, 0.05), 1.1, 0.15, seed=seed)


sfx("sirens", "klaxon-01", "Klaxon 1", ["alarm", "klaxon", "horn", "warning", "lockdown"])(lambda: _klaxon(2.0, 330, 262, 810))
sfx("sirens", "klaxon-02", "Klaxon 2", ["alarm", "klaxon", "horn", "danger"])(lambda: _klaxon(1.6, 392, 311, 811))


# ------------------------------------------------------------------------------------------------
# Engines and tires (synthetic)
# ------------------------------------------------------------------------------------------------

def _engine(dur: float, rpm_curve, seed: int, cyl: int = 8, grit: float = 0.5):
    n = n_of(dur)
    f = as_curve(rpm_curve, n) / 60 * cyl / 2
    y = np.zeros(n)
    for h, a in [(1, 1.0), (2, 0.6), (3, 0.35), (4, 0.25), (6, 0.12)]:
        y += saw(f * h, dur, h * 0.13) * a / h
    jit = lowpass(rng(seed).standard_normal(n), 30) * 0.4
    y *= 1 + jit
    y += bandpass(white(dur, seed), 200, 1200) * grit * (f / f.max())
    y = drive(lowpass(y, 2200) * 1.5, 2.0)
    return y


def _rev(dur: float, idle: float, top: float, seed: int):
    rpm = glide([(0, idle), (dur * 0.25, top), (dur * 0.45, top * 0.92), (dur * 0.6, top * 1.02), (dur, idle * 1.1)], dur, "ease")
    y = _engine(dur, rpm, seed) * env_adsr(dur, 0.05, 0.1, 0.9, 0.3)
    return reverb(fade(y, 0.01, 0.1), 0.8, 0.1, seed=seed)


sfx("engines", "engine-rev-01", "Engine rev 1 (V8)", ["engine", "car", "rev", "muscle", "race"])(lambda: _rev(2.6, 900, 6200, 900))
sfx("engines", "engine-rev-02", "Engine rev 2 (sport)", ["engine", "car", "rev", "sport", "race"])(lambda: _rev(2.2, 1100, 8200, 901))
sfx("engines", "engine-rev-03", "Engine rev 3 (bike)", ["engine", "motorbike", "rev", "bike"])(
    lambda: fade(highpass(_rev(2.0, 1500, 10500, 902), 120) * 0.9, 0.01, 0.1)
)
sfx("engines", "engine-idle-01", "Engine idle", ["engine", "idle", "car", "rumble", "loop"])(
    lambda: fade(_engine(3.0, 820, 903, grit=0.3) * 0.8, 0.2, 0.3)
)


def _passby(dur: float, seed: int, speed: float = 45.0):
    n = n_of(dur)
    t = tvec(dur)
    tc = dur / 2
    x = (t - tc) * speed
    dist = np.sqrt(x**2 + 6.0**2)
    vr = speed * x / dist
    dop = 343 / (343 + vr)
    y = _engine(dur, 4200 * dop, seed, grit=0.6)
    amp = (6.0 / dist) ** 1.2
    y = sweep(y * amp, "lp", 1200 + 3800 * amp / amp.max(), 0.7)
    return fade(to_stereo(y, np.clip(x / 25, -1, 1)), 0.05, 0.1)


sfx("engines", "pass-by-01", "Car pass-by 1", ["engine", "car", "pass-by", "doppler", "street"])(lambda: _passby(3.2, 910))
sfx("engines", "pass-by-02", "Car pass-by 2 (fast)", ["engine", "car", "pass-by", "doppler", "race", "fast"])(lambda: _passby(2.4, 911, 70))


def _screech(dur: float, seed: int, f: float):
    n = n_of(dur)
    wob = 1 + 0.03 * np.sin(np.cumsum(2 * np.pi * (6 + 4 * rng(seed).random(n)) / SR))
    tone = fm(f * wob, 1.5, 0.8, dur) * 0.5
    nz = sweep(white(dur, seed), "bp", f * 1.2 * wob, 6.0) * 1.2
    y = (tone + nz) * env_adsr(dur, 0.03, 0.1, 0.85, 0.25)
    return reverb(fade(drive(y, 1.4), 0.01, 0.05), 0.9, 0.12, seed=seed)


sfx("engines", "tire-screech-01", "Tire screech 1", ["tire", "screech", "drift", "brake", "car"])(lambda: _screech(1.6, 920, 1650))
sfx("engines", "tire-screech-02", "Tire screech 2 (long drift)", ["tire", "screech", "drift", "car"])(lambda: _screech(2.8, 921, 1400))


# ------------------------------------------------------------------------------------------------
# Explosions and booms (synthetic)
# ------------------------------------------------------------------------------------------------

def _explosion(dur: float, seed: int, size: float = 1.0, far: bool = False):
    n = n_of(dur)
    body = brown(dur, seed) * 2.0 + pink(dur, seed + 1) * 0.8
    body = sweep(body, "lp", np.geomspace(5000 if not far else 1500, 120, n), 0.7)
    sub = sine(np.geomspace(70 * size, 28, n), dur) * env_exp(dur, 0.45 * size)
    crk = highpass(crackle(dur, 260, seed + 2, 1.0), 1200) * env_exp(dur, 0.6) * (0.0 if far else 0.4)
    y = drive((body * env_exp(dur, 0.55 * size, 0.004) + sub * 1.2 + crk) * 1.3, 2.4)
    st = reverb(fade(y, 0.0005, 0.3), 2.2 if far else 1.6, 0.4 if far else 0.25, seed=seed, bright=3000 if far else 6000)
    return st


sfx("explosions", "boom-01", "Boom 1", ["explosion", "boom", "blast", "big", "car"])(lambda: _explosion(2.8, 1000))
sfx("explosions", "boom-02", "Boom 2 (short)", ["explosion", "boom", "blast", "grenade"])(lambda: _explosion(1.8, 1001, 0.8))
sfx("explosions", "boom-03", "Boom 3 (heavy)", ["explosion", "boom", "heavy", "bass"])(lambda: _explosion(3.4, 1002, 1.3))
def _explosion_debris(seed: int):
    y = _explosion(4.0, seed, 1.4)
    debris = highpass(crackle(4.0, 90, seed + 10, 1.0), 2000) * env_exp(4.0, 1.5) * 0.3
    mix_at(y, to_stereo(debris), 0.0)
    return y


sfx("explosions", "explosion-big-01", "Big explosion 1", ["explosion", "big", "debris", "fire", "heist"])(lambda: _explosion_debris(1003))
sfx("explosions", "explosion-big-02", "Big explosion 2", ["explosion", "big", "rumble", "fire"])(lambda: _explosion(4.5, 1004, 1.5))
sfx("explosions", "distant-boom-01", "Distant boom 1", ["explosion", "distant", "far", "thunder", "city"])(lambda: _explosion(3.5, 1005, 1.0, True))
sfx("explosions", "distant-boom-02", "Distant boom 2", ["explosion", "distant", "far", "war"])(lambda: _explosion(4.0, 1006, 1.2, True))


def _firework(seed: int):
    d = 2.2
    y = np.zeros(n_of(d))
    mix_at(y, highpass(white(0.05, seed), 1500) * env_exp(0.05, 0.006) * 1.6, 0.0)
    mix_at(y, lowpass(white(0.3, seed + 1), 900) * env_exp(0.3, 0.06), 0.0, 0.8)
    mix_at(y, highpass(crackle(1.8, 220, seed + 2, 0.9), 2500) * env_exp(1.8, 0.7) * 0.7, 0.25)
    return reverb(fade(y, 0.0005, 0.2), 1.8, 0.3, seed=seed)


sfx("explosions", "firework-pop-01", "Firework pop", ["firework", "pop", "celebration", "crackle", "party"])(lambda: _firework(1010))


# ------------------------------------------------------------------------------------------------
# Stingers (our own melodies)
# ------------------------------------------------------------------------------------------------

def _brass(m: float, dur: float, seed: int, bright: float = 1.0):
    f = note(m)
    y = supersaw(f, dur, 5, 12, seed) * 0.6 + square(f / 2, dur, 0.4) * 0.2
    n = n_of(dur)
    cutoff = 600 + 4200 * bright * np.exp(-np.arange(n) / (0.25 * SR)) + 900
    return sweep(y, "lp", cutoff, 0.9) * env_adsr(dur, 0.02, 0.15, 0.75, min(0.4, dur * 0.4))


def _timp(m: float, dur: float, seed: int):
    f = note(m)
    y = sine(glide([(0, f * 1.4), (0.04, f), (dur, f * 0.98)], dur), dur) * env_exp(dur, 0.5)
    y += lowpass(white(dur, seed), 1200) * env_exp(dur, 0.05) * 0.5
    return y


def _stinger(events: list[tuple[float, list[float], float]], seed: int, timp: list[tuple[float, float]] = (), shimmer: bool = False, tail: float = 1.2):
    total = max(t + d for t, _, d in events) + tail
    y = np.zeros(n_of(total))
    for t, chord, d in events:
        for k, m in enumerate(chord):
            mix_at(y, _brass(m, d, seed + k), t, 0.55 / np.sqrt(len(chord)))
    for t, m in timp:
        mix_at(y, _timp(m, 1.0, seed + 50), t, 0.9)
    if shimmer:
        sh = sum(_bell_note(note(m), 1.6, 1.2) for m in (84, 88, 91, 96))
        mix_at(y, highpass(sh, 1500) * 0.3, events[-1][0])
    return reverb(fade(y, 0.002, 0.3), 2.0, 0.28, seed=seed)


# Mission complete: rising, major, confident (original phrases).
sfx("stingers", "mission-complete-01", "Mission complete 1", ["stinger", "success", "win", "complete", "victory"])(
    lambda: _stinger([(0.0, [60, 64], 0.18), (0.2, [64, 67], 0.18), (0.4, [67, 72, 76], 1.4)], 1100, [(0.4, 36)], True)
)
sfx("stingers", "mission-complete-02", "Mission complete 2", ["stinger", "success", "win", "complete", "triumph"])(
    lambda: _stinger([(0.0, [57, 62, 66], 0.25), (0.3, [59, 64, 67], 0.25), (0.6, [62, 66, 69, 74], 1.6)], 1101, [(0.0, 38), (0.6, 38)], True)
)
sfx("stingers", "mission-complete-03", "Mission complete 3 (short)", ["stinger", "success", "short", "done"])(
    lambda: _stinger([(0.0, [65, 69, 72], 0.15), (0.16, [67, 71, 74, 79], 1.0)], 1102, [(0.16, 43)])
)
# Mission failed: falling, minor, heavy (original phrases).
sfx("stingers", "mission-failed-01", "Mission failed 1", ["stinger", "fail", "lose", "failed", "sad"])(
    lambda: _stinger([(0.0, [64, 67, 71], 0.35), (0.4, [63, 66, 70], 0.35), (0.8, [57, 60, 64], 1.8)], 1110, [(0.8, 33)])
)
sfx("stingers", "mission-failed-02", "Mission failed 2", ["stinger", "fail", "lose", "dark"])(
    lambda: _stinger([(0.0, [62, 65], 0.5), (0.55, [56, 60, 63], 2.0)], 1111, [(0.0, 31), (0.55, 29)])
)
sfx("stingers", "mission-failed-03", "Mission failed 3 (sad trombone style)", ["stinger", "fail", "funny", "lose", "comedy"])(
    lambda: _sad_horn(1112)
)


def _sad_horn(seed: int):
    parts = []
    for m, d in [(62, 0.32), (61, 0.32), (60, 0.32)]:
        parts.append(formant(saw(note(m), d) * env_adsr(d, 0.02, 0.05, 0.85, 0.06), "o"))
    last_d = 1.4
    vib = note(59) * (1 + 0.02 * np.sin(2 * np.pi * 5.5 * tvec(last_d)))
    parts.append(formant(saw(np.linspace(note(59), note(57), n_of(last_d)) * vib / note(59), last_d) * env_adsr(last_d, 0.02, 0.1, 0.8, 0.4), "o"))
    y = np.concatenate(parts) * 0.8
    return reverb(fade(y, 0.002, 0.2), 1.2, 0.2, seed=seed)


sfx("stingers", "tension-stinger-01", "Tension stinger 1", ["stinger", "tension", "suspense", "danger", "reveal"])(
    lambda: _stinger([(0.0, [45, 46, 52, 58], 1.8)], 1120, [(0.0, 26)])
)
sfx("stingers", "tension-stinger-02", "Tension stinger 2", ["stinger", "tension", "horror", "hit"])(
    lambda: _stinger([(0.0, [41, 47, 53, 54], 1.4)], 1121, [(0.0, 29)])
)
sfx("stingers", "reveal-stinger-01", "Reveal stinger 1", ["stinger", "reveal", "epic", "big"])(
    lambda: _stinger([(0.0, [48, 55, 60, 64, 67], 2.2)], 1122, [(0.0, 36)], True)
)
sfx("stingers", "reveal-stinger-02", "Reveal stinger 2", ["stinger", "reveal", "drama", "cinematic"])(
    lambda: _stinger([(0.0, [50, 57, 62, 65], 0.5), (0.55, [53, 60, 65, 69], 1.8)], 1123, [(0.55, 41)])
)


def _levelup(seed: int, notes: list[int], step: float = 0.06):
    d = step * len(notes) + 0.5
    y = np.zeros(n_of(d))
    for k, m in enumerate(notes):
        dd = 0.12 if k < len(notes) - 1 else 0.45
        mix_at(y, square(note(m), dd, 0.25) * env_adsr(dd, 0.002, 0.03, 0.7, 0.05) * 0.35, k * step)
    return reverb(fade(y, 0.001, 0.05), 0.6, 0.12, seed=seed)


sfx("stingers", "level-up-01", "Level up 1", ["stinger", "level-up", "rank", "retro", "8-bit", "upgrade"])(lambda: _levelup(1130, [60, 64, 67, 72, 76, 79, 84]))
sfx("stingers", "level-up-02", "Level up 2", ["stinger", "level-up", "rank", "retro", "unlock"])(lambda: _levelup(1131, [67, 71, 74, 79, 83, 86], 0.07))


# ------------------------------------------------------------------------------------------------
# Camera and film
# ------------------------------------------------------------------------------------------------

def _shutter(seed: int, gap: float = 0.07):
    d = gap + 0.15
    y = np.zeros(n_of(d))
    for k, t in enumerate([0.0, gap]):
        c = bandpass(white(0.04, seed + k), 1500, 9000) * env_exp(0.04, 0.005)
        c += sine(2400 - 600 * k, 0.04) * env_exp(0.04, 0.004) * 0.3
        mix_at(y, c, t)
    return fade(y, 0.0005, 0.02)


sfx("camera", "shutter-01", "Camera shutter 1", ["camera", "shutter", "photo", "screenshot", "snap"])(lambda: _shutter(1200))
sfx("camera", "shutter-02", "Camera shutter 2 (fast)", ["camera", "shutter", "photo", "burst"])(lambda: _shutter(1201, 0.045))
sfx("camera", "flash-charge-01", "Flash charge", ["camera", "flash", "charge", "whine", "power-up"])(
    lambda: fade(sine(np.geomspace(1800, 9000, n_of(1.2)), 1.2) * np.linspace(0.05, 0.4, n_of(1.2)), 0.02, 0.05)
)
sfx("camera", "focus-beep-01", "Focus beep", ["camera", "focus", "beep", "lock-on"])(
    lambda: fade(np.concatenate([sine(2800, 0.06), np.zeros(n_of(0.05)), sine(2800, 0.08)]) * 0.4, 0.002, 0.01)
)
sfx("camera", "film-wind-01", "Film wind", ["camera", "film", "wind", "ratchet", "retro"])(
    lambda: fade(sum_clicks(1211, 9, 0.55), 0.002, 0.02)
)


def sum_clicks(seed: int, k: int, dur: float):
    y = np.zeros(n_of(dur + 0.05))
    for i in range(k):
        mix_at(y, _click(seed + i, 1800, 0.04), i * dur / k)
    return y


# ------------------------------------------------------------------------------------------------
# Record scratch and tape stop
# ------------------------------------------------------------------------------------------------

def _scratch(seed: int, moves: list[tuple[float, float]]):
    """moves: (duration, direction speed); a tone plus noise pitched by the hand's speed."""
    parts = []
    for d, sp in moves:
        n = n_of(d)
        speed = np.sin(np.linspace(0, np.pi, n)) * sp
        f = 220 * (1 + np.abs(speed) * 2.2)
        tone = saw(f, d) * 0.3 + sweep(white(d, seed), "bp", 900 * (1 + np.abs(speed)), 1.8)
        parts.append(tone * np.abs(speed))
        seed += 1
    return fade(drive(np.concatenate(parts) * 1.2, 1.5), 0.002, 0.02)


sfx("record", "record-scratch-01", "Record scratch 1", ["scratch", "record", "stop", "dj", "funny"])(lambda: _scratch(1300, [(0.12, 1.0), (0.1, -0.8), (0.15, 1.2)]))
sfx("record", "record-scratch-02", "Record scratch 2", ["scratch", "record", "dj", "rewind"])(lambda: _scratch(1301, [(0.08, 0.9), (0.08, -0.9), (0.08, 0.9), (0.2, -1.1)]))


def _tape_stop(seed: int, dur: float, chord: list[int]):
    n = n_of(dur)
    slow = np.linspace(1, 0.02, n) ** 1.6
    y = sum(saw(note(m) * slow, dur, k * 0.2) for k, m in enumerate(chord)) / len(chord)
    y += square(note(chord[0] - 12) * slow, dur) * 0.3
    y = sweep(y, "lp", 3000 * slow + 80, 0.8) * np.linspace(1, 0, n) ** 0.4
    return fade(y, 0.002, 0.05)


sfx("record", "tape-stop-01", "Tape stop 1", ["tape", "stop", "slowdown", "power-down", "transition"])(lambda: _tape_stop(1310, 1.1, [57, 60, 64]))
sfx("record", "tape-stop-02", "Tape stop 2 (power down)", ["tape", "stop", "power-down", "shutdown"])(lambda: _tape_stop(1311, 1.6, [45, 52, 57]))


# ------------------------------------------------------------------------------------------------
# Phone
# ------------------------------------------------------------------------------------------------

def _marimba(m: float, dur: float):
    f = note(m)
    return (sine(f, dur) + 0.3 * sine(f * 4.0, dur) * env_exp(dur, 0.05)) * env_exp(dur, 0.25, 0.002)


def _ring(seed: int, pattern: list[int], step: float, reps: int = 2):
    seq_d = step * len(pattern)
    total = seq_d * reps + 0.5 * reps
    y = np.zeros(n_of(total))
    for r_ in range(reps):
        for k, m in enumerate(pattern):
            mix_at(y, _marimba(m, 0.5), r_ * (seq_d + 0.5) + k * step, 0.5)
    return reverb(fade(y, 0.002, 0.1), 0.8, 0.12, seed=seed)


sfx("phone", "ring-01", "Phone ring 1", ["phone", "ring", "call", "ringtone", "incoming"])(lambda: _ring(1400, [76, 79, 84, 79, 76, 72], 0.11))
sfx("phone", "ring-02", "Phone ring 2", ["phone", "ring", "call", "ringtone"])(lambda: _ring(1401, [71, 74, 78, 81, 78, 74], 0.1))
sfx("phone", "text-ping-01", "Text ping 1", ["phone", "text", "message", "sms", "ping"])(lambda: _chime([84, 88], 0.08, 0.4, 1410, 0.1))
sfx("phone", "text-ping-02", "Text ping 2", ["phone", "text", "message", "pop"])(
    lambda: fade(sine(glide([(0, 900), (0.04, 1600), (0.15, 1500)], 0.15), 0.15) * env_exp(0.15, 0.05) * 0.6, 0.001, 0.02)
)
sfx("phone", "text-ping-03", "Text ping 3", ["phone", "text", "message", "double"])(lambda: _chime([91, 91], 0.12, 0.3, 1412, 0.08))


def _vibrate(seed: int, pulses: int, on: float, off: float):
    total = pulses * (on + off)
    y = np.zeros(n_of(total))
    for k in range(pulses):
        b = (square(170, on, 0.5) * 0.25 + lowpass(white(on, seed + k), 600) * 0.4) * env_adsr(on, 0.01, 0.02, 0.9, 0.03)
        mix_at(y, b, k * (on + off))
    return fade(y, 0.002, 0.02)


sfx("phone", "vibrate-01", "Phone vibrate 1", ["phone", "vibrate", "buzz", "silent"])(lambda: _vibrate(1420, 2, 0.35, 0.25))
sfx("phone", "vibrate-02", "Phone vibrate 2 (short)", ["phone", "vibrate", "buzz", "notification"])(lambda: _vibrate(1421, 3, 0.12, 0.08))
sfx("phone", "dial-blip-01", "Dial blip", ["phone", "dial", "keypad", "beep"])(
    lambda: fade((sine(770, 0.12) + sine(1336, 0.12)) * 0.3 * env_adsr(0.12, 0.002, 0.01, 0.9, 0.02), 0.001, 0.01)
)
sfx("phone", "hang-up-01", "Hang up", ["phone", "hang-up", "end", "call", "beep"])(
    lambda: fade(np.concatenate([sine(480, 0.18) * 0.35, np.zeros(n_of(0.08)), sine(480, 0.18) * 0.35, np.zeros(n_of(0.08)), sine(480, 0.18) * 0.35]), 0.002, 0.02)
)


# ------------------------------------------------------------------------------------------------
# Comedic
# ------------------------------------------------------------------------------------------------

def _boing(seed: int, f0: float, dur: float):
    t = tvec(dur)
    f = f0 * (1 + 0.5 * np.exp(-t * 6) * np.sin(2 * np.pi * 14 * t)) * (1 + 0.6 * np.exp(-t * 3))
    y = sine(f, dur) * env_exp(dur, dur * 0.35) + triangle(f * 2, dur) * env_exp(dur, dur * 0.2) * 0.3
    return fade(y, 0.001, 0.05)


sfx("comedy", "boing-01", "Boing 1", ["boing", "spring", "funny", "bounce", "cartoon"])(lambda: _boing(1500, 220, 0.8))
sfx("comedy", "boing-02", "Boing 2 (high)", ["boing", "spring", "funny", "jump"])(lambda: _boing(1501, 380, 0.6))
sfx("comedy", "boing-03", "Boing 3 (low)", ["boing", "spring", "funny", "fall"])(lambda: _boing(1502, 140, 1.0))
sfx("comedy", "plop-01", "Plop 1", ["plop", "pop", "drop", "funny", "bubble"])(
    lambda: fade(sine(glide([(0, 900), (0.05, 220), (0.12, 180)], 0.15), 0.15) * env_exp(0.15, 0.05) * 0.8, 0.0005, 0.02)
)
sfx("comedy", "plop-02", "Plop 2 (pop)", ["plop", "pop", "cork", "funny"])(
    lambda: fade(sine(glide([(0, 300), (0.02, 1400), (0.1, 1000)], 0.12), 0.12) * env_exp(0.12, 0.03) * 0.8 + highpass(white(0.12, 1511), 3000) * env_exp(0.12, 0.004), 0.0005, 0.02)
)


def _slide(up: bool, seed: int):
    d = 0.9
    f = np.geomspace(500, 2000, n_of(d)) if up else np.geomspace(2000, 450, n_of(d))
    f = f * (1 + 0.012 * np.sin(2 * np.pi * 6 * tvec(d)))
    y = sine(f, d) * env_adsr(d, 0.04, 0.05, 0.85, 0.15) * 0.6 + highpass(white(d, seed), 3000) * 0.04
    return fade(y, 0.005, 0.03)


sfx("comedy", "slide-whistle-up-01", "Slide whistle up", ["slide-whistle", "up", "funny", "cartoon", "rise"])(lambda: _slide(True, 1520))
sfx("comedy", "slide-whistle-down-01", "Slide whistle down", ["slide-whistle", "down", "funny", "cartoon", "fall"])(lambda: _slide(False, 1521))
sfx("comedy", "honk-01", "Bike horn honk", ["honk", "horn", "clown", "funny", "squeeze"])(
    lambda: fade(formant(saw(glide([(0, 300), (0.05, 360), (0.25, 340)], 0.25), 0.25), "a") * env_adsr(0.25, 0.01, 0.04, 0.8, 0.06) * 0.9, 0.002, 0.02)
)
sfx("comedy", "car-horn-01", "Car horn", ["horn", "car", "honk", "traffic", "angry"])(
    lambda: fade(drive((saw(392, 0.6) + saw(494, 0.6)) * 0.4 * env_adsr(0.6, 0.01, 0.03, 0.9, 0.05), 1.8), 0.002, 0.02)
)
sfx("comedy", "crowd-ooh-01", "Crowd ooh (synthetic)", ["crowd", "ooh", "reaction", "wow", "audience"])(lambda: _crowd_vowel(1530, "o", 1.6, glide_up=False))
sfx("comedy", "crowd-cheer-01", "Crowd cheer (synthetic)", ["crowd", "cheer", "reaction", "win", "audience"])(lambda: _crowd_vowel(1531, "a", 2.2, glide_up=True))


def _crowd_vowel(seed: int, vowel: str, dur: float, glide_up: bool):
    r = rng(seed)
    y = np.zeros(n_of(dur))
    for k in range(18):
        f0 = r.uniform(110, 260)
        f = glide([(0, f0), (dur, f0 * (1.25 if glide_up else 0.9))], dur)
        v = formant(saw(f * (1 + 0.01 * np.sin(2 * np.pi * r.uniform(4, 7) * tvec(dur))), dur), vowel)
        y += v * r.uniform(0.3, 1.0)
    y += bandpass(white(dur, seed), 400, 3000) * 0.6
    y *= env_adsr(dur, 0.25, 0.3, 0.7, dur * 0.4)
    return reverb(fade(y / 6, 0.05, 0.1), 1.5, 0.3, seed=seed)
