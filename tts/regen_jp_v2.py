# -*- coding: utf-8 -*-
"""日语修复 v2：
  问题1 语速偏慢  -> cross_lingual speed 提到 1.2
  问题2 棒读(太平) -> 每条生成 K 个候选(模型采样随机)，按 F0 起伏 cv 选最自然语气者；
                       对过度兴奋(峰值/中位>2.8)的候选降权，最终仍偏兴奋则软限幅。
  不使用 instruct2：冒烟测试证明 instruct2 会让时长暴涨(插入大量短停顿)，与用户「空白太多」投诉相反。
依赖：cosyvoice_src venv + _extramods；pyworld/soundfile/numpy/torchaudio。
"""
import os
import sys
import types
import numpy as np
import torch
import torchaudio
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src")
EXTRA = os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")
REF = os.environ.get("COSYVOICE_REF", os.path.join(HERE, "ref", "prompt.wav"))
from cosy_model import resolve_cosy_model
MODEL = resolve_cosy_model()
FP16 = os.environ.get("COSYVOICE_FP16", "1") not in ("0", "false", "False")
SPEED = float(os.environ.get("COSYVOICE_SPEED", "1.2"))
K = int(os.environ.get("COSY_K", "4"))
ONLY = os.environ.get("COSY_ONLY", "")
only_set = set()
if ONLY:
    for pair in ONLY.split():
        p, i = pair.split(",")
        only_set.add((p, int(i)))

for p in (HERE, COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)

import pyworld  # 需要 _extramods 里的 pkg_resources

_ns = "torch.nn.attention.flex_attention"
if _ns not in sys.modules and not hasattr(torch.nn.attention, "flex_attention"):
    m = types.ModuleType(_ns)
    m.flex_attention = lambda *a, **k: (_ for _ in ()).throw(NotImplementedError("stub"))
    sys.modules[_ns] = m
    torch.nn.attention.flex_attention = m  # type: ignore

SR = 24000
from fix_cosy_issues import (clean_silence, tame_spike, peak_median_ratio,
                             speech_only_ratio, synth, _patch_flex)
from make_audition_kouhai_cosyvoice import JP


def f0_cv(wav):
    if wav.ndim > 1:
        wav = wav.mean(1)
    wav = wav.astype(np.float64)
    f0, _ = pyworld.harvest(wav, fs=SR, f0_floor=50.0, f0_ceil=500.0)
    v = f0[f0 > 0]
    if len(v) < 10:
        return 0.0
    return float(v.std() / v.mean())


def prosody_score(wav):
    """棒读=低 F0 起伏；兴奋=峰值/中位过高。奖励起伏，但对过度兴奋做温和指数惩罚；
    另加时长惩罚(>9s 按比例衰减)，避免选到拖沓的候选。"""
    cv = f0_cv(wav)
    pmr = peak_median_ratio(wav)
    dur = len(wav) / SR
    if pmr <= 5.0:
        score = cv
    else:
        score = cv * float(np.exp(-(pmr - 5.0) / 12.0))
    if dur > 9.0:
        score *= 9.0 / dur
    return score, cv, pmr


def main():
    _patch_flex()
    from cosyvoice.cli.cosyvoice import CosyVoice2
    cosy = CosyVoice2(MODEL, load_jit=False, load_trt=False, fp16=FP16)
    print(">> model loaded  speed=%.2f  K=%d" % (SPEED, K))

    JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")
    for (pool, idx), text in sorted(JP.items()):
        if only_set and (pool, idx) not in only_set:
            continue
        out_path = os.path.join(JP_OUT, "%s_%d.wav" % (pool, idx))
        best = None
        for k in range(K):
            sp_tensor = synth(cosy, text, SPEED)
            wav = sp_tensor.squeeze(0).cpu().numpy().astype(np.float32)
            wav = wav / (np.max(np.abs(wav)) + 1e-9)
            score, cv, pmr = prosody_score(wav)
            print("  %s cand%d  cv=%.3f pmr=%.2f score=%.3f" % (os.path.basename(out_path), k, cv, pmr, score))
            if best is None or score > best[0]:
                best = (score, wav, cv, pmr)
        _, wav, cv, pmr = best
        # 兴奋保护
        if pmr > 2.5 or speech_only_ratio(wav) > 2.3:
            wav = tame_spike(wav)
            print("  %s 触发软限幅(pmr=%.2f)" % (os.path.basename(out_path), pmr))
        cleaned = clean_silence(wav)
        cleaned = cleaned / (np.max(np.abs(cleaned)) + 1e-9)
        sf.write(out_path, cleaned, SR)
        dur = len(cleaned) / SR
        print(">> %s 选用 cv=%.3f pmr=%.2f 时长=%.1fs" % (os.path.basename(out_path), cv, pmr, dur))

    print("日语修复 v2 完成 -> %s" % JP_OUT)


if __name__ == "__main__":
    main()
