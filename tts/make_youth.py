# -*- coding: utf-8 -*-
"""少年感调优：把克隆音色往微软 Yunxia（男童音色）的方向推，并给出目标参照。

输出（tts/_out/youth/）：
  Y_ref_Yunxia.mp3   目标参照：微软 YunxiaNeural 念同一句（我们要靠近的声音）
  S1_p25.wav         当前配置：+2.5 半音（对照）
  S2_p35.wav         +3.5 半音
  S3_p45.wav         +4.5 半音
  S4_p35_bright.wav  +3.5 半音 + 明亮化（提中高频、削低频厚度，模拟少年声道）

用法：python make_youth.py
"""
import os
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from audio_polish import (clean_reference, master, pitch_shift,  # noqa: E402
                          read_wav, report, write_wav)
from engines import IndexTTSEngine  # noqa: E402

# 换一句台词：好奇 + 开心，情绪明亮，方便判断少年感与韵律
TEXT = "你点我是不是无聊了，那我给你讲个深海冷知识，海马是爸爸生孩子的，神不神奇。"
EMO = "curious"

OUT_DIR = os.path.join(HERE, "_out", "youth")
REF_SRC = os.path.join(HERE, "ref", "ref.wav")


def gen_target_mp3(text, voice, out_path):
    """用微软音色生成目标参照（edge-tts）。"""
    import asyncio

    import edge_tts

    async def _run():
        c = edge_tts.Communicate(text, voice)
        await c.save(out_path)

    asyncio.run(_run())


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 1) 目标参照：Yunxia（男童）
    p = os.path.join(OUT_DIR, "Y_ref_Yunxia.mp3")
    try:
        gen_target_mp3(TEXT, "zh-CN-YunxiaNeural", p)
        print("  target           -> %s (%d bytes)" % (p, os.path.getsize(p)))
    except Exception as e:  # noqa: BLE001
        print("  target FAIL:", type(e).__name__, e)

    # 2) 克隆音色的少年感变体
    x, sr = read_wav(REF_SRC)
    seg = x[int(78.02 * sr): int(93.16 * sr)]

    def ref_shifted(semi, bright=False):
        y = pitch_shift(seg, sr, semi) if abs(semi) > 1e-6 else seg
        if bright:
            # 少年声道更短 → 共振峰更高：提中高频、削低频厚度，同时削掉变调 artifacts
            return clean_reference(y, sr,
                                   low_shelf_gain=-6.0, low_shelf_cut=320.0,
                                   box_gain=-3.0,
                                   high_shelf_gain=3.0, high_shelf_cut=3500.0,
                                   deartifact_gain=-8.0)
        return clean_reference(y, sr, high_shelf_gain=0.0, deartifact_gain=-8.0)

    eng = IndexTTSEngine()
    eng._ensure()

    def ref_formant(semi):
        """变调 + 模拟少年声道（共振峰上移）。

        光提高音调不够"少年"：儿童的声道更短，共振峰(F1/F2)也更高。
        这里在变调之后，压低成人 F1 区(450Hz)、抬高少年 F1(900Hz)/F2(2200Hz)，
        用 EQ 模拟更短的声道。高频保持克制，避免变调 artifacts 被放大。
        """
        import pedalboard

        y = pitch_shift(seg, sr, semi)
        board = pedalboard.Pedalboard([
            pedalboard.HighpassFilter(cutoff_frequency_hz=90.0),
            pedalboard.LowShelfFilter(cutoff_frequency_hz=300.0, gain_db=-5.0, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=450.0, gain_db=-3.0, q=1.0),   # 削成人 F1
            pedalboard.PeakFilter(cutoff_frequency_hz=900.0, gain_db=3.5, q=1.2),    # 少年 F1
            pedalboard.PeakFilter(cutoff_frequency_hz=2200.0, gain_db=3.0, q=1.2),    # 少年 F2
            pedalboard.HighShelfFilter(cutoff_frequency_hz=4500.0, gain_db=-1.0, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=11000.0, gain_db=-8.0, q=0.9),  # 削 artifacts
            pedalboard.Compressor(threshold_db=-22.0, ratio=2.2, attack_ms=8.0, release_ms=140.0),
        ])
        return board.process(y.astype(np.float32), sr).astype(np.float64)

    variants = [
        ("S1_p25", 2.5, False),
        ("S2_p35", 3.5, False),
        ("S3_p45", 4.5, False),
        ("S4_p35_bright", 3.5, True),
        ("S5_p35_formant", 3.5, "formant"),
        ("S6_p40_formant", 4.0, "formant"),
    ]
    for name, semi, bright in variants:
        out = os.path.join(OUT_DIR, name + ".wav")
        if os.path.isfile(out) and os.path.getsize(out) > 20000:
            print("  %-16s (skip, exists)" % name)
            continue
        ref_path = os.path.join(HERE, "ref", "_y_%s.wav" % name)
        y = ref_formant(semi) if bright == "formant" else ref_shifted(semi, bool(bright))
        with open(ref_path, "wb") as f:
            f.write(write_wav(y, sr))
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            eng._tts.infer(spk_audio_prompt=ref_path, text=TEXT, output_path=tmp,
                           emo_vector=eng.EMO_VEC.get(EMO), emo_alpha=0.85, verbose=False)
            with open(tmp, "rb") as f:
                raw = f.read()
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        y, osr = read_wav(raw)
        out = os.path.join(OUT_DIR, name + ".wav")
        with open(out, "wb") as f:
            f.write(write_wav(master(y, osr), osr))
        print("  %-16s -> %s  %s" % (name, out, report(out)))
        try:
            os.remove(ref_path)
        except OSError:
            pass

    print("\ndone ->", OUT_DIR)


if __name__ == "__main__":
    main()
