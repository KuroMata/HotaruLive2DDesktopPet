# TTS 语音侧车

桌宠台词的可选语音合成模块。**纯 Python 标准库实现，无需 pip 安装任何第三方包。**

## 组成

| 文件 | 作用 |
|---|---|
| `tts_server.py` | HTTP 服务，默认监听 `127.0.0.1:18766`。由 Electron 主进程自动拉起。 |
| `engines.py` | 引擎层：统一 `synth(text, voice, emo) -> WAV` 接口，含注册表与优先级。 |
| `selftest.py` | 自检：列出引擎可用性并合成一句样例到 `_out/`。 |

## 引擎与优先级

`auto` 时按以下顺序挑第一个可用的引擎：

| 优先级 | 引擎 | 说明 | 现状 |
|---|---|---|---|
| 1 | `cosyvoice` | 阿里 Fun-CosyVoice3，**实时流式**（聊天回复用）。 | 待部署，需设 `COSYVOICE_DIR` |
| 2 | `indextts` | B站 IndexTTS-2，**离线最佳音质 + 情感/音色分离**（固定台词预渲染用）。 | 待部署，需设 `INDEXTTS_DIR` |
| 3 | `sapi` | Windows 内置语音（System.Speech）。零下载、立刻出声，作**占位**。 | 开箱可用（本机中文音色 `Microsoft Huihui Desktop`） |
| 4 | `tone` | 纯 Python 提示音，仅用于验证链路。 | 始终可用 |

## 接口

```
GET /health                                   -> { ok, engine, engines:[{name,label,available,voices}] }
GET /voices?engine=xxx                        -> { engine, voices:[...] }
GET /tts?text=..&engine=..&voice=..&emo=..    -> audio/wav
```

前端**不直连**该端口，而是走主进程同源代理：

```
GET /api/tts?text=...&emo=...     -> 转发到侧车 /tts，返回 audio/wav
GET /api/tts/health               -> 主进程缓存的引擎状态
```

## 配置（app/config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `ttsEnabled` | `true` | 语音总开关（托盘菜单「语音（TTS）」也可实时切换） |
| `ttsPort` | `18766` | 侧车监听端口 |
| `ttsEngine` | `"auto"` | 指定引擎；`auto` 按优先级自动挑 |
| `ttsPython` | `""` | Python 解释器路径；留空则依次尝试 `python` / `python3` / `py` |
| `ttsVoice` | `""` | 指定音色名；留空用引擎默认 |

## 手动运行 / 自检

```bat
python tts\tts_server.py --port 18766 --engine auto
python tts\selftest.py
python tts\selftest.py sapi
```

## 排错

- **侧车里不起来**：多为找不到 Python。在 `config.json` 设 `ttsPython` 为绝对路径（如 `C:\Python311\python.exe`），重启桌宠。
- **SAPI 报错**：少数被安全策略收紧的环境会拦截 `Add-Type`/`System.Speech`。此时在托盘「语音（TTS）→ 引擎」切到 `tone` 先跑通链路，或直接部署 CosyVoice / IndexTTS。
- **没有声音**：看 `app.log` 里 `tts:` 开头的行——会打印 spawn 的启动器、`/health` 结果、以及每次合成的引擎与字节数。

## 下一步

本模块只解决「文本 → WAV → 播放」。播放时已把音频接到 `AnalyserNode`，RMS 暂存于 `window.__ttsRms`；
下一步将用它驱动 `ParamMouthOpenY`，把口型从「拼音文本驱动」改为「音频驱动」，实现声嘴同步。
