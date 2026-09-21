# -*- coding: utf-8 -*-
"""生成音色变体，供人工 A/B 试听选择。

一次加载 IndexTTS-2，然后用不同的参考音频/后处理组合合成同一句台词，
输出到 tts/_out/variants/ 。

变体说明：
  A_old        旧方案：原参考 + 输出后用 librosa 变调 +2.5（= 你现在听到的，电音感来源）
  B_raw        原参考，不做任何处理（诊断用：判断模型/干音本身的底子）
  C_clean      清洁后的参考 + 输出润色（不变调）
  D_p2         清洁后参考再上调 2 半音 + 输出润色（少年感，推荐起点）
  E_p3         清洁后参考再上调 3 半音 + 输出润色（更少年）

用法：
  python make_variants.py                 # 全部生成
  python make_variants.py "自定义台词"     # 用别的台词
"""
import os
import sys
import time

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from audio_polish import (clean_reference, master, normalize_loudness,  # noqa: E402
                          pitch_shift, read_wav, report, write_wav)
from engines import IndexTTSEngine, build_engines  # noqa: E402

TEXT = "前辈，今天的海水样本送到了，溶氧量比昨天高了零点三。"
EMO = "focus"

OUT_DIR = os.path.join(HERE, "_out", "variants")
REF_DIR = os.path.join(HERE, "ref")
REF_SRC = os.path.join(REF_DIR, "ref.wav")


def prep_refs():
    """准备参考音频变体，返回 {名字: 路径}。"""
    x, sr = read_wav(REF_SRC)
    # 从 78.02s 取 15s（与 prompt.wav 一致的区间）
    seg = x[int(78.02 * sr): int(93.16 * sr)]
    refs = {}

    def save(name, data):
        p = os.path.join(REF_DIR, name)
        with open(p, "wb") as f:
            f.write(write_wav(data, sr))
        refs[name] = p
        return p

    save("_v_ref_clean.wav", clean_reference(seg, sr))
    # 变调后再清洁：让 EQ 作用于最终频谱
    save("_v_ref_p2.wav", clean_reference(pitch_shift(seg, sr, 2.0), sr))
    save("_v_ref_p3.wav", clean_reference(pitch_shift(seg, sr, 3.0), sr))

    # 改进版：变调后「不提高频 + 削掉高频 artifacts」。
    # 变调会在高频留下 artifacts，此时若还提升高频，等于把噪声一起放大
    # （实测会让合成结果 8kHz 以上占比从 1.7% 涨到 6%，听感发毛）。
    def clean_shifted(data, semi):
        return clean_reference(pitch_shift(data, sr, semi), sr,
                               high_shelf_gain=0.0, deartifact_gain=-8.0)

    save("_v_ref_p15b.wav", clean_shifted(seg, 1.5))
    save("_v_ref_p2b.wav", clean_shifted(seg, 2.0))
    save("_v_ref_p25b.wav", clean_shifted(seg, 2.5))
    return refs


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else TEXT
    os.makedirs(OUT_DIR, exist_ok=True)
    refs = prep_refs()
    print("refs prepared:", list(refs.keys()))

    eng = IndexTTSEngine()
    print("engine available:", eng.available())
    t0 = time.time()
    eng._ensure()
    print("model loaded in %.1fs" % (time.time() - t0))

    import tempfile

    def synth(ref_path, label, post=None):
        out0 = os.path.join(OUT_DIR, "%s.wav" % label)
        # 已生成过就跳过：本脚本可被反复重跑（后台任务有 ~2 分钟上限，分批跑）
        if os.path.isfile(out0) and os.path.getsize(out0) > 20000:
            print("  %-10s (skip, exists) %s" % (label, out0))
            return out0
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            eng._tts.infer(spk_audio_prompt=ref_path, text=text,
                           output_path=tmp, emo_vector=eng.EMO_VEC.get(EMO),
                           emo_alpha=0.85, verbose=False)
            with open(tmp, "rb") as f:
                data = f.read()
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        if post:
            y, sr = read_wav(data)
            data = write_wav(post(y, sr), sr)
        out = os.path.join(OUT_DIR, "%s.wav" % label)
        with open(out, "wb") as f:
            f.write(data)
        print("  %-10s -> %s  %s" % (label, out, report(out)))
        return out

    print("\n== generating ==")

    # A: 旧方案（对照）
    def old_way(y, sr):
        import librosa
        return librosa.effects.pitch_shift(y=y, sr=sr, n_steps=2.5)
    synth(REF_SRC, "A_old", post=old_way)

    # B: 原参考，原样输出（诊断）
    synth(REF_SRC, "B_raw", post=None)

    # C: 清洁参考 + 润色
    synth(refs["_v_ref_clean.wav"], "C_clean", post=lambda y, sr: master(y, sr))

    # D: +2 半音（pre-shift）+ 润色
    synth(refs["_v_ref_p2.wav"], "D_p2", post=lambda y, sr: master(y, sr))

    # E: +3 半音（pre-shift）+ 润色
    synth(refs["_v_ref_p3.wav"], "E_p3", post=lambda y, sr: master(y, sr))

    # F/G/H: 改进版少年化（变调后不提高频 + 削 artifacts）
    synth(refs["_v_ref_p15b.wav"], "F_p15b", post=lambda y, sr: master(y, sr))
    synth(refs["_v_ref_p2b.wav"], "G_p2b", post=lambda y, sr: master(y, sr))
    synth(refs["_v_ref_p25b.wav"], "H_p25b", post=lambda y, sr: master(y, sr))

    print("\ndone ->", OUT_DIR)


if __name__ == "__main__":
    main()
