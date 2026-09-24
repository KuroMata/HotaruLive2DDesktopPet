# -*- coding: utf-8 -*-
"""GPT-SoVITS 语音引擎「就绪度」检测（桌宠向导用）。

设计约束：**只依赖标准库**。向导可能在一台"什么都没装"的机器上跑这段检测，
那时只能用系统里随便哪个 Python 来执行它，所以不能 import 任何第三方包。

用法：
  python detect_engine.py [--root <tts 目录>] [--need-bytes]

输出（stdout，单行 JSON）：
  {
    "root": "...", "ready": true,
    "checks": [{"id","label","ok","detail","fix"}...],
    "missing": ["weights.v2Pro", ...],
    "needBytes": 11811160064,
    "diskFreeBytes": 123456789
  }

`checks` 每项都带 `fix`：缺什么、该怎么补（向导直接把这句显示给用户）。
"""
import argparse
import json
import os
import shutil
import sys

# 通用引擎的下载体积估算（分离下载方案）：源码 ~0.1G + 权重 5.2G + Python 环境 6.5G
NEED_BYTES = int(11.8 * 1024 ** 3)


def _file(path):
    try:
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except Exception:
        return False


def _dir(path):
    try:
        return os.path.isdir(path)
    except Exception:
        return False


def _mb(path):
    try:
        if os.path.isfile(path):
            return os.path.getsize(path) / 1048576.0
        total = 0
        for r, _d, fs in os.walk(path):
            for n in fs:
                try:
                    total += os.path.getsize(os.path.join(r, n))
                except Exception:
                    pass
        return total / 1048576.0
    except Exception:
        return 0.0


def detect(root):
    repo = os.path.join(root, "GPT-SoVITS")
    code = os.path.join(repo, "GPT_SoVITS")
    pm = os.path.join(code, "pretrained_models")
    venv_py = os.path.join(root, "venv-gptsovits", "Scripts", "python.exe")
    ref = os.path.join(root, "ref", "prompt_9s.wav")
    ref_txt = os.path.join(root, "ref", "prompt_9s_reftext.txt")

    checks = []

    # ① 引擎源码：推理入口存在即算有
    tts_py = os.path.join(code, "TTS_infer_pack", "TTS.py")
    checks.append({
        "id": "repo", "label": "引擎源码（GPT-SoVITS）", "ok": _file(tts_py),
        "detail": "已就位" if _file(tts_py) else "未安装（约 100 MB）",
        "fix": "向导会自动下载源码包并解压到 " + repo,
    })

    # ② 通用预训练权重：逐个关键文件判（缺哪个说哪个，别只说"权重没装"）
    weights = [
        ("gsv-v2final-s1", os.path.join(pm, "gsv-v2final-pretrained",
                                        "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"), "GPT 语义模型 (s1)"),
        ("v2pro-s2", os.path.join(pm, "v2Pro", "s2Gv2Pro.pth"), "声码器 (s2 v2Pro)"),
        ("bert", os.path.join(pm, "chinese-roberta-wwm-ext-large"), "中文 BERT"),
        ("hubert", os.path.join(pm, "chinese-hubert-base"), "HuBERT 编码器"),
        ("g2pw", os.path.join(pm, "G2PWModel", "g2pW.onnx"), "中文注音 G2PW"),
    ]
    missing_w = []
    for wid, p, label in weights:
        ok = _dir(p) if wid in ("bert", "hubert") else _file(p)
        if not ok:
            missing_w.append(wid)
        checks.append({
            "id": "weights." + wid, "label": "权重：" + label, "ok": ok,
            "detail": "已就位" if ok else "缺失",
            "fix": "从 ModelScope 下载通用预训练权重（共约 5.2 GB）",
        })

    # ③ Python 运行环境：venv 里有 torch 才算真能跑（只看 python.exe 会被"空壳 venv"骗过）
    venv_ok = _file(venv_py)
    torch_ok = _dir(os.path.join(root, "venv-gptsovits", "Lib", "site-packages", "torch"))
    checks.append({
        "id": "python", "label": "Python 运行环境（torch cu126）", "ok": bool(venv_ok and torch_ok),
        "detail": ("已就位" if torch_ok else ("有解释器但缺 torch" if venv_ok else "未安装（约 6.5 GB）")),
        "fix": "向导会自动准备 Python 3.11 并安装 torch(CUDA) 等依赖",
    })

    # ④ 声库：安装包内置，正常一定在（就是"默认用你的音色"的那份参考音频）
    voice_ok = _file(ref) and _file(ref_txt)
    checks.append({
        "id": "voice", "label": "声库（参考音频，内置）", "ok": voice_ok,
        "detail": ("已内置 · %.0f KB" % (_mb(ref) * 1024)) if voice_ok else "缺失（参考音频不在安装目录里）",
        "fix": "声库随安装包分发，缺失说明安装不完整，请重新安装",
    })

    ready = all(c["ok"] for c in checks)
    missing = [c["id"] for c in checks if not c["ok"]]

    disk_free = -1
    try:
        st = os.statvfs(root) if hasattr(os, "statvfs") else None
        if st:
            disk_free = st.f_bavail * st.f_frsize
        else:
            import ctypes
            free = ctypes.c_ulonglong(0)
            ctypes.windll.kernel32.GetDiskFreeSpaceExW(
                ctypes.c_wchar_p(root), None, None, ctypes.pointer(free))
            disk_free = int(free.value)
    except Exception:
        disk_free = -1

    return {
        "root": root,
        "ready": ready,
        "checks": checks,
        "missing": missing,
        "needBytes": NEED_BYTES,
        "diskFreeBytes": disk_free,
        "python3_11_found": find_python311(),
    }


def find_python311():
    """找一个可用的 Python 3.11（优先 py 启动器，其次常见安装路径）。

    返回解释器绝对路径；找不到返回 ""。**只探测，不安装**。
    """
    # 1) 当前解释器就是 3.11 —— 最常见（向导自己就是用它跑的）
    if sys.version_info[:2] == (3, 11):
        return sys.executable
    # 2) py 启动器
    py = shutil.which("py")
    if py:
        try:
            import subprocess
            out = subprocess.check_output(
                [py, "-3.11", "-c", "import sys;print(sys.executable)"],
                stderr=subprocess.DEVNULL, timeout=15)
            p = out.decode("utf-8", "ignore").strip().splitlines()[-1]
            if p and os.path.isfile(p):
                return p
        except Exception:
            pass
    # 3) 常见安装位置
    la = os.environ.get("LOCALAPPDATA", "")
    cands = [
        os.path.join(la, "Programs", "Python", "Python311", "python.exe"),
        "C:\\Python311\\python.exe",
        "C:\\Program Files\\Python311\\python.exe",
    ]
    for c in cands:
        if _file(c):
            return c
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.dirname(os.path.abspath(__file__)))
    args = ap.parse_args()
    res = detect(os.path.abspath(args.root))
    sys.stdout.write(json.dumps(res, ensure_ascii=False))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
