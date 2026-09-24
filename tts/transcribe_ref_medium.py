# -*- coding: utf-8 -*-
"""whisper(medium) 重转 prompt.wav，base 幻觉太重，换 medium 提高准确率。"""
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

print("loading whisper medium ...", flush=True)
m = whisper.load_model("medium")
r = m.transcribe(w, language="zh", fp16=False)
text = r["text"].strip()
with open(OUT, "w", encoding="utf-8") as f:
    f.write(text)
print("REF_TEXT:", text, flush=True)
print("SAVED", OUT, flush=True)
