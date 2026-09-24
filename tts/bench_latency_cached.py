"""Qwen3-TTS 延迟拆解测试（缓存说话人声纹）
量三件事：
 1) 首次构建 voice_clone_prompt 的成本（15s 参考音频编码 + 声纹提取，只做一次）
 2) 复用缓存 prompt 时，单次合成总耗时 + 组件拆解：AR 生成(talker.generate) vs 声码器解码(speech_tokenizer.decode)
 3) 短句（Vtuber 常见 bark，约 1~2s 语音）的纯合成耗时地板
产物：tts/results/qwen3tts/latency_breakdown.json
"""
import os, sys, time, json, functools
import numpy as np
import torch
import soundfile as sf
import librosa

REF_WAV = "D:/live2d-companion/tts/ref/prompt.wav"
BASE = "D:/live2d-companion/tts/qwen3tts-models/Qwen3-TTS-12Hz-0.6B-Base"
OUT = "D:/live2d-companion/tts/results/qwen3tts"
os.makedirs(OUT, exist_ok=True)


def load_ref_24k(path, max_sec=None):
    w, sr = sf.read(path, dtype="float32", always_2d=False)
    if w.ndim > 1:
        w = np.mean(w, axis=-1)
    if max_sec is not None:
        w = w[: int(sr * max_sec)]
    if sr != 24000:
        w = librosa.resample(w.astype("float32"), orig_sr=sr, target_sr=24000)
    return w.astype(np.float32), 24000


def main():
    from qwen_tts import Qwen3TTSModel

    print("loading model ...", flush=True)
    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(BASE, device_map="cuda:0", dtype=torch.bfloat16)
    print("model loaded %.1fs" % (time.time() - t0), flush=True)

    ref_wav, ref_sr = load_ref_24k(REF_WAV, max_sec=15)

    # ---- 1) 首次构建 prompt（含 15s 参考编码 + 声纹提取）----
    t1 = time.time()
    items = model.create_voice_clone_prompt(ref_audio=(ref_wav, ref_sr), x_vector_only_mode=True)
    t_build = time.time() - t1
    print("build prompt (15s ref encode+spk) = %.2fs" % t_build, flush=True)

    # ---- 插桩：AR 生成 & 声码器解码 ----
    gen_times, dec_times = [], []
    _orig_talker_gen = model.model.talker.generate
    _orig_decode = model.model.speech_tokenizer.decode

    @functools.wraps(_orig_talker_gen)
    def _wrap_talker_gen(*a, **k):
        tg0 = time.time()
        r = _orig_talker_gen(*a, **k)
        gen_times.append(time.time() - tg0)
        return r

    def _wrap_decode(codes, *a, **k):
        td0 = time.time()
        r = _orig_decode(codes, *a, **k)
        dec_times.append(time.time() - td0)
        return r

    model.model.talker.generate = _wrap_talker_gen
    model.model.speech_tokenizer.decode = _wrap_decode

    LONG = "嗨嗨，主子大人，今天心情不错哦。要不我们一起来个桌面整理小挑战吧？"
    SHORT = "好的，我来啦。"

    results = {"build_prompt_sec": round(t_build, 2), "runs": []}

    # ---- 2) 长句多次（缓存 prompt）----
    for i in range(3):
        t2 = time.time()
        wavs, sr = model.generate_voice_clone(text=LONG, language="Chinese", voice_clone_prompt=items)
        dt = time.time() - t2
        w = wavs[0]
        dur = len(w) / sr
        results["runs"].append(dict(
            tag="long#%d" % i, synth_sec=round(dt, 2), audio_sec=round(dur, 2),
            rtf=round(dt / dur, 2), ar_gen_sec=round(gen_times[-1], 2),
            vocoder_sec=round(dec_times[-1], 2)))
        print("long#%d synth=%.2fs audio=%.2fs RTF=%.2f (ar=%.2f voc=%.2f)" %
              (i, dt, dur, dt / dur, gen_times[-1], dec_times[-1]), flush=True)

    # ---- 3) 短句地板 ----
    t3 = time.time()
    wavs, sr = model.generate_voice_clone(text=SHORT, language="Chinese", voice_clone_prompt=items)
    dt = time.time() - t3
    w = wavs[0]
    dur = len(w) / sr
    results["runs"].append(dict(
        tag="short", synth_sec=round(dt, 2), audio_sec=round(dur, 2),
        rtf=round(dt / dur, 2), ar_gen_sec=round(gen_times[-1], 2),
        vocoder_sec=round(dec_times[-1], 2)))
    print("short synth=%.2fs audio=%.2fs RTF=%.2f (ar=%.2f voc=%.2f)" %
          (dt, dur, dt / dur, gen_times[-1], dec_times[-1]), flush=True)

    with open(os.path.join(OUT, "latency_breakdown.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("WROTE latency_breakdown.json", flush=True)


if __name__ == "__main__":
    main()
