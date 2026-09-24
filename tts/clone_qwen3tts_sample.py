# -*- coding: utf-8 -*-
"""Qwen3-TTS 0.6B-Base 零样本克隆 萤 音色 → 生成试听样本 + 测延迟

用法:
  python clone_qwen3tts_sample.py "要说的文本"            # ICL 模式(需 prompt_reftext.txt)
  python clone_qwen3tts_sample.py --xvec "要说的文本"     # 免文本模式(只取声纹)
依赖: 隔离 venv (venv-qwen3tts) + 已下载 0.6B-Base(含 speech_tokenizer) + prompt.wav
产出: tts/results/qwen3tts/{clone_<mode>_<ts>.wav, clone_<mode>_<ts>.txt, stats_<mode>.json}
"""
import os, sys, time, json

REF_WAV = "D:/live2d-companion/tts/ref/prompt.wav"
REF_TXT = "D:/live2d-companion/tts/ref/prompt_reftext.txt"
BASE = "D:/live2d-companion/tts/qwen3tts-models/Qwen3-TTS-12Hz-0.6B-Base"
OUT = "D:/live2d-companion/tts/results/qwen3tts"
os.makedirs(OUT, exist_ok=True)

import torch
import numpy as np
import librosa
import soundfile as sf
from qwen_tts import Qwen3TTSModel

DEFAULT_TEXT = "嗨嗨，主子大人，今天心情不错哦。要不我们一起来个桌面整理小挑战吧？"


def load_ref_24k(path, max_sec=8.0):
    """soundfile 读取 + 重采样到 24k，返回 (np.float32, 24000)，绕过 SoX/librosa 加载。

    裁到 max_sec：克隆只需 ~3-8s 参考，过长会徒增编码耗时（首版用整段 15s 导致 RTF 虚高）。
    """
    w, sr = sf.read(path, dtype="float32", always_2d=False)
    if w.ndim > 1:
        w = np.mean(w, axis=-1)
    if sr != 24000:
        w = librosa.resample(w.astype("float32"), orig_sr=sr, target_sr=24000)
    max_n = int(max_sec * 24000)
    if w.shape[0] > max_n:
        w = w[:max_n]
    return w.astype(np.float32), 24000


def main():
    xvec = "--xvec" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    text = args[0] if args else DEFAULT_TEXT
    ref_text = None
    if not xvec:
        with open(REF_TXT, encoding="utf-8") as f:
            ref_text = f.read().strip()
        print("REF_TEXT(%d): %s" % (len(ref_text), ref_text), flush=True)
    else:
        print("MODE: x_vector_only (no ref_text needed)", flush=True)

    ref_wav, ref_sr = load_ref_24k(REF_WAV)
    print("REF loaded: sr=%d len=%.2fs" % (ref_sr, len(ref_wav) / ref_sr), flush=True)

    print("loading 0.6B-Base ...", flush=True)
    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(
        BASE, device_map="cuda:0", dtype=torch.bfloat16,
    )
    print("model loaded in %.1fs" % (time.time() - t0), flush=True)

    ts = time.strftime("%Y%m%d-%H%M%S")
    t1 = time.time()
    if xvec:
        wavs, sr = model.generate_voice_clone(
            text=text, language="Chinese",
            ref_audio=(ref_wav, ref_sr), x_vector_only_mode=True,
        )
    else:
        wavs, sr = model.generate_voice_clone(
            text=text, language="Chinese",
            ref_audio=(ref_wav, ref_sr), ref_text=ref_text,
        )
    dt = time.time() - t1
    wav = wavs[0]
    dur = len(wav) / sr
    tag = "xvec" if xvec else "icl"
    out_wav = os.path.join(OUT, "clone_%s_%s.wav" % (tag, ts))
    sf.write(out_wav, wav, sr)
    out_txt = os.path.join(OUT, "clone_%s_%s.txt" % (tag, ts))
    with open(out_txt, "w", encoding="utf-8") as f:
        f.write(text)
    stats = dict(mode=tag, text=text, synth_sec=round(dt, 2), audio_sec=round(dur, 2),
                rtf=round(dt / dur, 2), sr=sr, wav=out_wav)
    with open(os.path.join(OUT, "stats_%s.json" % tag), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print("CLONE[%s] synth=%.2fs audio=%.2fs RTF=%.2f -> %s" % (tag, dt, dur, dt / dur, out_wav), flush=True)


if __name__ == "__main__":
    main()
