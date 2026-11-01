"""Seamless music loops, composed and synthesized here: drums, bass, chords and leads are all
oscillators and filtered noise. Each loop is rendered twice and the second pass kept, so reverb and
delay tails wrap around and the loop joins without a click."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .audio_core import (
    SR, bandpass, crackle, delay, drive, env_adsr, env_exp, fade, fm, glide, highpass, lowpass, mix_at, n_of,
    peak_eq, pink, reverb, rng, saw, sidechain, sine, square, supersaw, sweep, to_stereo, triangle, white,
)


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


NOTE = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
QUAL = {
    "": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11], "m9": [0, 3, 7, 10, 14],
    "9": [0, 4, 7, 10, 14], "maj9": [0, 4, 7, 11, 14], "13": [0, 4, 10, 14, 21], "add9": [0, 4, 7, 14], "madd9": [0, 3, 7, 14],
    "sus2": [0, 2, 7], "sus4": [0, 5, 7], "7b9": [0, 4, 7, 10, 13], "m11": [0, 3, 7, 10, 14, 17],
}


def chord(name: str, octave: int = 4) -> tuple[int, list[int]]:
    """'Am7' -> (root midi in octave 2, chord tones as midi in `octave`)."""
    root = name[:2] if len(name) > 1 and name[1] in "#b" else name[:1]
    q = name[len(root):]
    r = NOTE[root]
    base = 12 * (octave + 1) + r
    tones = [base + i for i in QUAL[q]]
    # voice-lead into a compact range around the octave's middle
    tones = [t - 12 if t > 12 * (octave + 1) + 16 else t for t in tones]
    return 12 * 3 + r, sorted(tones)


# ------------------------------------------------------------------------------------------------
# Instruments (mono unless noted)
# ------------------------------------------------------------------------------------------------

def kick(style: str = "punch") -> np.ndarray:
    if style == "808":
        d = 0.9
        y = sine(glide([(0, 120), (0.03, 55), (d, 48)], d), d) * env_exp(d, 0.45)
        return drive(y * 1.5, 1.6)
    if style == "lofi":
        d = 0.35
        y = sine(glide([(0, 130), (0.04, 52), (d, 46)], d), d) * env_exp(d, 0.16)
        y += lowpass(white(d, 3), 1200) * env_exp(d, 0.008) * 0.3
        return lowpass(y, 2500) * 0.95
    d = 0.42
    y = sine(glide([(0, 170), (0.045, 54), (d, 48)], d), d) * env_exp(d, 0.22)
    y += highpass(white(d, 1), 2500) * env_exp(d, 0.003) * 0.5
    return drive(y * 1.25, 1.4)


def snare(style: str = "gated", seed: int = 11) -> np.ndarray:
    if style == "trap":
        d = 0.25
        y = bandpass(white(d, seed), 1500, 9000) * env_exp(d, 0.07) + sine(glide([(0, 260), (d, 180)], d), d) * env_exp(d, 0.05) * 0.6
        return drive(y * 1.3, 1.3)
    if style == "lofi":
        d = 0.3
        y = bandpass(white(d, seed), 900, 5000) * env_exp(d, 0.09) + sine(195, d) * env_exp(d, 0.05) * 0.5
        return lowpass(y, 4500) * 0.85
    d = 0.45
    y = bandpass(white(d, seed), 1000, 8000) * env_exp(d, 0.16) + sine(glide([(0, 240), (d, 190)], d), d) * env_exp(d, 0.08) * 0.7
    return y


def clap(seed: int = 21) -> np.ndarray:
    d = 0.3
    y = np.zeros(n_of(d))
    for k, t in enumerate([0.0, 0.011, 0.022]):
        mix_at(y, bandpass(white(0.02, seed + k), 900, 6000) * env_exp(0.02, 0.004), t)
    mix_at(y, bandpass(white(0.25, seed + 9), 900, 5000) * env_exp(0.25, 0.06), 0.03)
    return y * 1.2


def hat(open_: bool = False, seed: int = 31, tone: float = 7000) -> np.ndarray:
    d = 0.32 if open_ else 0.06
    y = highpass(white(d, seed), tone) * env_exp(d, 0.11 if open_ else 0.014)
    y += highpass(square(tone * 0.83, d, 0.5) * 0.15 + square(tone * 1.21, d, 0.5) * 0.1, tone) * env_exp(d, 0.02)
    return y * 0.55


def shaker(seed: int = 41) -> np.ndarray:
    d = 0.09
    return bandpass(white(d, seed), 3500, 11000) * env_adsr(d, 0.02, 0.02, 0.4, 0.04) * 0.45


def rim(seed: int = 51) -> np.ndarray:
    d = 0.08
    return (bandpass(white(d, seed), 1500, 6000) * env_exp(d, 0.008) + sine(1700, d) * env_exp(d, 0.015) * 0.5) * 0.8


def bass_synth(m: float, dur: float, bright: float = 1.0, seed: int = 0) -> np.ndarray:
    f = hz(m)
    y = saw(f, dur, seed * 0.1) * 0.6 + square(f / 2, dur, 0.5) * 0.25 + sine(f / 2, dur) * 0.4
    n = n_of(dur)
    cut = 180 + 1400 * bright * np.exp(-np.arange(n) / (0.07 * SR))
    return sweep(y, "lp", cut, 1.1) * env_adsr(dur, 0.004, 0.08, 0.7, min(0.06, dur * 0.3))


def bass_808(m: float, dur: float, prev: float | None = None) -> np.ndarray:
    f1 = hz(m)
    f0 = hz(prev) if prev is not None else f1
    f = glide([(0, f0), (0.06 if prev is not None else 0, f1), (dur, f1)], dur)
    y = sine(f, dur) * env_adsr(dur, 0.004, 0.2, 0.8, min(0.12, dur * 0.4))
    y = drive(y * 1.8, 1.8)
    y += sine(f * 2, dur) * env_exp(dur, 0.03) * 0.15
    return y


def bass_slap(m: float, dur: float) -> np.ndarray:
    f = hz(m)
    y = square(f, dur, 0.35) * 0.5 + sine(f, dur) * 0.5
    n = n_of(dur)
    cut = 250 + 3000 * np.exp(-np.arange(n) / (0.035 * SR))
    return sweep(y, "lp", cut, 2.0) * env_adsr(dur, 0.002, 0.06, 0.55, 0.03)


def pad(notes: list[int], dur: float, seed: int, cutoff: float = 1800, attack: float = 0.25, stereo: bool = True) -> np.ndarray:
    chans = []
    for c in range(2 if stereo else 1):
        y = sum(supersaw(hz(m), dur, 5, 16, seed + 7 * k + 97 * c) for k, m in enumerate(notes)) / max(1, len(notes))
        y = lowpass(y, cutoff, 2) * env_adsr(dur, attack, 0.3, 0.85, min(0.4, dur * 0.3))
        chans.append(y)
    return np.stack(chans) if stereo else chans[0]


def rhodes(m: float, dur: float, vel: float = 1.0) -> np.ndarray:
    f = hz(m)
    n = n_of(dur)
    idx = 1.6 * vel * np.exp(-np.arange(n) / (0.35 * SR)) + 0.2
    y = fm(f, 1.0, idx, dur) * 0.7 + sine(f * 2, dur) * env_exp(dur, 0.15) * 0.1
    trem = 1 + 0.12 * np.sin(2 * np.pi * 4.2 * np.arange(n) / SR)
    return y * trem * env_adsr(dur, 0.004, 0.6, 0.45, min(0.3, dur * 0.4)) * vel


def pluck(m: float, dur: float, bright: float = 1.0, seed: int = 0) -> np.ndarray:
    f = hz(m)
    y = saw(f, dur, seed * 0.17) * 0.5 + square(f, dur, 0.3) * 0.3
    n = n_of(dur)
    cut = 300 + 5000 * bright * np.exp(-np.arange(n) / (0.09 * SR))
    return sweep(y, "lp", cut, 1.0) * env_exp(dur, 0.22)


def bell(m: float, dur: float) -> np.ndarray:
    f = hz(m)
    n = n_of(dur)
    idx = 3.0 * np.exp(-np.arange(n) / (0.25 * SR))
    return fm(f, 3.5, idx, dur) * env_exp(dur, 0.5) * 0.6


def lead(m: float, dur: float, vib: float = 0.006) -> np.ndarray:
    f = hz(m)
    n = n_of(dur)
    t = np.arange(n) / SR
    v = 1 + vib * np.sin(2 * np.pi * 5.2 * t) * np.clip(t / 0.25, 0, 1)
    y = square(f * v, dur, 0.4) * 0.45 + saw(f * v * 1.003, dur) * 0.35
    return lowpass(y, 3800) * env_adsr(dur, 0.01, 0.1, 0.8, min(0.08, dur * 0.3))


def stab(notes: list[int], dur: float, seed: int) -> np.ndarray:
    y = sum(supersaw(hz(m), dur, 3, 10, seed + k) for k, m in enumerate(notes)) / len(notes)
    n = n_of(dur)
    cut = 500 + 4500 * np.exp(-np.arange(n) / (0.06 * SR))
    return sweep(y, "lp", cut, 1.0) * env_adsr(dur, 0.003, 0.08, 0.3, 0.05)


def clav(notes: list[int], dur: float) -> np.ndarray:
    y = sum(square(hz(m), dur, 0.25) for m in notes) / len(notes)
    return bandpass(y, 500, 3500) * env_exp(dur, 0.09)


# ------------------------------------------------------------------------------------------------
# Song structure
# ------------------------------------------------------------------------------------------------

@dataclass
class Loop:
    slug: str
    genre: str
    name: str
    bpm: float
    bars: int
    tags: list[str]
    build: Callable[["Ctx"], np.ndarray]
    extra: dict = field(default_factory=dict)


@dataclass
class Ctx:
    bpm: float
    bars: int
    swing: float = 0.0

    @property
    def beat(self) -> float:
        return 60.0 / self.bpm

    @property
    def step(self) -> float:
        return self.beat / 4

    @property
    def loop_n(self) -> int:
        """Loop length in samples, rounded to a whole millisecond so durationMs is exact."""
        return int(round(self.bars * 4 * self.beat * 1000)) * (SR // 1000)

    @property
    def loop_s(self) -> float:
        return self.loop_n / SR

    def t(self, bar: int, step: float) -> float:
        """Time of a 16th step in a bar (swing delays the off-16ths)."""
        s = bar * 16 + step
        frac = step % 2
        sw = self.swing * self.step if abs(frac - 1) < 1e-6 else 0.0
        return s * self.step + sw

    def buf(self, stereo: bool = False) -> np.ndarray:
        n = n_of(self.loop_s * 2 + 4.0)
        return np.zeros((2, n)) if stereo else np.zeros(n)


def place(ctx: Ctx, bus: np.ndarray, sound: np.ndarray, steps: list[float], bars: range | list[int] | None = None, gain: float = 1.0, both: bool = True) -> list[float]:
    """Put `sound` at each step of every bar, in both passes of the loop. Returns hit times."""
    times = []
    for rep in (0, 1) if both else (0,):
        for b in bars if bars is not None else range(ctx.bars):
            for s in steps:
                tt = rep * ctx.loop_s + ctx.t(b, s)
                mix_at(bus, sound, tt, gain)
                times.append(tt)
    return times


def take_second_pass(ctx: Ctx, mixdown: np.ndarray) -> np.ndarray:
    a = ctx.loop_n
    return mixdown[..., a : a * 2]


def master(ctx: Ctx, mixdown: np.ndarray) -> np.ndarray:
    """Mastering EQ on the whole two-pass render (so filter state is continuous across the loop
    point): tame the sub (synth kicks and 808s carry a lot of energy below 80 Hz), add a little
    presence and a gentle saturation. Then keep the second pass."""
    y = highpass(mixdown, 30, 2)
    y = peak_eq(y, 52, 0.6, -9.0)
    y = peak_eq(y, 110, 0.9, -3.0)
    y = peak_eq(y, 3200, 0.7, 3.0)
    y = peak_eq(y, 9000, 0.7, 2.0)
    return take_second_pass(ctx, drive(y * 0.9, 1.15))


def drums_four(ctx: Ctx, kick_style="punch", snare_style="gated", hats="8", open_off=False, clap_on=False, seed=0, swing_hats=False):
    kb = ctx.buf()
    k_hits = place(ctx, kb, kick(kick_style), [0, 4, 8, 12])
    sb = ctx.buf()
    place(ctx, sb, snare(snare_style, seed + 11), [4, 12])
    if clap_on:
        place(ctx, sb, clap(seed + 21), [4, 12], gain=0.7)
    hb = ctx.buf()
    steps = {"8": [0, 2, 4, 6, 8, 10, 12, 14], "16": list(range(16)), "off": [2, 6, 10, 14]}[hats]
    r = rng(seed + 5)
    for s in steps:
        place(ctx, hb, hat(False, seed + 31 + s), [s], gain=0.6 + 0.3 * r.random())
    if open_off:
        place(ctx, hb, hat(True, seed + 61), [2, 6, 10, 14], gain=0.55)
    return kb, sb, hb, k_hits


def chord_bars(ctx: Ctx, prog: list[str], octave: int = 4) -> list[tuple[int, list[int]]]:
    per = ctx.bars // len(prog)
    out = []
    for b in range(ctx.bars):
        out.append(chord(prog[min(len(prog) - 1, b // per)], octave))
    return out


def stereoize(x: np.ndarray, pan: float = 0.0) -> np.ndarray:
    return to_stereo(x, pan) if x.ndim == 1 else x


def mixdown(ctx: Ctx, parts: list[tuple[np.ndarray, float, float]]) -> np.ndarray:
    """parts: (bus, gain, pan)."""
    n = max(p[0].shape[-1] for p in parts)
    out = np.zeros((2, n))
    for bus, g, pan_ in parts:
        st = stereoize(bus, pan_)
        out[:, : st.shape[-1]] += st * g
    return out


# ------------------------------------------------------------------------------------------------
# The loops
# ------------------------------------------------------------------------------------------------

LOOPS: list[Loop] = []


def loop(slug, genre, name, bpm, bars, tags):
    def wrap(fn):
        LOOPS.append(Loop(slug, genre, name, bpm, bars, tags, fn))
        return fn

    return wrap


def synthwave(ctx: Ctx, prog: list[str], seed: int, bass_pattern: list[float], arp: bool, lead_line: list[tuple[int, float, float]] | None, pad_cut=1800):
    kb, sb, hb, k_hits = drums_four(ctx, "punch", "gated", "8", seed=seed)
    sb = reverb(sb, 1.8, 0.35, seed=seed + 1, bright=5000)
    cb = chord_bars(ctx, prog)
    bb = ctx.buf()
    pb = ctx.buf(True)
    ab = ctx.buf()
    for b, (root, tones) in enumerate(cb):
        place(ctx, pb, pad(tones, 4 * ctx.beat, seed + b % len(prog), pad_cut, 0.2), [0], [b], 0.5)
        for k, s in enumerate(bass_pattern):
            m = root + (12 if k % 2 else 0) if len(bass_pattern) == 8 else root
            place(ctx, bb, bass_synth(m, ctx.step * 1.8, 0.8, k), [s], [b], 0.7)
        if arp:
            seq = (tones + [tones[0] + 12])
            for s in range(16):
                m = seq[s % len(seq)] + 12
                place(ctx, ab, pluck(m, ctx.step * 1.5, 0.8, s), [s], [b], 0.28)
    pb = sidechain(pb, k_hits, 0.55, ctx.beat * 0.6)
    bb = sidechain(bb, k_hits, 0.4, ctx.beat * 0.4)
    parts = [(kb, 0.9, 0), (sb, 0.55, 0), (hb, 0.35, 0.2), (bb, 0.6, 0), (pb, 0.45, 0)]
    if arp:
        parts.append((delay(ab, ctx.beat * 0.75, 0.35, 0.3), 0.5, 0))
    if lead_line:
        lb = ctx.buf()
        for (m, start_step, len_steps) in lead_line:
            for rep in (0, 1):
                mix_at(lb, lead(m, len_steps * ctx.step), rep * ctx.loop_s + start_step * ctx.step, 0.32)
        parts.append((reverb(delay(lb, ctx.beat * 0.75, 0.3, 0.25), 1.6, 0.25, seed=seed + 3), 0.55, 0))
    return master(ctx, mixdown(ctx, parts))


@loop("neon-drive", "synthwave", "Neon Drive", 100, 8, ["synthwave", "retro", "night", "drive", "80s", "neon"])
def _neon_drive(ctx: Ctx):
    return synthwave(ctx, ["Am", "F", "C", "G"], 2000, [0, 2, 4, 6, 8, 10, 12, 14], True, None)


@loop("vice-nights", "synthwave", "Vice Nights", 108, 8, ["synthwave", "retro", "night", "city", "80s", "melody"])
def _vice_nights(ctx: Ctx):
    s16 = 16
    line = []
    motif = [(74, 0, 3), (72, 3, 3), (69, 6, 2), (72, 8, 4), (74, 12, 2), (77, 14, 2)]
    motif2 = [(76, 0, 3), (74, 3, 3), (72, 6, 2), (69, 8, 6), (67, 14, 2)]
    for bar in range(8):
        m = motif if bar % 2 == 0 else motif2
        for note_, st, ln in m:
            line.append((note_ - (2 if bar in (2, 3) else 0) - (4 if bar in (6, 7) else 0), bar * s16 + st, ln))
    return synthwave(ctx, ["Dm", "Bb", "F", "C"], 2010, [0, 3, 4, 6, 8, 11, 12, 14], False, line, 1500)


@loop("sunset-cruise", "synthwave", "Sunset Cruise", 96, 8, ["synthwave", "chill", "sunset", "cruise", "beach", "warm"])
def _sunset_cruise(ctx: Ctx):
    kb, sb, hb, k_hits = drums_four(ctx, "punch", "gated", "off", seed=2020)
    sb = reverb(sb, 2.0, 0.35, seed=2021)
    cb = chord_bars(ctx, ["Fmaj7", "Em7", "Dm7", "Cmaj7"])
    rb = ctx.buf()
    bb = ctx.buf()
    pb = ctx.buf(True)
    for b, (root, tones) in enumerate(cb):
        place(ctx, pb, pad(tones, 4 * ctx.beat, 2022 + b % 4, 1400, 0.4), [0], [b], 0.35)
        for s in (0, 6, 10):
            place(ctx, rb, sum(rhodes(m, ctx.beat * 1.4, 0.8) for m in tones) / len(tones), [s], [b], 0.5)
        for s, m in ((0, root), (6, root), (8, root + 7), (14, root + 12)):
            place(ctx, bb, bass_synth(m, ctx.step * 2.5, 0.6, s), [s], [b], 0.6)
    pb = sidechain(pb, k_hits, 0.45, ctx.beat * 0.6)
    parts = [(kb, 0.75, 0), (sb, 0.45, 0), (hb, 0.3, -0.2), (bb, 0.55, 0), (pb, 0.4, 0), (reverb(rb, 1.4, 0.25, seed=2023), 0.55, 0)]
    return master(ctx, mixdown(ctx, parts))


def trap(ctx: Ctx, prog: list[str], seed: int, melody: Callable[[int, list[int]], list[tuple[int, float, float]]], inst: str = "bell", dark: bool = False):
    kb = ctx.buf()
    k_steps = [[0, 7, 10], [0, 3, 10], [0, 7, 11, 14], [0, 6, 10]]
    k_hits = []
    for b in range(ctx.bars):
        k_hits += place(ctx, kb, kick("punch") * 0.9, k_steps[b % 4], [b])
    sb = ctx.buf()
    place(ctx, sb, snare("trap", seed + 1), [8])
    place(ctx, sb, clap(seed + 2), [8], gain=0.6)
    hb = ctx.buf()
    r = rng(seed + 3)
    for b in range(ctx.bars):
        for s in range(0, 16, 2):
            place(ctx, hb, hat(False, seed + 40 + s), [s], [b], 0.5 + 0.2 * r.random())
        roll_at = [6, 14] if b % 2 else [14]
        for ra in roll_at:
            for k in range(4):
                place(ctx, hb, hat(False, seed + 90 + k, 7600), [ra + k * 0.5], [b], 0.35 + 0.08 * k)
    place(ctx, hb, hat(True, seed + 70, 6500), [12], list(range(1, ctx.bars, 2)), 0.4)
    cb = chord_bars(ctx, prog, 4)
    b8 = ctx.buf()
    prev = None
    for b, (root, tones) in enumerate(cb):
        for k, s in enumerate(k_steps[b % 4]):
            nxt = k_steps[b % 4][k + 1] if k + 1 < len(k_steps[b % 4]) else 16
            m = root - 12 + (7 if (b % 4 == 3 and k == 2) else 0)
            place(ctx, b8, bass_808(m, (nxt - s) * ctx.step * 0.98, prev), [s], [b], 0.9)
            prev = m
    mb = ctx.buf()
    pb = ctx.buf(True)
    for b, (root, tones) in enumerate(cb):
        place(ctx, pb, pad(tones, 4 * ctx.beat, seed + 5 + b % 4, 900 if dark else 1300, 0.6), [0], [b], 0.25)
        for m, st, ln in melody(b, tones):
            snd = bell(m, ln * ctx.step + 0.4) if inst == "bell" else pluck(m, ln * ctx.step + 0.2, 0.7, int(st))
            place(ctx, mb, snd, [st], [b], 0.4)
    mb = reverb(delay(mb, ctx.beat * 0.75 if not dark else ctx.beat * 0.5, 0.3, 0.25), 1.8, 0.3, seed=seed + 6)
    parts = [(kb, 0.55, 0), (b8, 0.85, 0), (sb, 0.6, 0), (hb, 0.35, 0.15), (pb, 0.45, 0), (mb, 0.55, 0)]
    return master(ctx, mixdown(ctx, parts))


@loop("block-party", "trap", "Block Party", 140, 8, ["trap", "hip-hop", "808", "street", "party", "bounce"])
def _block_party(ctx: Ctx):
    def mel(b, tones):
        hi = [t + 12 for t in tones]
        return [(hi[0], 0, 2), (hi[2], 3, 2), (hi[1], 6, 2), (hi[0], 10, 2), (hi[2] - 12 + 12, 12, 3)] if b % 2 == 0 else [(hi[1], 0, 3), (hi[0], 4, 2), (hi[2], 8, 4)]
    return trap(ctx, ["Cm", "Ab", "Bb", "G"], 2100, mel, "bell")


@loop("heist-prep", "trap", "Heist Prep", 150, 8, ["trap", "dark", "heist", "tension", "808", "plan"])
def _heist_prep(ctx: Ctx):
    def mel(b, tones):
        return [(tones[0] + 12, 0, 1), (tones[0] + 12, 3, 1), (tones[1] + 12, 6, 1), (tones[2] + 12, 8, 2), (tones[1] + 12, 12, 1), (tones[0] + 11, 14, 2)]
    return trap(ctx, ["Fm", "Db", "Eb", "C"], 2110, mel, "pluck", dark=True)


@loop("getaway", "trap", "Getaway", 136, 8, ["trap", "chase", "getaway", "808", "fast", "escape"])
def _getaway(ctx: Ctx):
    def mel(b, tones):
        hi = [t + 12 for t in tones]
        return [(hi[2], 0, 2), (hi[1], 2, 2), (hi[0], 4, 4), (hi[1], 10, 2), (hi[2], 12, 4)]
    return trap(ctx, ["Gm", "Eb", "Cm", "D"], 2120, mel, "bell")


def lofi(ctx: Ctx, prog: list[str], seed: int, rain: bool = False):
    ctx.swing = 0.18
    kb = ctx.buf()
    k_hits = place(ctx, kb, kick("lofi"), [0, 7, 10])
    sb = ctx.buf()
    place(ctx, sb, snare("lofi", seed + 1), [4, 12])
    place(ctx, sb, rim(seed + 2), [15], list(range(1, ctx.bars, 2)), 0.5)
    hb = ctx.buf()
    r = rng(seed + 3)
    for s in range(0, 16, 2):
        place(ctx, hb, hat(False, seed + 30 + s, 6000), [s], None, 0.35 + 0.2 * r.random())
    place(ctx, hb, shaker(seed + 4), [1, 3, 5, 7, 9, 11, 13, 15], None, 0.25)
    cb = chord_bars(ctx, prog, 4)
    rb = ctx.buf()
    bb = ctx.buf()
    for b, (root, tones) in enumerate(cb):
        for s, vel in ((0, 0.9), (7, 0.6), (11, 0.7)):
            place(ctx, rb, sum(rhodes(m, ctx.beat * 1.8, vel) for m in tones) / len(tones), [s], [b], 0.7)
        for s, m in ((0, root), (7, root + 7), (10, root + 12), (14, root + 10)):
            place(ctx, bb, sine(hz(m), ctx.step * 2.6) * env_adsr(ctx.step * 2.6, 0.01, 0.1, 0.7, 0.05), [s], [b], 0.55)
    rb = reverb(rb, 1.5, 0.22, seed=seed + 5)
    vb = crackle(ctx.loop_s, 18, seed + 6, 0.5) * 0.25 + highpass(pink(ctx.loop_s, seed + 7), 4000) * 0.02
    vinyl = np.concatenate([vb, vb])
    parts = [(kb, 0.85, 0), (sb, 0.55, 0), (hb, 0.35, 0.25), (bb, 0.55, 0), (rb, 0.6, 0), (vinyl, 0.5, 0)]
    if rain:
        rn = bandpass(pink(ctx.loop_s, seed + 8), 1500, 9000) * 0.05 + crackle(ctx.loop_s, 140, seed + 9, 0.3) * 0.15
        parts.append((np.concatenate([rn, rn]), 0.5, 0.3))
    mixed = mixdown(ctx, parts)
    mixed = lowpass(mixed, 6500, 2)
    return master(ctx, mixed)


@loop("rooftop-chill", "lofi", "Rooftop Chill", 80, 4, ["lofi", "chill", "jazzy", "relax", "night", "study"])
def _rooftop(ctx: Ctx):
    return lofi(ctx, ["Dm9", "G13", "Cmaj9", "A7b9"], 2200)


@loop("rain-window", "lofi", "Rain Window", 76, 4, ["lofi", "rain", "chill", "mellow", "sad"])
def _rain_window(ctx: Ctx):
    return lofi(ctx, ["Ebmaj7", "Dm7", "Cm7", "Bbmaj7"], 2210, rain=True)


@loop("late-shift", "lofi", "Late Shift", 84, 4, ["lofi", "chill", "jazzy", "late-night", "cruise"])
def _late_shift(ctx: Ctx):
    return lofi(ctx, ["Am7", "D9", "Gmaj7", "Cmaj7"], 2220)


def drive_loop(ctx: Ctx, prog: list[str], seed: int, aggressive: bool = False, plucks: bool = False):
    kb, sb, hb, k_hits = drums_four(ctx, "punch", "gated", "16", open_off=True, clap_on=True, seed=seed)
    cb = chord_bars(ctx, prog, 4)
    bb = ctx.buf()
    xb = ctx.buf()
    for b, (root, tones) in enumerate(cb):
        for s in range(16):
            if s % 4 == 0:
                continue
            m = root + (12 if s % 2 else 0)
            place(ctx, bb, bass_synth(m, ctx.step * 0.9, 1.4 if aggressive else 1.0, s), [s], [b], 0.55)
        if plucks:
            seq = [tones[0] + 12, tones[1] + 12, tones[2] + 12, tones[1] + 12]
            for s in (0, 3, 6, 8, 11, 14):
                place(ctx, xb, pluck(seq[s % 4], ctx.step * 2, 1.0, s), [s], [b], 0.35)
        else:
            for s in (2, 6, 10, 14) if not aggressive else (0, 3, 6, 10, 12):
                place(ctx, xb, stab([t + 12 for t in tones[:3]], ctx.step * 1.5, seed + s), [s], [b], 0.35)
    bb = sidechain(bb, k_hits, 0.35, ctx.beat * 0.35)
    if aggressive:
        bb = drive(bb * 1.4, 1.8)
    xb = reverb(delay(xb, ctx.beat * 0.75, 0.3, 0.25), 1.2, 0.2, seed=seed + 3)
    parts = [(kb, 0.9, 0), (sb, 0.45, 0), (hb, 0.3, 0.2), (bb, 0.55, 0), (xb, 0.5, 0)]
    return master(ctx, mixdown(ctx, parts))


@loop("pursuit", "drive", "Pursuit", 128, 8, ["drive", "chase", "action", "electronic", "fast", "police"])
def _pursuit(ctx: Ctx):
    return drive_loop(ctx, ["Em", "C", "G", "D"], 2300)


@loop("chase-mode", "drive", "Chase Mode", 132, 8, ["drive", "chase", "aggressive", "action", "intense"])
def _chase_mode(ctx: Ctx):
    return drive_loop(ctx, ["Bm", "G", "D", "A"], 2310, aggressive=True)


@loop("boost", "drive", "Boost", 124, 8, ["drive", "house", "energy", "race", "upbeat"])
def _boost(ctx: Ctx):
    return drive_loop(ctx, ["F#m", "D", "A", "E"], 2320, plucks=True)


@loop("tension-bed", "cinematic", "Tension Bed", 90, 8, ["tension", "dark", "suspense", "heist", "stealth", "cinematic"])
def _tension(ctx: Ctx):
    pb = ctx.buf(True)
    prog = [["A2", [45, 52, 57, 60]], ["A2", [45, 52, 58, 60]], ["F2", [41, 48, 57, 60]], ["E2", [40, 47, 56, 59]]]
    for b in range(ctx.bars):
        _, tones = prog[(b // 2) % 4]
        place(ctx, pb, pad(tones, 8 * ctx.beat, 2400 + b, 900, 1.2), [0], [b] if b % 2 == 0 else [], 0.5)
    tb = ctx.buf()
    for s in range(16):
        place(ctx, tb, rim(2401 + s) * (0.5 if s % 4 else 0.9), [s], None, 0.25)
    sb = ctx.buf()
    place(ctx, sb, sine(hz(33), 1.2) * env_exp(1.2, 0.6), [0, 10], None, 0.6)
    hb = ctx.buf()
    place(ctx, hb, kick("808") * 0.8, [0], None, 0.6)
    pbs = reverb(pb, 3.0, 0.4, seed=2402, bright=3000)
    parts = [(pbs, 0.6, 0), (tb, 0.35, 0.3), (sb, 0.6, 0), (hb, 0.5, 0)]
    return master(ctx, mixdown(ctx, parts))


@loop("victory-lap", "funk", "Victory Lap", 116, 8, ["funk", "victory", "win", "upbeat", "groove", "happy"])
def _victory(ctx: Ctx):
    kb, sb, hb, k_hits = drums_four(ctx, "punch", "gated", "16", open_off=False, clap_on=True, seed=2500)
    cb = chord_bars(ctx, ["C", "Am", "F", "G"], 4)
    bb = ctx.buf()
    cl = ctx.buf()
    for b, (root, tones) in enumerate(cb):
        for s, off in ((0, 0), (3, 12), (6, 0), (8, 7), (10, 12), (11, 0), (14, 10)):
            place(ctx, bb, bass_slap(root + off, ctx.step * 1.4), [s], [b], 0.6)
        for s in (2, 5, 7, 10, 13, 15):
            place(ctx, cl, clav([t + 12 for t in tones], ctx.step * 1.2), [s], [b], 0.4)
    parts = [(kb, 0.85, 0), (reverb(sb, 1.0, 0.2, seed=2501), 0.5, 0), (hb, 0.3, 0.2), (bb, 0.65, 0), (cl, 0.45, -0.25)]
    return master(ctx, mixdown(ctx, parts))


def render_loop(lp: Loop) -> np.ndarray:
    return lp.build(Ctx(lp.bpm, lp.bars))
