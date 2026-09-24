import os, zipfile, sys

REPO = "D:/live2d-companion/tts/GPT-SoVITS"
MODELS = "D:/live2d-companion/tts/gptsovits-models"

# 推理代码默认从 GPT_SoVITS/pretrained_models/ 读取：
#   pretrained_models.zip 顶层为 pretrained_models/  -> 解压到 REPO/GPT_SoVITS/
#   G2PWModel.zip        顶层为 G2PWModel/         -> 解压到 REPO/GPT_SoVITS/pretrained_models/
code_pkg = os.path.join(REPO, "GPT_SoVITS")
pm_dir = os.path.join(code_pkg, "pretrained_models")
if not os.path.isdir(code_pkg):
    sys.exit("ERROR: %s 不存在，请先克隆 GPT-SoVITS 仓库" % code_pkg)
os.makedirs(pm_dir, exist_ok=True)

for zf, dest in [
    (os.path.join(MODELS, "pretrained_models.zip"), code_pkg),
    (os.path.join(MODELS, "G2PWModel.zip"), pm_dir),
]:
    print("extracting", zf, "->", dest)
    with zipfile.ZipFile(zf) as z:
        z.extractall(dest)

print("DONE. pretrained_models at", pm_dir)
print("G2PWModel at", os.path.join(pm_dir, "G2PWModel"))
