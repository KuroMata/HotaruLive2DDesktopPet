#!/usr/bin/env bash
# 重装 CosyVoice 2 推理依赖（去掉 openai-whisper，torch 锁 cu118，与 index-tts 一致）
set +e
VENV="D:/cosyvoice_src/.venv/Scripts/python.exe"
LOG="D:/live2d-companion/tts/_out/install_cosyvoice_deps.log"
echo "===== $(date) deps install start =====" | tee -a "$LOG"

echo "----- upgrade setuptools/wheel -----" | tee -a "$LOG"
"$VENV" -m pip install -U setuptools wheel >>"$LOG" 2>&1
echo "rc=$?" | tee -a "$LOG"

echo "----- install core inference deps (cu118) -----" | tee -a "$LOG"
"$VENV" -m pip install --extra-index-url https://download.pytorch.org/whl/cu118 \
  torch==2.3.1 torchaudio==2.3.1 \
  modelscope==1.20.0 transformers==4.51.3 x-transformers==2.11.24 conformer==0.3.2 \
  HyperPyYAML==1.2.3 omegaconf==2.3.0 numpy==1.26.4 librosa==0.10.2 soundfile==0.12.1 \
  wetext==0.0.4 onnxruntime==1.18.0 onnx==1.16.0 pyworld==0.3.4 inflect==7.3.1 \
  networkx==3.1 protobuf==4.25 rich==13.7.1 \
  >>"$LOG" 2>&1
echo "rc=$?" | tee -a "$LOG"

echo "----- torch/CUDA check -----" | tee -a "$LOG"
"$VENV" -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'avail', torch.cuda.is_available())" >>"$LOG" 2>&1

echo "----- import cosyvoice cli -----" | tee -a "$LOG"
"$VENV" -c "import sys; sys.path.insert(0,'D:/cosyvoice_src'); from cosyvoice.cli.model import CosyVoice2; print('CosyVoice2 import OK')" >>"$LOG" 2>&1
echo "import rc=$?" | tee -a "$LOG"

echo "===== $(date) deps install end =====" | tee -a "$LOG"
