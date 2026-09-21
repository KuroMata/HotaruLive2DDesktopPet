# -*- coding: utf-8 -*-
"""往"日本声优少年感"靠拢：用 Yunxia（男童音色）参与参考音频，减少对变调的依赖。

思路：
  S6 的问题 = 变调 +4 半音把 f0 推到 311Hz（女声区），且变调本身的"磁带加速感"
  就是那股"中式配音味"。IndexTTS-2 支持**音色与情感分离**，所以可以直接用
  Yunxia 的男童音色做参考（或部分混合），情感仍由我们的 emo 向量控制，
  不必靠大幅变调去"伪装"少年。

变体：
  T1_mix50     参考 = 你的干音(不变调) + Yunxia 各半
  T2_mix50p35  参考 = 你的干音(+3.5 半音，与 Yunxia 音高对齐) + Yunxia 各半
  T3_yunxia    参考 = 纯 Yunxia（男童音色 + 我们的情感控制，作为音色基线）
  T4_mix50_f   参考 = 你的干音(+3.5 半音 + 少年声道模拟) + Yunxia 各半

注：实测你的干音 f0≈101Hz，+3.5 半音后≈297Hz，与 Yunxia(≈299Hz) 基本对齐，
混合参考的音高不会"打架"；纯 +2 半音(≈113Hz)会与 Yunxia 差太多，已弃用。

用法：python make_jpboy.py
"""
import os
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from audio_polish import (clean_reference, clean_reference_formant,  # noqa: E402
                          master, pitch_shift, read_wav, report,
                          write_wav)
from engines import IndexTTSEngine  # noqa: E402

# 台词沿用上一轮，便于与 S5/S6 直接对比
TEXT = "你点我是不是无聊了，那我给你讲个深海冷知识，海马是爸爸生孩子的，神不神奇。"
EMO = "curious"

# 参考用的中性文本（与台词不同，避免自回归"背诵"）
REF_TEXT = ("今天的水温是十四度，能见度还不错，我把采样器放下去，"
            "等它慢慢沉到两百米，再记录一次压力数据。")

OUT_DIR = os.path.join(HERE, "_out", "jpboy")
REF_SRC = os.path.join(HERE, "ref", "ref.wav")
YUNXIA_CACHE = os.path.join(HERE, "ref", "_y_ref_yunxia.wav")


def gen_yunxia_ref(sr_target=44100):
    """用微软 Yunxia（男童）生成一段参考音频，缓存复用。"""
    if os.path.isfile(YUNXIA_CACHE):
        y, sr = read_wav(YUNXIA_CACHE)
        return y, sr
    import asyncio

    import edge_tts
    import soundfile as sf

    mp3 = os.path.join(HERE, "ref", "_y_ref_yunxia.mp3")
    async def _run():
        c = edge_tts.Communicate(REF_TEXT, "zh-CN-YunxiaNeural")
        await c.save(mp3)

    asyncio.run(_run())
    y, sr = sf.read(mp3, always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = y.astype(np.float64)
    with open(YUNXIA_CACHE, "wb") as f:
        f.write(write_wav(y, sr))
    try:
        os.remove(mp3)
    except OSError:
        pass
    return y, sr


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    yx, ysr = gen_yunxia_ref()
    print("yunxia ref: %.2fs @ %d Hz" % (len(yx) / ysr, ysr))

    x, sr = read_wav(REF_SRC)
    seg = x[int(78.02 * sr): int(93.16 * sr)]      # 与 prompt.wav 一致的区间
    yxr = yx

    def make_ref(kind):
        if kind == "yunxia":
            return yxr, ysr
        if kind == "mix50":
            mine = seg
        elif kind == "mix50p35":
            mine = pitch_shift(seg, sr, 3.5)
        elif kind == "mix50_f":
            mine = clean_reference_formant(pitch_shift(seg, sr, 3.5), sr)
        else:
            mine = seg
        # 统一采样率后拼接：前段你的声音，后段 Yunxia（男童音色）
        if ysr != sr:
            import pedalboard
            y2 = pedalboard.Resample(target_sample_rate=sr).process(
                yxr.astype(np.float32), ysr).astype(np.float64)
        else:
            y2 = yxr
        return np.concatenate([mine, y2]), sr

    eng = IndexTTSEngine()
    eng._ensure()

    variants = ["T1_mix50", "T2_mix50p35", "T3_yunxia", "T4_mix50_f"]
    for name in variants:
        out = os.path.join(OUT_DIR, name + ".wav")
        if os.path.isfile(out) and os.path.getsize(out) > 20000:
            print("  %-14s (skip, exists)" % name)
            continue
        kind = {"T1_mix50": "mix50", "T2_mix50p35": "mix50p35",
                "T3_yunxia": "yunxia", "T4_mix50_f": "mix50_f"}[name]
        ref_data, ref_sr = make_ref(kind)
        if kind == "yunxia":
            ref_data = clean_reference(ref_data, ref_sr)
        ref_path = os.path.join(HERE, "ref", "_j_%s.wav" % name)
        with open(ref_path, "wb") as f:
            f.write(write_wav(ref_data, ref_sr))
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
        with open(out, "wb") as f:
            f.write(write_wav(master(y, osr), osr))
        print("  %-14s -> %s  %s" % (name, out, report(out)))
        try:
            os.remove(ref_path)
        except OSError:
            pass

    print("\ndone ->", OUT_DIR)


if __name__ == "__main__":
    main()
