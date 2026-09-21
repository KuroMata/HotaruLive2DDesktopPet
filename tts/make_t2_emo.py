# -*- coding: utf-8 -*-
"""用 emo_audio_prompt（情绪参考音频）重新合成 T2 方案的 7 句台词。

与 make_t2_lines.py 的区别：
  旧版用手写 emo_vector -> 情绪被混进说话人表征，含 angry/sad/afraid/serious
  分量的情绪会把音色带偏（用户反馈 04/07/11/18 语气不对、且不像同一音色）。
  本版改用 emo_audio_prompt：spk_audio_prompt=T2 参考（锁死音色），
  emo_audio_prompt=ref/emo_ref/<情绪>.wav（只借情感），两条独立提取后合并，
  音色永远 = T2，情绪来自参考音频，不串味。

输出：tts/_out/jpboy_t2_emo/<idx>_<emo>.wav
"""
import os
import sys
import json
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from audio_polish import read_wav, write_wav, master, report  # noqa: E402
from engines import IndexTTSEngine  # noqa: E402
from make_t2_lines import build_t2_ref, PICK, blend_emo  # noqa: E402

EMO_REF_DIR = os.path.join(HERE, "ref", "emo_ref")
OUT_DIR = os.path.join(HERE, "_out", "jpboy_t2_emo")

# 每句情绪 -> 用于借情感的主情绪参考（取情绪列表里第一个作为主导）
LINES_SRC = os.path.join(HERE, "..", "app", "data", "click-lines.json")

EMO_ALPHA = 0.9  # 情绪强度：越高情感越明显（音色仍锁 T2）


def emo_ref_for(emo_list):
    if not emo_list:
        return None
    for e in emo_list:
        p = os.path.join(EMO_REF_DIR, "%s.wav" % e)
        if os.path.isfile(p):
            return p
    return None


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(LINES_SRC, "r", encoding="utf-8") as f:
        lines = json.load(f)
    ref_path = build_t2_ref()
    eng = IndexTTSEngine()
    eng._ensure()

    for idx in PICK:
        item = lines[idx]
        text = item["text"]
        emo_list = item.get("emo", ["neutral"])
        label = "%02d_%s" % (idx, "_".join(emo_list))
        out = os.path.join(OUT_DIR, label + ".wav")
        if os.path.isfile(out) and os.path.getsize(out) > 20000:
            print("  %-22s (skip, exists)" % label)
            continue
        emo_audio = emo_ref_for(emo_list)
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            kwargs = dict(spk_audio_prompt=ref_path, text=text, output_path=tmp)
            if emo_audio:
                kwargs["emo_audio_prompt"] = emo_audio
                kwargs["emo_alpha"] = EMO_ALPHA
            eng._tts.infer(**kwargs)
            with open(tmp, "rb") as f:
                raw = f.read()
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        y, osr = read_wav(raw)
        with open(out, "wb") as f:
            f.write(write_wav(master(y, osr), osr))
        print("  %-22s emo=%s -> %s  %s" % (label, os.path.basename(emo_audio or "none"), out, report(out)))

    print("\ndone ->", OUT_DIR)


if __name__ == "__main__":
    main()
