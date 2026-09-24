# -*- coding: utf-8 -*-
"""
TTS 引擎层 —— 桌宠语音侧车
=========================
设计目标：
  * 零第三方依赖即可运行（纯标准库）。缺依赖时不报错崩溃，只是"该引擎不可用"。
  * 引擎可插拔：/health 会列出全部引擎及其可用性；默认引擎按优先级自动挑选。
  * 统一接口 synth(text, voice, emo) -> WAV 字节。

引擎优先级（auto）：cosyvoice > indextts > sapi > tone
  * cosyvoice —— 阿里 Fun-CosyVoice3，**实时流式**用途（聊天回复）。需本地部署后配置 COSYVOICE_DIR。
  * indextts  —— B站 IndexTTS-2，**离线最佳音质 + 情感/音色分离**。需配置 INDEXTTS_DIR。
  * sapi      —— Windows 内置语音（System.Speech）。零下载、立刻能出声，作为**占位/兜底**。
  * tone      —— 纯 Python 生成提示音。无语音，仅用于验证"文本→WAV→播放"链路。

后续接真实模型时，只需补全对应引擎的 available()/synth()，无需改动服务器与前端。
"""
import io
import math
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import wave
import http.client as http_client

# 情绪名 -> 供引擎使用的语气描述（未来 CosyVoice/IndexTTS 直接消费；SAPI 忽略）
EMO_HINT = {
    "neutral": "平静地",
    "focus": "认真、平稳地",
    "curious": "带着好奇、微微上扬地",
    "joy": "开心地、带笑意地",
    "sleepy": "犯困、有气无力地",
    "affection": "温柔、轻声地",
    "shy": "害羞、声音变小地",
    "tease": "调侃、俏皮地",
    "serious": "严肃、字字清晰地说",
    "surprise": "惊讶地",
    "pout": "有点赌气地",
    "smug": "得意地",
}

# 假名（平假名 + 片假名 + 片假名扩展）——判断"这句话是日文"的唯一可靠信号。
# 注意**不能看汉字**：中文里也全是汉字，只有假名是日文独有的。
_KANA_RE = re.compile(u'[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]')


def _has_japanese(text):
    """文本里有没有假名（有就当日语处理，CosyVoice 的 cross-lingual 分支按此选语言）。

    ⚠ 这个函数曾经**只有调用没有定义**（`CosyVoiceEngine.synth` 里 `lang = "jp" if _has_japanese(text) ...`），
    于是只要把引擎设成 cosyvoice，每次合成都抛 `NameError: name '_has_japanese' is not defined`，
    而前端 catch 掉之后只写一行日志、退化回文本驱动口型 —— 表面上"没声音"，很难联想到是这里。
    0.2.2 的安装包里带的就是这个状态，补上定义即可。改动时请保证调用与定义始终成对存在。
    """
    return bool(_KANA_RE.search(text or ''))


class TTSEngine(object):
    name = "base"
    label = "基类"

    def available(self):
        return False

    def voices(self):
        return []

    def synth(self, text, voice=None, emo=None):
        """返回 (wav_bytes, sample_rate)。不可用时抛异常。"""
        raise NotImplementedError

    #: 返回音频的 MIME。默认 wav；返回 mp3 的引擎（如 Edge）需覆盖。
    mime = "audio/wav"

    def info(self):
        return {"name": self.name, "label": self.label,
                "available": bool(self.available()), "voices": list(self.voices())}


def _wav_from_pcm16(pcm_bytes, sample_rate, channels=1):
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(channels)
    w.setsampwidth(2)
    w.setframerate(sample_rate)
    w.writeframes(pcm_bytes)
    w.close()
    return buf.getvalue()


class ToneEngine(TTSEngine):
    """纯 Python 提示音。仅用于链路自检：音长随文本长度变化，听感像"哔—"。"""
    name = "tone"
    label = "提示音（链路自检）"

    def available(self):
        return True

    def voices(self):
        return ["tone"]

    def synth(self, text, voice=None, emo=None):
        n = len(text or "")
        n = max(1, min(n, 160))
        seg = 0.11
        sr = 22050
        total = seg * n + 0.15
        frames = int(total * sr)
        out = bytearray()
        for i in range(frames):
            t = i / float(sr)
            phase = (t % seg) / seg
            env = 0.0
            if phase < 0.7:
                env = 0.5 * (1.0 - math.cos(2.0 * math.pi * (phase / 0.7)))
            f = 175.0 + 18.0 * math.sin(2.0 * math.pi * 0.9 * t)
            s = math.sin(2.0 * math.pi * f * t) * 0.32 * env
            if s > 1.0:
                s = 1.0
            elif s < -1.0:
                s = -1.0
            out += struct.pack("<h", int(s * 32767))
        return _wav_from_pcm16(bytes(out), sr), sr


class SapiEngine(TTSEngine):
    """Windows 内置语音（System.Speech）。零下载、立刻出声，作占位/兜底。

    注意：因为要调用 PowerShell 且依赖 .NET 的 System.Speech，少数被安全策略收紧的
    环境可能失败；失败时请把引擎切到 tone，或等接入 CosyVoice/IndexTTS 后使用。
    """
    name = "sapi"
    label = "Windows 内置语音"

    def _ps(self):
        if os.name != "nt":
            return None
        for c in ("powershell.exe", "pwsh.exe"):
            p = shutil.which(c)
            if p:
                return p
        return None

    def available(self):
        return self._ps() is not None

    def voices(self):
        ps = self._ps()
        if not ps:
            return []
        try:
            script = (
                "Add-Type -AssemblyName System.Speech;"
                "(New-Object System.Speech.Synthesis.SpeechSynthesizer)."
                "GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"
            )
            r = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", script],
                               capture_output=True, timeout=20)
            out = r.stdout.decode("utf-8", "ignore")
            return [ln.strip() for ln in out.splitlines() if ln.strip()]
        except Exception:
            return []

    def synth(self, text, voice=None, emo=None):
        ps = self._ps()
        if not ps:
            raise RuntimeError("no powershell available")
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        fd2, txt = tempfile.mkstemp(suffix=".txt")
        os.close(fd2)
        try:
            with open(txt, "w", encoding="utf-8") as f:
                f.write(text or "")
            parts = ["Add-Type -AssemblyName System.Speech;",
                     "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"]
            if voice:
                safe = voice.replace("'", "''")
                parts.append("$s.SelectVoice('%s');" % safe)
            parts.append("$t = Get-Content -Raw -Encoding UTF8 '%s';" % txt)
            parts.append("$s.SetOutputToWaveFile('%s');" % wav)
            parts.append("$s.Speak($t); $s.Dispose();")
            script = " ".join(parts)
            r = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", script],
                               capture_output=True, timeout=120)
            if r.returncode != 0:
                raise RuntimeError("SAPI failed: " + r.stderr.decode("utf-8", "ignore")[:300])
            with open(wav, "rb") as f:
                data = f.read()
            if not data:
                raise RuntimeError("SAPI produced empty wav")
            return data, 0
        finally:
            for p in (wav, txt):
                try:
                    os.remove(p)
                except OSError:
                    pass


class _DirEngine(TTSEngine):
    """需本地部署的模型引擎基类：靠环境变量指向模型目录判断可用。"""
    env_key = ""

    def __init__(self):
        self.dir = os.environ.get(self.env_key, "") if self.env_key else ""

    def available(self):
        return bool(self.dir) and os.path.isdir(self.dir)

    def voices(self):
        return []

    def synth(self, text, voice=None, emo=None):
        raise RuntimeError("%s 未部署（请设置环境变量 %s 指向模型目录）" % (self.label, self.env_key))


class CosyVoiceEngine(_DirEngine):
    """阿里 Fun-CosyVoice2 零样本跨语言克隆（中文/日文同一 prompt 出双语言）。

    复用 tts/cosy_gen.generate_best（多候选选优 + 音乐/挂断音伪影硬拒绝 + 响度归一），
    与预生成脚本 gen_lines.py 同一条质量管线，保证聊天实时合成与离线台词一致听感。
    模型在首次 synth 时惰性加载并缓存（侧车常驻，不会每条都 reload）。
    """
    name = "cosyvoice"
    label = "CosyVoice 3（流式·实时）"
    env_key = "COSYVOICE_DIR"

    def __init__(self):
        super().__init__()
        self._cosy = None
        self._sr = 24000
        self._gen = None        # cosy_gen.generate_best（惰性导入后挂在这里）

    def _ensure(self):
        if self._cosy is None:
            # 惰性导入：避免在 indextts 等其它引擎的 venv 里因缺 torch 而崩溃。
            # ⚠ 必须把 generate_best 挂到 self 上再返回。之前它是这个函数的**局部名**，
            # 出了 _ensure() 就没了，synth() 里那句 generate_best(...) 直接
            # NameError: name 'generate_best' is not defined —— 和 _has_japanese 同一族的坑：
            # 名字只在局部作用域里存在，调用点却在别处。前端 catch 后只写一行日志，
            # 表现为"引擎显示可用、但一句话都合成不出来"。
            from cosy_gen import load_cosy, generate_best, SR
            self._cosy = load_cosy()
            self._sr = SR
            self._gen = generate_best
        return self._cosy

    def synth(self, text, voice=None, emo=None):
        cosy = self._ensure()
        lang = "jp" if _has_japanese(text) else "cn"
        w, _info = self._gen(
            cosy, text,
            max_candidates=2,                 # 实时聊天：速度优先，2 候选足够
            speed_primary=(1.0, 1.06),
            speed_fallback=(1.12, 1.18),
            verbose=False, label="chat", lang=lang)
        import numpy as np
        import io
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(self._sr)
            pcm = (np.clip(w, -1.0, 1.0) * 32767.0).astype("<i2")
            wf.writeframes(pcm.tobytes())
        return buf.getvalue(), self._sr


class IndexTTSEngine(_DirEngine):
    """B站 IndexTTS-2：离线、音质最好、**音色与情感分离**。

    调用的是官方 Python API（indextts.infer_v2.IndexTTS2），按官方文档：
        tts.infer(spk_audio_prompt=参考音频, text=文本, output_path=输出,
                  emo_vector=[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm],
                  emo_alpha=强度)

    相关的环境变量：
      INDEXTTS_DIR        仓库根目录（git clone 出来的 index-tts）——决定本引擎是否可用
      INDEXTTS_MODEL_DIR  权重目录，相对仓库根或绝对路径。官方 README：
                            IndexTTS-2   -> checkpoints_2（默认）
                            IndexTTS-2.5 -> checkpoints
      INDEXTTS_REF        参考音频路径，默认 tts/ref/prompt.wav
      INDEXTTS_EMO_ALPHA  情感强度 0–1，默认 0.85
      INDEXTTS_EMO_REF_DIR 情绪参考音频库目录，默认 tts/ref/emo_ref
                          （gen_emo_refs.py 产出 <情绪>.wav）。synth 优先用
                          emo_audio_prompt 借情感——音色锁死 spk、不串味；
                          缺对应文件时回落到手写 emo_vector。
      INDEXTTS_BOYIFY     1=开启少年化，默认 1
      INDEXTTS_SEMITONES  少年化上移半音数，默认 2.0（1.5–3，别超过 4）
      INDEXTTS_POLISH     1=输出润色（mastering），默认 1
      INDEXTTS_POLISH_MODE 润色预设：natural(默认) / broadcast / smooth(圆滑沉闷)

    ⚠️ 少年化的实现方式：**变调作用在参考音频上**（pre-shift），不是作用在合成结果上。
    早期版本用 librosa 对 TTS 输出做 pitch_shift（相位声码器），会在 5–8kHz 堆出大量
    artifacts（实测该频段能量从干音的 2.8% 涨到 9.2%），听感就是强烈"电音感"。
    改成 pre-shift 后模型直接按少年音色合成，输出无需后期变调，天然干净。

    注意：本仓库自 2025 起改用 uv 管理依赖（pyproject.toml + uv.lock，**没有
    requirements.txt**）。依赖需用 `uv sync` 装进仓库内的 .venv，并把
    config.json 的 ttsPython 指向该 .venv 的 python.exe。
    """
    name = "indextts"
    label = "IndexTTS-2（离线·情感分离）"
    env_key = "INDEXTTS_DIR"

    # 我们的情绪标签 -> IndexTTS-2 的 8 维情感向量
    # 顺序固定为 [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
    EMO_VEC = {
        'neutral':   [0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.60],
        'focus':     [0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.85],
        'curious':   [0.45, 0.00, 0.00, 0.00, 0.00, 0.00, 0.30, 0.25],
        'joy':       [0.95, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.15],
        'sleepy':    [0.00, 0.00, 0.20, 0.00, 0.00, 0.55, 0.00, 0.45],
        'affection': [0.50, 0.00, 0.00, 0.00, 0.00, 0.15, 0.00, 0.45],
        'shy':       [0.25, 0.00, 0.00, 0.30, 0.00, 0.00, 0.00, 0.50],
        'tease':     [0.60, 0.00, 0.00, 0.00, 0.00, 0.00, 0.20, 0.15],
        'serious':   [0.00, 0.15, 0.00, 0.00, 0.00, 0.00, 0.00, 0.90],
        'surprise':  [0.20, 0.00, 0.00, 0.25, 0.00, 0.00, 0.95, 0.00],
        'pout':      [0.00, 0.35, 0.30, 0.00, 0.00, 0.30, 0.00, 0.25],
        'smug':      [0.55, 0.00, 0.00, 0.00, 0.00, 0.00, 0.20, 0.30],
    }

    def __init__(self):
        super().__init__()
        here = os.path.dirname(os.path.abspath(__file__))
        self._ref = os.environ.get('INDEXTTS_REF', '') or os.path.join(here, 'ref', 'prompt.wav')
        try:
            self._alpha = float(os.environ.get('INDEXTTS_EMO_ALPHA', '0.85'))
        except ValueError:
            self._alpha = 0.85
        self._boyify = os.environ.get('INDEXTTS_BOYIFY', '1') not in ('0', 'false', 'False')
        try:
            self._semi = float(os.environ.get('INDEXTTS_SEMITONES', '2.5'))
        except ValueError:
            self._semi = 2.0
        # 输出润色（mastering）开关。默认开：实测生成音频 5-8kHz 能量是干音的 3 倍，
        # 那是变调 artifacts 堆积区，听感即"电音感"，润色链会压掉它。
        self._polish = os.environ.get('INDEXTTS_POLISH', '1') not in ('0', 'false', 'False')
        # 少年声道模拟（共振峰上移）。光提高音调会"像大人装小孩"，开启后更接近童声。
        self._formant = os.environ.get('INDEXTTS_FORMANT', '0') not in ('0', 'false', 'False')
        # 权重目录：官方把 IndexTTS-2 放在 checkpoints_2、IndexTTS-2.5 放在 checkpoints
        self._model_dir = os.environ.get('INDEXTTS_MODEL_DIR', '') or 'checkpoints_2'
        # 情绪参考音频库目录（gen_emo_refs.py 产出）。有对应 <情绪>.wav 时，
        # synth 优先用 emo_audio_prompt 借情感（音色不串味），否则回落手写 emo_vector。
        self._emo_ref_dir = os.environ.get('INDEXTTS_EMO_REF_DIR', '') or os.path.join(here, 'ref', 'emo_ref')
        self._tts = None
        self._ref_prepared = None      # 预处理后的参考音频路径（惰性生成并缓存）

    def _ckpt_dir(self):
        d = self._model_dir
        if not os.path.isabs(d):
            d = os.path.join(self.dir or '.', d)
        return d

    # 主权重里最大的那个文件，用它做"下完了没"的哨兵（避免下到一半就算可用）
    _MAIN_WEIGHTS = ('config.yaml', 'gpt.pth')
    _GPT_MIN_BYTES = 100 * 1024 * 1024

    def _weights_ready(self):
        ckpt = self._ckpt_dir()
        cfg = os.path.join(ckpt, 'config.yaml')
        gpt = os.path.join(ckpt, 'gpt.pth')
        if not (os.path.isfile(cfg) and os.path.getsize(cfg) > 0):
            return False
        try:
            return os.path.getsize(gpt) > self._GPT_MIN_BYTES
        except OSError:
            return False

    def available(self):
        """仓库在、参考音频在、且权重已下完才算可用。"""
        if not (self.dir and os.path.isdir(self.dir)):
            return False
        if not os.path.isfile(self._ref):
            return False
        return self._weights_ready()

    def voices(self):
        return ['clone']

    def info(self):
        d = super().info()
        d['reference'] = self._ref if os.path.isfile(self._ref) else ''
        d['modelDir'] = self._ckpt_dir()
        d['weightsReady'] = self._weights_ready()
        # 声码器（BigVGAN）在首次推理时才会下载，缺它会在推理阶段报错，这里提前告知
        bg = os.path.join(self._ckpt_dir(), 'hf_cache', 'bigvgan', 'bigvgan_generator.pt')
        d['vocoderReady'] = os.path.isfile(bg) and os.path.getsize(bg) > 50 * 1024 * 1024
        d['boyify'] = self._boyify
        d['semitones'] = self._semi
        return d

    def _ensure(self):
        if self._tts is not None:
            return
        ckpt = self._ckpt_dir()
        if not self._weights_ready():
            raise RuntimeError(
                'IndexTTS-2 权重未就绪：%s 里的 config.yaml / gpt.pth 不完整。'
                '请按 tts/安装步骤_详细版.md 下载权重（IndexTeam/IndexTTS-2 -> checkpoints_2）。' % ckpt)
        # 官方用法：在仓库根目录下运行（uv run），代码才能从 indextts 包导入
        if self.dir not in sys.path:
            sys.path.insert(0, self.dir)
        from indextts.infer_v2 import IndexTTS2   # noqa: E402
        # use_qwen_emo=False：情绪由我们自己的 emo 向量给出，不需要额外加载
        # QwenEmotion 文本情感模型（省显存、省启动时间）。use_cuda_kernel=False
        # 避免依赖本机 CUDA 12.8 toolkit。
        self._tts = IndexTTS2(cfg_path=os.path.join(ckpt, 'config.yaml'),
                              model_dir=ckpt, use_fp16=True,
                              use_cuda_kernel=False, use_deepspeed=False,
                              use_qwen_emo=False)

    def _emo_vector(self, emo):
        if not emo:
            return None
        key = str(emo).split(',')[0].strip()
        return self.EMO_VEC.get(key)

    def _emo_audio_path(self, emo):
        """情绪参考音频路径（ref/emo_ref/<情绪>.wav）。

        优先用"情绪参考音频"借情感：spk_audio_prompt 锁死音色，emo_audio_prompt
        只借情感，两者独立提取后合并 —— 音色不会被情绪带偏。对应 IndexTTS-2 的
        emo_audio_prompt 机制（infer_v2.py 439-444/504-519/571-577）。
        没有对应参考音频时返回 None，由调用方回落到手写 emo_vector。
        """
        if not emo:
            return None
        key = str(emo).split(',')[0].strip()
        p = os.path.join(self._emo_ref_dir, '%s.wav' % key)
        return p if os.path.isfile(p) else None

    def _prepare_ref(self):
        """预处理参考音频：变调（少年化）+ 清洁（去闷/补高频/压动态）。

        关键设计：**变调作用在参考音频上，而不是合成结果上**。
        之前用 librosa 对 TTS 输出做 pitch_shift（相位声码器），会在 5-8kHz
        堆出大量 artifacts——实测该频段能量从干音的 2.8% 涨到 9.2%，
        听感就是强烈的"电音感/金属感"。改成 pre-shift 后，模型直接按少年音色
        合成，输出天然干净，无需后期变调。
        """
        if self._ref_prepared and os.path.isfile(self._ref_prepared):
            return self._ref_prepared
        try:
            from audio_polish import (clean_reference, clean_reference_formant,
                                      pitch_shift, read_wav, write_wav)
        except Exception:
            return self._ref
        try:
            x, sr = read_wav(self._ref)
            semi = self._semi if self._boyify else 0.0
            if abs(semi) > 1e-6:
                x = pitch_shift(x, sr, semi)
                if self._formant:
                    # 变调 + 模拟少年声道（共振峰上移）：更像"小孩"而不是"大人装小孩"
                    x = clean_reference_formant(x, sr)
                else:
                    # 变调过的参考音频必须走这条：不提高频 + 削掉高频 artifacts。
                    # 实测对比：变调后若还提升高频，合成结果 8kHz 以上占比会到 6.0%（发毛），
                    # 用这条降到 1.78%，频谱平坦度也从 0.037 回到 0.021。
                    x = clean_reference(x, sr, high_shelf_gain=0.0, deartifact_gain=-8.0)
            else:
                x = clean_reference(x, sr)
            p = os.path.join(os.path.dirname(os.path.abspath(self._ref)), '_idx_ref.wav')
            with open(p, 'wb') as f:
                f.write(write_wav(x, sr))
            self._ref_prepared = p
            return p
        except Exception:
            return self._ref

    def synth(self, text, voice=None, emo=None):
        self._ensure()
        ref = self._prepare_ref()
        fd, out = tempfile.mkstemp(suffix='.wav')
        os.close(fd)
        try:
            kwargs = dict(spk_audio_prompt=ref, text=text, output_path=out)
            vec = self._emo_vector(emo)
            emo_audio = self._emo_audio_path(emo)
            if emo_audio:
                # 情绪参考音频：音色锁 spk、情感借 emo 参考，不串味（优于手写向量）
                kwargs['emo_audio_prompt'] = emo_audio
                kwargs['emo_alpha'] = self._alpha
            elif vec:
                kwargs['emo_vector'] = vec
                kwargs['emo_alpha'] = self._alpha
            self._tts.infer(**kwargs)
            with open(out, 'rb') as f:
                data = f.read()
            if not data:
                raise RuntimeError('IndexTTS-2 未产出音频')
            return self._polish_wav(data), 0
        finally:
            try:
                os.remove(out)
            except OSError:
                pass

    def _polish_wav(self, wav_bytes):
        """输出润色（mastering）：压掉电音感频段 + 去闷 + 补空气 + 稳动态 + 归一响度。

        预设由环境变量 INDEXTTS_POLISH_MODE 选择：
          natural   —— master()：明亮靠前、临场感强（默认）
          broadcast —— master_broadcast()：广播/视频配音，饱满中频、平动态
          smooth    —— smooth_muffled()：圆滑沉闷、不刺耳（用户要的"最初版本"风）
        缺依赖或关闭时原样返回，不影响出声。
        """
        if not self._polish:
            return wav_bytes
        try:
            from audio_polish import read_wav, write_wav
            mode = os.environ.get('INDEXTTS_POLISH_MODE', 'natural').strip().lower()
            if mode == 'broadcast':
                from audio_polish import master_broadcast as _m
            elif mode == 'smooth':
                from audio_polish import smooth_muffled as _m
            else:
                from audio_polish import master as _m
            x, sr = read_wav(wav_bytes)
            return write_wav(_m(x, sr), sr)
        except Exception:
            return wav_bytes


class EdgeTTSEngine(TTSEngine):
    """微软 Edge 在线 TTS —— 就是"网上 AI 配音视频"常用的那类音色。

    优点：音色专业（录音棚级素材训练），质感接近商业配音，零部署，可换多种风格
          （少年 / 专业播报 / 浑厚解说）；支持语速与音调微调。
    缺点：**需要联网**，且**不能克隆你的声音**（只能用微软提供的固定音色）。

    VOICE_LIST 覆盖中文（普通话/粤语/台湾）、日语、英语（美/英），
    供设置页"台词 → 语音来源 → 音色"下拉直接选择，中日英三语台词都能
    在本引擎内找到对应音色。
    环境变量 EDGE_VOICE 可指定默认音色，EDGE_RATE / EDGE_PITCH 可微调。
    """
    name = "edge"
    label = "Edge TTS（在线·微软音色）"
    mime = "audio/mpeg"

    DEFAULT_VOICE = "zh-CN-YunxiaNeural"

    # 情绪 -> (语速, 音调)。edge-tts 只有 rate/pitch 两个旋钮，用它近似情绪。
    EMO_STYLE = {
        'neutral':   ("+0%",   "+0Hz"),
        'focus':     ("+0%",   "+0Hz"),
        'curious':   ("+8%",   "+15Hz"),
        'joy':       ("+12%",  "+20Hz"),
        'sleepy':    ("-18%",  "-15Hz"),
        'affection': ("-5%",   "+8Hz"),
        'shy':       ("-8%",   "+5Hz"),
        'tease':     ("+10%",  "+18Hz"),
        'serious':   ("-6%",   "-12Hz"),
        'surprise':  ("+15%",  "+30Hz"),
        'pout':      ("-10%",  "+10Hz"),
        'smug':      ("+5%",   "+10Hz"),
    }

    # 设置页「台词 → 语音来源 → 音色」下拉的数据源，按语言分组排列，
    # 方便中日英三语台词各取所需。全部经 edge_tts.list_voices() 实查确认存在。
    VOICE_LIST = [
        # 中文（普通话）
        "zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural",
        "zh-CN-YunxiaNeural", "zh-CN-YunxiNeural",
        "zh-CN-YunjianNeural", "zh-CN-YunyangNeural",
        "zh-CN-liaoning-XiaobeiNeural", "zh-CN-shaanxi-XiaoniNeural",
        # 中文（台湾）
        "zh-TW-HsiaoChenNeural", "zh-TW-HsiaoYuNeural", "zh-TW-YunJheNeural",
        # 中文（香港）
        "zh-HK-HiuGaaiNeural", "zh-HK-HiuMaanNeural", "zh-HK-WanLungNeural",
        # 日语
        "ja-JP-NanamiNeural", "ja-JP-KeitaNeural",
        # 英语（美）：Ana 为童声，贴合少年角色；Aria 为通用女声
        "en-US-AnaNeural", "en-US-AriaNeural", "en-US-JennyNeural",
        "en-US-MichelleNeural", "en-US-AvaNeural", "en-US-EmmaNeural",
        "en-US-AndrewNeural", "en-US-BrianNeural", "en-US-GuyNeural",
        "en-US-ChristopherNeural", "en-US-EricNeural",
        "en-US-RogerNeural", "en-US-SteffanNeural",
        # 英语（美）多语种：中英混排文本表现更好
        "en-US-AvaMultilingualNeural", "en-US-EmmaMultilingualNeural",
        "en-US-AndrewMultilingualNeural", "en-US-BrianMultilingualNeural",
        # 英语（英）
        "en-GB-SoniaNeural", "en-GB-LibbyNeural", "en-GB-MaisieNeural",
        "en-GB-RyanNeural", "en-GB-ThomasNeural",
    ]

    def available(self):
        try:
            import edge_tts  # noqa: F401
            return True
        except Exception:
            return False

    def voices(self):
        return list(self.VOICE_LIST)

    def synth(self, text, voice=None, emo=None):
        import asyncio

        try:
            import edge_tts
        except Exception as e:  # noqa: BLE001
            raise RuntimeError("Edge TTS 未安装：pip install edge-tts（%s）" % e)

        v = voice or os.environ.get('EDGE_VOICE', '') or self.DEFAULT_VOICE
        rate = os.environ.get('EDGE_RATE', '') or None
        pitch = os.environ.get('EDGE_PITCH', '') or None
        if not rate or not pitch:
            r, p = self.EMO_STYLE.get(str(emo or '').split(',')[0].strip(), ("+0%", "+0Hz"))
            rate = rate or r
            pitch = pitch or p

        fd, out = tempfile.mkstemp(suffix='.mp3')
        os.close(fd)
        try:
            async def _run():
                c = edge_tts.Communicate(text, v, rate=rate, pitch=pitch)
                await c.save(out)
            asyncio.run(_run())
            with open(out, 'rb') as f:
                data = f.read()
            if not data:
                raise RuntimeError('Edge TTS 未产出音频（可能是网络问题）')
            return data, 0
        finally:
            try:
                os.remove(out)
            except OSError:
                pass


class GptSovitsEngine(TTSEngine):
    """GPT-SoVITS v2Pro 离线克隆音色（常驻"子侧车"在 18767，本类只做 HTTP 代理）。

    为什么要单独一个进程：GPT-SoVITS 需要 torch cu126 环境（tts/venv-gptsovits），
    与 cosyvoice/indextts 各自独立的 Python 解释器冲突，所以由 main.js 单独拉起
    gptsovits_server.py（见 main.js 的 gptsovitsSpawn），本引擎只通过 http.client
    把 /tts 请求转过去、把返回的 WAV 字节原样交给侧车。这样各引擎互不污染解释器。

    可用判定：参考音频存在 + 子侧车 18767 端口可连（TCP 探活，不阻塞）。
    子侧车模型懒加载，所以探活只确认"进程在线"，不确认"权重已就绪"——
    权重在首个 /tts 请求时才搬进显存（约 13s），之后常驻。
    """
    name = "gptsovits"
    label = "GPT-SoVITS v2Pro（离线·克隆你的音色）"
    _HOST = "127.0.0.1"
    _PORT = int(os.environ.get("GPTSOVITS_PORT", "18767"))

    def _ref_default(self):
        here = os.path.dirname(os.path.abspath(__file__))
        return os.environ.get("GPTSOVITS_REF") or os.path.join(here, "ref", "prompt_9s.wav")

    def available(self):
        ref = self._ref_default()
        if not os.path.isfile(ref):
            return False
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.4)
        try:
            s.connect((self._HOST, self._PORT))
            return True
        except Exception:
            return False
        finally:
            try:
                s.close()
            except Exception:
                pass

    def voices(self):
        return ["clone"]

    def synth(self, text, voice=None, emo=None):
        q = urllib.parse.urlencode({"text": text})
        conn = http_client.HTTPConnection(self._HOST, self._PORT, timeout=180)
        try:
            conn.request("GET", "/tts?" + q)
            r = conn.getresponse()
            if r.status != 200:
                body = r.read().decode("utf-8", "ignore")
                raise RuntimeError("GPT-SoVITS 侧车返回 %d: %s" % (r.status, body[:200]))
            data = r.read()
        finally:
            conn.close()
        if not data:
            raise RuntimeError("GPT-SoVITS 未产出音频")
        return data, 0


# 优先级：越靠前越优先（auto 时取第一个 available）
# gptsovits 紧随 cosyvoice：cosyvoice 配置缺失（ref 为空等）不可用时，自动回落到
# GPT-SoVITS 克隆音色；二者都不可用时再退到在线 Edge / 内置语音 / 提示音。
_PRIORITY = ["cosyvoice", "gptsovits", "indextts", "edge", "sapi", "tone"]


def build_engines():
    reg = {}
    for e in (CosyVoiceEngine(), GptSovitsEngine(), IndexTTSEngine(), EdgeTTSEngine(),
              SapiEngine(), ToneEngine()):
        reg[e.name] = e
    return reg


def pick_engine_name(reg, want):
    """want 为空或 'auto' 时按优先级挑第一个可用的；否则按名字（不可用则回落 auto）。"""
    if want and want != "auto":
        e = reg.get(want)
        if e and e.available():
            return want
    for n in _PRIORITY:
        e = reg.get(n)
        if e and e.available():
            return n
    return "tone"
