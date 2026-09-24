import os, time
from modelscope import snapshot_download

REPO = "XXXXRT/GPT-SoVITS-Pretrained"
OUT = "D:/live2d-companion/tts/gptsovits-models"
os.makedirs(OUT, exist_ok=True)

t0 = time.time()
print("[download] repo=%s -> %s" % (REPO, OUT), flush=True)
path = snapshot_download(
    model_id=REPO,
    allow_file_pattern=["pretrained_models.zip", "G2PWModel.zip"],
    local_dir=OUT,
)
print("[download] done in %.1fs" % (time.time() - t0), flush=True)
print("[download] files:", flush=True)
for root, _, files in os.walk(OUT):
    for f in files:
        p = os.path.join(root, f)
        print("  %s  (%.1f MB)" % (p, os.path.getsize(p) / 1e6), flush=True)
