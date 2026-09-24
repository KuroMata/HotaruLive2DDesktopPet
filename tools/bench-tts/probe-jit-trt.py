# -*- coding: utf-8 -*-
"""CosyVoice JIT / TRT 加速选项实测。

只回答一个问题：load_jit=True 和 load_trt=True 分别能让一句话快多少？

流程：
  1. 基线：load_jit=False, load_trt=False, fp16=True —— 预热后每句跑 3 次取中位
  2. JIT：load_jit=True（flow.encoder.fp16.zip，模型目录已带）
  3. TRT：load_trt=True（首次会从 fp32 onnx 现场构建 fp16 plan，可能要几分钟）

用法： python tools/bench-tts/probe-jit-trt.py [jit|trt|both]   # 默认 both
"""
import os
import sys
import time
import json
import gc

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(os.path.dirname(HERE))
TTS = os.path.join(PROJ, "tts")
for p in (TTS, os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src"),
          os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")):
    if p not in sys.path:
        sys.path.insert(0, p)

import torch

SR = 24000
OUT = os.path.join(HERE, "results")
os.makedirs(OUT, exist_ok=True)

TESTS = [
    ("S", "来了来了，这就回你。"),
    ("M", "你这问题问得好，不过我得先看一眼屏幕才知道你在说啥。"),
]
REF_PATH = os.environ.get("COSYVOICE_REF", os.path.join(TTS, "ref", "prompt.wav"))

log_lines = []


def L(s=""):
    print(s, flush=True)
    log_lines.append(s)


def bench(cosy, warm_text="预热。", n_run=3):
    """返回 {tag: {med, dur, rtf}}"""
    # 预热（含 CUDA kernel 编译）
    t0 = time.time()
    out = []
    for chunk in cosy.inference_cross_lingual(tts_text=warm_text, prompt_wav=REF_PATH,
                                              stream=False, speed=1.0):
        out.append(chunk["tts_speech"])
    w = torch.cat(out, dim=-1)
    L("  预热: %.1f s（含首次 kernel 编译）" % (time.time() - t0))
    del out, w
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    res = {}
    for tag, text in TESTS:
        times, durs = [], []
        for i in range(n_run):
            t0 = time.time()
            out = []
            for chunk in cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF_PATH,
                                                      stream=False, speed=1.0):
                out.append(chunk["tts_speech"])
            el = time.time() - t0
            w = torch.cat(out, dim=-1)
            d = w.shape[-1] / SR
            times.append(el)
            durs.append(d)
            del out, w
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        times.sort()
        res[tag] = dict(text=text, dur=durs[1], med=times[1], rtf=times[1] / durs[1],
                        mn=times[0], mx=times[2])
        L("  %-2s 中位 %.2f s（%.2f ~ %.2f）  音频 %.2f s  RTF %.2f" % (
            tag, times[1], times[0], times[2], durs[1], times[1] / durs[1]))
    return res


def load(load_jit, load_trt):
    from cosy_model import resolve_cosy_model
    from cosyvoice.cli.cosyvoice import CosyVoice2
    model = resolve_cosy_model()
    gc.collect()
    torch.cuda.empty_cache()
    t0 = time.time()
    cosy = CosyVoice2(model, load_jit=load_jit, load_trt=load_trt, fp16=True)
    t = time.time() - t0
    L("  模型加载: %.1f s   显存 allocated %.2f GB" % (
        t, torch.cuda.memory_allocated() / 2**30))
    return cosy, t


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    L("=" * 74)
    L("CosyVoice JIT / TRT 加速实测  %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    L("=" * 74)
    L("GPU: %s  torch %s / cuda %s" % (
        torch.cuda.get_device_name(0), torch.__version__, torch.version.cuda))
    L("nvidia-smi 记账: ")
    os.system("nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader")
    L("")

    results = {}

    def run_stage(name, jit, trt):
        L("-" * 74)
        L("%s（load_jit=%s, load_trt=%s, fp16=True）" % (name, jit, trt))
        L("-" * 74)
        cosy, t_load = load(jit, trt)
        res = bench(cosy)
        res["_load"] = t_load
        results[name] = res
        L("")
        del cosy
        gc.collect()
        torch.cuda.empty_cache()
        return res

    run_stage("baseline", False, False)

    if which in ("jit", "both"):
        try:
            run_stage("jit", True, False)
        except Exception as e:
            L("JIT 阶段失败: %r" % e)
            results["jit"] = {"err": repr(e)}

    if which in ("trt", "both"):
        try:
            L("(TRT 首次会把 fp32 onnx 构建成 fp16 plan，可能需要几分钟……)")
            run_stage("trt", False, True)
        except Exception as e:
            L("TRT 阶段失败: %r" % e)
            results["trt"] = {"err": repr(e)}

    # 汇总
    L("=" * 74)
    L("汇总（中位耗时 / RTF，加速比 = 基线 / 本项）")
    L("=" * 74)
    for tag, text in TESTS:
        b = results.get("baseline", {}).get(tag)
        if not b:
            continue
        L("「%s」 音频 %.2f s" % (text[:24], b["dur"]))
        for name in ("baseline", "jit", "trt"):
            r = results.get(name, {}).get(tag)
            if r and "med" in r:
                L("  %-9s %6.2f s  RTF %.2f  %s" % (
                    name, r["med"], r["rtf"],
                    ("加速 %.2fx" % (b["med"] / r["med"])) if name != "baseline" else "（基线）"))
        L("")

    with open(os.path.join(OUT, "probe-jit-trt.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT, "probe-jit-trt.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
    L("已写 results/probe-jit-trt.json / .log")


if __name__ == "__main__":
    main()
