# -*- coding: utf-8 -*-
"""用 T2 方案（= make_jpboy 的 T2_mix50p35：你的干音 +3.5 半音 + Yunxia 各半）
批量合成多句真实台词，验证少年化方案在不同情绪/语境下的稳定性。

输出：tts/_out/jpboy_t2/<idx>_<emo>.wav
参考音频与 make_jpboy.T2 完全一致（复用 ref/_y_ref_yunxia.wav 缓存 + 同一段 78.02-93.16s）。

用法：INDEXTTS_DIR=D:/index-tts INDEXTTS_MODEL_DIR=checkpoints_2 python make_t2_lines.py
"""
import os
import sys
import json
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from audio_polish import (pitch_shift, read_wav, report,  # noqa: E402
                          write_wav, master)
from engines import IndexTTSEngine  # noqa: E402

LINES_SRC = os.path.join(HERE, "..", "app", "data", "click-lines.json")
REF_SRC = os.path.join(HERE, "ref", "ref.wav")
YUNXIA_CACHE = os.path.join(HERE, "ref", "_y_ref_yunxia.wav")
YUNXIA_FALLBACK = os.path.join(HERE, "_out", "youth", "Y_ref_Yunxia.mp3")
OUT_DIR = os.path.join(HERE, "_out", "jpboy_t2")
T2_REF_CACHE = os.path.join(HERE, "ref", "_j_T2_lines.wav")

# 选取覆盖多种情绪的若干句（click-lines.json 的 0-based 下标）
PICK = [0, 4, 7, 11, 18, 21, 29]


def load_yunxia():
    if os.path.isfile(YUNXIA_CACHE):
        return read_wav(YUNXIA_CACHE)
    if os.path.isfile(YUNXIA_FALLBACK):
        return read_wav(YUNXIA_FALLBACK)
    raise RuntimeError("找不到 Yunxia 参考（edge-tts 未生成且无兜底缓存）")


def build_t2_ref():
    """与 make_jpboy.T2 完全一致的参考音频：你的干音 +3.5 半音 + Yunxia 各半。"""
    if os.path.isfile(T2_REF_CACHE):
        return T2_REF_CACHE
    x, sr = read_wav(REF_SRC)
    seg = x[int(78.02 * sr): int(93.16 * sr)]
    mine = pitch_shift(seg, sr, 3.5)
    yx, ysr = load_yunxia()
    if ysr != sr:
        import pedalboard
        y2 = pedalboard.Resample(target_sample_rate=sr).process(
            yx.astype(np.float32), ysr).astype(np.float64)
    else:
        y2 = yx
    ref = np.concatenate([mine, y2])
    with open(T2_REF_CACHE, "wb") as f:
        f.write(write_wav(ref, sr))
    return T2_REF_CACHE


def blend_emo(eng, emo_list):
    vecs = [eng.EMO_VEC[e] for e in emo_list if e in eng.EMO_VEC]
    if not vecs:
        return None
    n = len(vecs)
    out = [sum(v[i] for v in vecs) / n for i in range(8)]
    return out


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
        emo_vec = blend_emo(eng, emo_list)
        label = "%02d_%s" % (idx, "_".join(emo_list))
        out = os.path.join(OUT_DIR, label + ".wav")
        if os.path.isfile(out) and os.path.getsize(out) > 20000:
            print("  %-22s (skip, exists)" % label)
            continue
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            kwargs = dict(spk_audio_prompt=ref_path, text=text, output_path=tmp)
            if emo_vec:
                kwargs["emo_vector"] = emo_vec
                kwargs["emo_alpha"] = 0.85
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
        print("  %-22s -> %s  %s" % (label, out, report(out)))

    print("\ndone ->", OUT_DIR)


if __name__ == "__main__":
    main()
