#!/usr/bin/env bash
# 部署 CosyVoice 2（用于日语零样本克隆：中文参考音频 -> 日语）
# 独立 venv，不污染 index-tts。后台运行，日志见 deploy_cosyvoice.log
set +e
PY="C:/Users/Administrator/AppData/Local/Programs/Python/Python311/python.exe"
SRC="D:/cosyvoice_src"
LOG="D:/live2d-companion/tts/_out/deploy_cosyvoice.log"
mkdir -p "D:/live2d-companion/tts/_out"
echo "===== $(date) deploy start =====" | tee -a "$LOG"

echo "----- 1. clone CosyVoice (shallow) -----" | tee -a "$LOG"
rm -rf "$SRC"
git clone --depth 1 https://github.com/FunAudioLLM/CosyVoice.git "$SRC" >>"$LOG" 2>&1
echo "clone rc=$?" | tee -a "$LOG"

echo "----- 2. create venv (py3.11) -----" | tee -a "$LOG"
"$PY" -m venv "$SRC/.venv" >>"$LOG" 2>&1
VENV="$SRC/.venv/Scripts/python.exe"
"$VENV" -m pip install --upgrade pip >>"$LOG" 2>&1
echo "venv rc=$?" | tee -a "$LOG"

echo "----- 3. install requirements -----" | tee -a "$LOG"
cd "$SRC"
"$VENV" -m pip install -r requirements.txt >>"$LOG" 2>&1
echo "pip rc=$?" | tee -a "$LOG"

echo "----- 4. torch/CUDA check -----" | tee -a "$LOG"
"$VENV" -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'avail', torch.cuda.is_available())" >>"$LOG" 2>&1

echo "----- 5. pre-download model iic/CosyVoice2-0.5B -----" | tee -a "$LOG"
"$VENV" -c "from modelscope import snapshot_download; p=snapshot_download('iic/CosyVoice2-0.5B'); print('MODEL_DIR='+p)" >>"$LOG" 2>&1
echo "download rc=$?" | tee -a "$LOG"

echo "===== $(date) deploy end =====" | tee -a "$LOG"
