# -*- coding: utf-8 -*-
"""声库拼接 · 运行时拼接器（三层架构）

L1 短语缓存：整句文本精确命中 -> 直接出整句音频(0ms, 自然)
L2 音节库  ：逐字查预切音节单位 -> 交叉淡化拼接(≈0ms, 机械但快)
L3 现合成  ：音节库缺失 -> CosyVoice 现合成该音节并回填库(仅首次慢, 之后 0ms)

直接给文本即可"开口"；--ollama 拉本地 Ollama 回复来合成；--ab 同时出声库版与现合成版做 A/B。
拼接耗时(排除模型加载)单独计量，用于证明"零延迟" claims。

用法:
  python speak-bank.py "要说的文本"
  python speak-bank.py --ollama "向萤提的问题"
  python speak-bank.py --ab "要对比的文本"
"""
import os
import sys
import time
import json
import re
import argparse

sys.path.insert(0, "D:/cosyvoice_src")
sys.path.insert(0, "D:/live2d-companion/tts")

import numpy as np
import torch
import soundfile as sf
import pyworld as pw
from pypinyin import pinyin, Style
from cosy_gen import load_cosy

SR = 24000
REF = "D:/live2d-companion/tts/ref/prompt.wav"
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5:7b-instruct-q4_K_M"
SYSTEM = (
    "你是黑叶萤，一只住在电脑桌面上的 Live2D 猫娘桌面宠物，性格随和、有点毒舌但很可靠，"
    "会陪主人干活、聊天。请用自然简短的口语中文回复，控制在 2 到 3 句话，不要列表、不要长篇大论。"
)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "syllable-bank")
UNITS = os.path.join(ROOT, "units")
PHRASES = os.path.join(ROOT, "phrases")
os.makedirs(PHRASES, exist_ok=True)

_cosy_inst = None


def cosy():
    global _cosy_inst
    if _cosy_inst is None:
        _cosy_inst = load_cosy()
        _cosy_inst.add_zero_shot_spk("", REF, "bank")
    return _cosy_inst


def f0_median(x):
    f0, _ = pw.harvest(x.astype(np.float64), SR, f0_floor=60.0, f0_ceil=400.0)
    v = f0[f0 > 0]
    return float(np.median(v)) if len(v) else 0.0


def pitch_shift(x, ratio):
    x = x.astype(np.float64)
    f0, t = pw.harvest(x, SR, f0_floor=60.0, f0_ceil=400.0)
    sp = pw.cheaptrick(x, f0, t, SR)
    ap = pw.d4c(x, f0, t, SR)
    y = pw.synthesize(f0 * ratio, sp, ap, SR)
    n = min(len(y), len(x))
    return y[:n]


def trim(x, win=480, thr=0.02, margin=0.02):
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


def toned(text):
    return [w[0] for w in pinyin(text, style=Style.TONE3, heteronym=False, errors="ignore")]


def load_manifest():
    mp = os.path.join(ROOT, "manifest.json")
    if not os.path.exists(mp):
        return None
    with open(mp, encoding="utf-8") as f:
        return json.load(f)


def concat_fade(units, fade=0.02):
    if not units:
        return np.zeros(0, dtype=np.float32)
    n = int(fade * SR)
    out = units[0].astype(np.float32).copy()
    for w in units[1:]:
        w = w.astype(np.float32)
        if len(out) >= n and len(w) >= n:
            a = out[-n:]
            b = w[:n]
            mix = a * np.linspace(1, 0, n) + b * np.linspace(0, 1, n)
            out = np.concatenate([out[:-n], mix, w[n:]])
        else:
            out = np.concatenate([out, w])
    return out


def live_synth(text):
    torch.manual_seed(42)
    wavs = []
    for c in cosy().inference_cross_lingual(
        tts_text=text, prompt_wav=REF,
        zero_shot_spk_id="bank", stream=False, speed=1.0,
    ):
        wavs.append(c["tts_speech"])
    return torch.cat(wavs, dim=-1).squeeze(0).cpu().numpy().astype(np.float32)


def synth_missing_and_cache(p, ch, manifest):
    """L3：现合成缺失音节，音高归一化后回填音节库 + manifest。"""
    w = trim(live_synth(ch))
    if manifest:
        tgt = manifest.get("target_f0", 0.0)
        f = f0_median(w)
        if tgt > 0 and f > 0 and abs(12 * np.log2(f / tgt)) > 0.15:
            w = pitch_shift(w, tgt / f)
    w = (w / (np.max(np.abs(w)) + 1e-9) * 0.9).astype(np.float32)
    sf.write(os.path.join(UNITS, "%s.wav" % p), w, SR)
    if manifest:
        manifest.setdefault("units", {})[p] = dict(
            char=ch, f0=round(float(f0_median(w)), 2),
            dur=round(len(w) / SR, 3), path="units/%s.wav" % p,
        )
        with open(os.path.join(ROOT, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    return w


def speak(text, manifest, allow_live=True):
    """返回 (wav, tag, elapsed_sec)。elapsed 为纯拼接耗时(含 L3 兜底), 排除模型首次加载。"""
    t0 = time.time()
    h = hash(text)
    ph = os.path.join(PHRASES, "%d.wav" % h)
    if os.path.exists(ph):  # L1
        w, _ = sf.read(ph)
        return w.astype(np.float32), "L1_phrase_cache", time.time() - t0

    units = []
    used_live = 0
    for ch in text:
        if not re.match(r"[\u4e00-\u9fff]", ch):
            if re.match(r"[\s，。！？!?；;、,.]", ch):
                units.append(np.zeros(int(0.12 * SR), dtype=np.float32))  # 标点/空格停顿
            continue
        ps = toned(ch)
        p = ps[0] if ps else None
        if p and manifest and p in manifest.get("units", {}):
            w, _ = sf.read(os.path.join(ROOT, manifest["units"][p]["path"]))
            units.append(w)
        elif allow_live and p:
            ch2 = (manifest.get("units", {}).get(p, {}).get("char")) or ch
            units.append(synth_missing_and_cache(p, ch2, manifest))
            used_live += 1
        # 既无库又禁止现合成：静默跳过该字

    out = concat_fade(units)
    m = np.max(np.abs(out)) + 1e-9
    out = (out / m * 0.9).astype(np.float32)
    sf.write(ph, out, SR)  # 回填 L1，下次同句 0ms 自然
    tag = "L2_bank" if used_live == 0 else "L2_bank+L3_live(%d)" % used_live
    return out, tag, time.time() - t0


def ollama_reply(prompt):
    import urllib.request
    payload = json.dumps({
        "model": MODEL, "prompt": prompt, "system": SYSTEM,
        "stream": False, "options": {"temperature": 0.8},
    }).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data.get("response", ""), time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="*", help="要说的文本")
    ap.add_argument("--ollama", help="改为向 Ollama 提这个问题并合成其回复")
    ap.add_argument("--ab", action="store_true", help="同时出声库版与现合成版做 A/B")
    args = ap.parse_args()

    manifest = load_manifest()
    if manifest is None:
        print("ERROR: 没找到音节库 manifest.json，请先跑 build-syllable-bank.py", flush=True)
        return

    if args.ollama:
        reply, gt = ollama_reply(args.ollama)
        print("OLLAMA_REPLY (%.2fs): %s" % (gt, reply), flush=True)
        text = reply
    else:
        text = "".join(args.text)
        if not text:
            text = "嗨嗨，主子大人，今天心情不错哦。"
    print("TEXT: %s" % text, flush=True)

    w_bank, tag, el = speak(text, manifest, allow_live=True)
    print("BANK  -> tag=%s  splice=%.3fs  audio=%.2fs" % (tag, el, len(w_bank) / SR), flush=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    bp = os.path.join(ROOT, "speak_bank_%s.wav" % ts)
    sf.write(bp, w_bank, SR)

    if args.ab:
        t0 = time.time()
        w_live = live_synth(text)
        live_t = time.time() - t0
        print("LIVE  -> synth=%.2fs  audio=%.2fs" % (live_t, len(w_live) / SR), flush=True)
        lp = os.path.join(ROOT, "speak_live_%s.wav" % ts)
        sf.write(lp, w_live, SR)
        print("SAVED bank=%s\nSAVED live=%s" % (bp, lp), flush=True)
        # 延迟对照写文件
        with open(os.path.join(ROOT, "ab_%s.txt" % ts), "w", encoding="utf-8") as f:
            f.write(
                "TEXT: %s\n\nBANK tag=%s  splice=%.3fs  audio=%.2fs\n"
                "LIVE synth=%.2fs  audio=%.2fs\n" % (
                    text, tag, el, len(w_bank) / SR, live_t, len(w_live) / SR)
            )
    else:
        print("SAVED %s" % bp, flush=True)


if __name__ == "__main__":
    main()
