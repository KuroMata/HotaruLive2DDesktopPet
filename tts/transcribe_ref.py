# -*- coding: utf-8 -*-
"""用 whisper(base) 转录 萤 的参考音频 prompt.wav，输出 ref_text 供 Qwen3-TTS 克隆。"""
import sys, os
sys.path.insert(0, "D:/cosyvoice_src")
import whisper
import soundfile as sf
import librosa

REF = "D:/live2d-companion/tts/ref/prompt.wav"
OUT = "D:/live2d-companion/tts/ref/prompt_reftext.txt"

w, sr = sf.read(REF)
if sr != 16000:
    w = librosa.resample(y=w.astype("float32"), orig_sr=sr, target_sr=16000)
    sr = 16000
w = w.astype("float32")

print("loading whisper base ...", flush=True)
m = whisper.load_model("base")
r = m.transcribe(w, language="zh", fp16=False)
text = r["text"].strip()
with open(OUT, "w", encoding="utf-8") as f:
    f.write(text)
print("REF_TEXT:", text, flush=True)
print("SAVED", OUT, flush=True)
