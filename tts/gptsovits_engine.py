# -*- coding: utf-8 -*-
"""
GPT-SoVITS v2Pro 引擎封装（参考音频常驻）
=======================================
设计要点：
  * 单例 TTS：进程内只加载一次模型（权重常驻 GPU 显存）。
  * 参考音频常驻：init() 时 set_ref_audio() 一次，之后每次 speak() 复用
    prompt_cache 里的语义/频谱向量，不再重复编码参考音频。
    —— 这是 GPT-SoVITS 官方内置机制（run() 内有 ref_audio_path / prompt_text
       一致性闸），无需 patch 源码，零额外运行负荷。
  * 纯本地：显式锁死 HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE，推理零网络、零 token。

实测结论（见 results/bench_cache_ab.log）：
  * 参考编码不是首帧瓶颈，常驻对首帧几乎无改善。
  * 流式首帧地板 ≈ 4.9s（瓶颈是 GPT 自回归解码，无法靠缓存消除）。
  * 整句合成 ≈ 5.1s，RTF ≈ 0.5（合成比实时快，边生成边播很流畅）。

接口：
  init_gptsovits(ref_wav, ref_txt, device="cuda")  -> 加载并常驻参考音频
  speak_gptsovits(text, stream=True)               -> 流式生成器 / (sr, audio)
"""
import os, sys

# ---- 纯本地保证：推理零网络 ----
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

REPO = "D:/live2d-companion/tts/GPT-SoVITS"
PM = os.path.join(REPO, "GPT_SoVITS", "pretrained_models")

# 关键：sv.py 内部用 os.getcwd() 拼接 eres2net 路径，且 SV 权重路径是相对 cwd 的
# "GPT_SoVITS/pretrained_models/sv/..."，因此必须把 cwd 切到 REPO 根。
os.chdir(REPO)

# GPT-SoVITS 需要两个 import 根：
#   REPO            -> from GPT_SoVITS.TTS_infer_pack.TTS import ...
#   REPO/GPT_SoVITS -> from AR.models... / from process_ckpt import ...
#   REPO/GPT_SoVITS/eres2net -> sv.py 顶层 `from ERes2NetV2 import ...`
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "GPT_SoVITS"))
sys.path.insert(0, os.path.join(REPO, "GPT_SoVITS", "eres2net"))

import numpy as np
import soundfile as sf
import torch, torchaudio


def _torchaudio_load_sf(path, *a, **k):
    # torchaudio 2.11 仅提供基于系统 FFmpeg 的 load_with_torchcodec；
    # 改用已装的 soundfile，避免依赖系统 FFmpeg。
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(np.ascontiguousarray(data.T)), int(sr)


torchaudio.load = _torchaudio_load_sf

from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

_TTS = None          # 单例
_REF_WAV = None


def _build_config(device):
    cfg = TTS_Config(os.path.join(REPO, "GPT_SoVITS", "configs", "tts_infer.yaml"))
    cfg.device = device
    cfg.is_half = True
    cfg.version = "v2Pro"
    cfg.t2s_weights_path = os.path.join(
        PM, "gsv-v2final-pretrained",
        "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt")
    cfg.vits_weights_path = os.path.join(PM, "v2Pro", "s2Gv2Pro.pth")
    cfg.bert_base_path = os.path.join(PM, "chinese-roberta-wwm-ext-large")
    cfg.cnhuhbert_base_path = os.path.join(PM, "chinese-hubert-base")
    return cfg


def init_gptsovits(ref_wav, ref_txt, device="cuda"):
    """加载模型并常驻参考音频（进程生命周期内只调用一次）。"""
    global _TTS, _REF_WAV
    if _TTS is not None:
        return _TTS
    os.chdir(REPO)
    cfg = _build_config(device)
    _TTS = TTS(cfg)
    _REF_WAV = ref_wav
    # 官方内置常驻机制：一次性算好 prompt_semantic / refer_spec 存进 prompt_cache
    _TTS.set_ref_audio(ref_wav)
    # 预存参考文本，run() 时传相同文本即可复用 BERT/phones 缓存
    _TTS._ref_text = open(ref_txt, encoding="utf-8").read().strip()
    return _TTS


def _inputs(text, stream):
    return {
        "text": text,
        "text_lang": "zh",
        "ref_audio_path": _REF_WAV,          # 与 prompt_cache 一致 -> run() 跳过重编码
        "prompt_text": getattr(_TTS, "_ref_text", ""),
        "prompt_lang": "zh",
        "top_k": 5, "top_p": 1, "temperature": 1,
        "text_split_method": "cut0",
        "batch_size": 1,
        # 语速：1.0 偏慢（听着犯困），默认提到 1.2；可用环境变量 GPTSOVITS_SPEED 调整
        # （main.js 从 config.gptsovitsSpeed 透传；改后需重启侧车生效）
        "speed_factor": float(os.environ.get("GPTSOVITS_SPEED", "1.2")),
        "seed": -1,
        "parallel_infer": True,
        "repetition_penalty": 1.35,
        "return_fragment": stream,
    }


def speak_gptsovits(text, stream=True):
    """合成语音。
    stream=True  -> 返回生成器，逐段 yield (sr, np.ndarray)（首帧约 4.9s 后开始）
    stream=False -> 返回 (sr, np.ndarray) 整段音频
    注意：ref_audio_path 与 prompt_text 与常驻缓存一致，run() 内部不会重编码参考音频。
    """
    if _TTS is None:
        raise RuntimeError("请先调用 init_gptsovits()")
    if stream:
        return _TTS.run(_inputs(text, True))
    sr, audio = list(_TTS.run(_inputs(text, False)))[-1]
    return sr, audio


if __name__ == "__main__":
    import time
    t = init_gptsovits(
        "D:/live2d-companion/tts/ref/prompt_9s.wav",
        "D:/live2d-companion/tts/ref/prompt_9s_reftext.txt")
    txt = "今天天气真好，我们一起去公园散步吧。"
    t0 = time.perf_counter()
    frags = []
    for sr, a in speak_gptsovits(txt, stream=True):
        if len(frags) == 0:
            print("first_audio after %.3fs" % (time.perf_counter() - t0))
        frags.append(a)
    audio = np.concatenate(frags)
    sf.write("D:/live2d-companion/tts/results/gptsovits_engine_test.wav", audio, sr)
    print("done: %.2fs audio, saved" % (len(audio) / sr))
