# -*- coding: utf-8 -*-
"""拆分 CosyVoice 的耗时构成：模型推理 vs 多候选 vs 后处理。

背景：实测一次请求 RTF 4.4、单句要等 56~100 秒。而 GPU 本身是健康的（fp16 43.7 TFLOPS）。
所以要把这段耗时拆开，看钱花在哪儿：

    _to_wav(synth)          纯模型推理一次
    music_severity          伪影检测（音乐度）
    has_tonal_artifact      伪影检测（纯音/双音/低频嗡鸣）
    prosody_score           语气评分
    clean_silence / normalize_loudness / tame_spike   后处理

用法： python tools/bench-tts/split-cost.py
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TTS = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'tts')   # tools/bench-tts → 项目根/tts
sys.path.insert(0, TTS)

import numpy as np

from cosy_gen import load_cosy, _to_wav, expected_cap, SR
from fix_cosy_issues import (has_tonal_artifact, clean_silence, normalize_loudness,
                             tame_spike, peak_median_ratio, speech_only_ratio)
from regen_jp_v3 import music_severity, prosody_score

TEXT = '来了来了，这就回你。'

def T(fn, *a, **kw):
    t0 = time.time()
    try:
        r = fn(*a, **kw)
    except Exception as e:
        return None, None, str(e)
    return r, (time.time() - t0) * 1000, None

print('加载模型…')
t0 = time.time()
cosy = load_cosy()
print('模型加载 %.1f s\n' % (time.time() - t0))

rows = []
for sp in (1.0, 1.06):
    print('--- speed=%.2f ---' % sp)
    w, ms_synth, err = T(_to_wav, cosy, TEXT, sp)
    if err:
        print('  合成失败: %s' % err)
        continue
    dur = len(w) / SR
    print('  模型推理 _to_wav      %8.0f ms   （音频 %.2f s → 该步 RTF %.2f）' % (ms_synth, dur, ms_synth / 1000 / dur))
    _, ms_m, _ = T(music_severity, w)
    _, ms_t, _ = T(has_tonal_artifact, w, SR, 0.3)
    _, ms_p, _ = T(prosody_score, w)
    _, ms_cs, _ = T(clean_silence, w)
    _, ms_nl, _ = T(normalize_loudness, w)
    _, ms_pmr, _ = T(peak_median_ratio, w)
    _, ms_sor, _ = T(speech_only_ratio, w)
    post = ms_m + ms_t + ms_p + ms_cs + ms_nl + ms_pmr + ms_sor
    print('  伪影检测 music/tonal  %8.0f / %8.0f ms' % (ms_m, ms_t))
    print('  语气评分 prosody      %8.0f ms' % ms_p)
    print('  后处理 clean/norm     %8.0f / %8.0f ms' % (ms_cs, ms_nl))
    print('  其它指标              %8.0f ms' % (ms_pmr + ms_sor))
    print('  合计：模型 %.0f ms  +  包装 %.0f ms  =  %.0f ms   （占比 %.0f%% / %.0f%%）'
          % (ms_synth, post, ms_synth + post, ms_synth / (ms_synth + post) * 100, post / (ms_synth + post) * 100))
    rows.append((sp, ms_synth, post))
    print('')

if rows:
    print('=' * 74)
    print('结论：一次候选合成里，模型推理占 %.0f%%，包装（检测+评分+后处理）占 %.0f%%。'
          % (sum(r[1] for r in rows) / sum(r[1] + r[2] for r in rows) * 100,
             sum(r[2] for r in rows) / sum(r[1] + r[2] for r in rows) * 100))
    print('      实时档每次请求跑 2 个候选 ⇒ 总耗时 ≈ 上述单次的 2 倍。')
    print('      所以要压到实时，主要得从"模型推理"这一项下手（换加速路径），')
    print('      或把候选数降到 1 —— 后者立刻减半，但会牺牲选优。')
