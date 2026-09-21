# -*- coding: utf-8 -*-
"""用「靠谱后辈」人设，对两个新台词池的全部 5 条做试听合成（共 10 条）。

人设参数（与用户已认可的那版一致，必须在这里显式锁死，独立脚本不读 config.json）：
  BOYIFY=0  SEMITONES=0  FORMANT=0  POLISH=1  POLISH_MODE=natural  EMO_ALPHA=0.3
音色锁死在 prompt.wav（纯克隆，不变调），情绪从 ref/emo_ref/<标签>.wav 借入（不串味）。
后辈人设：平时认真(focus)、态度好(neutral)、沉稳可靠(serious)，
          偶尔假装不在意地拐弯抹角表达喜欢(tease / affection)。
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

OUT_DIR = os.path.join(HERE, "_out", "kouhai_audition")
os.makedirs(OUT_DIR, exist_ok=True)


def _load(pool):
    name = "click-lines.json" if pool == "click" else "idle-lines.json"
    with open(os.path.join(HERE, "..", "app", "data", name), "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    eng = IndexTTSEngine()
    eng._ensure()
    for pool in ("click", "idle"):
        items = _load(pool)
        for idx, item in enumerate(items):
            outname = "%s_%d" % (pool, idx)
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
                  % (outname, emo, r["rms_db"], r["5k-8k"], r["80-300"], text[:20]))
    print("全部完成 -> %s" % OUT_DIR)


if __name__ == "__main__":
    main()
