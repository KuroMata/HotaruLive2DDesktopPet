# IndexTTS-2 部署步骤（技术版 · 适配你这台机器）

> 面向"想看懂原理"的情况。日常操作照 `安装步骤_详细版.md` 做（双击两个 .cmd）即可。
>
> **2026-09-18 修订**：官方仓库已改用 **uv** 管理依赖（`pyproject.toml` + `uv.lock`），
> **不再提供 `requirements.txt`**。旧的 `pip install -r requirements.txt` 会直接报
> `Could not open requirements file`。本文件已按新版重写。

部门：本机已做的体检结果（`python tts/env_check.py`）：

| 项目 | 现状 |
|---|---|
| 显卡 | RTX 3080，驱动 616.56，**12288 MiB** |
| 显存占用 | 体检时已用 **6.9 GB**，剩 ~5.1 GB ⚠️ 见下方提醒 |
| 磁盘 | C: 可用 86.5 GB / D: 可用 88.7 GB |
| Python 3.11（系统） | 已有 torch 2.7.0+cu118（**但 IndexTTS-2 不会用它**，见下） |
| git | 已装（2.51.0） |
| uv | 未装 → 脚本会自动 `pip install -U uv` |
| 网络 | PyTorch 源 / 清华 PyPI 镜像 / ModelScope 均通，实测 20 MB/s 以上 |
| 参考音频 | `tts/ref/prompt.wav`（15.14 s，按引擎内部取用长度重截）✅ |

> ⚠️ **运行前腾显存**：IndexTTS-2 fp16 推理约需 6–8 GB，跑之前关掉浏览器 / 游戏 / 其他 AI 工具。

---

## 关键概念：为什么用 uv，而不是直接 pip

官方把依赖版本锁得很死（`torch==2.8.*` 且从 **cu128** 源安装），并要求 `>=3.10,<3.12`。
直接往系统 Python 里 pip 装会：

1. 把系统的 torch 2.7.0+cu118 **升级成 2.8+cu128**（几个 GB），影响你其他项目；
2. 改掉 `numpy` 等公共库版本，可能连带影响别的工程。

`uv sync` 会在**仓库内**建一个 `.venv`（虚拟环境），依赖全装在里头，跟系统 Python 完全隔离。
代价是它要自己下一份 torch（几个 GB），但换来"不污染环境"。

---

## 实际使用的命令（脚本里替你做了）

```bat
rem 0) 装 uv（官方 README 就是这么要求的）
"C:\...\Python311\python.exe" -m pip install -U uv

rem 1) 拉代码
git clone https://github.com/index-tts/index-tts.git D:\index-tts

rem 2) 建环境 + 装依赖（关键：不要让它去下托管的 Python，见下）
pushd D:\index-tts
set UV_PYTHON_DOWNLOADS=never
set UV_HTTP_TIMEOUT=300
set UV_CONCURRENT_DOWNLOADS=8
"C:\...\Python311\python.exe" -m uv sync --python "C:\...\Python311\python.exe" ^
    --default-index "https://pypi.tuna.tsinghua.edu.cn/simple"
popd

rem 3) 下权重（约 10 GB，走 ModelScope 更快）
D:\index-tts\.venv\Scripts\modelscope.exe download ^
    --model IndexTeam/IndexTTS-2 --local_dir D:\index-tts\checkpoints_2
```

### 三个踩过的坑（都已写进脚本）

| 坑 | 现象 | 解法 |
|---|---|---|
| **uv 自己下 Python 会卡死** | 日志停在 `Downloading cpython-3.11.13-windows-x86_64-none`，几分钟不动 | `UV_PYTHON_DOWNLOADS=never` + `--python <系统3.11路径>`，改用系统 3.11（满足 `>=3.10,<3.12`） |
| **依赖里没有 requirements.txt** | `ERROR: Could not open requirements file` | 改用 `uv sync` |
| **镜像偶发超时** | `Failed to download pytz ... network timeout` | `UV_HTTP_TIMEOUT=300`、降低并发；重跑会**续传**（已缓存的跳过） |

### 权重放哪：`checkpoints_2`，不是 `checkpoints`

官方 README 规定：

| 模型 | HF/ModelScope 仓库 | 本地目录 |
|---|---|---|
| **IndexTTS-2**（我们用的） | `IndexTeam/IndexTTS-2` | **`checkpoints_2`** |
| IndexTTS-2.5 | `IndexTeam/IndexTTS-2.5` | `checkpoints` |

`checkpoints/` 目录仓库自带，但里面只有一个 `pinyin.vocab`。
判定"权重是否就绪"的标志是 **`checkpoints_2\config.yaml` 是否存在**。

---

## 装完后：把侧车指向它

`tts/engines.py` 里的 `IndexTTSEngine` 是真实实现，经 `main.js` 注入这些环境变量
（来源是 `app/config.json`，**不需要设系统环境变量**）：

| 环境变量 | 含义 | config.json 键 | 默认值 |
|---|---|---|---|
| `INDEXTTS_DIR` | 仓库根目录 | `indexttsDir` | — |
| `INDEXTTS_MODEL_DIR` | 权重目录（相对仓库根或绝对路径） | `indexttsModelDir` | `checkpoints_2` |
| `INDEXTTS_REF` | 参考音频 | `indexttsRef` | `tts/ref/prompt.wav` |
| `INDEXTTS_EMO_ALPHA` | 情感强度 0–1 | `indexttsEmoAlpha` | `0.85` |
| `INDEXTTS_BOYIFY` | 少年化开关 | `indexttsBoyify` | `true` |
| `INDEXTTS_SEMITONES` | 少年化上移半音 | `indexttsSemitones` | `2.5` |

**最关键的一条**：`ttsPython` 必须指向 `.venv` 里的 python，否则侧车会用系统 Python，
`import indextts` 失败 → 引擎显示"不可用"：

```json
"ttsPython": "D:\\index-tts\\.venv\\Scripts\\python.exe",
"ttsEngine": "indextts",
"indexttsDir": "D:\\index-tts",
"indexttsModelDir": "checkpoints_2"
```

（`ttsEngine` 即使写了 `indextts` 而引擎暂不可用，侧车会自动回落到 `sapi` → `tone`，不会报错。）

---

## 适配器实现要点（`tts/engines.py::IndexTTSEngine`）

- 载入：`from indextts.infer_v2 import IndexTTS2`，构造参数
  `cfg_path=<ckpt>/config.yaml`、`model_dir=<ckpt>`、`use_fp16=True`、
  **`use_cuda_kernel=False`**（避免依赖本机 CUDA 12.8 toolkit）、`use_deepspeed=False`、
  **`use_qwen_emo=False`**（情绪由我们自己的向量给，省显存与启动时间）。
- 情绪映射：12 个中文情绪标签 → IndexTTS-2 的 **8 维情感向量**
  （顺序固定 `[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]`），
  通过 `infer(..., emo_vector=[...], emo_alpha=<强度>)` 传入。
- **情绪不拼进文本**（只作为参数），所以不会被念出来。
- 少年化：后处理 `librosa.effects.pitch_shift` 上移若干半音（保留时长）；缺依赖则静默跳过。
- 参考音频：引擎内部 `_load_and_cut_audio(ref, 15)` 只取 **15 秒**，所以 `prompt.wav`
  已按 15 秒重新截取（原 93.6 秒的 `ref.wav` 完整保留备用）。

---

## 验证

```bat
python tts\env_check.py                  rem 看 INDEXTTS_DIR / 依赖是否齐
tts\try_voice.cmd                        rem 双击：生成 tts\_out\sample_indextts.wav
```

`selftest` 出来的 WAV 就是"你的音色 + 少年化"。

| 调整项 | 键 | 建议范围 |
|---|---|---|
| 音调太高/太低 | `INDEXTTS_SEMITONES` / `indexttsSemitones` | 1.5 – 3.5 |
| 语气太夸张/太平 | `INDEXTTS_EMO_ALPHA` / `indexttsEmoAlpha` | 0.6 – 0.9 |
| 不要少年化 | `INDEXTTS_BOYIFY=0` / `indexttsBoyify: false` | — |

## 已知注意事项

- 首次推理较慢（加载权重 + 预热，约 10–30 s），之后 3080 上每句大约数秒。
- 少年化目前只做**音高上移**，不改共振峰，听感偏"音调变高"。想要更自然可后续叠共振峰偏移。
- 聊天回复走**流式**（CosyVoice 3）那一路尚未部署，目前只有固定台词在用 IndexTTS-2 预渲染。
