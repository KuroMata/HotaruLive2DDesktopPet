# -*- coding: utf-8 -*-
"""Ollama(本地 qwen2.5) -> 文本 -> CosyVoice 逐句现合成 -> 拼接导出 wav。

证明端到端 "Ollama 开口说话" 管线（Live CosyVoice 模式：自然，每句数秒 TTS 延迟）。
不联网，全程本地。Ollama 出文本后按句切分，逐句用 CosyVoice 零样本克隆音色合成。

用法：
  python ollama-speak.py                       # 用内置默认提问
  python ollama-speak.py "你的自定义提问"       # 自定义提问
前置：ollama serve 已在本地 11434 起来、且模型 qwen2.5:7b-instruct-q4_K_M 已拉取。
"""
import os
import sys
import time
import json
import re
import urllib.request

sys.path.insert(0, "D:/cosyvoice_src")
sys.path.insert(0, "D:/live2d-companion/tts")

import numpy as np
import torch
import soundfile as sf
from cosy_gen import load_cosy

SR = 24000
REF = "D:/live2d-companion/tts/ref/prompt.wav"
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5:7b-instruct-q4_K_M"
SYSTEM = (
    "你是黑叶萤，一只住在电脑桌面上的 Live2D 猫娘桌面宠物，性格随和、有点毒舌但很可靠，"
    "会陪主人干活、聊天。请用自然简短的口语中文回复，控制在 2 到 3 句话，不要列表、不要长篇大论。"
)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "ollama-speak")
os.makedirs(ROOT, exist_ok=True)


def ollama_reply(prompt, system=SYSTEM, timeout=300):
    payload = json.dumps({
        "model": MODEL,
        "prompt": prompt,
        "system": system,
        "stream": False,
        "options": {"temperature": 0.8},
    }).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data.get("response", ""), time.time() - t0


def split_sentences(text):
    # 在句末标点(含换行)后切分，保留标点
    parts = re.split(r"(?<=[。！？!?；;\n])", text)
    out = []
    for p in parts:
        p = p.strip()
        if p:
            out.append(p)
    return out


def synth(cosy, text):
    wavs = []
    for c in cosy.inference_cross_lingual(
        tts_text=text, prompt_wav=REF,
        zero_shot_spk_id="bank", stream=False, speed=1.0,
    ):
        wavs.append(c["tts_speech"])
    return torch.cat(wavs, dim=-1).squeeze(0).cpu().numpy().astype(np.float32)


def concat_fade(units, fade=0.02):
    if not units:
        return np.zeros(0, dtype=np.float32)
    n = int(fade * SR)
    out = units[0].copy()
    for w in units[1:]:
        if len(out) >= n and len(w) >= n:
            a = out[-n:]
            b = w[:n]
            mix = a * np.linspace(1, 0, n) + b * np.linspace(0, 1, n)
            out = np.concatenate([out[:-n], mix, w[n:]])
        else:
            out = np.concatenate([out, w])
    return out


def main():
    prompt = (sys.argv[1] if len(sys.argv) > 1
              else "萤，跟你的主人打个招呼，顺便说一句今天想一起做点什么。")
    print("PROMPT: %s" % prompt, flush=True)

    cosy = load_cosy()
    cosy.add_zero_shot_spk("", REF, "bank")

    reply, gen_t = ollama_reply(prompt)
    print("OLLAMA_REPLY (%.2fs): %s" % (gen_t, reply), flush=True)

    sentences = split_sentences(reply)
    print("SENTENCES=%d" % len(sentences), flush=True)

    units = []
    tts_total = 0.0
    for i, s in enumerate(sentences):
        t0 = time.time()
        w = synth(cosy, s)
        dt = time.time() - t0
        tts_total += dt
        units.append(w)
        print("  [%d/%d] %.2fs  %s" % (i + 1, len(sentences), dt, s), flush=True)

    out = concat_fade(units)
    m = np.max(np.abs(out)) + 1e-9
    out = (out / m * 0.9).astype(np.float32)

    ts = time.strftime("%Y%m%d-%H%M%S")
    wav_path = os.path.join(ROOT, "ollama_speak_%s.wav" % ts)
    txt_path = os.path.join(ROOT, "ollama_speak_%s.txt" % ts)
    sf.write(wav_path, out, SR)
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(
            "PROMPT: %s\n\nREPLY: %s\n\nSENTENCES=%d  TTS_total=%.2fs  "
            "OLLAMA_gen=%.2fs  WAV=%.2fs\n" % (
                prompt, reply, len(sentences), tts_total, gen_t, len(out) / SR)
        )
    print(
        "SAVED %s (%.2fs, %d sentences, tts_total=%.2fs, ollama_gen=%.2fs)" % (
            wav_path, len(out) / SR, len(sentences), tts_total, gen_t),
        flush=True,
    )


if __name__ == "__main__":
    main()
