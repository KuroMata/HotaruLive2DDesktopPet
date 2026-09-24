# -*- coding: utf-8 -*-
"""优化组合实测：JIT + 音色缓存 + 单候选，看能压到多快、音色是否变稳。

对照基线是 probe-speed.py（load_jit=False, 无缓存, stream=False）：
    XS 3.9s / S 4.3s / M 7.7s

本脚本：
  1. load_jit=True 加载（模型目录里有 flow.encoder.fp16.zip）
  2. add_zero_shot_spk 一次性注册音色（跳过每句重编码参考音频）
  3. 每句只跑 1 个候选（generate_best 的 max_candidates=2 会让耗时翻倍）
  4. 每句生成 3 份 wav，供 analyze.py 做"变声期"分析

用法： python tools/bench-tts/probe-opt.py
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
import soundfile as sf

SR = 24000
RES = os.path.join(HERE, "results")
OUTDIR = os.path.join(RES, "cosyvoice-opt")
os.makedirs(OUTDIR, exist_ok=True)

REF = os.environ.get("COSYVOICE_REF", os.path.join(TTS, "ref", "prompt.wav"))

SENTENCES = [
    ("S1", "来了来了，这就回你。"),
    ("S2", "你这问题问得好，不过我得先看一眼屏幕才知道你在说啥。"),
    ("S3", "行，我给你捋一下。第一，本地模型跑起来之后就不用联网了；第二，语音也得留在本地，不然就串味了；第三，弹幕那种必须联网的，我们再单独接。"),
]

BASELINE = {"S1": 4.3, "S2": 7.7, "S3": None}   # probe-speed 的裸推理中位（近似）

log = []


def L(s=""):
    print(s, flush=True)
    log.append(s)


def main():
    L("=" * 74)
    L("优化组合实测：load_jit=True + 音色缓存 + 单候选")
    L("=" * 74)

    from cosy_gen import load_cosy, _to_wav
    from fix_cosy_issues import synth, clean_silence, normalize_loudness
    from regen_jp_v3 import prosody_score
    from cosy_model import resolve_cosy_model

    L("模型: %s" % resolve_cosy_model())
    t0 = time.time()
    # load_jit=True：用 flow.encoder.fp16.zip 替换 flow encoder
    cosy = load_cosy()
    L("load_cosy() 耗时 %.1f s" % (time.time() - t0))
    L("  注：load_cosy() 内部固定 load_jit=False，如需 JIT 需改 cosy_gen.py；"
      "本轮先测「缓存 + 单候选」的收益")
    L("")

    t0 = time.time()
    cosy.add_zero_shot_spk("", REF, "hotaru")
    L("音色注册: %.2f s" % (time.time() - t0))
    L("")

    def synth_one(text, sp=1.0):
        """缓存音色 + 单候选：只跑一次推理，不做多候选择优"""
        chunks = []
        for chunk in cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF,
                                                  zero_shot_spk_id="hotaru",
                                                  stream=False, speed=sp):
            chunks.append(chunk["tts_speech"])
        w = torch.cat(chunks, dim=-1).squeeze(0).cpu().numpy().astype(np.float32)
        w = w / (np.max(np.abs(w)) + 1e-9)
        w = clean_silence(w)
        w = normalize_loudness(w)
        return w

    summary = {}
    for sid, text in SENTENCES:
        L("-" * 74)
        L("%s  「%s」" % (sid, text[:26]))
        times, durs = [], []
        for run in range(3):
            t0 = time.time()
            w = synth_one(text, 1.0)
            el = time.time() - t0
            dur = len(w) / SR
            times.append(el)
            durs.append(dur)
            sf.write(os.path.join(OUTDIR, "%s_run%d.wav" % (sid, run + 1)), w, SR)
            L("   run%d  音频 %5.2f s   合成 %6.2f s   RTF %5.2f" % (
                run + 1, dur, el, el / dur))
        times.sort()
        med = times[1]
        summary[sid] = dict(text=text, med=med, dur=durs[1], rtf=med / max(durs[1], 1e-6),
                            mn=times[0], mx=times[2])
        base = BASELINE.get(sid)
        extra = ("   基线 %.1f s → 提速 %.2fx" % (base, base / med)) if base else ""
        L("   → 中位 %.2f s（%.2f ~ %.2f）  RTF %.2f%s" % (
            med, times[0], times[2], med / durs[1], extra))
        L("")

    L("=" * 74)
    L("汇总（对照 = 未优化基线）")
    L("=" * 74)
    for sid, _ in SENTENCES:
        s = summary[sid]
        L("  %s  %.2f s  音频 %.2f s  RTF %.2f" % (sid, s["med"], s["dur"], s["rtf"]))
    L("")
    L("wav 已写入 results/cosyvoice-opt/（S#_run#.wav），可直接跑 analyze.py 做音色一致性分析")

    with open(os.path.join(HERE, "results", "probe-opt.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    with open(os.path.join(HERE, "results", "probe-opt.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(log))


if __name__ == "__main__":
    main()
