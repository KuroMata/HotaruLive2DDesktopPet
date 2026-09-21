# -*- coding: utf-8 -*-
"""把修复后的 smooth_muffled 真正应用到 original/ 与 original_emo/ 已生成的 wav。

背景：smooth_muffled 原先调用 pedalboard.LowpassFilter(..., q=...) 报错被引擎静默吞掉，
导致两批文件都没被圆滑沉闷处理。这里直接对已生成文件做后处理覆盖，无需重跑模型。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from audio_polish import read_wav, write_wav, smooth_muffled, report

DIRS = [os.path.join(HERE, "_out", "original"),
        os.path.join(HERE, "_out", "original_emo")]

for d in DIRS:
    print("== %s ==" % os.path.basename(d))
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".wav"):
            continue
        p = os.path.join(d, fn)
        x, sr = read_wav(p)
        y = smooth_muffled(x, sr)
        with open(p, "wb") as f:
            f.write(write_wav(y, sr))
        r = report(p)
        print("  %-18s rms=%sdB  5k-8k=%s%%  low80-300=%s%%" % (
            fn, r["rms_db"], r["5k-8k"], r["80-300"]))
print("done")
