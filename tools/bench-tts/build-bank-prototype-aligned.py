# -*- coding: utf-8 -*-
"""A 路线原型：整句现合成 → whisper 字级时间戳切字 → 按原句顺序拼回。

与之前孤立单字拼接 (build-bank-prototype.py) 的本质区别：
  - 素材来自带语境的整句自然语流，每个字读音正确（根治"念错词"）
  - 切出来的片段是连续语流里的一段，不含单字默认的 1.3s 停顿（根治"拖沓"）
  - 不依赖 ffmpeg：soundfile 读 24k → librosa 重采样 16k → 喂 whisper numpy

产出三组对照：
  demo_aligned/  整句切字拼回（A 路线结果）
  demo_norm/     同上再叠加音高归一化（整体平移到中位 F0，保留声调轮廓）
  demo_full/     整句现合成（质量上限参照）

用法： python tools/bench-tts/build-bank-prototype-aligned.py
"""
import os
import sys
import time
import json
import re
sys.path.insert(0, "D:/cosyvoice_src")
sys.path.insert(0, "D:/live2d-companion/tts")
import numpy as np
import torch
import soundfile as sf
import librosa
import whisper
import pyworld as pw
from pypinyin import pinyin, Style
from cosy_gen import load_cosy

SR = 24000
REF = "D:/live2d-companion/tts/ref/prompt.wav"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "bank-proto-aligned")
for d in ("demo_aligned", "demo_norm", "demo_full"):
    os.makedirs(os.path.join(ROOT, d), exist_ok=True)

DEMOS = [
    "你好呀",
    "欢迎回来",
    "今天天气不错",
    "我来念一段弹幕",
    "你的名字真有趣",
]


def synth_full(cosy, text):
    wavs = []
    for c in cosy.inference_cross_lingual(
            tts_text=text, prompt_wav=REF, zero_shot_spk_id="bank",
            stream=False, speed=1.0):
        wavs.append(c["tts_speech"])
    return torch.cat(wavs, dim=-1).squeeze(0).cpu().numpy().astype(np.float32)


def to16k(w):
    return librosa.resample(w.astype(np.float64), orig_sr=SR, target_sr=16000).astype(np.float32)


def segment(text, wav, words):
    """按原句字符顺序切分。优先用 whisper 逐字段；否则退化为时间轴 N 等分。"""
    T = len(wav) / SR
    N = len(text)
    if words and len(words) == N:
        bounds = [(w["start"], w["end"]) for w in words]
    else:
        # whisper 没逐字时，按整句时间轴均匀 N 等分（读音仍正确，仅字边界略糊）
        bounds = [(T * i / N, T * (i + 1) / N) for i in range(N)]
    segs = []
    for (s, e) in bounds:
        si = max(0, int(s * SR))
        ei = min(len(wav), int(e * SR))
        segs.append(wav[si:ei])
    return segs


def trim(x, win=480, thr=0.02, margin=0.02):
    a = np.abs(x)
    if len(a) < win:
        return x
    env = np.convolve(a, np.ones(win) / win, mode="same")
    env = env / (env.max() + 1e-9)
    idx = np.where(env > thr)[0]
    if len(idx) == 0:
        return x
    s = max(0, idx[0] - int(margin * SR))
    e = min(len(x), idx[-1] + int(margin * SR))
    return x[s:e]


def f0_median(x):
    f0, t = pw.harvest(x.astype(np.float64), SR, f0_floor=60.0, f0_ceil=400.0)
    v = f0[f0 > 0]
    return float(np.median(v)) if len(v) else 0.0


def pitch_shift(x, ratio):
    x = x.astype(np.float64)
    f0, t = pw.harvest(x, SR, f0_floor=60.0, f0_ceil=400.0)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap = pw.d4c(x, f0, t, SR)
    y = pw.synthesize(f0 * ratio, sp, ap, SR)
    n = min(len(y), len(x))
    return y[:n]


def concat(units_wavs, fade=0.02):
    n_fade = int(fade * SR)
    out = units_wavs[0].copy()
    for w in units_wavs[1:]:
        if len(out) >= n_fade and len(w) >= n_fade:
            a = out[-n_fade:]; b = w[:n_fade]
            mix = a * np.linspace(1, 0, n_fade) + b * np.linspace(0, 1, n_fade)
            out = np.concatenate([out[:-n_fade], mix, w[n_fade:]])
        else:
            out = np.concatenate([out, w])
    return out


def norm_peak(x, peak=0.9):
    m = np.max(np.abs(x)) + 1e-9
    return x / m * peak


def main():
    cosy = load_cosy()
    cosy.add_zero_shot_spk("", REF, "bank")
    model = whisper.load_model("base")
    stats = {}
    log = []
    for s in DEMOS:
        t0 = time.time()
        w = synth_full(cosy, s)
        w16 = to16k(w)
        res = model.transcribe(w16, language="zh", word_timestamps=True,
                               prepend_punctuations="", append_punctuations="")
        words = []
        for seg in res["segments"]:
            for wd in seg.get("words", []):
                words.append({"word": wd["word"], "start": wd["start"], "end": wd["end"]})
        segs = segment(s, w, words)  # 顺序 == 原句字符顺序
        segs = [trim(x) for x in segs]
        # 音高归一化：整体平移到中位 F0，保留各字声调轮廓
        f0s = [f0_median(x) for x in segs if f0_median(x) > 0]
        target = float(np.median(f0s)) if f0s else 0.0
        segs_n = []
        for x in segs:
            f = f0_median(x)
            if f > 0 and abs(12 * np.log2(f / target)) > 0.15:
                segs_n.append(pitch_shift(x, target / f))
            else:
                segs_n.append(x)

        a = norm_peak(concat(segs, fade=0.02))
        b = norm_peak(concat(segs_n, fade=0.02))
        c = norm_peak(trim(synth_full(cosy, s)))

        sf.write(os.path.join(ROOT, "demo_aligned", "%s.wav" % s), a, SR)
        sf.write(os.path.join(ROOT, "demo_norm", "%s.wav" % s), b, SR)
        sf.write(os.path.join(ROOT, "demo_full", "%s.wav" % s), c, SR)

        stats[s] = dict(n_whisper_words=len(words), n_chars=len(s),
                        aligned_s=len(a) / SR, norm_s=len(b) / SR, full_s=len(c) / SR,
                        recog=res["text"].strip(),
                        whisper_words=[w["word"] for w in words])
        msg = "「%s」 whisper词数=%d 字数=%d | aligned=%.2fs norm=%.2fs full=%.2fs | 识别=%s" % (
            s, len(words), len(s), len(a) / SR, len(b) / SR, len(c) / SR, res["text"].strip())
        print(msg, flush=True); log.append(msg)

    with open(os.path.join(ROOT, "stats_aligned.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    with open(os.path.join(ROOT, "build_aligned.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(log))


if __name__ == "__main__":
    main()
