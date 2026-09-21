# -*- coding: utf-8 -*-
"""量化 10 条 JP 音频的响度与音高:
  - 峰值 / 全段 RMS / 语音门控 RMS
  - 集成响度 LUFS (ITU-R BS.1770, pyloudnorm)
  - 中位 F0(音高基准)
  - prompt.wav 作为「平常语气」基准
输出对比表，定位 click_1 偏高与响度不一致的文件。
"""
import os
import sys
import numpy as np
import soundfile as sf
import torch
import pyloudnorm as pyln

HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = "D:/cosyvoice_src"
EXTRA = "D:/cosyvoice_src/_extramods"
REF = os.path.join(HERE, "ref", "prompt.wav")
for p in (HERE, COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)
import pyworld

SR = 24000
_meter = pyln.Meter(SR)


def loudness_lufs(wav):
    x = wav.astype(np.float64)
    if np.max(np.abs(x)) < 1e-4:
        return -100.0
    # pyloudnorm 要求峰值不超过 1.0
    x = x / (np.max(np.abs(x)) + 1e-9)
    return float(_meter.integrated_loudness(x))


def gated_rms(wav):
    """语音门控 RMS: 200ms 窗 RMS，取 5%~95% 分位的中位数(抗静音/爆音)。"""
    win = int(0.200 * SR)
    hop = int(0.050 * SR)
    n = len(wav)
    if n < win:
        return float(np.sqrt(np.mean(wav ** 2) + 1e-12))
    rms = []
    for i in range(0, n - win + 1, hop):
        seg = wav[i:i + win]
        rms.append(np.sqrt(np.mean(seg ** 2) + 1e-12))
    rms = np.array(rms)
    lo, hi = np.percentile(rms, 5), np.percentile(rms, 95)
    band = rms[(rms >= lo) & (rms <= hi)]
    return float(np.median(band)) if len(band) else float(np.median(rms))


def med_f0(wav):
    if wav.ndim > 1:
        wav = wav.mean(1)
    f0, _ = pyworld.harvest(wav.astype(np.float64), fs=SR, f0_floor=50.0, f0_ceil=500.0)
    v = f0[f0 > 0]
    if len(v) < 10:
        return 0.0
    return float(np.median(v))


def load(path):
    w, sr = sf.read(path)
    if w.ndim > 1:
        w = w.mean(1)
    if sr != SR:
        import torchaudio
        w = torchaudio.functional.resample(torch.from_numpy(w).float(), sr, SR).numpy()
    return w.astype(np.float32)


def main():
    JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")
    print("%-12s %7s %7s %7s %8s %8s" % ("file", "peak", "rms", "grms", "LUFS", "medF0"))
    rows = []
    for p in ("click", "idle"):
        for i in range(5):
            fn = "%s_%d.wav" % (p, i)
            fp = os.path.join(JP_OUT, fn)
            if not os.path.isfile(fp):
                continue
            w = load(fp)
            peak = float(np.max(np.abs(w)))
            rms = float(np.sqrt(np.mean(w ** 2)))
            grms = gated_rms(w)
            lufs = loudness_lufs(w)
            mf = med_f0(w)
            rows.append((fn, peak, rms, grms, lufs, mf))
            print("%-12s %7.3f %7.3f %7.3f %8.2f %8.1f" % (fn, peak, rms, grms, lufs, mf))
    grms_vals = np.array([r[3] for r in rows])
    lufs_vals = np.array([r[4] for r in rows])
    mf_vals = np.array([r[5] for r in rows])
    print("---")
    print("gatedRMS: min=%.3f max=%.3f range=%.3f (%.1f dB)"
          % (grms_vals.min(), grms_vals.max(), grms_vals.max() - grms_vals.min(),
             20 * np.log10(grms_vals.max() / grms_vals.min())))
    print("LUFS    : min=%.2f max=%.2f range=%.2f dB"
          % (lufs_vals.min(), lufs_vals.max(), lufs_vals.max() - lufs_vals.min()))
    print("medF0   : min=%.1f max=%.1f (%.1f Hz)"
          % (mf_vals.min(), mf_vals.max(), mf_vals.max() - mf_vals.min()))
    ref = load(REF)
    print("REF prompt.wav: peak=%.3f grms=%.3f LUFS=%.2f medF0=%.1f"
          % (float(np.max(np.abs(ref))), gated_rms(ref), loudness_lufs(ref), med_f0(ref)))


if __name__ == "__main__":
    main()
