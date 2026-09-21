# -*- coding: utf-8 -*-
"""生成「情绪参考音频库」—— 供 IndexTTS-2 的 emo_audio_prompt 借用情感用。

为什么需要它：
  IndexTTS-2 的 emo_vector 会把手写情绪向量直接混进说话人表征，导致
  含 angry/sad/afraid/serious 分量的情绪把音色也带偏（即用户听到的
  "04/07/11/18 语气不对、且不像同一个音色"）。
  正确做法是 emo_audio_prompt：spk_audio_prompt 只出音色，emo_audio_prompt
  只出情感，两者独立提取后 merge。本脚本用 Edge TTS 的 Yunxia（男童音色）
  以不同语速/音高生成各情绪的"纯韵律"参考，缓存到 ref/emo_ref/。

注意：emo_audio_prompt 的*音色*不会渗进成品（成品音色只来自 spk_audio_prompt），
所以这里用 Yunxia 完全没问题，反而和少年化目标一致。

用法：D:/index-tts/.venv/Scripts/python.exe gen_emo_refs.py
"""
import os
import sys
import asyncio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

OUT_DIR = os.path.join(HERE, "ref", "emo_ref")
os.makedirs(OUT_DIR, exist_ok=True)

# 每个情绪的"夸张韵律"（比日常更极端，确保情绪嵌入向量可区分）
# 内容统一用一句中性话，只靠 rate/pitch 表达情绪（内容会被模型忽略）
EMO_PROSODY = {
    "neutral":   ("+0%",   "+0Hz"),
    "focus":     ("-6%",   "+0Hz"),
    "curious":   ("+15%",  "+25Hz"),
    "joy":       ("+25%",  "+40Hz"),
    "sleepy":    ("-30%",  "-20Hz"),
    "affection": ("-12%",  "+12Hz"),
    "shy":       ("-18%",  "+8Hz"),
    "tease":     ("+20%",  "+30Hz"),
    "serious":   ("-15%",  "-25Hz"),
    "surprise":  ("+30%",  "+45Hz"),
    "pout":      ("-20%",  "+20Hz"),
    "smug":      ("+8%",   "+15Hz"),
}

PHRASE = "我来给你讲一件事吧，你听好了哦。"


def read_mp3_to_wav(mp3_path):
    """把 edge-tts 的 mp3 读成 (float64 单声道, sr)。优先 pedalboard（能读 mp3）。"""
    try:
        import pedalboard
        audio, sr = pedalboard.io.read(mp3_path)
        if audio.ndim > 1:
            audio = audio.mean(axis=0)
        return audio.astype("float64"), int(sr)
    except Exception:
        pass
    import soundfile as sf
    x, sr = sf.read(mp3_path, always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x.astype("float64"), int(sr)


def write_wav(x, sr, path):
    import soundfile as sf
    import numpy as np
    sf.write(path, np.clip(x, -1.0, 1.0), sr, format="WAV", subtype="PCM_16")


async def gen_one(emo, rate, pitch, venv_py):
    import edge_tts
    mp3 = os.path.join(OUT_DIR, "_tmp_%s.mp3" % emo)
    out = os.path.join(OUT_DIR, "%s.wav" % emo)
    c = edge_tts.Communicate(PHRASE, "zh-CN-YunxiaNeural", rate=rate, pitch=pitch)
    await c.save(mp3)
    x, sr = read_mp3_to_wav(mp3)
    write_wav(x, sr, out)
    try:
        os.remove(mp3)
    except OSError:
        pass
    print("  %-10s %s %s -> %s" % (emo, rate, pitch, out))


def main():
    import edge_tts  # 提前确认可用
    print("生成情绪参考音频库 ->", OUT_DIR)
    for emo, (rate, pitch) in EMO_PROSODY.items():
        out = os.path.join(OUT_DIR, "%s.wav" % emo)
        if os.path.isfile(out) and os.path.getsize(out) > 4000:
            print("  %-10s (skip, exists)" % emo)
            continue
        try:
            asyncio.run(gen_one(emo, rate, pitch, None))
        except Exception as e:  # noqa: BLE001
            print("  %-10s FAILED: %s" % (emo, e))
    print("done")


if __name__ == "__main__":
    main()
