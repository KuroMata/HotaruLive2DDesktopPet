# -*- coding: utf-8 -*-
"""一次性回填：对已有音节库做时长归一化(与 build-syllable-bank.py 同逻辑)。
把每个孤立音节单位 time_stretch 压到 TARGET_SYL 秒/字，使整句拼接长度接近自然语流。
不重合成，纯 DSP，秒级完成。覆盖写回 units/ 并更新 manifest.json。

用法: python normalize-bank-duration.py
"""
import os
import json
import numpy as np
import soundfile as sf
import librosa

SR = 24000
TARGET_SYL = 0.40
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "syllable-bank")
UNITS = os.path.join(ROOT, "units")
MP = os.path.join(ROOT, "manifest.json")

with open(MP, encoding="utf-8") as f:
    man = json.load(f)

for p, u in man["units"].items():
    w, _ = sf.read(os.path.join(ROOT, u["path"]))
    w = w.astype(np.float32)
    dur = len(w) / SR
    rate = dur / TARGET_SYL
    if rate > 1.15:
        w = librosa.effects.time_stretch(w, rate=rate)
    w = (w / (np.max(np.abs(w)) + 1e-9) * 0.9).astype(np.float32)
    sf.write(os.path.join(ROOT, u["path"]), w, SR)
    u["dur"] = round(len(w) / SR, 3)

with open(MP, "w", encoding="utf-8") as f:
    json.dump(man, f, ensure_ascii=False, indent=2)

# 简单自检
durs = [u["dur"] for u in man["units"].values()]
print("normalized units=%d  median=%.2fs  mean=%.2fs" % (len(durs), np.median(durs), np.mean(durs)))
