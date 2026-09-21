# -*- coding: utf-8 -*-
"""生成「最初版本」试听：纯克隆你的声音，不开少年化、不变调、不加情绪，
输出用 smooth_muffled（圆滑沉闷、去电音）润色。与之前认可的 T2 版同 7 句，便于 A/B。

环境变量在 import engines 之前设好，让引擎 __init__ 直接读到：
  INDEXTTS_BOYIFY=0      不开少年化（不变调、不加 Yunxia 混参）
  INDEXTTS_FORMANT=0
  INDEXTTS_SEMITONES=0
  INDEXTTS_POLISH=1
  INDEXTTS_POLISH_MODE=smooth   圆滑沉闷预设
  INDEXTTS_EMO_ALPHA=0          不注入情绪（纯中性克隆，音色最干净）
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("INDEXTTS_DIR", "D:/index-tts")
os.environ.setdefault("INDEXTTS_MODEL_DIR", "checkpoints_2")
os.environ["INDEXTTS_BOYIFY"] = "0"
os.environ["INDEXTTS_FORMANT"] = "0"
os.environ["INDEXTTS_SEMITONES"] = "0"
os.environ["INDEXTTS_POLISH"] = "1"
os.environ["INDEXTTS_POLISH_MODE"] = "smooth"
os.environ["INDEXTTS_EMO_ALPHA"] = "0"

from engines import IndexTTSEngine
from audio_polish import report

# 与之前 T2 试听相同的 7 句（按真实台词文本），便于直接对比
LINES = [
    ("00_joy_tease",       "前辈！你点我啦，是不是想我了，嘿嘿，我刚好也想到你，这下我们算想到一块去了吧。"),
    ("04_shy_affection",   "唔，你靠这么近，我心跳好快，别盯着我看，我脸要红了，你肯定是故意的，故意的我也没办法。"),
    ("07_affection_focus", "前辈，别走，再陪我五分钟，就五分钟，我把这段波形看完就陪你，好不好，你不答应我就一直拽着你衣角。"),
    ("11_affection_serious","前辈，我偷偷把你设成了紧急联系人第一位，出事第一个打给你，你不准换掉，换掉我就天天给你打测试电话。"),
    ("18_pout_tease",      "别笑我矮，我还在长，等我长高了第一个扛起来的人就是你，前辈等着，到时候换我护着你。"),
    ("21_tease_affection", "前辈，你点我一下我就开心半天，这算不算被你拿捏了，哼，算吧，我认，反正我也不想挣。"),
    ("29_affection_sleepy","前辈，要是有一天我不在了，记得我留给你的热可可配方，糖减半，奶加倍，那是只给你的，别人问也不给。"),
]

OUT_DIR = os.path.join(HERE, "_out", "original")
os.makedirs(OUT_DIR, exist_ok=True)

READY = []

def main():
    eng = IndexTTSEngine()
    eng._ensure()
    for name, text in LINES:
        out = os.path.join(OUT_DIR, name + ".wav")
        if os.path.isfile(out) and os.path.getsize(out) > 20000:
            print("  %-18s (skip, exists)" % name)
            READY.append((name, text, out))
            continue
        data, _ = eng.synth(text, emo=None)   # emo=None = 中性克隆，不借情绪
        with open(out, "wb") as f:
            f.write(data)
        r = report(out)
        print("  %-18s done  rms=%sdB  5k-8k=%s%%  low80-300=%s%%" % (
            name, r["rms_db"], r["5k-8k"], r["80-300"]))
        READY.append((name, text, out))
    print("全部完成，输出目录：%s" % OUT_DIR)

if __name__ == "__main__":
    main()
