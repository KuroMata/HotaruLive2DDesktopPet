# -*- coding: utf-8 -*-
"""CosyVoice 流式(stream=True)首帧延迟实测

inference_cross_lingual(stream=True) 增量 yield 音频块。
测两件事：
  t_first = 从调用到第一个音频块出来的耗时（感知延迟上限）
  t_total = 到全部音频块出来的耗时（完整音频就绪）
验证：t_first 能否 <=2s（满足用户延迟预算的"开口即播"语义）。
"""
import os, sys, time
sys.path.insert(0, "D:/cosyvoice_src")
sys.path.insert(0, "D:/live2d-companion/tts")

import torch
from cosy_gen import load_cosy

REF = "D:/live2d-companion/tts/ref/prompt.wav"

CLAUSES = [
    "嗨嗨，主子大人。",
    "我们一起来整理桌面吧。",
    "你刚才说的那个文件我已经帮你找出来了。",
    "好的，我现在就把下载目录里的大文件列出来给你看。",
]

def main():
    cosy = load_cosy()
    cosy.add_zero_shot_spk("", REF, "bank")
    print("LOADED", flush=True)
    # warmup
    for _ in cosy.inference_cross_lingual(tts_text="你好。", prompt_wav=REF,
                                          zero_shot_spk_id="bank", stream=True, speed=1.0):
        pass
    print("WARMUP_DONE", flush=True)

    for cl in CLAUSES:
        t0 = time.time()
        t_first = None
        n = 0
        for c in cosy.inference_cross_lingual(tts_text=cl, prompt_wav=REF,
                                              zero_shot_spk_id="bank", stream=True, speed=1.0):
            n += 1
            if t_first is None:
                t_first = time.time() - t0
        t_total = time.time() - t0
        first_ok = "OK" if (t_first is not None and t_first <= 2.0) else "OVER"
        print("[%s] t_first=%.2fs t_total=%.2fs chunks=%d first_frame->%s" %
              (cl, t_first if t_first else -1, t_total, n, first_ok), flush=True)

if __name__ == "__main__":
    main()
