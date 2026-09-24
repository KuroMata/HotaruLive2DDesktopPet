import os, librosa, numpy as np, soundfile as sf

REPO = "D:/live2d-companion/tts"
SRC = os.path.join(REPO, "ref/prompt.wav")
TXT = os.path.join(REPO, "ref/prompt_reftext.txt")
OUT_WAV = os.path.join(REPO, "ref/prompt_9s.wav")
OUT_TXT = os.path.join(REPO, "ref/prompt_9s_reftext.txt")

TARGET = 9.0  # seconds, within GPT-SoVITS 3~10s window

y, sr = librosa.load(SRC, sr=None, mono=True)
dur = len(y) / sr
print("src dur=%.3fs sr=%d" % (dur, sr))

# find first speech frame: hop through RMS, skip leading silence
frame = 1024
hop = 512
rms = librosa.feature.rms(y=y, frame_length=frame, hop_length=hop)[0]
thr = rms.max() * 0.02
speech_idx = np.where(rms > thr)[0]
if len(speech_idx) > 0:
    start_sec = max(0.0, speech_idx[0] * hop / sr - 0.10)
else:
    start_sec = 0.0
print("first speech ~%.3fs" % start_sec)

# clamp so [start, start+TARGET] fits in audio
if start_sec + TARGET > dur:
    start_sec = max(0.0, dur - TARGET)
s, e = int(start_sec * sr), int(min(dur, start_sec + TARGET) * sr)
seg = y[s:e]
sf.write(OUT_WAV, seg, sr)
print("wrote %s dur=%.3fs" % (OUT_WAV, len(seg)/sr))

# truncate ref_text proportionally to the kept audio fraction (relative to its own span)
with open(TXT, encoding="utf-8") as f:
    full = f.read().strip()
ratio = (len(seg)/sr) / dur
n = max(1, int(round(len(full) * ratio)))
cut = full[:n]
with open(OUT_TXT, "w", encoding="utf-8") as f:
    f.write(cut)
print("wrote %s (%d/%d chars): %s" % (OUT_TXT, len(cut), len(full), cut))
