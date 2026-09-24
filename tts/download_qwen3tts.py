# -*- coding: utf-8 -*-
"""用 modelscope SDK 下载 Qwen3-TTS 权重（修正 python -m modelscope 不可用的问题）"""
import os, sys

MODELS = "D:/live2d-companion/tts/qwen3tts-models"
os.makedirs(MODELS, exist_ok=True)

repos = [
    ("Qwen/Qwen3-TTS-Tokenizer-12Hz", os.path.join(MODELS, "Qwen3-TTS-Tokenizer-12Hz")),
    ("Qwen/Qwen3-TTS-12Hz-0.6B-Base", os.path.join(MODELS, "Qwen3-TTS-12Hz-0.6B-Base")),
]

try:
    from modelscope import snapshot_download
    print("using modelscope snapshot_download", flush=True)
    for repo, local in repos:
        print("=== download %s -> %s" % (repo, local), flush=True)
        p = snapshot_download(repo, local_dir=local)
        print("OK: %s" % p, flush=True)
except Exception as e:
    print("MODELSCOPE_FAIL: %r" % e, flush=True)
    print("=== fallback: huggingface_hub ===", flush=True)
    try:
        from huggingface_hub import snapshot_download as hf_dl
        for repo, local in repos:
            print("=== hf download %s -> %s" % (repo, local), flush=True)
            p = hf_dl(repo, local_dir=local)
            print("OK: %s" % p, flush=True)
    except Exception as e2:
        print("HF_FAIL: %r" % e2, flush=True)
        sys.exit(1)

print("ALL_DONE", flush=True)
