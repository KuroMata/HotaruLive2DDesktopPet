# -*- coding: utf-8 -*-
"""声库拼接最小原型：生成单字单位 → 归一化 → 拼出句子，让你直接听。

产出三组音频供对比：
  demo_raw/    只用裁好的原始单位硬拼（音质最好，但每字音高乱跳）
  demo_norm/   先做音高归一化再用交叉淡化拼（音高连续，经过 WORLD 声码器）
  demo_full/   同句子整句现合成（当前方案，作为质量上限参照）

用法： python tools/bench-tts/build-bank-prototype.py [单位数上限，默认 200]
"""
import os
import sys
import time
import json
import re

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
import pyworld as pw
from pypinyin import pinyin, Style

SR = 24000
ROOT = os.path.join(HERE, "results", "bank-proto")
for d in ("raw", "norm", "demo_raw", "demo_norm", "demo_full"):
    os.makedirs(os.path.join(ROOT, d), exist_ok=True)
REF_PATH = os.environ.get("COSYVOICE_REF", os.path.join(TTS, "ref", "prompt.wav"))
SEED = 42

# 演示句（这些字一定会被收进单位表）
DEMOS = [
    "你好呀",
    "欢迎回来",
    "今天天气不错",
    "我来念一段弹幕",
    "你的名字真有趣",
]

# 常用字（覆盖日常读音；单位按 拼音+声调 去重）
COMMON = "".join([
    "的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间知世什两次使身者被高已亲其进此话常与活正感光",
    "见明问力理尔点文白住字关才怎王全太巴机十民由本条平系月公水机票加山元气利合句信马走定让东西再向工更比安吃做叫意",
])

log = []


def L(s=""):
    print(s, flush=True)
    log.append(s)


# ---------------- 单位表 ----------------
def build_units(limit):
    chars = []
    for s in DEMOS:
        chars.extend(list(s))
    chars.extend([c for c in COMMON if "\u4e00" <= c <= "\u9fff"])
    seen, units = set(), []
    for ch in chars:
        py = pinyin(ch, style=Style.TONE3)
        if not py or not py[0][0]:
            continue
        base = py[0][0]
        m = re.match(r"^([a-z]+)([1-5])?$", base)
        if not m:
            continue
        key = (m.group(1), m.group(2) or "5")
        if key in seen:
            continue
        seen.add(key)
        units.append(dict(char=ch, py=m.group(1), tone=m.group(2) or "5",
                          key="%s%s" % (m.group(1), m.group(2) or "5")))
        if len(units) >= limit:
            break
    return units


# ---------------- 生成 ----------------
def synth_unit(cosy, ch, spk_id=None):
    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)
    out = []
    for chunk in cosy.inference_cross_lingual(tts_text=ch, prompt_wav=REF_PATH,
                                              zero_shot_spk_id=spk_id or "",
                                              stream=False, speed=1.0):
        out.append(chunk["tts_speech"])
    w = torch.cat(out, dim=-1)
    return w.squeeze(0).cpu().numpy().astype(np.float64)


# ---------------- 裁剪静音 ----------------
def trim(x, win=480, thr=0.02, margin=0.03):
    a = np.abs(x)
    if len(a) < win:
        return x
    env = np.convolve(a, np.ones(win) / win, mode="same")
    env = env / (env.max() + 1e-9)
    idx = np.where(env > thr)[0]
    if len(idx) == 0:
        return x
    s = max(0, idx[0] - int(margin * SR))
    e = min(len(x), idx[-1] + int(margin * SR))
    return x[s:e]


# ---------------- 音高归一化（保留声调轮廓，只做整体平移）----------------
def f0_median(x):
    f0, t = pw.harvest(x.astype(np.float64), SR, f0_floor=60.0, f0_ceil=400.0)
    v = f0[f0 > 0]
    return float(np.median(v)) if len(v) else 0.0


def pitch_shift(x, ratio):
    """WORLD：把 F0 整体乘 ratio，保留轮廓形状（声调）与时长"""
    x = x.astype(np.float64)
    f0, t = pw.harvest(x, SR, f0_floor=60.0, f0_ceil=400.0)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap = pw.d4c(x, f0, t, SR)
    f0 = f0 * ratio
    y = pw.synthesize(f0, sp, ap, SR)
    n = min(len(y), len(x))
    return y[:n]


# ---------------- 拼接 ----------------
def concat(units_wavs, fade=0.02):
    n_fade = int(fade * SR)
    out = units_wavs[0].copy()
    for w in units_wavs[1:]:
        if len(out) >= n_fade and len(w) >= n_fade:
            a = out[-n_fade:]
            b = w[:n_fade]
            mix = a * np.linspace(1, 0, n_fade) + b * np.linspace(0, 1, n_fade)
            out = np.concatenate([out[:-n_fade], mix, w[n_fade:]])
        else:
            out = np.concatenate([out, w])
    return out


def norm_peak(x, peak=0.9):
    m = np.max(np.abs(x)) + 1e-9
    return x / m * peak


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    from cosy_gen import load_cosy

    units = build_units(limit)
    L("=" * 74)
    L("声库拼接最小原型  %s   单位数 %d" % (time.strftime("%H:%M:%S"), len(units)))
    L("=" * 74)

    cosy = load_cosy()
    # 注册音色缓存：参考音频只编码一次，后续每单位省约 1 秒
    t0 = time.time()
    ok = cosy.add_zero_shot_spk("", REF_PATH, "bank")
    L("音色缓存注册: %.1f s (ok=%s)" % (time.time() - t0, ok))

    # ---- 1. 生成 + 裁剪 ----
    L("")
    L("-" * 74)
    L("1. 生成 %d 个单字单位（固定 seed=%d）" % (len(units), SEED))
    L("-" * 74)
    t_start = time.time()
    raw = {}
    f0s = []
    for i, u in enumerate(units):
        t0 = time.time()
        x = synth_unit(cosy, u["char"], spk_id="bank")
        el = time.time() - t0
        xt = trim(x)
        u["gen_s"] = el
        u["raw_dur"] = len(x) / SR
        u["dur"] = len(xt) / SR
        u["f0"] = f0_median(xt)
        if u["f0"] > 0:
            f0s.append(u["f0"])
        raw[u["key"]] = xt
        sf.write(os.path.join(ROOT, "raw", "%s.wav" % u["key"]), xt, SR)
        if (i + 1) % 20 == 0:
            L("  %3d/%d  最近 %s(%s) 生成 %.1fs  裁后 %.2fs  F0 %.0fHz  累计 %.1f 分钟" % (
                i + 1, len(units), u["char"], u["key"], el, u["dur"], u["f0"],
                (time.time() - t_start) / 60))
        del x, xt
        torch.cuda.empty_cache()
    gen_min = (time.time() - t_start) / 60
    L("")
    L("  生成总耗时 %.1f 分钟（平均 %.2f s/单位）" % (gen_min, np.mean([u["gen_s"] for u in units])))
    L("  裁后平均时长 %.2f s（原始 %.2f s → 裁掉 %.0f%% 的静音）" % (
        np.mean([u["dur"] for u in units]), np.mean([u["raw_dur"] for u in units]),
        100 * (1 - np.mean([u["dur"] for u in units]) / max(np.mean([u["raw_dur"] for u in units]), 1e-9))))
    L("  F0 分布：中位 %.0f Hz，跨单位 %.0f ~ %.0f Hz（跨度 %.1f 半音）" % (
        np.median(f0s), min(f0s), max(f0s), 12 * np.log2(max(f0s) / min(f0s))))

    # ---- 2. 音高归一化 ----
    L("")
    L("-" * 74)
    L("2. 音高归一化（整体平移到统一基准，保留声调轮廓）")
    L("-" * 74)
    target = float(np.median(f0s))
    norm = {}
    t0 = time.time()
    for u in units:
        xt = raw[u["key"]]
        if u["f0"] > 0 and abs(12 * np.log2(u["f0"] / target)) > 0.15:
            y = pitch_shift(xt, target / u["f0"])
        else:
            y = xt.copy()
        norm[u["key"]] = y
        sf.write(os.path.join(ROOT, "norm", "%s.wav" % u["key"]), y, SR)
    L("  目标 F0 %.0f Hz，处理 %d 个单位，用时 %.1f s" % (
        target, len(units), time.time() - t0))
    f0n = [f0_median(v) for v in norm.values()]
    f0n = [f for f in f0n if f > 0]
    L("  归一化后跨度 %.1f 半音（原 %.1f 半音）" % (
        12 * np.log2(max(f0n) / min(f0n)), 12 * np.log2(max(f0s) / min(f0s))))

    # ---- 3. 拼句子 ----
    L("")
    L("-" * 74)
    L("3. 拼接演示句")
    L("-" * 74)
    stats = {}
    for s in DEMOS:
        keys = []
        ok_all = True
        for ch in s:
            py = pinyin(ch, style=Style.TONE3)[0][0]
            m = re.match(r"^([a-z]+)([1-5])?$", py)
            k = "%s%s" % (m.group(1), m.group(2) or "5")
            if k not in raw:
                ok_all = False
                break
            keys.append(k)
        if not ok_all:
            L("  「%s」缺单位，跳过" % s)
            continue

        t0 = time.time()
        a = norm_peak(concat([raw[k] for k in keys]))
        t_raw = (time.time() - t0) * 1000
        sf.write(os.path.join(ROOT, "demo_raw", "%s.wav" % s), a, SR)

        t0 = time.time()
        b = norm_peak(concat([norm[k] for k in keys], fade=0.02))
        t_norm = (time.time() - t0) * 1000
        sf.write(os.path.join(ROOT, "demo_norm", "%s.wav" % s), b, SR)

        t0 = time.time()
        c = synth_unit(cosy, s, spk_id="bank")
        t_full = (time.time() - t0)
        c = norm_peak(trim(c))
        sf.write(os.path.join(ROOT, "demo_full", "%s.wav" % s), c, SR)

        stats[s] = dict(concat_raw_ms=t_raw, concat_norm_ms=t_norm, full_s=t_full,
                        dur_raw=len(a) / SR, dur_norm=len(b) / SR, dur_full=len(c) / SR)
        L("  「%s」  直拼 %.2fs（%.1fms）/ 归一化 %.2fs（%.1fms）/ 整句现合成 %.1fs 出 %.2fs" % (
            s, len(a) / SR, t_raw, len(b) / SR, t_norm, t_full, len(c) / SR))

    L("")
    L("=" * 74)
    L("完成。音频在：%s" % ROOT)
    L("  raw/        单个单位（原始，裁过静音）")
    L("  norm/       单个单位（音高归一化后）")
    L("  demo_raw/   硬拼结果 —— 音质最好，音高会跳")
    L("  demo_norm/  归一化+交叉淡化 —— 音高连续，经过 WORLD 声码器")
    L("  demo_full/  整句现合成 —— 质量上限参照")
    L("=" * 74)

    with open(os.path.join(ROOT, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(dict(units=[{k: v for k, v in u.items()} for u in units],
                       gen_min=gen_min, target_f0=target, demos=stats), f,
                  ensure_ascii=False, indent=2)
    with open(os.path.join(ROOT, "build.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(log))


if __name__ == "__main__":
    main()
