# -*- coding: utf-8 -*-
"""生成完成后复核：40 条是否齐全 + 用 has_tonal_artifact 复扫挂断音/纯音伪影。

用法：python verify_lines.py
依赖：cosy_gen / fix_cosy_issues / regen_jp_v3（仅取 has_tonal_artifact 与 music_severity，
不加载模型，导入很快）。
"""
import os
import sys
import json
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fix_cosy_issues import has_tonal_artifact
from regen_jp_v3 import music_severity, SR

OUT = os.path.join(HERE, "..", "app", "data", "lines")
mp = os.path.join(OUT, "manifest.json")
manifest = json.load(open(mp, encoding="utf-8"))

total = 0
missing = []
tonal = []   # (fn, score) 挂断音/纯音/双音
music = []   # (fn, sec)  死平/低频嗡鸣

for pool, recs in manifest["pools"].items():
    for idx, rec in enumerate(recs):
        for lang in ("cn", "jp"):
            fn = rec.get(lang)
            total += 1
            if not fn:
                missing.append("%s_%d.%s (manifest 缺字段)" % (pool, idx, lang))
                continue
            fp = os.path.join(OUT, fn)
            if not os.path.exists(fp):
                missing.append(fn)
                continue
            w, _ = sf.read(fp, dtype="float32")
            if w.ndim > 1:
                w = w.mean(1)
            t = has_tonal_artifact(w, SR, thr=0.3)
            m = music_severity(w)
            if t > 0.3:
                tonal.append((fn, round(float(t), 3)))
            if m > 0:
                music.append((fn, round(float(m), 3)))

print("=== 预生成音频复核：manifest 槽位=%d 个文件 ===" % total)
print("缺失/未生成文件:", missing if missing else "无")
print("挂断音/纯音标记(tonal>0.3):", tonal if tonal else "无")
print("音乐/死平标记(music>0):", music if music else "无")
# 重点：idle_1（idle 池第 1 条，0-based idx=1）的 CN/JP 是否带挂断音
for lang in ("cn", "jp"):
    fn = manifest["pools"]["idle"][1].get(lang)
    if fn and os.path.exists(os.path.join(OUT, fn)):
        w, _ = sf.read(os.path.join(OUT, fn), dtype="float32")
        if w.ndim > 1:
            w = w.mean(1)
        t = has_tonal_artifact(w, SR, thr=0.3)
        print("idle_1.%s (%s): tonal=%.3f %s" % (lang, fn, t, "<< 挂断音!" if t > 0.3 else "OK"))
