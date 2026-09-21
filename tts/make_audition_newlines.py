# -*- coding: utf-8 -*-
"""用已认可的「无口傲娇 / 闷骚」人设，对新台词池里的代表性几句做试听合成。

设置与 make_emo_kuudere.py 一致（即用户已认可的那版）：
  BOYIFY=0  SEMITONES=0  FORMANT=0  POLISH=1  POLISH_MODE=natural  EMO_ALPHA=0.3
音色锁死在 prompt.wav（纯克隆，不变调），情绪从 ref/emo_ref/<标签>.wav 借入（不串味）。
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("INDEXTTS_DIR", "D:/index-tts")
os.environ.setdefault("INDEXTTS_MODEL_DIR", "checkpoints_2")
os.environ["INDEXTTS_BOYIFY"] = "0"
os.environ["INDEXTTS_FORMANT"] = "0"
os.environ["INDEXTTS_SEMITONES"] = "0"
os.environ["INDEXTTS_POLISH"] = "1"
os.environ["INDEXTTS_POLISH_MODE"] = "natural"
os.environ["INDEXTTS_EMO_ALPHA"] = "0.3"

from engines import IndexTTSEngine
from audio_polish import report

# (输出名, 池, 下标) —— 从两个新台词池各挑覆盖各情绪的若干句
SEL = [
    ("click_00", "click", 0),    # pout   别戳了
    ("click_01", "click", 1),    # focus  点我干什么
    ("click_02", "click", 2),    # neutral 嗯？
    ("click_04", "click", 4),    # tease  你闲成这样
    ("click_07", "click", 7),    # serious 盯着人看
    ("click_10", "click", 10),   # pout   我脸没东西
    ("click_29", "click", 29),   # neutral 好了别点了
    ("idle_03",  "idle", 3),     # pout   小章鱼挡镜头
    ("idle_04",  "idle", 4),     # tease  放弃治疗
    ("idle_08",  "idle", 8),     # neutral 熄灯了
    ("idle_10",  "idle", 10),    # sleepy 有点困
    ("idle_16",  "idle", 16),    # tease  章鱼三颗心脏
    ("idle_19",  "idle", 19),    # serious 报告写完了
    ("idle_28",  "idle", 28),    # neutral 热可可
]

OUT_DIR = os.path.join(HERE, "_out", "newlines_audition")
os.makedirs(OUT_DIR, exist_ok=True)


def _load(pool):
    name = "click-lines.json" if pool == "click" else "idle-lines.json"
    with open(os.path.join(HERE, "..", "app", "data", name), "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    click = _load("click")
    idle = _load("idle")
    pools = {"click": click, "idle": idle}
    eng = IndexTTSEngine()
    eng._ensure()
    for outname, pool, idx in SEL:
        item = pools[pool][idx]
        text = item["text"]
        emo = item["emo"][0] if item.get("emo") else "neutral"
        out = os.path.join(OUT_DIR, outname + ".wav")
        if os.path.isfile(out) and os.path.getsize(out) > 20000:
            print("  %-10s (skip, exists)" % outname)
            continue
        data, _ = eng.synth(text, emo=emo)
        with open(out, "wb") as f:
            f.write(data)
        r = report(out)
        print("  %-10s emo=%-9s rms=%sdB 5k-8k=%s%% low80-300=%s%% | %s"
              % (outname, emo, r["rms_db"], r["5k-8k"], r["80-300"], text[:18]))
    print("全部完成 -> %s" % OUT_DIR)


if __name__ == "__main__":
    main()
