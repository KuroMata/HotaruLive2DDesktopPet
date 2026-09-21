# -*- coding: utf-8 -*-
"""分析 CosyVoice 克隆音频：静音段统计 + 能量尖峰定位。"""
import os
import sys
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
CN = os.path.join(HERE, "_out", "kouhai_cn_cosyvoice")
JP = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")

SR_TARGET = 24000
HOP = 240      # 10 ms
WIN = 960      # 40 ms

def rms_envelope(wav, sr):
    # 重采样到 24k 以保证帧对齐一致（若不是）
    if sr != SR_TARGET:
        import torchaudio
        import torch
        x = torch.from_numpy(wav).float()
        if x.dim() == 1:
            x = x.unsqueeze(0)
        x = torchaudio.functional.resample(x, sr, SR_TARGET).squeeze(0).numpy()
        sr = SR_TARGET
        wav = x
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    # 归一化到峰值 1.0 便于跨文件对比
    peak = np.max(np.abs(wav)) + 1e-9
    wav = wav / peak
    n = len(wav)
    nframes = 1 + (n - WIN) // HOP
    env = np.zeros(nframes)
    for i in range(nframes):
        seg = wav[i * HOP: i * HOP + WIN]
        env[i] = np.sqrt(np.mean(seg ** 2) + 1e-12)
    return env, sr, n / sr

def analyze_silence(env, dur, thresh_db=-45.0):
    thresh = 10 ** (thresh_db / 20.0)
    sil = env < thresh
    # 找连续静音段（>150ms = 15 frames）
    min_gap = 15
    gaps = []
    i = 0
    N = len(sil)
    while i < N:
        if sil[i]:
            j = i
            while j < N and sil[j]:
                j += 1
            glen = j - i
            if glen >= min_gap:
                t0 = i * HOP / SR_TARGET
                t1 = j * HOP / SR_TARGET
                gaps.append((t0, t1, t1 - t0))
            i = j
        else:
            i += 1
    total_sil = sum(g[2] for g in gaps)
    # 噪声底（静音帧 RMS 的中位数，单位 dB）
    sil_rms = env[sil]
    noise_floor = float(np.median(sil_rms)) if len(sil_rms) else 0.0
    return gaps, total_sil, 20 * np.log10(noise_floor + 1e-12)

def analyze_spike(env):
    med = np.median(env)
    # 找相对中位数 > 2.5x 且相对整体峰值 > 0.6 的尖峰
    peak = np.max(env)
    peak_idx = int(np.argmax(env))
    peak_t = peak_idx * HOP / SR_TARGET
    ratio_vs_med = peak / (med + 1e-9)
    # 局部尖峰：滑动窗口找能量突增
    return peak_t, float(peak), float(med), float(ratio_vs_med)

def main():
    print("=" * 78)
    print("静音段统计（阈值 -45dB，最小间隙 150ms）")
    print("=" * 78)
    print("%-22s %8s %8s %10s %12s" % ("file", "dur(s)", "gaps", "sil_tot(s)", "noise_floor(dB)"))
    allfiles = []
    for d, label in ((CN, "CN"), (JP, "JP")):
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".wav"):
                continue
            path = os.path.join(d, fn)
            wav, sr = sf.read(path)
            env, _, dur = rms_envelope(wav, sr)
            gaps, tsil, nf = analyze_silence(env, dur)
            allfiles.append((os.path.join(d, fn), label, env, dur, gaps, tsil, nf))
            print("%-22s %8.2f %8d %10.2f %12.1f" % (fn, dur, len(gaps), tsil, nf))
    # 重点：CN idle_3 / JP idle_2 的能量尖峰
    print()
    print("=" * 78)
    print("「突然兴奋」能量尖峰定位")
    print("=" * 78)
    for path, label, env, dur, gaps, tsil, nf in allfiles:
        base = os.path.basename(path)
        if (label == "CN" and base == "idle_3.wav") or (label == "JP" and base == "idle_2.wav"):
            pt, pk, med, rm = analyze_spike(env)
            print("%-22s 峰值时间=%.2fs 峰值RMS=%.4f 中位RMS=%.4f 峰值/中位=%.2fx" %
                  (base, pt, pk, med, rm))
    # 输出 JSON 供绘图脚本使用
    import json
    data = {}
    for path, label, env, dur, gaps, tsil, nf in allfiles:
        base = os.path.basename(path)
        data[base] = {"label": label, "dur": dur, "env": env.tolist(),
                      "gaps": gaps, "noise_floor_db": nf}
    out = os.path.join(HERE, "_out", "cosy_analysis.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f)
    print("\nanalysis json -> %s" % out)

if __name__ == "__main__":
    main()
