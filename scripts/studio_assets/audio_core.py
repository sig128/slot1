"""Audio building blocks for SLOT1's Studio library: oscillators, envelopes, filters, effects,
BS.1770 loudness and encoding. Everything is synthesized from scratch (no samples).

Deterministic: every random source takes an explicit seed, so the library rebuilds identically.
"""
from __future__ import annotations

import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np
from scipy import signal

SR = 48_000
TAU = 2 * np.pi


# ------------------------------------------------------------------------------------------------
# Basics
# ------------------------------------------------------------------------------------------------

def n_of(dur: float) -> int:
    return max(1, int(round(dur * SR)))


def tvec(dur: float) -> np.ndarray:
    return np.arange(n_of(dur)) / SR


def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def as_curve(v, n: int) -> np.ndarray:
    """A constant or an array resampled to n points."""
    if np.isscalar(v):
        return np.full(n, float(v))
    v = np.asarray(v, dtype=float)
    if len(v) == n:
        return v
    return np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(v)), v)


def ramp(n: int, a: float, b: float, shape: str = "lin") -> np.ndarray:
    x = np.linspace(0, 1, n)
    if shape == "exp":
        a2, b2 = max(a, 1e-6), max(b, 1e-6)
        return a2 * (b2 / a2) ** x
    if shape == "ease":
        x = 0.5 - 0.5 * np.cos(np.pi * x)
    return a + (b - a) * x


def glide(points: list[tuple[float, float]], dur: float, shape: str = "exp") -> np.ndarray:
    """Piecewise curve from (time_s, value) points."""
    n = n_of(dur)
    out = np.empty(n)
    pts = sorted(points)
    for i in range(len(pts) - 1):
        t0, v0 = pts[i]
        t1, v1 = pts[i + 1]
        i0, i1 = int(t0 * SR), min(n, int(t1 * SR))
        if i1 > i0:
            out[i0:i1] = ramp(i1 - i0, v0, v1, shape)
    last = int(pts[-1][0] * SR)
    if last < n:
        out[last:] = pts[-1][1]
    first = int(pts[0][0] * SR)
    if first > 0:
        out[:first] = pts[0][1]
    return out


# ------------------------------------------------------------------------------------------------
# Envelopes
# ------------------------------------------------------------------------------------------------

def env_exp(dur: float, decay: float, attack: float = 0.002) -> np.ndarray:
    t = tvec(dur)
    e = np.exp(-t / max(decay, 1e-4))
    na = n_of(attack)
    if na > 1:
        e[:na] *= np.linspace(0, 1, na)
    return e


def env_adsr(dur: float, a: float, d: float, s: float, r: float) -> np.ndarray:
    """dur includes the release."""
    n = n_of(dur)
    na, nd, nr = n_of(a), n_of(d), n_of(r)
    ns = max(0, n - na - nd - nr)
    parts = [np.linspace(0, 1, na, endpoint=False), np.linspace(1, s, nd, endpoint=False), np.full(ns, s), np.linspace(s, 0, nr)]
    e = np.concatenate(parts)
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def env_bell(dur: float, peak: float = 0.5, sharp: float = 2.0) -> np.ndarray:
    """Rise to `peak` (fraction of dur) and fall, both smooth."""
    x = np.linspace(0, 1, n_of(dur))
    up = np.clip(x / max(peak, 1e-3), 0, 1)
    down = np.clip((1 - x) / max(1 - peak, 1e-3), 0, 1)
    return np.minimum(up, down) ** sharp * (3 - 2 * np.minimum(up, down)) ** 0


def fade(x: np.ndarray, fin: float = 0.003, fout: float = 0.01) -> np.ndarray:
    y = x.copy()
    a, b = n_of(fin), n_of(fout)
    sl = (slice(None),) * (y.ndim - 1)
    if a > 1:
        w = np.linspace(0, 1, a)
        y[..., :a] *= w
    if b > 1:
        w = np.linspace(1, 0, b)
        y[..., -b:] *= w
    return y


# ------------------------------------------------------------------------------------------------
# Oscillators (band-limited where it matters)
# ------------------------------------------------------------------------------------------------

def phase_of(freq, n: int, phase0: float = 0.0) -> np.ndarray:
    f = as_curve(freq, n)
    return phase0 + np.cumsum(f) / SR  # in cycles


def sine(freq, dur: float, phase0: float = 0.0) -> np.ndarray:
    n = n_of(dur)
    return np.sin(TAU * phase_of(freq, n, phase0))


def _polyblep(t: np.ndarray, dt: np.ndarray) -> np.ndarray:
    out = np.zeros_like(t)
    m1 = t < dt
    x = t[m1] / dt[m1]
    out[m1] = x + x - x * x - 1.0
    m2 = t > 1.0 - dt
    x = (t[m2] - 1.0) / dt[m2]
    out[m2] = x * x + x + x + 1.0
    return out


def saw(freq, dur: float, phase0: float = 0.0) -> np.ndarray:
    n = n_of(dur)
    f = as_curve(freq, n)
    ph = phase_of(f, n, phase0) % 1.0
    dt = np.clip(f / SR, 1e-6, 0.5)
    return (2.0 * ph - 1.0) - _polyblep(ph, dt)


def square(freq, dur: float, pw: float = 0.5, phase0: float = 0.0) -> np.ndarray:
    n = n_of(dur)
    f = as_curve(freq, n)
    ph = phase_of(f, n, phase0) % 1.0
    dt = np.clip(f / SR, 1e-6, 0.5)
    y = np.where(ph < pw, 1.0, -1.0)
    y += _polyblep(ph, dt)
    y -= _polyblep((ph + 1.0 - pw) % 1.0, dt)
    return y


def triangle(freq, dur: float, phase0: float = 0.0) -> np.ndarray:
    n = n_of(dur)
    ph = phase_of(freq, n, phase0) % 1.0
    return 4.0 * np.abs(ph - 0.5) - 1.0


def fm(carrier, ratio: float, index, dur: float, phase0: float = 0.0) -> np.ndarray:
    """Two-operator FM: sin(2π fc t + I(t) sin(2π fc*ratio t))."""
    n = n_of(dur)
    fc = as_curve(carrier, n)
    mod = np.sin(TAU * phase_of(fc * ratio, n))
    idx = as_curve(index, n)
    return np.sin(TAU * phase_of(fc, n, phase0) + idx * mod)


def partials(freqs: list[float], amps: list[float], decays: list[float], dur: float, seed: int = 0) -> np.ndarray:
    """Inharmonic struck sound (bells, metal, coins)."""
    r = rng(seed)
    t = tvec(dur)
    y = np.zeros_like(t)
    for f, a, d in zip(freqs, amps, decays):
        y += a * np.sin(TAU * f * t + r.uniform(0, TAU)) * np.exp(-t / d)
    return y


def supersaw(freq, dur: float, voices: int = 5, detune_cents: float = 14.0, seed: int = 0) -> np.ndarray:
    r = rng(seed)
    n = n_of(dur)
    f = as_curve(freq, n)
    y = np.zeros(n)
    for v in range(voices):
        c = (v - (voices - 1) / 2) / max(1, (voices - 1) / 2) * detune_cents
        y += saw(f * 2 ** (c / 1200), dur, r.uniform(0, 1))
    return y / np.sqrt(voices)


# ------------------------------------------------------------------------------------------------
# Noise
# ------------------------------------------------------------------------------------------------

def white(dur: float, seed: int) -> np.ndarray:
    return rng(seed).standard_normal(n_of(dur)) * 0.35


def pink(dur: float, seed: int) -> np.ndarray:
    n = n_of(dur)
    w = rng(seed).standard_normal(n)
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1, -2.494956002, 2.017265875, -0.522189400]
    return signal.lfilter(b, a, w) * 0.9


def brown(dur: float, seed: int) -> np.ndarray:
    w = rng(seed).standard_normal(n_of(dur))
    y = np.cumsum(w)
    y = signal.sosfilt(signal.butter(1, 20, "highpass", fs=SR, output="sos"), y)
    return y / (np.max(np.abs(y)) + 1e-9) * 0.8


def crackle(dur: float, density: float, seed: int, sharp: float = 0.6) -> np.ndarray:
    """Sparse clicks (vinyl, fire, sparks)."""
    r = rng(seed)
    n = n_of(dur)
    y = np.zeros(n)
    count = int(density * dur)
    pos = r.integers(0, n, count)
    amp = r.uniform(0.2, 1.0, count) * np.where(r.random(count) < 0.5, -1, 1)
    y[pos] = amp
    k = np.exp(-np.arange(int(0.0015 * SR)) / (0.0003 * SR)) * sharp
    return signal.fftconvolve(y, k)[:n]


# ------------------------------------------------------------------------------------------------
# Filters (static and swept)
# ------------------------------------------------------------------------------------------------

def _clip_f(f: float) -> float:
    return float(np.clip(f, 15.0, SR / 2 * 0.95))


def lowpass(x: np.ndarray, f: float, order: int = 2) -> np.ndarray:
    return signal.sosfilt(signal.butter(order, _clip_f(f), "lowpass", fs=SR, output="sos"), x, axis=-1)


def highpass(x: np.ndarray, f: float, order: int = 2) -> np.ndarray:
    return signal.sosfilt(signal.butter(order, _clip_f(f), "highpass", fs=SR, output="sos"), x, axis=-1)


def bandpass(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    lo, hi = _clip_f(lo), _clip_f(hi)
    if hi <= lo * 1.02:
        hi = lo * 1.02
    return signal.sosfilt(signal.butter(order, [lo, hi], "bandpass", fs=SR, output="sos"), x, axis=-1)


def _rbj(kind: str, f: float, q: float, gain_db: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    f = _clip_f(f)
    w0 = TAU * f / SR
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    A = 10 ** (gain_db / 40)
    if kind == "lp":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "bp":
        b = [alpha, 0, -alpha]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peak":
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    else:
        raise ValueError(kind)
    b = np.array(b) / a[0]
    a = np.array(a) / a[0]
    return b, a


def sweep(x: np.ndarray, kind: str, freq, q: float = 0.9, block: int = 128) -> np.ndarray:
    """Time-varying resonant filter (lp/hp/bp), coefficients updated every `block` samples."""
    n = len(x)
    f = as_curve(freq, n)
    y = np.zeros(n)
    zi = np.zeros(2)
    for i in range(0, n, block):
        b, a = _rbj(kind, float(f[min(n - 1, i + block // 2)]), q)
        y[i : i + block], zi = signal.lfilter(b, a, x[i : i + block], zi=zi)
    return y


def peak_eq(x: np.ndarray, f: float, q: float, gain_db: float) -> np.ndarray:
    b, a = _rbj("peak", f, q, gain_db)
    return signal.lfilter(b, a, x, axis=-1)


def formant(x: np.ndarray, vowel: str = "a") -> np.ndarray:
    table = {"a": (800, 1150, 2900), "e": (400, 1700, 2600), "o": (450, 800, 2830), "u": (325, 700, 2530), "i": (300, 2200, 3000)}
    y = np.zeros_like(x)
    for i, f in enumerate(table[vowel]):
        b, a = _rbj("bp", f, 6.0)
        y += signal.lfilter(b, a, x) * (1.0, 0.6, 0.3)[i]
    return y


# ------------------------------------------------------------------------------------------------
# Effects
# ------------------------------------------------------------------------------------------------

def drive(x: np.ndarray, amount: float) -> np.ndarray:
    return np.tanh(x * amount) / np.tanh(amount)


def bitcrush(x: np.ndarray, bits: int = 6, hold: int = 6) -> np.ndarray:
    y = np.repeat(x[::hold], hold)[: len(x)]
    q = 2 ** (bits - 1)
    return np.round(y * q) / q


def to_stereo(x: np.ndarray, pan=0.0) -> np.ndarray:
    """Equal-power pan; `pan` may be a curve from -1 (left) to 1 (right)."""
    if x.ndim == 2:
        return x
    p = as_curve(pan, len(x))
    ang = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(ang), x * np.sin(ang)])


def mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=0) if x.ndim == 2 else x


def pad_to(x: np.ndarray, n: int) -> np.ndarray:
    if x.shape[-1] >= n:
        return x[..., :n]
    pad = [(0, 0)] * (x.ndim - 1) + [(0, n - x.shape[-1])]
    return np.pad(x, pad)


def mix_at(dst: np.ndarray, src: np.ndarray, start_s: float, gain: float = 1.0) -> None:
    """Add src into dst at start_s (both mono or both stereo); clipped at dst's end."""
    i = int(round(start_s * SR))
    if i >= dst.shape[-1]:
        return
    m = min(src.shape[-1], dst.shape[-1] - i)
    dst[..., i : i + m] += src[..., :m] * gain


def reverb_ir(decay: float, seed: int, bright: float = 6000.0, predelay: float = 0.012, stereo: bool = True) -> np.ndarray:
    dur = decay * 1.4 + predelay
    chans = []
    for c in range(2 if stereo else 1):
        r = rng(seed + c * 101)
        n = n_of(dur)
        t = np.arange(n) / SR
        noise = r.standard_normal(n)
        e = np.exp(-t * 6.9 / decay)
        ir = lowpass(noise * e, bright, 1)
        pd = n_of(predelay)
        ir[:pd] = 0
        # early reflections
        for k in range(6):
            pos = pd + int(r.uniform(0.002, 0.05) * SR)
            if pos < n:
                ir[pos] += r.uniform(0.3, 0.8) * (1 if r.random() < 0.5 else -1)
        chans.append(ir / np.sqrt(np.sum(ir**2) + 1e-12))
    return np.stack(chans) if stereo else chans[0]


def reverb(x: np.ndarray, decay: float = 1.6, mix: float = 0.25, seed: int = 7, bright: float = 6000.0, predelay: float = 0.015) -> np.ndarray:
    """Convolution reverb with a synthetic impulse response. Returns stereo, same length + tail."""
    ir = reverb_ir(decay, seed, bright, predelay, stereo=True)
    src = mono(x)
    wet = np.stack([signal.fftconvolve(src, ir[0]), signal.fftconvolve(src, ir[1])])
    dry = to_stereo(x) if x.ndim == 1 else x
    n = wet.shape[-1]
    out = pad_to(dry, n) * (1 - mix) + wet * mix * 0.9
    return out


def delay(x: np.ndarray, t: float, fb: float = 0.35, mix: float = 0.3, taps: int = 6, pingpong: bool = True) -> np.ndarray:
    st = to_stereo(x) if x.ndim == 1 else x
    d = n_of(t)
    n = st.shape[-1] + d * taps
    out = pad_to(st, n).copy()
    src = mono(st)
    for k in range(1, taps + 1):
        g = mix * fb ** (k - 1)
        ch = (k % 2) if pingpong else None
        echo = lowpass(src, 5000 - 400 * k, 1) * g
        if ch is None:
            out[:, k * d : k * d + len(echo)] += echo
        else:
            out[ch, k * d : k * d + len(echo)] += echo
    return out


def sidechain(x: np.ndarray, hits_s: list[float], depth: float = 0.6, release: float = 0.22) -> np.ndarray:
    n = x.shape[-1]
    g = np.ones(n)
    rel = n_of(release)
    curve = 1 - depth * np.exp(-np.arange(rel) / (rel / 4))
    for h in hits_s:
        i = int(h * SR)
        if 0 <= i < n:
            m = min(rel, n - i)
            g[i : i + m] = np.minimum(g[i : i + m], curve[:m])
    return x * g


# ------------------------------------------------------------------------------------------------
# Loudness (ITU-R BS.1770-4) and normalization
# ------------------------------------------------------------------------------------------------

_K1 = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]), np.array([1.0, -1.69065929318241, 0.73248077421585]))
_K2 = (np.array([1.0, -2.0, 1.0]), np.array([1.0, -1.99004745483398, 0.99007225036621]))


def _k_weight(x: np.ndarray) -> np.ndarray:
    y = signal.lfilter(_K1[0], _K1[1], x, axis=-1)
    return signal.lfilter(_K2[0], _K2[1], y, axis=-1)


def _blocks(z: np.ndarray, win: int, hop: int) -> np.ndarray:
    n = z.shape[-1]
    if n <= win:
        return z.mean(axis=-1, keepdims=True)
    idx = np.arange(0, n - win + 1, hop)
    cs = np.cumsum(np.pad(z, [(0, 0)] * (z.ndim - 1) + [(1, 0)]), axis=-1)
    return (cs[..., idx + win] - cs[..., idx]) / win


def loudness_integrated(x: np.ndarray) -> float:
    st = x if x.ndim == 2 else x[None, :]
    z = _k_weight(st) ** 2
    ms = _blocks(z, n_of(0.4), n_of(0.1)).sum(axis=0)
    with np.errstate(divide="ignore"):
        lk = -0.691 + 10 * np.log10(ms + 1e-20)
    keep = ms[lk > -70]
    if len(keep) == 0:
        return -99.0
    rel = -0.691 + 10 * np.log10(keep.mean()) - 10
    keep2 = ms[(lk > -70) & (lk > rel)]
    if len(keep2) == 0:
        keep2 = keep
    return float(-0.691 + 10 * np.log10(keep2.mean()))


def loudness_momentary_max(x: np.ndarray) -> float:
    st = x if x.ndim == 2 else x[None, :]
    z = _k_weight(st) ** 2
    ms = _blocks(z, n_of(0.4), n_of(0.02)).sum(axis=0)
    return float(-0.691 + 10 * np.log10(ms.max() + 1e-20))


def true_peak(x: np.ndarray) -> float:
    st = x if x.ndim == 2 else x[None, :]
    up = signal.resample_poly(st, 4, 1, axis=-1)
    return float(np.max(np.abs(up)) + 1e-12)


def normalize(x: np.ndarray, target_lufs: float, mode: str = "integrated", ceiling_db: float = -1.0) -> np.ndarray:
    """Gain to the loudness target, then a soft limiter so the true peak stays under the ceiling."""
    y = x.astype(float)
    ceiling = 10 ** (ceiling_db / 20)
    for _ in range(3):
        cur = loudness_integrated(y) if mode == "integrated" else loudness_momentary_max(y)
        y = y * 10 ** ((target_lufs - cur) / 20)
        tp = true_peak(y)
        if tp <= ceiling:
            break
        # soft-knee limiter above 0.6 * ceiling
        th = 0.6 * ceiling
        a = np.abs(y)
        over = a > th
        y[over] = np.sign(y[over]) * (th + (ceiling - th) * np.tanh((a[over] - th) / (ceiling - th)))
    tp = true_peak(y)
    if tp > ceiling:
        y *= ceiling / tp * 0.995
    return y


# ------------------------------------------------------------------------------------------------
# Waveform peaks and encoding
# ------------------------------------------------------------------------------------------------

def waveform_peaks(x: np.ndarray, bins: int = 48) -> list[float]:
    m = np.abs(mono(x))
    edges = np.linspace(0, len(m), bins + 1).astype(int)
    vals = np.array([m[a:b].max() if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])])
    top = vals.max() + 1e-9
    return [round(float(v / top), 3) for v in vals]


def write_wav(path: Path, x: np.ndarray) -> None:
    st = x if x.ndim == 2 else x[None, :]
    pcm = (np.clip(st, -1, 1) * 32767).astype("<i2").T.copy()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(st.shape[0])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def encode_m4a(x: np.ndarray, out: Path, bitrate_k: int, channels: int) -> None:
    """AAC-LC in MP4 (plays in every browser and in ffmpeg). Deterministic, no metadata."""
    out.parent.mkdir(parents=True, exist_ok=True)
    y = x
    if channels == 1:
        y = mono(x)
    elif x.ndim == 1:
        y = to_stereo(x)
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "in.wav"
        write_wav(wav, y)
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
            "-c:a", "aac", "-b:a", f"{bitrate_k}k", "-ac", str(channels), "-ar", str(SR),
            "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
            "-movflags", "+faststart", str(out),
        ]
        subprocess.run(cmd, check=True)
