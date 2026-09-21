# -*- coding: utf-8 -*-
"""独立复核 regen_jp_v2 最终输出：时长 / 噪声底 / 语音内峰值平稳比 / F0 起伏。"""
import os, sys
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = "D:/cosyvoice_src"; EXTRA = "D:/cosyvoice_src/_extramods"
for p in (HERE, COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)
import pyworld  # 需要 _extramods 里的 pkg_resources
from fix_cosy_issues import frame_rms, peak_median_ratio, speech_only_ratio, THR

SR = 24000
JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")


def f0_cv(wav):
    if wav.ndim > 1:
        wav = wav.mean(1)
    f0, _ = pyworld.harvest(wav.astype(np.float64), fs=SR, f0_floor=50.0, f0_ceil=500.0)
    v = f0[f0 > 0]
    return float(v.std() / v.mean()) if len(v) > 10 else 0.0


def main():
    print("%-14s %7s %10s %12s %10s" % ("file", "dur(s)", "noise_dB", "spk_peak/bal", "f0_cv"))
    for fn in sorted(os.listdir(JP_OUT)):
        if not fn.endswith(".wav"):
            continue
        wav, sr = sf.read(os.path.join(JP_OUT, fn))
        if sr != SR:
            import torchaudio
            wav = torchaudio.functional.resample(torch.from_numpy(wav).float().mean(1, keepdim=True), sr, SR).squeeze().numpy()
        dur = len(wav) / SR
        env = frame_rms(wav)
        sil_env = env[env < THR]
        nf = 20 * np.log10(float(np.median(sil_env)) + 1e-12) if len(sil_env) else -999
        spr = speech_only_ratio(wav)
        cv = f0_cv(wav)
        flag = "  <-- 偏高" if spr > 2.6 else ""
        print("%-14s %7.1f %10.1f %12.2f %10.3f%s" % (fn, dur, nf, spr, cv, flag))


if __name__ == "__main__":
    main()
