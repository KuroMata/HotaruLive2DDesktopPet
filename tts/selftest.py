# -*- coding: utf-8 -*-
"""
TTS 引擎自检 —— 列出引擎可用性，并用指定引擎合成一句样例。
用法：
  python selftest.py            # auto 选引擎
  python selftest.py sapi       # 指定引擎
  python selftest.py tone
产出：tts/_out/sample_<engine>.wav
"""
import os
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engines import build_engines, pick_engine_name  # noqa: E402


def main():
    reg = build_engines()
    print("== engines ==")
    for e in reg.values():
        vs = e.voices()
        print("  %-10s %-28s available=%-5s voices=%s" % (
            e.name, e.label, e.available(), (vs[:4] if vs else "-")))
    want = sys.argv[1] if len(sys.argv) > 1 else "auto"
    name = pick_engine_name(reg, want)
    print("active engine:", name, "(want=%s)" % want)

    text = "前辈，今天的海水样本送到了，溶氧量比昨天高了零点三。"
    data, sr = reg[name].synth(text, emo="focus")
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_out")
    os.makedirs(out, exist_ok=True)
    # Edge 等引擎返回 mp3，扩展名要跟着变（wave 模块只能解析 wav）
    ext = ".mp3" if getattr(reg[name], "mime", "") == "audio/mpeg" else ".wav"
    p = os.path.join(out, "sample_%s%s" % (name, ext))
    with open(p, "wb") as f:
        f.write(data)
    if ext == ".wav":
        w = wave.open(p)
        print("wrote %s (%d bytes, %d Hz, %.2fs)" % (
            p, len(data), w.getframerate(), w.getnframes() / float(w.getframerate())))
    else:
        print("wrote %s (%d bytes, %s)" % (p, len(data), ext.lstrip(".")))


if __name__ == "__main__":
    main()
