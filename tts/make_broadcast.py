# -*- coding: utf-8 -*-
"""生成"广播级/视频配音"风格的样本：用你的克隆音色，做成 AI 配音视频那种质感。

输出两个文件到 tts/_out/ ：
  clone_broadcast.wav   广播级处理（重压缩 + 中频突出 + 响度 -16）
  clone_polished.wav    普通润色（上一版的方案）

用法：python make_broadcast.py
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from audio_polish import (master, master_broadcast, read_wav,  # noqa: E402
                          report, write_wav)
from engines import IndexTTSEngine  # noqa: E402

TEXT = "前辈，今天的海水样本送到了，溶氧量比昨天高了零点三。"
OUT_DIR = os.path.join(HERE, "_out")


def main():
    text = sys.argv[1] if len(sys.argv) > 1 else TEXT
    eng = IndexTTSEngine()
    eng._ensure()
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        eng._tts.infer(spk_audio_prompt=eng._prepare_ref(), text=text,
                       output_path=tmp, emo_vector=eng.EMO_VEC.get("focus"),
                       emo_alpha=0.85, verbose=False)
        with open(tmp, "rb") as f:
            raw = f.read()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    x, sr = read_wav(raw)
    for name, fn in (("clone_broadcast", master_broadcast), ("clone_polished", master)):
        y = fn(x, sr)
        p = os.path.join(OUT_DIR, name + ".wav")
        with open(p, "wb") as f:
            f.write(write_wav(y, sr))
        print("  %-16s -> %s  %s" % (name, p, report(p)))


if __name__ == "__main__":
    main()
