# -*- coding: utf-8 -*-
"""固定随机种子能不能让 CosyVoice 输出完全一致？

这是"Vocaloid 式音库"路线的可行性前提：如果每次生成的单字音色都在漂，
拼起来的句子只会比现在更难听。

测：同一句话，固定 seed 合成 3 次，比较波形是否逐字节相同 / F0 是否一致。
"""
import os
import sys
import time
import json

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(os.path.dirname(HERE))
TTS = os.path.join(PROJ, "tts")
for p in (TTS, os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src"),
          os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")):
    if p not in sys.path:
        sys.path.insert(0, p)

import numpy as np
import torch

SR = 24000
OUT = os.path.join(HERE, "results")
os.makedirs(OUT, exist_ok=True)
REF_PATH = os.environ.get("COSYVOICE_REF", os.path.join(TTS, "ref", "prompt.wav"))
TEXT = "来了来了，这就回你。"


def set_seed(s):
    torch.manual_seed(s)
    torch.cuda.manual_seed(s)
    torch.cuda.manual_seed_all(s)
    import random
    random.seed(s)
    np.random.seed(s)


def synth_once(cosy, text, seed=None):
    if seed is not None:
        set_seed(seed)
    out = []
    for chunk in cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF_PATH,
                                              stream=False, speed=1.0):
        out.append(chunk["tts_speech"])
    w = torch.cat(out, dim=-1)
    return w.squeeze(0).cpu().numpy().astype(np.float32)


def f0_mean(w):
    try:
        import pyworld as pw
        x = w.astype(np.float64)
        f0, t = pw.harvest(x, SR, f0_floor=60.0, f0_ceil=400.0)
        f0 = f0[f0 > 0]
        return float(np.median(f0)) if len(f0) else 0.0
    except Exception:
        return 0.0


def main():
    from cosy_gen import load_cosy
    cosy = load_cosy()

    w0 = synth_once(cosy, "预热。")
    del w0

    res = {"no_seed": [], "seed_42": []}
    print("=" * 70)
    print("A. 不设 seed，合成 3 次")
    print("=" * 70)
    waves_ns = []
    for i in range(3):
        w = synth_once(cosy, TEXT)
        d = len(w) / SR
        f = f0_mean(w)
        waves_ns.append(w)
        res["no_seed"].append(dict(dur=d, f0=f))
        print("  run%d  时长 %.3f s  F0 中位 %.1f Hz  采样数 %d" % (i + 1, d, f, len(w)))

    print()
    print("=" * 70)
    print("B. 固定 seed=42，合成 3 次")
    print("=" * 70)
    waves_s = []
    for i in range(3):
        w = synth_once(cosy, TEXT, seed=42)
        d = len(w) / SR
        f = f0_mean(w)
        waves_s.append(w)
        res["seed_42"].append(dict(dur=d, f0=f))
        print("  run%d  时长 %.3f s  F0 中位 %.1f Hz  采样数 %d" % (i + 1, d, f, len(w)))

    def cmp(name, waves):
        print()
        print("--- %s 两两对比 ---" % name)
        n = min(len(w) for w in waves)
        identical = []
        for i in range(len(waves)):
            for j in range(i + 1, len(waves)):
                a, b = waves[i][:n], waves[j][:n]
                same = bool(np.array_equal(a, b))
                diff = float(np.max(np.abs(a - b)))
                f0a, f0b = f0_mean(a), f0_mean(b)
                semi = 12 * np.log2(f0b / f0a) if f0a > 0 and f0b > 0 else 0.0
                identical.append(same)
                print("  run%d vs run%d  逐字节相同=%s  最大振幅差=%.4f  F0 差=%.2f 半音" % (
                    i + 1, j + 1, same, diff, semi))
        return identical

    ident_ns = cmp("不设 seed", waves_ns)
    ident_s = cmp("固定 seed=42", waves_s)
    res["no_seed_identical"] = all(ident_ns)
    res["seed_identical"] = all(ident_s)

    print()
    print("=" * 70)
    print("结论：不设 seed 逐字节相同 = %s ；固定 seed 逐字节相同 = %s" % (
        res["no_seed_identical"], res["seed_identical"]))
    print("=" * 70)

    with open(os.path.join(OUT, "probe-seed.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
