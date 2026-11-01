"""Ambience beds (filtered noise and tones), made loopable with an equal-power crossfade of the
end into the start."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from .audio_core import (
    SR, bandpass, brown, crackle, drive, env_adsr, env_exp, formant, highpass, lowpass, mix_at, n_of, pink,
    reverb, rng, saw, sine, sweep, to_stereo, triangle, white,
)


@dataclass
class Bed:
    slug: str
    name: str
    tags: list[str]
    length: float
    make: Callable[[float], np.ndarray]


BEDS: list[Bed] = []


def bed(slug: str, name: str, tags: list[str], length: float = 20.0):
    def wrap(fn):
        BEDS.append(Bed(slug, name, tags, length, fn))
        return fn

    return wrap


XF = 2.0  # crossfade seconds


def make_loopable(y: np.ndarray, loop_s: float) -> np.ndarray:
    """y covers loop_s + XF seconds; the extra tail is crossfaded into the start."""
    n, x = n_of(loop_s), n_of(XF)
    st = y if y.ndim == 2 else y[None, :]
    out = st[:, :n].copy()
    w = np.linspace(0, np.pi / 2, x)
    out[:, :x] = st[:, :x] * np.sin(w) + st[:, n : n + x] * np.cos(w)
    return out if y.ndim == 2 else out[0]


def _slow_lfo(dur: float, seed: int, rate: float = 0.08, depth: float = 0.3) -> np.ndarray:
    r = rng(seed)
    n = n_of(dur)
    t = np.arange(n) / SR
    return 1 + depth * (np.sin(2 * np.pi * rate * t + r.uniform(0, 6.28)) * 0.6 + np.sin(2 * np.pi * rate * 2.3 * t + r.uniform(0, 6.28)) * 0.4)


def _stereo_noise(dur: float, seed: int, fn) -> np.ndarray:
    return np.stack([fn(dur, seed), fn(dur, seed + 500)])


@bed("city-night", "City at night", ["ambience", "city", "night", "traffic", "urban", "street"], 24.0)
def _city(dur: float):
    rumble = _stereo_noise(dur, 3000, lambda d, s: lowpass(brown(d, s), 300) * 1.4)
    hiss = _stereo_noise(dur, 3010, lambda d, s: bandpass(pink(d, s), 300, 3500) * 0.25)
    y = (rumble + hiss) * _slow_lfo(dur, 3020, 0.05, 0.25)
    r = rng(3030)
    for k in range(5):  # distant cars passing
        t0 = r.uniform(0, dur - 4)
        d = r.uniform(3, 5)
        car = bandpass(pink(d, 3040 + k), 200, 1600) * np.sin(np.linspace(0, np.pi, n_of(d))) ** 2 * 0.6
        pan = np.linspace(r.uniform(-1, 0), r.uniform(0, 1), n_of(d))
        mix_at(y, to_stereo(car, pan), t0)
    for k in range(2):  # far horns
        t0 = r.uniform(1, dur - 2)
        h = lowpass(saw(r.uniform(330, 440), 0.4) * env_adsr(0.4, 0.02, 0.05, 0.8, 0.1), 900) * 0.12
        mix_at(y, reverb(h, 2.0, 0.6, seed=3050 + k), t0)
    return y


@bed("rain", "Rain", ["ambience", "rain", "weather", "storm", "calm", "window"], 20.0)
def _rain(dur: float):
    body = _stereo_noise(dur, 3100, lambda d, s: bandpass(pink(d, s), 800, 9000) * 0.6)
    drops = np.stack([highpass(crackle(dur, 900, 3110, 0.5), 1500), highpass(crackle(dur, 900, 3111, 0.5), 1500)]) * 0.5
    low = _stereo_noise(dur, 3120, lambda d, s: lowpass(brown(d, s), 400) * 0.4)
    return (body + drops + low) * _slow_lfo(dur, 3130, 0.04, 0.15)


@bed("wind", "Wind", ["ambience", "wind", "weather", "desert", "rooftop", "lonely"], 24.0)
def _wind(dur: float):
    n = n_of(dur)
    out = []
    for c in range(2):
        src = pink(dur, 3200 + c) * 1.2
        lfo = _slow_lfo(dur, 3210 + c, 0.07, 0.45)
        cut = 250 + 900 * (lfo - lfo.min()) / (np.ptp(lfo) + 1e-9)
        y = sweep(src, "bp", cut, 1.8) * lfo
        whistle = sine(cut * 2.1, dur) * 0.02 * (lfo - lfo.min())
        out.append(y + whistle)
    return np.stack(out)


@bed("neon-hum", "Neon hum", ["ambience", "neon", "hum", "electric", "sign", "night", "buzz"], 16.0)
def _neon(dur: float):
    n = n_of(dur)
    hum = sum(sine(60 * h, dur) * a for h, a in [(1, 0.4), (2, 0.25), (3, 0.15), (5, 0.08), (7, 0.05)])
    buzz = bandpass(saw(120, dur), 800, 5000) * 0.05
    r = rng(3300)
    flick = np.ones(n)
    for k in range(6):
        t0 = int(r.uniform(0, dur - 0.5) * SR)
        ln = int(r.uniform(0.05, 0.3) * SR)
        flick[t0 : t0 + ln] = r.uniform(0.2, 0.7)
    flick = lowpass(flick, 40, 1)
    y = (hum + buzz) * flick + bandpass(white(dur, 3310), 2000, 8000) * 0.01
    return np.stack([y, np.roll(y, 37)])


@bed("crowd-murmur", "Crowd murmur", ["ambience", "crowd", "people", "bar", "party", "murmur", "talk"], 20.0)
def _crowd(dur: float):
    r = rng(3400)
    out = np.zeros((2, n_of(dur)))
    vowels = ["a", "e", "o", "u", "i"]
    for k in range(60):
        t0 = r.uniform(0, dur - 1.2)
        d = r.uniform(0.25, 1.1)
        f0 = r.uniform(100, 240)
        syl = formant(saw(f0 * (1 + 0.04 * np.sin(np.linspace(0, r.uniform(2, 6), n_of(d)))), d), vowels[k % 5])
        syl *= env_adsr(d, 0.04, 0.1, 0.7, d * 0.4) * r.uniform(0.2, 0.6)
        mix_at(out, to_stereo(lowpass(syl, 2500), r.uniform(-0.9, 0.9)), t0)
    room = _stereo_noise(dur, 3410, lambda d, s: bandpass(pink(d, s), 250, 2500) * 0.2)
    return reverb(out * 0.35 + room, 1.6, 0.4, seed=3420)[:, : n_of(dur)]


@bed("ocean-waves", "Ocean waves", ["ambience", "ocean", "waves", "beach", "sea", "calm"], 24.0)
def _waves(dur: float):
    n = n_of(dur)
    t = np.arange(n) / SR
    out = []
    for c in range(2):
        swell = (0.5 + 0.5 * np.sin(2 * np.pi * t / 6.0 + c * 0.7)) ** 2.5
        src = pink(dur, 3500 + c)
        y = sweep(src, "lp", 400 + 5000 * swell, 0.7) * (0.25 + swell)
        out.append(y)
    return np.stack(out)


@bed("club-through-wall", "Club through the wall", ["ambience", "club", "party", "muffled", "bass", "interior"], 16.0)
def _club(dur: float):
    bpm = 124
    beat = 60 / bpm
    y = np.zeros(n_of(dur))
    k = sine(np.geomspace(110, 45, n_of(0.3)), 0.3) * env_exp(0.3, 0.12)
    t = 0.0
    while t < dur:
        mix_at(y, k, t)
        t += beat
    bassline = lowpass(saw(55, dur) * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * (bpm / 60) * 2 * np.arange(n_of(dur)) / SR))), 180) * 0.25
    y = lowpass(y + bassline, 160, 2) * 1.2
    room = lowpass(pink(dur, 3600), 500) * 0.12
    return to_stereo(y + room)


@bed("highway", "Highway", ["ambience", "highway", "traffic", "cars", "freeway", "road"], 24.0)
def _highway(dur: float):
    base = _stereo_noise(dur, 3700, lambda d, s: bandpass(pink(d, s), 150, 2500) * 0.5)
    r = rng(3710)
    for k in range(9):
        t0 = r.uniform(-1, dur - 2)
        d = r.uniform(2.5, 4.0)
        car = bandpass(pink(d, 3720 + k), 120, r.uniform(1500, 3000)) * np.sin(np.linspace(0, np.pi, n_of(d))) ** 3 * r.uniform(0.6, 1.2)
        side = 1 if r.random() < 0.5 else -1
        mix_at(base, to_stereo(car, np.linspace(-side, side, n_of(d))), max(0.0, t0))
    return base


def render_bed(b: Bed) -> np.ndarray:
    raw = b.make(b.length + XF)
    if raw.ndim == 1:
        raw = to_stereo(raw)
    return make_loopable(raw, b.length)
