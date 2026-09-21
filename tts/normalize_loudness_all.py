# -*- coding: utf-8 -*-
"""批量响度归一化：对 _out/kouhai_jp_cosyvoice 下全部 wav 统一到目标 LUFS。
用于已生成但响度不一致的文件(如 click_2 偏轻、click_1 偏响)。纯后处理，不重新推理。
用法: python normalize_loudness_all.py  (可选 COSY_LOUDNESS_TARGET=-16.0)
"""
import os
import sys
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fix_cosy_issues import normalize_loudness
from analyze_loudness import loudness_lufs, gated_rms

JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")
TARGET = float(os.environ.get("COSY_LOUDNESS_TARGET", "-16.0"))
SR = 24000


def main():
    files = sorted(f for f in os.listdir(JP_OUT) if f.endswith(".wav"))
    print("目标 LUFS = %.1f  文件数 = %d" % (TARGET, len(files)))
    for fn in files:
        fp = os.path.join(JP_OUT, fn)
        wav, sr = sf.read(fp)
        if wav.ndim > 1:
            wav = wav.mean(1)
        if sr != SR:
            import torchaudio
            wav = torchaudio.functional.resample(torch.from_numpy(wav).float(), sr, SR).numpy()
        before = loudness_lufs(wav.astype(np.float32))
        out = normalize_loudness(wav.astype(np.float32), target_lufs=TARGET)
        after = loudness_lufs(out)
        sf.write(fp, out, SR)
        print("  %-14s LUFS %.2f -> %.2f   (gain %.1fdB)"
              % (fn, before, after, 20 * np.log10(
                  float(np.max(np.abs(out)) + 1e-9) / (float(np.max(np.abs(wav)) + 1e-9)))))


if __name__ == "__main__":
    main()
