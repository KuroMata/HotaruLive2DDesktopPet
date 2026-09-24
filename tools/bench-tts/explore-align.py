# -*- coding: utf-8 -*-
"""探索：用 CosyVoice 整句现合成 → openai-whisper 取字级时间戳 → 切分。
验证 whisper 在中文短句上的 word 级时间戳是否等于逐字、顺序是否与原句一致。
不依赖 ffmpeg：自己用 soundfile 读 24k，librosa 重采样到 16k 喂给 whisper。
"""
import sys
sys.path.insert(0, "D:/cosyvoice_src")
sys.path.insert(0, "D:/live2d-companion/tts")
import json
import torch
import numpy as np
import soundfile as sf
import librosa
import whisper
from cosy_gen import load_cosy

SR = 24000
REF = "D:/live2d-companion/tts/ref/prompt.wav"
TEXTS = ["你好呀", "欢迎回来", "今天天气不错", "我来念一段弹幕", "你的名字真有趣"]


def synth_full(text):
    wavs = []
    for c in load_cosy().inference_cross_lingual(
            tts_text=text, prompt_wav=REF, zero_shot_spk_id="", stream=False, speed=1.0):
        wavs.append(c["tts_speech"])
    w = torch.cat(wavs, dim=-1).squeeze(0).cpu().numpy().astype(np.float32)
    return w


def main():
    cosy = load_cosy()
    model = whisper.load_model("tiny")
    report = {}
    for text in TEXTS:
        w = synth_full(text)
        sf.write("D:/tmp-trt/explore_%s.wav" % text, w, SR)
        w16 = librosa.resample(w.astype(np.float64), orig_sr=SR, target_sr=16000).astype(np.float32)
        res = model.transcribe(w16, language="zh", word_timestamps=True,
                               prepend_punctuations="", append_punctuations="")
        words = []
        for seg in res["segments"]:
            for wd in seg.get("words", []):
                words.append({"word": wd["word"], "start": round(wd["start"], 3),
                              "end": round(wd["end"], 3)})
        report[text] = {"recog": res["text"].strip(), "n_words": len(words),
                        "n_chars": len(text), "words": words}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
