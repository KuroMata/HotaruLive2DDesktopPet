# -*- coding: utf-8 -*-
"""「最初版本 + 情绪」试听：纯克隆你的声音（不变调/无少年化）做音色基底，
用 emo_audio_prompt 借情绪（只借情感、音色锁在你的原声，不串味、不变调）。
输出仍走 smooth_muffled（圆滑沉闷）。

与 make_original.py 的唯一区别：这里给每行传入情绪 -> 引擎优先用
ref/emo_ref/<情绪>.wav 走 emo_audio_prompt 借情感；音色由 plain ref 锁死。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("INDEXTTS_DIR", "D:/index-tts")
os.environ.setdefault("INDEXTTS_MODEL_DIR", "checkpoints_2")
os.environ["INDEXTTS_BOYIFY"] = "0"          # 不变调、无少年化、无 Yunxia 混参
os.environ["INDEXTTS_FORMANT"] = "0"
os.environ["INDEXTTS_SEMITONES"] = "0"
os.environ["INDEXTTS_POLISH"] = "1"
os.environ["INDEXTTS_POLISH_MODE"] = "smooth"  # 圆滑沉闷
os.environ["INDEXTTS_EMO_ALPHA"] = "0.9"       # 情绪强度

from engines import IndexTTSEngine
from audio_polish import report

# (文件名, 情绪, 台词) —— 情绪取最能体现该句的单一情绪，覆盖 7 种不同语气
LINES = [
    ("00_joy",       "joy",       "前辈！你点我啦，是不是想我了，嘿嘿，我刚好也想到你，这下我们算想到一块去了吧。"),
    ("04_shy",       "shy",       "唔，你靠这么近，我心跳好快，别盯着我看，我脸要红了，你肯定是故意的，故意的我也没办法。"),
    ("07_affection", "affection", "前辈，别走，再陪我五分钟，就五分钟，我把这段波形看完就陪你，好不好，你不答应我就一直拽着你衣角。"),
    ("11_serious",   "serious",   "前辈，我偷偷把你设成了紧急联系人第一位，出事第一个打给你，你不准换掉，换掉我就天天给你打测试电话。"),
    ("18_pout",      "pout",      "别笑我矮，我还在长，等我长高了第一个扛起来的人就是你，前辈等着，到时候换我护着你。"),
    ("21_tease",     "tease",     "前辈，你点我一下我就开心半天，这算不算被你拿捏了，哼，算吧，我认，反正我也不想挣。"),
    ("29_sleepy",    "sleepy",    "前辈，要是有一天我不在了，记得我留给你的热可可配方，糖减半，奶加倍，那是只给你的，别人问也不给。"),
]

OUT_DIR = os.path.join(HERE, "_out", "original_emo")
os.makedirs(OUT_DIR, exist_ok=True)

READY = []


def main():
    eng = IndexTTSEngine()
    eng._ensure()
    for name, emo, text in LINES:
        out = os.path.join(OUT_DIR, name + ".wav")
        if os.path.isfile(out) and os.path.getsize(out) > 20000:
            print("  %-14s (skip, exists)" % name)
            READY.append((name, emo, text, out))
            continue
        data, _ = eng.synth(text, emo=emo)   # 借情绪：音色锁 plain ref，只借 emo 参考的情感
        with open(out, "wb") as f:
            f.write(data)
        r = report(out)
        print("  %-14s emo=%-10s rms=%sdB  5k-8k=%s%%  low80-300=%s%%" % (
            name, emo, r["rms_db"], r["5k-8k"], r["80-300"]))
        READY.append((name, emo, text, out))
    print("全部完成，输出目录：%s" % OUT_DIR)


if __name__ == "__main__":
    main()
