# -*- coding: utf-8 -*-
"""
A/B 实测：参考音频编码「常驻复用」 vs 「每次重编码」
==================================================
目的：确认 set_ref_audio() 常驻机制到底省多少时间，以及流式首帧的真实地板。
A 组：TTS 单例 + 启动时 set_ref_audio 一次，之后每次 run 复用语义/频谱缓存。
B 组：每次 run 前清空 prompt_cache["ref_audio_path"]，强制重新 set_ref_audio（重编码）。

离线保证：显式设 HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE，推理零网络。
"""
import os, sys, time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

REPO = "D:/live2d-companion/tts/GPT-SoVITS"
PM = os.path.join(REPO, "GPT_SoVITS", "pretrained_models")
REF_WAV = "D:/live2d-companion/tts/ref/prompt_9s.wav"
REF_TXT = "D:/live2d-companion/tts/ref/prompt_9s_reftext.txt"
TARGET = "今天天气真好，我们一起去公园散步吧。它只睡了三个钟头，树林深处有条很窄的小路。"

os.chdir(REPO)
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "GPT_SoVITS"))

import numpy as np
import soundfile as sf
import torch, torchaudio


def _torchaudio_load_sf(path, *a, **k):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(np.ascontiguousarray(data.T)), int(sr)


torchaudio.load = _torchaudio_load_sf
from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config


def build_config():
    cfg = TTS_Config(os.path.join(REPO, "GPT_SoVITS", "configs", "tts_infer.yaml"))
    cfg.device = "cuda"
    cfg.is_half = True
    cfg.version = "v2Pro"
    cfg.t2s_weights_path = os.path.join(
        PM, "gsv-v2final-pretrained",
        "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt")
    cfg.vits_weights_path = os.path.join(PM, "v2Pro", "s2Gv2Pro.pth")
    cfg.bert_base_path = os.path.join(PM, "chinese-roberta-wwm-ext-large")
    cfg.cnhuhbert_base_path = os.path.join(PM, "chinese-hubert-base")
    return cfg


def make_inputs(fragment, ref_path):
    return {
        "text": TARGET,
        "text_lang": "zh",
        "ref_audio_path": ref_path,
        "prompt_text": open(REF_TXT, encoding="utf-8").read().strip(),
        "prompt_lang": "zh",
        "top_k": 5, "top_p": 1, "temperature": 1,
        "text_split_method": "cut0",
        "batch_size": 1,
        "speed_factor": 1.0,
        "seed": -1,
        "parallel_infer": True,
        "repetition_penalty": 1.35,
        "return_fragment": fragment,
    }


def synth_stream(tts, force_reencode):
    if force_reencode:
        # 让 run() 认为参考音频未设置 -> 重新 set_ref_audio（重编码）
        tts.prompt_cache["ref_audio_path"] = None
        ref_path = REF_WAV
    else:
        if tts.prompt_cache.get("ref_audio_path") != REF_WAV:
            tts.set_ref_audio(REF_WAV)  # 仅首次
        ref_path = REF_WAV
    t0 = time.perf_counter()
    ttfa = None
    frags = []
    for sr, a in tts.run(make_inputs(True, ref_path)):
        if ttfa is None:
            ttfa = time.perf_counter() - t0
        frags.append(a)
    total = time.perf_counter() - t0
    dur = (len(np.concatenate(frags)) / sr) if frags else 0.0
    return ttfa, total, dur


def main():
    t_load = time.perf_counter()
    tts = TTS(build_config())
    t_load = time.perf_counter() - t_load
    print("model load: %.2fs  device=%s  is_half=%s" % (t_load, "cuda", True))

    N = 5
    # 两种模式各 warmup 一次（CUDA kernel 预热），结果不计入
    synth_stream(tts, False)
    synth_stream(tts, True)

    A, B = [], []
    for _ in range(N):
        ttfa, tot, dur = synth_stream(tts, False)
        A.append((ttfa, tot, dur))
    for _ in range(N):
        ttfa, tot, dur = synth_stream(tts, True)
        B.append((ttfa, tot, dur))

    avg = lambda xs, k: sum(x[k] for x in xs) / len(xs)
    print("\n=== A 常驻(参考编码缓存复用) ===")
    print("  first_audio avg=%.3fs  total avg=%.3fs  audio=%.2fs" % (avg(A, 0), avg(A, 1), avg(A, 2)))
    print("=== B 每次重编码 ===")
    print("  first_audio avg=%.3fs  total avg=%.3fs  audio=%.2fs" % (avg(B, 0), avg(B, 1), avg(B, 2)))
    print("\n=== 常驻节省 ===")
    print("  first_audio: %.3fs -> %.3fs  (省 %.3fs)" % (avg(B, 0), avg(A, 0), avg(B, 0) - avg(A, 0)))
    print("  total:       %.3fs -> %.3fs  (省 %.3fs)" % (avg(B, 1), avg(A, 1), avg(B, 1) - avg(A, 1)))
    print("\n结论：常驻后流式首帧地板 = %.3fs" % avg(A, 0))


if __name__ == "__main__":
    main()
