"""Qwen3-TTS 语音合成模块（萤 音色）— 声纹缓存 + 短语磁盘缓存

设计目标：在"本地、自然可懂、≤2 秒"约束下，用"离线预渲染短语缓存"满足绝大多数
Vtuber 固定台词（命中 0ms 自然），动态/长尾文本回退到现合成（仍用同一引擎，音质一致）。

用法:
  python speak.py "要说的文本"            # 合成（命中缓存则 0ms），存 wav，打印耗时
  python speak.py --warmup               # 预渲染内置常用台词到缓存
  python speak.py --list-cache           # 列出当前缓存条目
依赖: venv-qwen3tts + Qwen3-TTS-12Hz-0.6B-Base + prompt.wav
注意: 当前用 x_vector_only 模式（免 ref_text）。拿到 prompt.wav 原话后改 ICL 模式音质更佳。
"""
import os, sys, time, json, hashlib
import numpy as np
import torch
import soundfile as sf
import librosa

REF_WAV = "D:/live2d-companion/tts/ref/prompt.wav"
BASE = "D:/live2d-companion/tts/qwen3tts-models/Qwen3-TTS-12Hz-0.6B-Base"
CACHE_DIR = "D:/live2d-companion/tts/results/phrase_cache"
OUT_DIR = "D:/live2d-companion/tts/results/qwen3tts"
MANIFEST = os.path.join(CACHE_DIR, "manifest.json")
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)

# 内置常用台词（warmup 预渲染，运行时命中即 0ms）
DEFAULT_PHRASES = [
    "嗨嗨，主子大人，今天心情不错哦。",
    "好的，我来啦。",
    "嗯，我在听呢。",
    "主人说得对。",
    "稍等一下，我看看。",
    "今天也要一起加油哦。",
]

_model = None
_vc_items = None


def _load_ref_24k(path, max_sec=15):
    w, sr = sf.read(path, dtype="float32", always_2d=False)
    if w.ndim > 1:
        w = np.mean(w, axis=-1)
    w = w[: int(sr * max_sec)]
    if sr != 24000:
        w = librosa.resample(w.astype("float32"), orig_sr=sr, target_sr=24000)
    return w.astype(np.float32), 24000


def get_model():
    """懒加载 + 缓存模型与声纹 prompt（进程内单例）。"""
    global _model, _vc_items
    if _model is not None:
        return _model, _vc_items
    from qwen_tts import Qwen3TTSModel
    print("[speak] loading Qwen3-TTS 0.6B-Base ...", flush=True)
    t0 = time.time()
    _model = Qwen3TTSModel.from_pretrained(BASE, device_map="cuda:0", dtype=torch.bfloat16)
    print("[speak] model loaded in %.1fs" % (time.time() - t0), flush=True)
    ref_wav, ref_sr = _load_ref_24k(REF_WAV)
    _vc_items = _model.create_voice_clone_prompt(ref_audio=(ref_wav, ref_sr), x_vector_only_mode=True)
    print("[speak] voice_clone_prompt cached (one-time).", flush=True)
    return _model, _vc_items


def _hash(text):
    return hashlib.md5(text.encode("utf-8")).hexdigest()[:12]


def _load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_manifest(m):
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


def synth(text, language="Chinese"):
    """现合成一句话，返回 (wav_path, dur, synth_sec)。"""
    model, items = get_model()
    t0 = time.time()
    wavs, sr = model.generate_voice_clone(text=text, language=language, voice_clone_prompt=items)
    dt = time.time() - t0
    w = wavs[0]
    dur = len(w) / sr
    ts = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(OUT_DIR, "speak_%s.wav" % ts)
    sf.write(path, w, sr)
    return path, dur, dt


def speak(text, use_cache=True):
    """优先命中短语缓存（0ms），未命中则现合成并写回缓存。
    返回 dict: {text, wav, dur, synth_sec, cache_hit(bool)}"""
    h = _hash(text)
    man = _load_manifest()
    cache_path = os.path.join(CACHE_DIR, "%s.wav" % h)
    if use_cache and h in man and os.path.exists(cache_path):
        info = man[h]
        w, sr = sf.read(cache_path, dtype="float32", always_2d=False)
        dur = len(w) / sr
        return dict(text=text, wav=cache_path, dur=round(dur, 2), synth_sec=0.0,
                    cache_hit=True, sr=int(sr))
    # 未命中：现合成
    path, dur, dt = synth(text)
    # 写回缓存
    import shutil
    shutil.copy(path, cache_path)
    man[h] = dict(text=text, wav=cache_path, dur=round(dur, 2))
    _save_manifest(man)
    return dict(text=text, wav=cache_path, dur=round(dur, 2), synth_sec=round(dt, 2),
                cache_hit=False, sr=24000)


def warmup(phrases=None):
    phrases = phrases or DEFAULT_PHRASES
    print("[speak] warmup: pre-render %d phrases into cache" % len(phrases), flush=True)
    for p in phrases:
        r = speak(p, use_cache=True)
        print("  %-40s cache_hit=%s synth=%.2fs dur=%.2fs" %
              (p[:38], r["cache_hit"], r["synth_sec"], r["dur"]), flush=True)
    print("[speak] warmup done.", flush=True)


def list_cache():
    man = _load_manifest()
    print("phrase cache entries: %d" % len(man))
    for h, v in man.items():
        print("  [%s] %s (%.2fs)" % (h, v["text"], v.get("dur", 0)))


def main():
    args = sys.argv[1:]
    if "--warmup" in args:
        warmup()
        return
    if "--list-cache" in args:
        list_cache()
        return
    text = " ".join(a for a in args if not a.startswith("--"))
    if not text:
        text = "嗨嗨，主子大人，今天心情不错哦。"
    r = speak(text)
    print(json.dumps({k: r[k] for k in ("text", "wav", "dur", "synth_sec", "cache_hit")},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
