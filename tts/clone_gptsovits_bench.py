# -*- coding: utf-8 -*-
"""
GPT-SoVITS v2pro 少样本克隆 + 动态延迟实测
==========================================
用 ref/prompt.wav (萤音色) + prompt_reftext.txt 做音色克隆，
测量：(1) 冷启动首条合成耗时 (2) 模型常驻、参考已缓存后的动态合成耗时
(3) 首帧延迟 (time-to-first-audio) (4) RTF。

运行前提：
  * 仓库已解压到 tts/GPT-SoVITS/，权重已落到 GPT_SoVITS/pretrained_models/
  * venv-gptsovits 已装好依赖
从仓库根目录运行（TTS 代码依赖 cwd + 相对权重路径）。
"""
import os, sys, time

REPO = "D:/live2d-companion/tts/GPT-SoVITS"
PM = os.path.join(REPO, "GPT_SoVITS", "pretrained_models")
REF_WAV = "D:/live2d-companion/tts/ref/prompt_9s.wav"          # GPT-SoVITS requires 3~10s ref; src prompt.wav is 15.14s
REF_TXT = "D:/live2d-companion/tts/ref/prompt_9s_reftext.txt"   # text truncated to match the 9s clip
OUT_WAV = "D:/live2d-companion/tts/results/clone_gptsovits_out.wav"
TARGET = "今天天气真好，我们一起去公园散步吧。它只睡了三个钟头，树林深处有条很窄的小路。"

os.chdir(REPO)
# GPT-SoVITS uses two import roots:
#   * REPO            -> `from GPT_SoVITS.TTS_infer_pack.TTS import ...`
#   * REPO/GPT_SoVITS -> `from AR.models...` and `from process_ckpt import ...`
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "GPT_SoVITS"))

import numpy as np
import soundfile as sf
import torch, torchaudio
# torchaudio 2.11 removed the soundfile/ffmpeg backends and only ships
# load_with_torchcodec (needs system FFmpeg). Patch load() to go through the
# already-installed soundfile so we don't depend on system FFmpeg.
def _torchaudio_load_sf(path, *a, **k):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    # soundfile -> (frames, channels); torchaudio convention -> (channels, frames)
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

def make_inputs(fragment):
    ref_text = open(REF_TXT, encoding="utf-8").read().strip()
    return {
        "text": TARGET,
        "text_lang": "zh",
        "ref_audio_path": REF_WAV,
        "prompt_text": ref_text,
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

def synth_full(tts):
    """return_fragment=False：整段合成，返回 (sr, audio, 耗时)。"""
    t0 = time.perf_counter()
    sr, audio = list(tts.run(make_inputs(False)))[-1]
    return sr, audio, time.perf_counter() - t0

def synth_ttfa(tts):
    """return_fragment=True：流式，记录首帧延迟与总耗时。"""
    t0 = time.perf_counter()
    frags, ttfa = [], None
    for sr, a in tts.run(make_inputs(True)):
        if ttfa is None:
            ttfa = time.perf_counter() - t0
        frags.append(a)
    full = time.perf_counter() - t0
    audio = np.concatenate(frags) if frags else np.zeros(1, np.int16)
    return sr, audio, full, ttfa

def main():
    print("=== loading models (one-time) ===")
    t_load = time.perf_counter()
    cfg = build_config()
    tts = TTS(cfg)
    t_load = time.perf_counter() - t_load
    print("model load time: %.2fs  device=%s  is_half=%s" % (t_load, cfg.device, cfg.is_half))

    # (1) 冷启动首条（含参考预处理）
    sr, audio, t_cold = synth_full(tts)
    dur = len(audio) / sr
    print("[cold ] total=%.3fs  audio=%.2fs  RTF=%.3f" % (t_cold, dur, t_cold / dur))

    # (2) 动态合成（模型常驻 + 参考已缓存）
    sr, audio, t_warm = synth_full(tts)
    dur = len(audio) / sr
    print("[warm ] total=%.3fs  audio=%.2fs  RTF=%.3f" % (t_warm, dur, t_warm / dur))

    # (3) 首帧延迟（流式）
    sr, audio, t_full, ttfa = synth_ttfa(tts)
    dur = len(audio) / sr
    print("[stream] first_audio=%.3fs  total=%.3fs  audio=%.2fs  RTF=%.3f"
          % (ttfa, t_full, dur, t_full / dur))

    sf.write(OUT_WAV, audio, sr)
    print("saved ->", OUT_WAV)

    ok = t_warm <= 2.0
    verdict = "PASS (within budget)" if ok else "FAIL (over budget)"
    print("=== VERDICT: dynamic latency %.3fs -> %s ===" % (t_warm, verdict))

if __name__ == "__main__":
    main()
