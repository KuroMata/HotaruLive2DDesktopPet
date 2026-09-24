# -*- coding: utf-8 -*-
"""GPT-SoVITS 通用语音引擎「装配器」（分离下载方案）。

由桌宠的语音引擎向导调用：向导负责选解释器 / 起进程 / 显示进度，
下载、解压、pip、兼容性修补全部在本脚本里完成。

为什么要有这个脚本：NSIS 安装包有 2 GB 硬上限，而通用引擎（源码 + 通用预训练
权重 + Python 环境）约 11.8 GB，塞不进安装包，只能首启现装。**注意声库（用户
音色，<1 MB）是随安装包内置的**，这里不涉及——它只装"跟谁的声音无关"的部分。

进度协议（stdout，每行一个 JSON 对象；人类可读日志一律走 stderr，避免污染）：
  {"step":"weights","percent":42.5,"message":"正在下载权重…","bytes":1,"total":2}
末行固定为 {"step":"done","percent":100,...}。

用法：
  python provision_engine.py --root <tts 目录> [--dry-run] [--skip python,source]
                             [--python-mode auto|reuse|installer]

退出码：0 成功；非 0 失败（末行会带 "ok": false 与 error）。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    from detect_engine import find_python311  # 复用探测逻辑，避免两处各写一份
except Exception:  # 极端情况（被单独拷走）：退化成只认当前解释器
    def find_python311():
        return sys.executable if sys.version_info[:2] == (3, 11) else ""

PY_VERSION = "3.11.9"
PY_INSTALLER_URL = "https://www.python.org/ftp/python/%s/python-%s-amd64.exe" % (PY_VERSION, PY_VERSION)
# 源码包：走镜像（境外直连在大包协商阶段容易挂死，这是踩过的坑）
SRC_TAG = "20250606v2pro"
SRC_PATH = "RVC-Boss/GPT-SoVITS/archive/refs/tags/%s.tar.gz" % SRC_TAG
MIRRORS = ["https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/", ""]
# 通用预训练权重（ModelScope）。这里**只装通用权重**，与用户音色无关。
WEIGHTS_REPO = "XXXXRT/GPT-SoVITS-Pretrained"
WEIGHTS_FILES = ["pretrained_models.zip", "G2PWModel.zip"]
# requirements 里这些不装：torch/torchaudio 单独指定 CUDA 源；其余是训练期或不需要的
PIP_SKIP = {"torch", "torchaudio", "gradio", "pyopenjtalk", "funasr",
            "faster-whisper", "jieba_fast", "tensorboard", "onnxruntime-gpu"}
PIP_INDEX_CUDA = "https://download.pytorch.org/whl/cu126"
PIP_INDEX_CN = "https://pypi.tuna.tsinghua.edu.cn/simple"

STEPS = ["python", "source", "weights", "deps", "fixups", "voice", "verify"]


def emit(step, percent, message, ok=None, **extra):
    obj = {"step": step, "percent": round(float(percent), 1), "message": str(message)}
    if ok is not None:
        obj["ok"] = bool(ok)
    obj.update(extra)
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write("[provision] %s\n" % msg)
    sys.stderr.flush()


# --------------------------------------------------------------------------- 工具
def run(cmd, cwd=None, timeout=None, on_line=None, env=None):
    """跑子进程并把输出按行回调（给 pip / 自检用）。返回 (code, tail)。"""
    log("$ " + " ".join(str(c) for c in cmd))
    try:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, universal_newlines=True,
                             encoding="utf-8", errors="replace")
    except Exception as e:
        return 127, "无法启动：%s" % e
    tail = []
    t0 = time.time()
    try:
        for line in p.stdout:
            line = line.rstrip()
            if line:
                tail.append(line)
                if len(tail) > 40:
                    tail.pop(0)
                if on_line:
                    on_line(line)
            if timeout and (time.time() - t0) > timeout:
                p.kill()
                return 124, "超时"
        p.wait()
    except Exception as e:
        try:
            p.kill()
        except Exception:
            pass
        return 1, str(e)
    return p.returncode, "\n".join(tail)


def http_get(url, dest, job=None, step="download", what=""):
    """带进度 + 断点续传的下载（.part 临时文件）。返回最终字节数。"""
    import urllib.request
    part = dest + ".part"
    start = os.path.getsize(part) if os.path.isfile(part) else 0
    req = urllib.request.Request(url, headers={"User-Agent": "HotaruPet-EngineWizard"})
    if start:
        req.add_header("Range", "bytes=%d-" % start)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(req, timeout=60) as r:
        total = int(r.headers.get("Content-Length") or 0)
        if r.status == 200 and start:      # 服务端不认 Range：从头写
            start, total = 0, total
        elif r.status == 206:
            total += start
        mode = "ab" if start else "wb"
        got = start
        last = 0.0
        with open(part, mode) as f:
            while True:
                if job is not None and job.get("cancelled"):
                    raise RuntimeError("已取消")
                chunk = r.read(262144)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                now = time.time()
                if now - last > 0.4:
                    last = now
                    pct = (got / total * 100) if total else 0
                    emit(step, pct, "正在下载%s…" % what, bytes=got, total=total)
    if os.path.isfile(dest):
        os.remove(dest)
    os.replace(part, dest)
    if os.path.isfile(part + ".meta"):
        os.remove(part + ".meta")
    return os.path.getsize(dest)


def pip_install(py, args, step="deps", what="", tries=3):
    """逐条 pip 安装 + 重试。本机踩过：终端防护会在 pip 原子重命名时瞬时持锁，
    整批安装会随机回滚；逐条安装并重试可以把损失限制在单个包上。"""
    for i in range(tries):
        code, tail = run([py, "-m", "pip", "install", "--disable-pip-version-check", "-q"] + args,
                         on_line=lambda l: log("pip| " + l))
        if code == 0:
            return True
        log("pip 第 %d 次失败（%s）：%s" % (i + 1, what, tail[-400:]))
        time.sleep(2)
    return False


# --------------------------------------------------------------------------- 各步
def step_python(ctx):
    root, mode = ctx["root"], ctx["python_mode"]
    venv_py = os.path.join(root, "venv-gptsovits", "Scripts", "python.exe")
    if os.path.isfile(venv_py):
        # 超时给足：torch 首次 import 要加载一堆 DLL，本机实测十几秒；
        # 超时太短会误判成"环境坏了"→ 重建 venv（5.4 GB，代价极大）。
        code, _ = run([venv_py, "-c", "import torch,sys;print(torch.__version__)"], timeout=420)
        if code == 0:
            emit("python", 100, "已有可用的 Python 环境，跳过")
            ctx["py"] = venv_py
            return True
        # 安全闸：重建会删掉整个运行环境（约 5.4 GB）。必须是显式要求才动手，
        # 否则一次 torch 加载抖动就会把用户装好的环境清掉。
        if not ctx.get("rebuild_env"):
            emit("python", 0, "已有运行环境但 torch 不可用。如确认要重建，请加 --rebuild-env 重试", ok=False)
            return False
        log("已有 venv 但 torch 不可用，按 --rebuild-env 重建")

    base = find_python311() if mode != "installer" else ""
    if not base and mode != "reuse":
        dest = os.path.join(ctx["work"], "python-3.11-amd64.exe")
        part = dest + ".part"
        emit("python", 5, "未找到 Python 3.11，正在下载官方安装包…")
        # 官方源在境外可能慢，走一遍镜像回退。**换源前必须清掉 .part**，
        # 否则会从上一家的半截包续传、拼出一个坏安装包。
        got_it = False
        for m in ("", "https://mirror.nju.edu.cn/python/",
                  "https://mirrors.aliyun.com/python-release/windows/"):
            url = (m + "python-%s-amd64.exe" % PY_VERSION) if m else PY_INSTALLER_URL
            try:
                try:
                    os.remove(part)
                except Exception:
                    pass
                emit("python", 5, "正在下载 Python 安装包…", source=(m or "python.org"))
                http_get(url, dest, ctx["job"], "python", "Python 安装包")
                got_it = True
                break
            except Exception as e:
                log("Python 安装包源失败：%s" % e)
        if not got_it or not os.path.isfile(dest):
            emit("python", 0, "Python 安装包下载失败", ok=False)
            return False
        emit("python", 60, "正在静默安装 Python 3.11（免管理员）…")
        code, _ = run([dest, "/quiet", "InstallAllUsers=0", "Include_launcher=0",
                       "Include_test=0", "PrependPath=0", "SimpleInstall=1"], timeout=900)
        if code != 0:
            emit("python", 0, "Python 安装失败（code=%s）" % code, ok=False)
            return False
        base = find_python311()
    if not base:
        emit("python", 0, "找不到可用的 Python 3.11，请手动安装后重试", ok=False)
        return False
    log("使用基础解释器：%s" % base)

    emit("python", 75, "正在创建独立运行环境…")
    if os.path.isdir(os.path.join(root, "venv-gptsovits")):
        shutil.rmtree(os.path.join(root, "venv-gptsovits"), ignore_errors=True)
    code, tail = run([base, "-m", "venv", os.path.join(root, "venv-gptsovits")], timeout=600)
    if code != 0 or not os.path.isfile(venv_py):
        emit("python", 0, "创建运行环境失败：%s" % tail[-200:], ok=False)
        return False
    run([venv_py, "-m", "pip", "install", "-q", "--upgrade", "pip", "setuptools<81", "wheel"],
        timeout=600, on_line=lambda l: log("pip| " + l))
    ctx["py"] = venv_py
    emit("python", 100, "Python 环境就绪")
    return True


def step_source(ctx):
    repo = os.path.join(ctx["root"], "GPT-SoVITS")
    if os.path.isfile(os.path.join(repo, "GPT_SoVITS", "TTS_infer_pack", "TTS.py")):
        emit("source", 100, "引擎源码已在，跳过")
        return True
    dest = os.path.join(ctx["work"], "gptsovits-src.tar.gz")
    ok = False
    for m in MIRRORS:
        try:
            try:
                os.remove(dest + ".part")   # 换源前清半截包，避免跨源续传拼坏
            except Exception:
                pass
            emit("source", 5, "正在下载引擎源码…", source=(m or "GitHub 直连"))
            http_get(m + SRC_PATH if m else "https://github.com/" + SRC_PATH,
                     dest, ctx["job"], "source", "引擎源码（约 6 MB）")
            ok = True
            break
        except Exception as e:
            log("源码镜像失败：%s" % e)
    if not ok:
        emit("source", 0, "源码下载失败（所有镜像都不通）", ok=False)
        return False
    emit("source", 70, "正在解压源码…")
    tmp = os.path.join(ctx["work"], "src-x")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    with tarfile.open(dest, "r:gz") as t:
        t.extractall(tmp)
    inner = [os.path.join(tmp, n) for n in os.listdir(tmp)]
    inner = [p for p in inner if os.path.isdir(p)]
    if not inner:
        emit("source", 0, "源码包内容异常", ok=False)
        return False
    if os.path.isdir(repo):
        shutil.rmtree(repo, ignore_errors=True)
    shutil.move(inner[0], repo)
    emit("source", 100, "引擎源码就绪")
    return True


def step_weights(ctx):
    py, root = ctx["py"], ctx["root"]
    code, _ = run([py, "-c", "import modelscope"], timeout=120)
    if code != 0:
        emit("weights", 2, "正在准备下载组件…")
        if not pip_install(py, ["-i", PIP_INDEX_CN, "modelscope"], "weights", "modelscope"):
            emit("weights", 0, "下载组件安装失败", ok=False)
            return False
    out = os.path.join(root, "gptsovits-models")
    os.makedirs(out, exist_ok=True)
    emit("weights", 5, "正在从 ModelScope 下载通用预训练权重（约 5.2 GB，请耐心）…")
    script = (
        "from modelscope import snapshot_download;"
        "snapshot_download(model_id=%r, allow_file_pattern=%r, local_dir=%r)"
        % (WEIGHTS_REPO, WEIGHTS_FILES, out)
    )
    # snapshot_download 没有细粒度进度回调，只能给个不定进度 + 心跳
    proc = subprocess.Popen([py, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            universal_newlines=True, encoding="utf-8", errors="replace")
    t0 = time.time()
    pct = 5.0
    while proc.poll() is None:
        if ctx["job"].get("cancelled"):
            proc.kill()
            raise RuntimeError("已取消")
        time.sleep(1.5)
        pct = min(88.0, pct + 0.4)
        got = 0
        for r, _d, fs in os.walk(out):
            for n in fs:
                try:
                    got += os.path.getsize(os.path.join(r, n))
                except Exception:
                    pass
        emit("weights", pct, "正在下载权重… %.2f GB" % (got / 1073741824.0),
             bytes=got, total=int(5.2 * 1073741824))
    if proc.returncode != 0:
        emit("weights", 0, "权重下载失败（code=%s）" % proc.returncode, ok=False)
        return False

    emit("weights", 90, "正在解压权重…")
    code_pkg = os.path.join(root, "GPT-SoVITS", "GPT_SoVITS")
    pm = os.path.join(code_pkg, "pretrained_models")
    os.makedirs(pm, exist_ok=True)
    for zf, dst in ((os.path.join(out, "pretrained_models.zip"), code_pkg),
                    (os.path.join(out, "G2PWModel.zip"), pm)):
        if not os.path.isfile(zf):
            emit("weights", 0, "缺少权重包：%s" % os.path.basename(zf), ok=False)
            return False
        with zipfile.ZipFile(zf) as z:
            z.extractall(dst)
    emit("weights", 100, "通用权重就绪（约 5.2 GB）")
    return True


def step_deps(ctx):
    py, repo = ctx["py"], os.path.join(ctx["root"], "GPT-SoVITS")
    emit("deps", 2, "正在安装 PyTorch（CUDA 12.6，约 2.5 GB 下载）…")
    if not pip_install(py, ["--index-url", PIP_INDEX_CUDA, "torch", "torchaudio"],
                       "deps", "torch"):
        emit("deps", 0, "PyTorch 安装失败（请检查网络/pip 源）", ok=False)
        return False
    emit("deps", 45, "正在安装其余依赖…")
    req = os.path.join(repo, "requirements.txt")
    pkgs = []
    if os.path.isfile(req):
        with open(req, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                name = s.split("==")[0].split(">=")[0].split("<")[0].strip().lower()
                if name in PIP_SKIP:
                    continue
                pkgs.append(s)
    # numpy 必须 <2（librosa/numba 需要）；matplotlib 推理不直接用但 AR 模块顶层 import
    pkgs += ["numpy<2", "matplotlib", "opencc"]
    total = len(pkgs)
    for i, p in enumerate(pkgs):
        if not pip_install(py, ["-i", PIP_INDEX_CN, p], "deps", p):
            log("依赖安装失败（跳过）：%s" % p)   # 非致命：缺了会在自检暴露
        emit("deps", 45 + 50.0 * (i + 1) / max(1, total), "正在安装依赖（%d/%d）…" % (i + 1, total))
    emit("deps", 100, "依赖安装完成")
    return True


def step_fixups(ctx):
    """兼容性修补。这三处都是本机实测踩过的坑，缺了推理起不来。"""
    py, root = ctx["py"], ctx["root"]
    sp = os.path.join(root, "venv-gptsovits", "Lib", "site-packages")
    emit("fixups", 5, "正在应用兼容性修补…")

    # ① jieba_fast 在 Windows 编译失败；仓库只用 cut/posseg.lcut/setLogLevel，
    #    用纯 Python jieba 做壳即可。
    code = (
        "import os,sys,site;sp=site.getsitepackages()[-1] if hasattr(site,'getsitepackages') else %r;"
        "d=os.path.join(sp,'jieba_fast');os.makedirs(d,exist_ok=True);"
        "open(os.path.join(d,'__init__.py'),'w',encoding='utf-8').write("
        "\"from jieba import *\\nimport jieba as _j\\ndef setLogLevel(*a,**k):\\n    return getattr(_j,'setLogLevel',lambda *a,**k:None)(*a,**k)\\n\")"
        " ;p=os.path.join(d,'posseg');os.makedirs(p,exist_ok=True);"
        "open(os.path.join(p,'__init__.py'),'w',encoding='utf-8').write("
        "\"from jieba.posseg import *\\nfrom jieba.posseg import lcut\\n\")"
    ) % sp
    run([py, "-c", code], timeout=60)

    # ② tools/my_utils.py 顶层 import gradio 会挡住推理加载（gradio 只在训练期用到）
    mu = os.path.join(root, "GPT-SoVITS", "tools", "my_utils.py")
    if os.path.isfile(mu):
        try:
            s = open(mu, encoding="utf-8").read()
            if "import gradio" in s and "try:" not in s.split("import gradio")[0][-40:]:
                s = s.replace("import gradio",
                              "try:\n    import gradio\nexcept ImportError:\n    gradio = None", 1)
                open(mu, "w", encoding="utf-8").write(s)
                log("已把 my_utils.py 的 gradio 改成可选导入")
        except Exception as e:
            log("my_utils 修补失败（非致命）：%s" % e)

    emit("fixups", 100, "兼容性修补完成")
    return True


def step_voice(ctx):
    """声库就位。声库随安装包内置（<1 MB），此处只保证它在预期位置。"""
    root = ctx["root"]
    ref = os.path.join(root, "ref", "prompt_9s.wav")
    txt = os.path.join(root, "ref", "prompt_9s_reftext.txt")
    ok = os.path.isfile(ref) and os.path.isfile(txt)
    emit("voice", 100, ("声库已内置（你的音色）" if ok else "声库缺失，请重新安装"), ok=ok)
    return ok


def step_verify(ctx):
    py, root = ctx["py"], ctx["root"]
    emit("verify", 10, "正在自检（加载引擎入口）…")
    repo = os.path.join(root, "GPT-SoVITS")
    code = (
        "import os,sys;os.chdir(%r);sys.path[:0]=[%r,os.path.join(%r,'GPT_SoVITS'),"
        "os.path.join(%r,'GPT_SoVITS','eres2net')];import torch;"
        "from GPT_SoVITS.TTS_infer_pack.TTS import TTS,TTS_Config;"
        "print('VERIFY_OK cuda=',torch.cuda.is_available())"
        % (repo, repo, repo, repo)
    )
    code_out, tail = run([py, "-c", code], timeout=600)
    okv = (code_out == 0) and ("VERIFY_OK" in tail)
    emit("verify", 100, ("自检通过：" + tail.splitlines()[-1]) if okv else "自检未通过，见日志", ok=okv)
    return okv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=HERE)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip", default="")
    ap.add_argument("--python-mode", default="auto", choices=["auto", "reuse", "installer"])
    ap.add_argument("--rebuild-env", action="store_true",
                    help="允许删除并重建已有的 venv-gptsovits（会清掉约 5.4 GB 环境，请谨慎）")
    ap.add_argument("--work", default="")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    work = args.work or os.path.join(root, "_setup")
    skip = set(s.strip() for s in args.skip.split(",") if s.strip())
    ctx = {"root": root, "work": work, "job": {"cancelled": False},
           "python_mode": args.python_mode, "rebuild_env": bool(args.rebuild_env), "py": ""}
    os.makedirs(work, exist_ok=True)

    plan = [s for s in STEPS if s not in skip]
    if args.dry_run:
        emit("plan", 0, "计划执行：" + " → ".join(plan), steps=plan)
        emit("done", 100, "dry-run 结束", ok=True)
        return 0

    fns = {"python": step_python, "source": step_source, "weights": step_weights,
           "deps": step_deps, "fixups": step_fixups, "voice": step_voice, "verify": step_verify}
    t0 = time.time()
    try:
        for s in plan:
            emit(s, 0, "步骤开始：" + s, phase="begin")
            if not fns[s](ctx):
                emit("done", 0, "装配失败于步骤：" + s, ok=False, step_failed=s)
                return 1
    except Exception as e:
        emit("done", 0, "装配异常：%s" % e, ok=False)
        log("异常：" + repr(e))
        return 1
    emit("done", 100, "语音引擎装配完成（耗时 %.1f 分钟）" % ((time.time() - t0) / 60.0), ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
