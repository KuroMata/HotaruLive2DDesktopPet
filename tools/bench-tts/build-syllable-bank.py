# -*- coding: utf-8 -*-
"""声库拼接 · 音节库构建器（L2 层素材）

读取语料(默认内置常见语料 / 或传 corpus.txt) → 取每个字的带调拼音(TONE3) → 去重得音节表
→ 对每个音节用 CosyVoice 零样本克隆音色合成一个"单位"(固定 seed=42 确定性)
→ 裁静音 → 音高归一化到全局中位 F0(让拼接更顺) → 存 24k mono wav + manifest.json。

产物: results/syllable-bank/{units/<pinyin>.wav, manifest.json, build.log}
运行时拼接器 speak-bank.py 直接消费这套库。

用法:
  python build-syllable-bank.py            # 用内置默认语料
  python build-syllable-bank.py corpus.txt # 用指定语料
"""
import os
import sys
import time
import json
import re

sys.path.insert(0, "D:/cosyvoice_src")
sys.path.insert(0, "D:/live2d-companion/tts")

import numpy as np
import torch
import soundfile as sf
import librosa
import pyworld as pw
from pypinyin import pinyin, Style
from cosy_gen import load_cosy

SR = 24000
REF = "D:/live2d-companion/tts/ref/prompt.wav"
# 孤立单字合成自带约 1.3s 默认停顿/拖尾，拼出来会爆长(5x)。
# 时长归一化：把每个单位压到目标音节时长，使整句长度接近自然语流。
TARGET_SYL = 0.40  # 秒/字（自然语流约 0.24~0.30，取 0.40 留一点机械感余量）
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "syllable-bank")
UNITS = os.path.join(ROOT, "units")
os.makedirs(UNITS, exist_ok=True)

# 默认语料：覆盖常见聊天/桌宠场景音节，尽量广以便运行时少触发 L3 兜底
DEFAULT_CORPUS = (
    "嗨嗨主子大人今天心情不错哦要不我们一起来个桌面整理小挑战吧早上好晚上好在吗谢谢再见"
    "什么怎么为什么可以宝贝乖玩电脑干活聊天吃饭喝水休息加油喜欢开心难过生气害怕朋友时间"
    "现在开始结束打开关闭你好吗今天天气怎么样我们一起是不是真的当然好呀没问题主人喂你说"
    "谁呀累了困了饿了对了看看这个那个它们它也都在哪儿哪里怎样才能如果因为所以但是而且"
    "时候年月份号点分秒钟话事东西上面下面前面后面左边右边中间外面里面出来进去走过"
    "听说明白知道想起忘记记住学会做想睡觉唱歌音乐电影书工作学习玩闹笑哭安静热闹"
)


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


def main():
    corpus = DEFAULT_CORPUS
    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        with open(sys.argv[1], encoding="utf-8") as f:
            corpus = f.read()

    # 收集 音节(pinyin) -> 代表字(语料里第一个读该音节的字)
    rep = {}
    for ch in corpus:
        if not re.match(r"[\u4e00-\u9fff]", ch):
            continue
        ps = toned(ch)
        if not ps:
            continue
        p = ps[0]
        if p not in rep:
            rep[p] = ch

    print("unique syllables=%d" % len(rep), flush=True)
    cosy = load_cosy()
    cosy.add_zero_shot_spk("", REF, "bank")

    raw = {}
    t0 = time.time()
    for p, ch in rep.items():
        torch.manual_seed(42)  # 确定性：同音节同素材
        wavs = []
        for c in cosy.inference_cross_lingual(
            tts_text=ch, prompt_wav=REF,
            zero_shot_spk_id="bank", stream=False, speed=1.0,
        ):
            wavs.append(c["tts_speech"])
        w = torch.cat(wavs, dim=-1).squeeze(0).cpu().numpy().astype(np.float32)
        raw[p] = trim(w)
        print("  synth %-5s (%s) %.2fs" % (p, ch, len(w) / SR), flush=True)

    medians = [f0_median(x) for x in raw.values() if f0_median(x) > 0]
    target = float(np.median(medians)) if medians else 0.0
    print("target F0=%.1f  build=%.1fs" % (target, time.time() - t0), flush=True)

    manifest = {"target_f0": round(target, 2), "sr": SR, "units": {}}
    for p, x in raw.items():
        f = f0_median(x)
        if f > 0 and abs(12 * np.log2(f / target)) > 0.15:
            x = pitch_shift(x, target / f)
        # 时长归一化：孤立单字自带 ~1.3s 停顿，压到目标音节时长(保音高)
        dur = len(x) / SR
        rate = dur / TARGET_SYL
        if rate > 1.15:  # 仅在明显偏长时压，避免不必要的相位损伤
            x = librosa.effects.time_stretch(x.astype(np.float32), rate=rate)
        x = (x / (np.max(np.abs(x)) + 1e-9) * 0.9).astype(np.float32)
        sf.write(os.path.join(UNITS, "%s.wav" % p), x, SR)
        manifest["units"][p] = dict(
            char=rep[p], f0=round(float(f0_median(x)), 2),
            dur=round(len(x) / SR, 3), path="units/%s.wav" % p,
        )

    with open(os.path.join(ROOT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("BANK_BUILT units=%d -> %s" % (len(manifest["units"]), ROOT), flush=True)


if __name__ == "__main__":
    main()
