# -*- coding: utf-8 -*-
"""诊断当前 JP CosyVoice 输出：
  1) 兴奋度: F0 峰值/中位(exc) + 能量峰值/中位(pmr) + 语音内峰值/平稳(sor)
  2) 棒读度: F0 起伏 cv
  3) 音乐/哼鸣伪影: 找出 持续时间长 且 F0 极平(稳定音高) 的浊音段(真人语音不会长时间死平)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src")
EXTRA = os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")
for p in (HERE, COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)

import numpy as np
import soundfile as sf
import pyworld

SR = 24000
HOP = 240
WIN = 960
GATE_DB = -45.0
THR = 10 ** (GATE_DB / 20.0)
JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")


def frame_rms(wav):
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    peak = float(np.max(np.abs(wav))) + 1e-9
    wav = wav / peak
    n = len(wav)
    nf = 1 + (n - WIN) // HOP
    env = np.zeros(nf)
    for i in range(nf):
        seg = wav[i * HOP: i * HOP + WIN]
        env[i] = float(np.sqrt(np.mean(seg ** 2) + 1e-12))
    return env, peak


def metrics(path):
    wav, sr = sf.read(path)
    if sr != SR:
        import torchaudio
        wav = torchaudio.functional.resample(
            torch.from_numpy(wav).float().mean(1, keepdim=True), sr, SR).squeeze().numpy()
    wav = wav.astype(np.float64)
    f0, _ = pyworld.harvest(wav, fs=SR, f0_floor=50.0, f0_ceil=500.0)
    voiced = f0 > 0
    v = f0[voiced]
    cv = float(v.std() / v.mean()) if len(v) > 10 else 0.0
    med_f0 = float(np.median(v)) if len(v) else 0.0
    max_f0 = float(np.max(v)) if len(v) else 0.0
    exc = max_f0 / (med_f0 + 1e-9) if med_f0 > 0 else 1.0

    env, peak = frame_rms(wav)
    pmr = float(np.max(env) / (np.median(env) + 1e-9))
    sp = env[env >= THR]
    sor = float(np.max(sp) / (np.percentile(sp, 35) + 1e-9)) if len(sp) else 0.0
    dur = len(wav) / SR

    # 音乐/哼鸣检测: 长浊音段 + F0 极平
    music = []
    if voiced.sum() > 5:
        idxs = np.where(voiced)[0]
        # 连续浊音 run
        runs = []
        s = idxs[0]
        prev = idxs[0]
        for x in idxs[1:]:
            if x - prev <= 2:
                prev = x
            else:
                runs.append((s, prev))
                s = x
                prev = x
        runs.append((s, prev))
        for a, b in runs:
            L = (b - a) * HOP / SR
            seg = f0[a:b + 1]
            seg = seg[seg > 0]
            if L >= 0.6 and len(seg) > 10:
                std = float(np.std(seg))
                meanf = float(np.mean(seg))
                # 该段能量(用帧 rms)
                e_seg = env[a:b + 1]
                emean = float(np.mean(e_seg))
                if std < 10.0 and emean > THR * 1.5:
                    music.append((round(L, 2), round(meanf, 1), round(std, 2), round(emean, 4)))
    return dict(cv=cv, exc=exc, pmr=pmr, sor=sor, dur=dur, music=music,
                f0range=(round(med_f0, 1), round(max_f0, 1)))


def main():
    for fn in sorted(os.listdir(JP_OUT)):
        if not fn.endswith(".wav"):
            continue
        m = metrics(os.path.join(JP_OUT, fn))
        flag_exc = "  <== 兴奋?" if m["exc"] > 1.55 or m["sor"] > 2.5 else ""
        flag_music = "  <== 音乐伪影!" if m["music"] else ""
        print("%-14s dur=%.1fs cv=%.3f exc=%.2f(max/med) pmr=%.2f sor=%.2f f0=%s%s%s"
              % (fn, m["dur"], m["cv"], m["exc"], m["pmr"], m["sor"], m["f0range"],
                 flag_exc, flag_music))
        for mu in m["music"]:
            print("      音乐段: 时长=%.2fs 基频=%.1fHz 抖动std=%.2f 能量=%.4f" % mu)


if __name__ == "__main__":
    main()
