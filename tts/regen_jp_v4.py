# -*- coding: utf-8 -*-
"""日语修复 v4 —— 在 v3 基础上解决「CosyVoice 跨语种偶发长时幻觉(跑飞)」：
  * v3 已修好: 语速折中(1.0~1.12)、音乐/哼鸣伪影硬拒绝、兴奋双端惩罚。
  * v4 新增:
      1) 自适应时长上限 cap = (字数/5)/speed + 1.5 的 2.3 倍；超过即判为跑飞，硬拒绝
         (不再像 v3 那样「全员都长」时只能选最不烂的 22s 垃圾)。
      2) 早停: 只要拿到一个「无音乐 + 时长达标」的候选即收手，避免无谓地烧时间。
      3) 兜底提速: 若主速度带(1.0/1.06/1.12)全跑飞，再试 1.18/1.24 逃生
         (仅对个别怎么都渲染不好的句子，比 22s 垃圾强；会记日志提示)。
      4) 只重渲染「现有文件不达标」的句子，已达标的(click_0/1/3 等)原样保留。
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
ONLY = os.environ.get("COSY_ONLY", "")
only_set = set()
if ONLY:
    for pair in ONLY.split():
        p, i = pair.split(",")
        only_set.add((p, int(i)))

for p in (HERE, COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)

import pyworld

_ns = "torch.nn.attention.flex_attention"
if _ns not in sys.modules and not hasattr(torch.nn.attention, "flex_attention"):
    m = types.ModuleType(_ns)
    m.flex_attention = lambda *a, **k: (_ for _ in ()).throw(NotImplementedError("stub"))
    sys.modules[_ns] = m
    torch.nn.attention.flex_attention = m  # type: ignore

SR = 24000
GATE_DB = -45.0
THR = 10 ** (GATE_DB / 20.0)
SP_PRIMARY = [1.0, 1.06, 1.12]
SP_FALLBACK = [1.18, 1.24]
MAX_TRIES = 24
# 个别句子跨语种偶发持续跑飞(>20s 循环)。根因是文本偏长 -> LM 步数多 -> 易跑飞。
# 改写为明显更短的句子可大幅提升干净样本命中率。仅作 TTS 试听文本(不写入角色 config)，
# 语义贴近原意(水温已提前调好，无需担心)。
REWORD = {
    ("click", 2): "水温、調整しておきました。ご心配なく。",
}

from fix_cosy_issues import (clean_silence, tame_spike, peak_median_ratio,
                             speech_only_ratio, synth, _patch_flex, normalize_loudness)
from make_audition_kouhai_cosyvoice import JP
from regen_jp_v3 import music_severity, prosody_score, f0_stats


def expected_cap(text, speed):
    n = len(text)
    base = (n / 5.0) / speed + 1.5
    return base * 2.3


def is_ok(wav, text, speed):
    """已达标的判定: 无音乐、时长不跑飞、语气不莫名兴奋。"""
    if music_severity(wav) > 0:
        return False
    dur = len(wav) / SR
    if dur > expected_cap(text, speed) or dur > 13.0:
        return False
    cv, exc, med, mx = f0_stats(wav)
    if exc > 2.6 or (peak_median_ratio(wav) > 6 and speech_only_ratio(wav) > 3.0):
        return False
    return True


def duration_of(wav):
    return len(wav) / SR


def gather(cosy, text, label):
    """对一句文本采样候选，返回 (clean列表, shortest元组)。
    clean: (score, wav, cv, exc, pmr, sor, dur, sp)；shortest: (dur, wav, sp)。"""
    clean = []
    shortest = None
    speeds = SP_PRIMARY + SP_FALLBACK
    si = 0
    tries = 0
    while tries < MAX_TRIES:
        sp = speeds[si % len(speeds)]
        si += 1
        sp_tensor = synth(cosy, text, sp)
        wav = sp_tensor.squeeze(0).cpu().numpy().astype(np.float32)
        wav = wav / (np.max(np.abs(wav)) + 1e-9)
        dur = duration_of(wav)
        music = music_severity(wav)
        cap = expected_cap(text, sp)
        tag = "music!" if music > 0 else ("RUN!" if dur > cap or dur > 13.0 else "ok")
        score, cv, exc, pmr, sor, _ = prosody_score(wav)
        print("  %s try%d sp=%.2f %s cv=%.3f exc=%.2f dur=%.1f cap=%.1f"
              % (label, tries, sp, tag, cv, exc, dur, cap))
        if shortest is None or dur < shortest[0]:
            shortest = (dur, wav, sp)
        if music <= 0 and dur <= cap and dur <= 13.0:
            clean.append((score, wav, cv, exc, pmr, sor, dur, sp))
            if len(clean) >= 6:
                break
        tries += 1
    return clean, shortest


def main():
    _patch_flex()
    from cosyvoice.cli.cosyvoice import CosyVoice2
    cosy = CosyVoice2(MODEL, load_jit=False, load_trt=False, fp16=FP16)
    print(">> model loaded  v4")

    JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")
    for (pool, idx), text in sorted(JP.items()):
        if only_set and (pool, idx) not in only_set:
            continue
        out_path = os.path.join(JP_OUT, "%s_%d.wav" % (pool, idx))
        label = os.path.basename(out_path)
        # 全部重渲染到折中速度带(用户反馈整体提速过高)；不再保留旧的高 speed 文件。
        clean, shortest = gather(cosy, text, label)
        if not clean and (pool, idx) in REWORD:
            print("  %s 原句全跑飞，改用改写句重试" % label)
            clean, shortest = gather(cosy, REWORD[(pool, idx)], label + "(改写)")

        if clean:
            clean.sort(key=lambda c: c[0], reverse=True)
            _, wav, cv, exc, pmr, sor, dur, sp = clean[0]
            print("  %s 选用 speed=%.2f cv=%.3f exc=%.2f 时长=%.1fs" % (label, sp, cv, exc, dur))
        else:
            # 全跑飞: 取最短兜底(仍可能偏长，记日志提示)
            dur, wav, sp = shortest
            print("  %s 警告: 全部候选跑飞，退选最短(%.1fs) speed=%.2f" % (label, dur, sp))

        if sor > 2.4 or pmr > 3.5:
            wav = tame_spike(wav)
            print("  %s 触发软限幅" % label)
        cleaned = clean_silence(wav)
        cleaned = normalize_loudness(cleaned)   # 统一响度到目标 LUFS，消除不一致
        sf.write(out_path, cleaned, SR)
        print(">> %s 已写 时长=%.1fs" % (label, len(cleaned) / SR))


if __name__ == "__main__":
    main()
