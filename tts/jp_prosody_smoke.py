# -*- coding: utf-8 -*-
"""日语棒读修复 A/B 冒烟测试：cross_lingual vs instruct2（不同语气指令）。
客观度量 F0 起伏（棒读=低起伏），选最佳方案再全量重跑。"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src")
from cosy_model import resolve_cosy_model
COSY_MODEL = resolve_cosy_model()
REF = os.path.join(HERE, "ref", "prompt.wav")
EXTRA = "D:/cosyvoice_src/_extramods"
for p in (COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)

# flex_attention stub (torch 2.3 缺)
import types, torch
_ns = "torch.nn.attention.flex_attention"
if _ns not in sys.modules and not hasattr(torch.nn.attention, "flex_attention"):
    m = types.ModuleType(_ns)
    m.flex_attention = lambda *a, **k: (_ for _ in ()).throw(NotImplementedError("stub"))
    sys.modules[_ns] = m
    torch.nn.attention.flex_attention = m

import soundfile as sf
import numpy as np
import pyworld
import torchaudio

SR = 24000
TMP = os.path.join(HERE, "_out", "_smoke_jp")
os.makedirs(TMP, exist_ok=True)

# 复用 fix_cosy_issues 的静音清理逻辑
sys.path.insert(0, HERE)
from fix_cosy_issues import clean_silence

JP_IDLE2 = "先輩のそちらの明かり、まだついてますよ。そろそろ休まないと、明日もデータの処理がありますから。"
JP_CLICK0 = "先輩、データの確認は終わりました。異常はありませんので、ご安心ください。"

INSTRUCTS = {
    "A_natural": "用自然、有感情、语气有起伏的方式朗读，不要平淡机械。",
    "B_shy_junior": "用温柔沉稳、带点害羞的语气，像在跟在意的人说话一样，语气要有起伏。",
    "C_reliable": "用沉稳可靠、自然亲切的语气朗读，语速适中，带着一点温度。",
}


def f0_stats(wav):
    if wav.ndim > 1:
        wav = wav.mean(1)
    wav = wav.astype(np.float64)
    # pyworld 需要 16k 采样以稳定；用原采样也可，这里直接用 24k
    f0, _t = pyworld.harvest(wav.astype(np.float64), fs=SR, f0_floor=50.0, f0_ceil=500.0)
    voiced = f0[f0 > 0]
    if len(voiced) < 10:
        return None
    return {
        "n_voiced": int(len(voiced)),
        "range": float(voiced.max() - voiced.min()),
        "std": float(voiced.std()),
        "mean": float(voiced.mean()),
        "cv": float(voiced.std() / voiced.mean()),
    }


def gen_and_save(cosy, label, text, out_wav, mode="cross", instruct=None, speed=1.2):
    if mode == "cross":
        gen = cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF, stream=False, speed=speed)
    else:
        gen = cosy.inference_instruct2(tts_text=text, instruct_text=instruct, prompt_wav=REF, stream=False, speed=speed)
    speech = None
    for ch in gen:
        speech = ch["tts_speech"]
    raw = speech.squeeze().numpy().astype(np.float32)
    raw = raw / (np.max(np.abs(raw)) + 1e-9)
    cleaned = clean_silence(raw)
    sf.write(out_wav, cleaned, SR)
    return cleaned


def main():
    from cosyvoice.cli.cosyvoice import CosyVoice2
    cosy = CosyVoice2(COSY_MODEL, load_jit=False, load_trt=False, fp16=True)
    print(">> model loaded")
    results = {}
    for tag, text in (("idle_2", JP_IDLE2), ("click_0", JP_CLICK0)):
        print("\n==== %s ====" % tag)
        # baseline
        b = os.path.join(TMP, "%s_cross.wav" % tag)
        w = gen_and_save(cosy, tag, text, b, mode="cross", speed=1.2)
        sb = f0_stats(w); dur = len(w) / SR
        results["%s_cross" % tag] = dict(dur=round(dur, 2), **(sb or {}))
        print("  cross@1.2    dur=%.2fs  F0range=%.1f std=%.1f cv=%.3f" % (dur, sb["range"], sb["std"], sb["cv"]))
        for k, inst in INSTRUCTS.items():
            o = os.path.join(TMP, "%s_%s.wav" % (tag, k))
            w = gen_and_save(cosy, tag, text, o, mode="instruct", instruct=inst, speed=1.2)
            s = f0_stats(w); dur = len(w) / SR
            results["%s_%s" % (tag, k)] = dict(dur=round(dur, 2), **(s or {}))
            print("  instruct[%s] dur=%.2fs  F0range=%.1f std=%.1f cv=%.3f" % (k, dur, s["range"], s["std"], s["cv"]))
    print("\n=== JSON ===")
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
