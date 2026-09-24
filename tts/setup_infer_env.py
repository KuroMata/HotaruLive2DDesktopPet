import os, sys, subprocess, re

VENV_PY = "D:/live2d-companion/tts/venv-gptsovits/Scripts/python.exe"
REPO = "D:/live2d-companion/tts/GPT-SoVITS"
REQ = os.path.join(REPO, "requirements.txt")
REQ_INFER = os.path.join(REPO, "requirements-infer.txt")

# Lines we already satisfied with a specific CUDA build (don't let requirements
# overwrite our working torch/torchaudio), plus packages that either need a
# heavy GUI server, fail to build on Windows, or are unused for Chinese
# few-shot inference.
# jieba_fast is jieba's Cython fork with an identical public API; it only ships
# sdist and fails to compile on this Windows box (no Windows SDK include path in
# the build env). We install pure-python `jieba` instead and drop a `jieba_fast`
# shim package (see jieba_fast/ in site-packages) that re-exports `jieba`.
SKIP = ("torch", "torchaudio", "gradio", "tensorboard", "wandb", "mvit",
        "pyopenjtalk", "funasr", "faster-whisper", "jieba_fast")

def read_req():
    with open(REQ, encoding="utf-8") as f:
        lines = f.read().splitlines()
    out = []
    for ln in lines:
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        # Drop pip options like "--no-binary=opencc" (we want prebuilt wheels on
        # Windows, not a source build that fails here).
        if s.startswith("-"):
            print("SKIPOPT", s)
            continue
        # strip inline comment / options
        name = re.split(r"[=<>!~ \t]", s)[0].strip().lower()
        if name in SKIP:
            print("SKIP  ", s)
            continue
        out.append(s)
    return out

def main():
    reqs = read_req()
    with open(REQ_INFER, "w", encoding="utf-8") as f:
        f.write("\n".join(reqs) + "\n")
    print("wrote", REQ_INFER, "with", len(reqs), "packages")

    # Install package-by-package with retries. A corporate on-access scanner
    # intermittently locks the dist-info INSTALLER file during pip's atomic
    # rename, raising WinError 5 and aborting the WHOLE `pip install -r`
    # transaction. Installing one package at a time means a transient lock only
    # retries that single package; already-installed ones are skipped instantly.
    print("=== pip install (per-package, with retry) ===")
    failed = []
    for spec in reqs:
        ok = False
        for attempt in range(1, 6):
            r = subprocess.run(
                [VENV_PY, "-m", "pip", "install", "--no-input", spec],
                env={**os.environ, "PIP_NO_INPUT": "1"},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if r.returncode == 0:
                ok = True
                break
            print("  retry %d for %s (rc=%d)" % (attempt, spec, r.returncode))
        print(("OK   " if ok else "FAIL ") + spec)
        if not ok:
            failed.append(spec)
    if failed:
        print("WARN: still failing:", failed)
    else:
        print("pip install OK (all packages)")

    # Build monotonic_align if present (needs MSVC vcvars env passed via PATH)
    ma = os.path.join(REPO, "GPT_SoVITS", "monotonic_align")
    setup = os.path.join(ma, "setup.py")
    if os.path.isfile(setup):
        print("=== build monotonic_align ===")
        try:
            rb = subprocess.run([VENV_PY, "setup.py", "build_ext", "--inplace"], cwd=ma)
            print("monotonic_align build rc=", rb.returncode)
        except Exception as e:
            print("monotonic_align build error:", e)
    else:
        print("no monotonic_align/setup.py (newer repo may not need it)")

    print("DONE setup_infer_env")

if __name__ == "__main__":
    main()
