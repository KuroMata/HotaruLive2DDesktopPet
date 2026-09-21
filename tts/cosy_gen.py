# -*- coding: utf-8 -*-
"""统一 CosyVoice 生成模块：预生成脚本与运行时引擎共用。

流程：多候选(速度网格) -> 伪影硬拒绝(音乐/死平 / 挂断音·纯音·双音·低频嗡鸣) ->
语气评分(棒读太平 / 兴奋拔高 / 音高稳定) -> 后处理(去静音 / 软限幅 / 响度归一 -16 LUFS)。
中/日均走 inference_cross_lingual（CosyVoice2 零样本克隆，一份 prompt.wav 出双语言）。
"""
import os
import sys
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src")
EXTRA = os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")
REF = os.environ.get("COSYVOICE_REF", os.path.join(HERE, "ref", "prompt.wav"))
from cosy_model import resolve_cosy_model
MODEL = resolve_cosy_model()
FP16 = os.environ.get("COSYVOICE_FP16", "1") not in ("0", "false", "False")
SR = 24000

for p in (HERE, COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)

from fix_cosy_issues import (synth, clean_silence, tame_spike, normalize_loudness,
                              peak_median_ratio, speech_only_ratio, _patch_flex,
                              has_tonal_artifact)
from regen_jp_v3 import music_severity, prosody_score, f0_stats, PITCH_CEIL

DEFAULT_SPEED_PRIMARY = (1.0, 1.06, 1.12)
DEFAULT_SPEED_FALLBACK = (1.18, 1.24)


def load_cosy():
    _patch_flex()
    from cosyvoice.cli.cosyvoice import CosyVoice2
    return CosyVoice2(MODEL, load_jit=False, load_trt=False, fp16=FP16)


def _to_wav(cosy, text, sp):
    t = synth(cosy, text, sp)
    w = t.squeeze(0).cpu().numpy().astype(np.float32)
    del t
    w = w / (np.max(np.abs(w)) + 1e-9)
    # 每次合成后释放显存，避免多候选循环下 VRAM 堆积导致 RTF 暴涨(1.5->17)进而卡死。
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return w


def expected_cap(text, sp):
    n = len(text)
    return ((n / 5.0) / sp + 1.5) * 2.3


def generate_best(cosy, text, max_candidates=8,
                   speed_primary=DEFAULT_SPEED_PRIMARY,
                   speed_fallback=DEFAULT_SPEED_FALLBACK,
                   verbose=True, label="", lang="jp"):
    """多候选择优 + 伪影拒绝 + 后处理。返回 (wav_float32, info_dict)。

    max_candidates 控制质量/延迟权衡：预生成用 8（充分选优）；聊天实时用 1~2（快）。
    """
    clean = []
    shortest = None
    speeds = list(speed_primary) + list(speed_fallback)
    si = 0
    for tries in range(max_candidates):
        sp = speeds[si % len(speeds)]
        si += 1
        try:
            w = _to_wav(cosy, text, sp)
        except Exception as e:
            if verbose:
                print("  %s synth err: %s" % (label, e))
            continue
        music = music_severity(w)
        tonal = has_tonal_artifact(w, SR, thr=0.3)
        dur = len(w) / SR
        cap = expected_cap(text, sp)
        score, cv, exc, pmr, sor, d = prosody_score(w)
        if shortest is None or dur < shortest[0]:
            shortest = (dur, w, sp)
        if music <= 0 and not tonal and dur <= cap and dur <= 13.0:
            clean.append((score, w, cv, exc, pmr, sor, dur, sp))
            if len(clean) >= 6:
                break
        if verbose:
            tag = "music!" if music > 0 else ("tonal!" if tonal else ("RUN!" if (dur > cap or dur > 13.0) else "ok"))
            print("  %s try%d sp=%.2f %s cv=%.3f exc=%.2f tonal=%.2f dur=%.1f cap=%.1f"
                  % (label, tries, sp, tag, cv, exc, tonal, dur, cap))
    if clean:
        clean.sort(key=lambda c: c[0], reverse=True)
        _, w, cv, exc, pmr, sor, dur, sp = clean[0]
    else:
        if shortest is None:
            raise RuntimeError("%s 无候选" % label)
        dur, w, sp = shortest
        if verbose:
            print("  %s 警告: 全部候选被拒，退选最短(%.1fs) speed=%.2f" % (label, dur, sp))
    # 后处理：软限幅(去兴奋) -> 去静音(去空白杂音) -> 响度归一(统一 -16 LUFS)
    if sor > 2.4 or pmr > 3.5:
        w = tame_spike(w)
    w = clean_silence(w)
    w = normalize_loudness(w)
    info = dict(cv=float(cv), exc=float(exc), pmr=float(pmr), sor=float(sor),
                dur=float(len(w) / SR), sp=float(sp), n_clean=len(clean), lang=lang)
    return w, info
