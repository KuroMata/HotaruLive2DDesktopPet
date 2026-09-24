# -*- coding: utf-8 -*-
"""CosyVoice 极速探针：把"一句要多久"拆到底，并回答一个具体问题——

    预生成那套筛选要求（多候选 + 伪影拒绝 + 语气评分 + 后处理）
    被带进实时路径后，到底拖慢了多少？

测四件事：
  A. 裸模型单次推理（cosy.inference_cross_lingual）——不含任何包装
  B. 流式首块延迟（stream=True 第一个 chunk 多久到）——决定"多久出声"
  C. 包装单项耗时（music_severity / tonal / prosody_score / 后处理）
  D. generate_best(max_candidates=1) 对照：包装总共加了多少

用法： python tools/bench-tts/probe-speed.py
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

TESTS = [
    ("XS", "嗯。"),
    ("S",  "来了来了，这就回你。"),
    ("M",  "你这问题问得好，不过我得先看一眼屏幕才知道你在说啥。"),
]

log_lines = []


def L(s=""):
    print(s, flush=True)
    log_lines.append(s)


def ms(t):
    return t * 1000.0


def main():
    L("=" * 74)
    L("CosyVoice 极速探针")
    L("=" * 74)
    L("GPU: " + torch.cuda.get_device_name(0))
    L("torch %s / cuda %s" % (torch.__version__, torch.version.cuda))
    L("TF32(matmul) 默认 = %s" % torch.backends.cuda.matmul.allow_tf32)
    L("")

    # ---------------- 加载 ----------------
    from cosy_gen import load_cosy, generate_best, _to_wav, SR as _SR
    from cosy_model import resolve_cosy_model
    from fix_cosy_issues import synth, clean_silence, tame_spike, normalize_loudness
    from fix_cosy_issues import has_tonal_artifact
    from regen_jp_v3 import music_severity, prosody_score

    MODEL = resolve_cosy_model()

    L("模型: %s" % MODEL)
    t0 = time.time()
    cosy = load_cosy()
    t_load = time.time() - t0
    L("模型加载: %.1f s" % t_load)
    L("加载后显存: 已用 %.2f GB / 空闲 %.2f GB" % (
        torch.cuda.memory_allocated() / 2**30,
        (torch.cuda.get_device_properties(0).total_memory - torch.cuda.memory_allocated()) / 2**30))
    L("")

    results = {}

    # ---------------- A. 裸模型推理（含一次预热）----------------
    L("-" * 74)
    L("A. 裸模型单次推理（synth = inference_cross_lingual, stream=False）")
    L("-" * 74)
    warm_text = "预热。"
    t0 = time.time()
    try:
        w = synth(cosy, warm_text, 1.0)
        L("  预热（首次含 CUDA kernel 编译）: %.1f s  音频 %.2f s" % (time.time() - t0, len(w[0]) / SR))
    except Exception as e:
        L("  预热失败: %r" % e)
    L("")

    resA = {}
    for tag, text in TESTS:
        times, durs = [], []
        for i in range(3):
            t0 = time.time()
            w = synth(cosy, text, 1.0)
            el = time.time() - t0
            times.append(el)
            durs.append(w.shape[-1] / SR)
            L("  %-3s run%d  音频 %5.2f s   推理 %6.1f s   RTF %5.2f" % (
                tag, i + 1, durs[-1], el, el / max(durs[-1], 1e-6)))
            del w
        times.sort()
        resA[tag] = dict(text=text, dur=durs[1], med=times[1], rtf=times[1] / durs[1],
                         mn=times[0], mx=times[2])
        L("  → %s 中位 %.1f s（%.1f ~ %.1f）  音频 %.2f s   RTF %.2f" % (
            tag, times[1], times[0], times[2], durs[1], times[1] / durs[1]))
        L("")
    results["A_bare"] = resA

    # ---------------- B. 流式首块延迟 ----------------
    L("-" * 74)
    L("B. 流式（stream=True）首块延迟 —— 决定「多久出第一个字」")
    L("-" * 74)
    resB = {}
    for tag, text in TESTS:
        try:
            t0 = time.time()
            first = None
            nchunk = 0
            total = 0.0
            for chunk in cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF_PATH,
                                                      stream=True, speed=1.0):
                n = chunk["tts_speech"].shape[-1] / SR
                total += n
                nchunk += 1
                if first is None:
                    first = (time.time() - t0, n)
            el = time.time() - t0
            resB[tag] = dict(first_latency=first[0], first_dur=first[1],
                             total=el, chunks=nchunk, audio=total)
            L("  %-3s 首块 %6.2f s（含 %.2f s 音频）  共 %d 块  总耗时 %6.2f s  音频 %5.2f s" % (
                tag, first[0], first[1], nchunk, el, total))
        except Exception as e:
            L("  %-3s 流式失败: %r" % (tag, e))
            resB[tag] = dict(err=repr(e))
    results["B_stream"] = resB
    L("")

    # ---------------- C. 包装单项耗时 ----------------
    L("-" * 74)
    L("C. 包装单项耗时（对同一段音频跑一遍筛选链）")
    L("-" * 74)
    wav = synth(cosy, TESTS[1][1], 1.0)
    w = wav.squeeze(0).cpu().numpy().astype(np.float32)
    w = w / (np.max(np.abs(w)) + 1e-9)
    del wav
    items = [
        ("music_severity", lambda: music_severity(w)),
        ("has_tonal_artifact", lambda: has_tonal_artifact(w, SR, thr=0.3)),
        ("prosody_score", lambda: prosody_score(w)),
        ("clean_silence", lambda: clean_silence(w)),
        ("tame_spike", lambda: tame_spike(w)),
        ("normalize_loudness", lambda: normalize_loudness(w)),
        ("empty_cache", lambda: torch.cuda.empty_cache()),
    ]
    resC = {}
    tot = 0.0
    for name, fn in items:
        t0 = time.time()
        try:
            fn()
        except Exception as e:
            L("  %-22s 失败 %r" % (name, e))
            continue
        el = time.time() - t0
        resC[name] = el
        tot += el
        L("  %-22s %8.1f ms" % (name, ms(el)))
    L("  %-22s %8.1f ms" % ("【合计】", ms(tot)))
    results["C_wrapper"] = resC
    L("")

    # ---------------- D. generate_best(candidates=1) 对照 ----------------
    L("-" * 74)
    L("D. generate_best 对照：多候选与筛选到底加了多少")
    L("-" * 74)
    resD = {}
    for tag, text in TESTS:
        for nc in (1, 2):
            t0 = time.time()
            try:
                w2, info = generate_best(cosy, text, max_candidates=nc, verbose=False,
                                         label=tag, lang="cn")
                el = time.time() - t0
                dur = len(w2) / SR
                base = resA[tag]["med"]
                resD["%s_c%d" % (tag, nc)] = dict(total=el, dur=dur, base=base,
                                                  overhead=el - base, n_clean=info.get("n_clean"))
                L("  %-3s candidates=%d  总 %6.1f s  = 裸推理 %.1f + 包装 %.1f s (%.0f%%)  音频 %.2f s  clean=%s" % (
                    tag, nc, el, base, el - base, 100.0 * (el - base) / max(el, 1e-6),
                    dur, info.get("n_clean")))
            except Exception as e:
                L("  %-3s candidates=%d 失败 %r" % (tag, nc, e))
    results["D_generate_best"] = resD
    L("")

    # ---------------- E. TF32 加速 ----------------
    L("-" * 74)
    L("E. 打开 TF32（Ampere 的 matmul 加速）后复测")
    L("-" * 74)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    resE = {}
    for tag, text in TESTS:
        times, durs = [], []
        for i in range(2):
            t0 = time.time()
            w = synth(cosy, text, 1.0)
            el = time.time() - t0
            times.append(el)
            durs.append(w.shape[-1] / SR)
            del w
        base = resA[tag]["med"]
        resE[tag] = dict(med=times[-1], base=base, speedup=base / max(times[-1], 1e-6))
        L("  %-3s %.1f s（TF32 前 %.1f s）  加速 %.2fx" % (tag, times[-1], base, base / times[-1]))
    results["E_tf32"] = resE
    L("")

    # ---------------- F. 音色缓存（add_zero_shot_spk）----------------
    L("-" * 74)
    L("F. 音色缓存：一次性注册说话人，之后每句跳过参考音频编码")
    L("-" * 74)
    try:
        import soundfile as sf
        ri = sf.info(REF_PATH)
        L("  参考音频: %s  %.2f s  %d Hz" % (os.path.basename(REF_PATH), ri.duration, ri.samplerate))
    except Exception as e:
        L("  参考音频信息读不到: %r" % e)

    resF, resF_stream = {}, {}
    try:
        t0 = time.time()
        ok = cosy.add_zero_shot_spk("", REF_PATH, "hotaru")
        t_reg = time.time() - t0
        L("  add_zero_shot_spk 注册耗时: %.1f s  (ok=%s)" % (t_reg, ok))
        L("")

        def synth_cached(text, sp=1.0):
            out = []
            for chunk in cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF_PATH,
                                                      zero_shot_spk_id="hotaru",
                                                      stream=False, speed=sp):
                out.append(chunk["tts_speech"])
            return torch.cat(out, dim=-1)

        for tag, text in TESTS:
            times, durs = [], []
            for i in range(3):
                t0 = time.time()
                w = synth_cached(text, 1.0)
                el = time.time() - t0
                times.append(el)
                durs.append(w.shape[-1] / SR)
                del w
            times.sort()
            base = resA[tag]["med"]
            resF[tag] = dict(med=times[1], dur=durs[1], rtf=times[1] / durs[1],
                             base=base, speedup=base / max(times[1], 1e-9), register=t_reg)
            L("  %-3s 缓存后 %6.2f s（缓存前 %.1f s）  加速 %5.1fx  音频 %.2f s  RTF %.3f" % (
                tag, times[1], base, base / times[1], durs[1], times[1] / durs[1]))
        L("")
        L("  缓存模式 + stream=True 的首块延迟：")
        for tag, text in TESTS:
            t0 = time.time()
            first = None
            total = 0.0
            n = 0
            for chunk in cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF_PATH,
                                                      zero_shot_spk_id="hotaru",
                                                      stream=True, speed=1.0):
                d = chunk["tts_speech"].shape[-1] / SR
                total += d
                n += 1
                if first is None:
                    first = (time.time() - t0, d)
            el = time.time() - t0
            resF_stream[tag] = dict(first=first[0], first_dur=first[1], total=el,
                                    chunks=n, audio=total)
            L("    %-3s 首块 %6.3f s（含 %.2f s 音频）  共 %d 块  总 %.2f s" % (
                tag, first[0], first[1], n, el))
    except Exception as e:
        L("  音色缓存失败: %r" % e)
    results["F_spkcache"] = resF
    results["F_stream"] = resF_stream
    L("")

    # ---------------- 汇总 ----------------
    L("=" * 74)
    L("汇总")
    L("=" * 74)
    for tag, text in TESTS:
        a = resA[tag]
        L("  %-3s 「%s」" % (tag, text[:20]))
        L("      裸推理中位 %.1f s / 音频 %.2f s → RTF %.2f" % (a["med"], a["dur"], a["rtf"]))
        if tag in resB and "first_latency" in resB[tag]:
            L("      流式首块 %.2f s（出第一个字的等待）" % resB[tag]["first_latency"])
        for nc in (1, 2):
            k = "%s_c%d" % (tag, nc)
            if k in resD:
                L("      generate_best(c=%d) %.1f s  包装占比 %.0f%%" % (
                    nc, resD[k]["total"], 100.0 * resD[k]["overhead"] / resD[k]["total"]))
        if tag in resE:
            L("      TF32 后 %.1f s（%.2fx）" % (resE[tag]["med"], resE[tag]["speedup"]))
        if tag in resF:
            L("      ★ 音色缓存后 %.2f s（%.1fx）  RTF %.3f" % (
                resF[tag]["med"], resF[tag]["speedup"], resF[tag]["rtf"]))
            if tag in resF_stream and "first" in resF_stream[tag]:
                L("      ★ 缓存+流式 首块 %.3f s" % resF_stream[tag]["first"])
        L("")

    with open(os.path.join(OUT, "probe-speed.json"), "w", encoding="utf-8") as f:
        json.dump(dict(model=str(MODEL), load=t_load, results=results), f,
                  ensure_ascii=False, indent=2)
    with open(os.path.join(OUT, "probe-speed.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
    L("已写 results/probe-speed.json 与 results/probe-speed.log")


REF_PATH = os.environ.get("COSYVOICE_REF", os.path.join(TTS, "ref", "prompt.wav"))

if __name__ == "__main__":
    main()
