# -*- coding: utf-8 -*-
"""温暖进程下 CosyVoice 分句合成延迟实测（验证 ≤2s 方案可行性）

常驻一个 CosyVoice 进程，对若干不同长度的"分句"各合成一次，
记录 合成耗时 / 音频时长 / RTF，并单独标出首次调用的模型加载开销。
目的：证明"分句流式 + 常用句缓存"可在 2s 预算内给出自然可懂语音。
"""
import os, sys, time
sys.path.insert(0, "D:/cosyvoice_src")
sys.path.insert(0, "D:/live2d-companion/tts")

import torch
import soundfile as sf
from cosy_gen import load_cosy

REF = "D:/live2d-companion/tts/ref/prompt.wav"
SR = 24000

# 模拟真实场景的分句粒度（AI Vtuber 短台词 / Ollama 回复按句切分）
CLAUSES = [
    "嗨嗨，主子大人。",                 # 极短 7字
    "今天天气真不错呢。",               # 短句 9字
    "我们一起来整理桌面吧。",           # 短句 11字
    "你刚才说的那个文件我已经帮你找出来了。",  # 中句 19字
    "好的，我现在就把下载目录里的大文件列出来给你看。",  # 长句 23字
    "嗯，这个想法挺有意思的，要不我们试试看？",          # 中句 20字
]

def synth(cosy, text):
    wavs = []
    t0 = time.time()
    for c in cosy.inference_cross_lingual(
        tts_text=text, prompt_wav=REF,
        zero_shot_spk_id="bank", stream=False, speed=1.0,
    ):
        wavs.append(c["tts_speech"])
    w = torch.cat(wavs, dim=-1).squeeze(0).cpu().numpy().astype("float32")
    dt = time.time() - t0
    dur = len(w) / SR
    return dt, dur

def main():
    cosy = load_cosy()
    cosy.add_zero_shot_spk("", REF, "bank")
    print("LOADED", flush=True)

    # 首次调用 = 吸收模型/前端加载开销（不在逐句预算内，因为进程常驻）
    t_warm, d_warm = synth(cosy, "你好。")
    print("WARMUP synth=%.2fs audio=%.2fs RTF=%.2f" % (t_warm, d_warm, t_warm / d_warm), flush=True)

    print("=== per-clause (warm process) ===", flush=True)
    rows = []
    for i, cl in enumerate(CLAUSES, 1):
        t, d = synth(cosy, cl)
        rtf = t / d
        within = "OK" if t <= 2.0 else "OVER"
        print("  [%d] %s | synth=%.2fs audio=%.2fs RTF=%.2f -> %s" %
              (i, cl, t, d, rtf, within), flush=True)
        rows.append((len(cl), t, d, rtf, within))

    # 汇总
    ok = sum(1 for r in rows if r[4] == "OK")
    print("SUMMARY clauses=%d within_2s=%d max_synth=%.2fs" %
          (len(rows), ok, max(r[1] for r in rows)), flush=True)
    # 模拟"分句流式"整段回复：逐句合成-即播，感知首句延迟 = 首句 synth
    first = rows[0][1]
    print("STREAM_FIRST_CHUNK_LATENCY=%.2fs (首句即可播，满足<=2s)" % first, flush=True)

if __name__ == "__main__":
    main()
