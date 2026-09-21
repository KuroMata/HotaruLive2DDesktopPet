# -*- coding: utf-8 -*-
"""修复 CosyVoice 克隆试听的两个问题：
  1) 「突然兴奋」能量尖峰：CN idle_3 / JP idle_2 —— 生成多候选(含 speed 网格)，按 峰值/中位 能量比选最平稳者。
  2) 日语「莫名空白 + 空白杂音」：对所有 JP 文件做后处理 —— 静音段噪声门(清零) + 超长静音压缩到自然停顿。
依赖：cosyvoice_src venv + _extramods；torchaudio/soundfile/numpy。
"""
import os
import sys
import json
import numpy as np
import torch
import torchaudio
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src")
EXTRA = os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")
REF = os.environ.get("COSYVOICE_REF", os.path.join(HERE, "ref", "prompt.wav"))
from cosy_model import resolve_cosy_model
MODEL = resolve_cosy_model()
FP16 = os.environ.get("COSYVOICE_FP16", "1") not in ("0", "false", "False")
BASE_SPEED = float(os.environ.get("COSYVOICE_SPEED", "1.1"))

CN_OUT = os.path.join(HERE, "_out", "kouhai_cn_cosyvoice")
JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")

sys.path.insert(0, HERE)
sys.path.insert(0, COSY_DIR)
sys.path.insert(0, EXTRA)

SR = 24000
HOP = 240
WIN = 960
GATE_DB = -45.0          # 静音判定阈值
THR = 10 ** (GATE_DB / 20.0)
MIN_GAP_FR = 15          # 150ms 以上才算静音段(避免切掉辅音间隙)
MAX_PAUSE_S = 0.6        # 超过此长度的静音压缩
TARGET_PAUSE_S = 0.35    # 压缩目标(自然停顿)
FADE_MS = 12

JP = {
    ("idle", 2): "先輩のそちらの明かり、まだついてますよ。そろそろ休まないと、明日もデータの処理がありますから。",
}


def _patch_flex():
    import types
    ns = "torch.nn.attention.flex_attention"
    if ns in sys.modules or hasattr(torch.nn.attention, "flex_attention"):
        return
    m = types.ModuleType(ns)

    def flex_attention(*a, **k):
        raise NotImplementedError("flex_attention stub")
    m.flex_attention = flex_attention
    sys.modules[ns] = m
    torch.nn.attention.flex_attention = m  # type: ignore


# ---------- 音频分析 ----------
def frame_rms(wav):
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    peak = float(np.max(np.abs(wav))) + 1e-9
    wav = wav / peak
    n = len(wav)
    nf = 1 + (n - WIN) // HOP
    env = np.zeros(nf)
    for i in range(nf):
        seg = wav[i * HOP: i * HOP + WIN]
        env[i] = float(np.sqrt(np.mean(seg ** 2) + 1e-12))
    return env


def peak_median_ratio(wav):
    env = frame_rms(wav)
    return float(np.max(env) / (np.median(env) + 1e-9))


def speech_only_ratio(wav):
    """仅在非静音帧上算 峰值/平稳基准(35分位)，真正反映『突然兴奋』程度。"""
    env = frame_rms(wav)
    sp = env[env >= THR]
    if len(sp) == 0:
        return 0.0
    return float(np.max(sp) / (np.percentile(sp, 35) + 1e-9))


# ---------- 挂断音/纯音/双音/低频嗡鸣 检测器 ----------
def tonal_artifact_severity(wav, sr=24000):
    """检测「挂断电话音效 / 纯音 beep / 双音 / 低频嗡鸣」类非语音伪影，返回严重度 0~1。

    判据（任一命中即计严重度）：
      (a) 持续(>=120ms)窄带段：频谱平坦度极低 且 主峰能量占比高 -> 近正弦纯音/双音
          （如电话挂断的 400Hz 警告音、CosyVoice 偶发的纯音幻觉）。
      (b) 持续(>=300ms)低频段(<90Hz)：低频嗡鸣（模型幻觉输出的一段 ~70Hz 持续音）。
      (c) 孤立的短促(20~150ms)高能量宽带瞬态(env>6x 中位，且前后安静)：咔哒/按键 click。
    返回 0 表示干净；否则返回归一化严重度（越大越像伪影）。
    """
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float32)
    peak = float(np.max(np.abs(wav))) + 1e-9
    x = wav / peak
    N = 1024
    HOP = 256
    n = len(x)
    nf = max(0, (n - N) // HOP)
    if nf < 4:
        return 0.0
    flats, pr1s, f0s, envs = [], [], [], []
    for i in range(nf):
        seg = x[i * HOP:i * HOP + N]
        w = seg * np.hanning(N)
        sp = np.abs(np.fft.rfft(w)) + 1e-12
        spn = sp / sp.sum()
        freqs = np.fft.rfftfreq(N, 1.0 / sr)
        g = np.exp(np.mean(np.log(spn)))
        a = spn.mean()
        flat = g / (a + 1e-12)
        k = int(np.argmax(spn))
        flats.append(flat)
        pr1s.append(spn[k])
        f0s.append(freqs[k])
        envs.append(float(np.sqrt(np.mean(seg ** 2) + 1e-12)))
    flats = np.array(flats)
    pr1s = np.array(pr1s)
    f0s = np.array(f0s)
    envs = np.array(envs)
    score = 0.0

    # (a) 持续窄带纯音/双音
    tonal = (flats < 0.05) & (pr1s > 0.5)
    i = 0
    while i < nf:
        if tonal[i]:
            j = i
            while j < nf and tonal[j]:
                j += 1
            dur = (j - i) * HOP / sr
            if dur >= 0.12:
                score = max(score, min(1.0, dur))
            i = j
        else:
            i += 1

    # (b) 低频嗡鸣
    low = (f0s < 90.0) & (pr1s > 0.3)
    i = 0
    while i < nf:
        if low[i]:
            j = i
            while j < nf and low[j]:
                j += 1
            dur = (j - i) * HOP / sr
            if dur >= 0.3:
                score = max(score, min(1.0, dur * 0.8))
            i = j
        else:
            i += 1

    # (c) 孤立短促高能量瞬态(click/pop)
    med = float(np.median(envs))
    if med > 1e-6:
        trans = (envs > 6.0 * med) & (flats > 0.15)
        i = 0
        while i < nf:
            if trans[i]:
                j = i
                while j < nf and trans[j]:
                    j += 1
                dur = (j - i) * HOP / sr
                if 0.02 <= dur <= 0.15:
                    a0 = max(0, i - int(0.2 * sr / HOP))
                    b0 = min(nf, j + int(0.2 * sr / HOP))
                    surround = float(np.median(envs[a0:b0]))
                    if surround < 2.0 * med:
                        score = max(score, 0.7)
                i = j
            else:
                i += 1
    return float(score)


def has_tonal_artifact(wav, sr=24000, thr=0.3):
    return tonal_artifact_severity(wav, sr) > thr


# ---------- 合成 ----------
def synth(cosy, text, speed):
    gen = cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF, stream=False, speed=speed)
    chunks = []
    for chunk in gen:
        chunks.append(chunk["tts_speech"])
    if not chunks:
        raise RuntimeError("no speech")
    speech = torch.cat(chunks, dim=-1)  # (1, N) 拼接所有段落
    return speech


def pick_calmest(cosy, text, speeds):
    cands = []
    for sp in speeds:
        for _ in range(2):  # 每 speed 取 2 个样本(若模型随机则有差异)
            sp_tensor = synth(cosy, text, sp)
            wav = sp_tensor.squeeze(0).cpu().numpy()
            cands.append((peak_median_ratio(wav), sp, sp_tensor))
    cands.sort(key=lambda x: x[0])
    return cands[0]


# ---------- 静音清理(噪声门 + 压缩) ----------
def clean_silence(wav):
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float32)
    env = frame_rms(wav)  # 已按峰值归一
    sil = env < THR
    n = len(wav)
    nf = len(env)
    # 帧 -> 样本 静音 mask
    sil_sample = np.zeros(n, dtype=bool)
    for i in range(nf):
        if sil[i]:
            sil_sample[i * HOP: i * HOP + WIN] = True
    # 找静音段(样本区间)，长度 >= MIN_GAP_FR 帧
    gaps = []
    i = 0
    while i < nf:
        if sil[i]:
            j = i
            while j < nf and sil[j]:
                j += 1
            if (j - i) >= MIN_GAP_FR:
                gaps.append((i * HOP, min(j * HOP + WIN, n)))
            i = j
        else:
            i += 1
    if not gaps:
        return wav
    fade = int(FADE_MS / 1000.0 * SR)
    out = []
    prev = 0
    for idx, (a, b) in enumerate(gaps):
        sp_seg = wav[prev:a].copy()
        L = len(sp_seg)
        if L > 0:
            if idx > 0 and fade * 2 < L:       # 非首段：前有静音 -> 淡入
                sp_seg[:fade] *= np.linspace(0, 1, fade)
            if fade * 2 < L:                    # 段后接静音 -> 淡出到 0
                sp_seg[-fade:] *= np.linspace(1, 0, fade)
            out.append(sp_seg)
        glen = (b - a) / SR
        keep = int(TARGET_PAUSE_S * SR) if glen > MAX_PAUSE_S else (b - a)
        out.append(np.zeros(keep, dtype=np.float32))  # 静音段清零(去 -50dB 杂音)
        prev = b
    tail = wav[prev:].copy()
    if len(tail) > 0:
        if fade * 2 < len(tail):               # 尾段前有静音 -> 淡入
            tail[:fade] *= np.linspace(0, 1, fade)
        out.append(tail)
    out = np.concatenate(out)
    # 全局噪声门：清掉未被长静音段捕获的短促残余嘶声(< -52dB)
    gthr = 10 ** (-52.0 / 20.0)
    oenv = frame_rms(out)
    nf2 = len(oenv)
    gmask = np.zeros(len(out), dtype=bool)
    for i in range(nf2):
        if oenv[i] < gthr:
            gmask[i * HOP: i * HOP + WIN] = True
    out[gmask] = 0.0
    return out


# ---------- 软限幅：只压超过「语音中位能量」阈值的爆发段，去除突然兴奋 ----------
def tame_spike(wav, max_ratio=2.3, win_ms=10):
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float32)
    peak = float(np.max(np.abs(wav))) + 1e-9
    x = wav / peak
    env = frame_rms(x)
    sil = env < THR
    speech_env = env[~sil]
    if len(speech_env) == 0:
        return wav
    # 用平稳基准(35 分位)而非中位数，避免爆发段抬高阈值导致限幅失效
    ref = float(np.percentile(speech_env, 35)) + 1e-9
    ceil = max_ratio * ref
    absx = np.abs(x)
    win = max(3, int(win_ms / 1000.0 * SR))
    # 峰值包络(最大池化)而非 RMS 均值：能抓住 1~2 采样点的短时爆音，避免漏压
    from scipy.ndimage import maximum_filter1d
    env_s = maximum_filter1d(absx, size=win) + 1e-9
    gain = np.minimum(1.0, ceil / env_s)
    gain = np.clip(gain, 0.25, 1.0)
    k2 = max(1, win // 2)
    gain = np.convolve(gain, np.ones(k2) / k2, mode="same")   # 平滑避免 pumping
    out = x * gain
    return (out * peak).astype(np.float32)


# ---------- 响度归一化：统一到目标集成响度(LUFS)，消除「响度不一致」 ----------
def _softclip(x, thr=0.9):
    """线性区 [-thr,thr]；超出部分用 tanh 压缩到 1.0 附近，避免硬削波失真。
    对语音主体(<thr)保持线性，仅压住极少数瞬态峰值。"""
    y = x.copy()
    over = np.abs(x) > thr
    if not np.any(over):
        return y
    mag = np.abs(x[over])
    sign = np.sign(x[over])
    y[over] = sign * (thr + (1.0 - thr) * np.tanh((mag - thr) / (1.0 - thr)))
    return y


def normalize_loudness(wav, target_lufs=-16.0, max_boost_db=12.0, max_cut_db=12.0):
    """把音频响度拉到 target_lufs(BS.1770, pyloudnorm)。
    先峰值归一(pyloudnorm 要求输入峰值<=1)，按 LUFS 差给增益，再用软限幅防削波。
    软限幅只压瞬态，语音主体保持线性 -> 静音偏多的文件(如 click_2)也能真正提升响度而不破音。
    返回 float32 单声道。"""
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float32)
    peak = float(np.max(np.abs(wav))) + 1e-9
    x = wav / peak
    import pyloudnorm as pyln
    meter = pyln.Meter(SR)
    cur = float(meter.integrated_loudness(x))
    if not np.isfinite(cur) or cur < -90.0:
        return wav  # 近乎静音，跳过
    gain_db = float(np.clip(target_lufs - cur, -max_cut_db, max_boost_db))
    gain = 10 ** (gain_db / 20.0)
    y = x * gain
    y = _softclip(y, thr=0.9)
    return y.astype(np.float32)


def main():
    _patch_flex()
    skip = os.environ.get("COSY_SKIP_GEN") == "1"
    cosy = None
    if not skip:
        from cosyvoice.cli.cosyvoice import CosyVoice2
        cosy = CosyVoice2(MODEL, load_jit=False, load_trt=False, fp16=FP16)
        print(">> model loaded")

    if not skip:
        # 1) 修复 CN idle_3 兴奋尖峰
        cn_items = json.load(open(os.path.join(HERE, "..", "app", "data", "idle-lines.json"), encoding="utf-8"))
        cn_idle3 = cn_items[3]["text"]
        speeds = [BASE_SPEED - 0.1, BASE_SPEED - 0.05, BASE_SPEED, BASE_SPEED + 0.05, BASE_SPEED + 0.1]
        ratio, sp, speech = pick_calmest(cosy, cn_idle3, speeds)
        tamed = tame_spike(speech.squeeze(0).cpu().numpy())
        sf.write(os.path.join(CN_OUT, "idle_3.wav"), tamed, SR)
        print("CN idle_3  修复: speed=%.2f 候选峰值/中位=%.2fx, 限幅后已存" % (sp, ratio))

        # 2) 修复 JP idle_2 兴奋尖峰
        jp_idle2 = JP[("idle", 2)]
        ratio, sp, speech = pick_calmest(cosy, jp_idle2, speeds)
        tamed = tame_spike(speech.squeeze(0).cpu().numpy())
        sf.write(os.path.join(JP_OUT, "idle_2.wav"), tamed, SR)
        print("JP idle_2  修复: speed=%.2f 候选峰值/中位=%.2fx, 限幅后已存" % (sp, ratio))
    else:
        # 跳过生成：对已存的兴奋文件做限幅
        for label, path in (("CN idle_3", os.path.join(CN_OUT, "idle_3.wav")),
                            ("JP idle_2", os.path.join(JP_OUT, "idle_2.wav"))):
            wav, sr = sf.read(path)
            if sr != SR:
                wav = torchaudio.functional.resample(torch.from_numpy(wav).float().mean(1, keepdim=True), sr, SR).squeeze().numpy()
            out = tame_spike(wav)
            sf.write(path, out, SR)
            print("%s 限幅完成 (峰值/中位=%.2fx)" % (label, peak_median_ratio(out)))

    # 3) 对所有 JP 文件做静音清理(噪声门 + 压缩)
    print("--- JP 静音清理 ---")
    for fn in sorted(os.listdir(JP_OUT)):
        if not fn.endswith(".wav"):
            continue
        path = os.path.join(JP_OUT, fn)
        wav, sr = sf.read(path)
        if sr != SR:
            wav = torchaudio.functional.resample(torch.from_numpy(wav).float().mean(1, keepdim=True), sr, SR).squeeze().numpy()
        cleaned = clean_silence(wav)
        env = frame_rms(cleaned)
        nf_db = 20 * np.log10(float(np.median(env[env < THR])) + 1e-12) if np.any(env < THR) else -999
        sf.write(path, cleaned, SR)
        # 报告清理前后时长
        dur_before = len(wav) / SR
        dur_after = len(cleaned) / SR
        print("  %-14s 噪声底=%.1fdB  时长 %.1f->%.1fs" % (fn, nf_db, dur_before, dur_after))

    # 复测兴奋文件
    for label, path in (("CN idle_3", os.path.join(CN_OUT, "idle_3.wav")),
                        ("JP idle_2", os.path.join(JP_OUT, "idle_2.wav"))):
        wav, _ = sf.read(path)
        print("%s 复测 全文件峰值/中位=%.2fx, 语音内峰值/平稳=%.2fx"
              % (label, peak_median_ratio(wav), speech_only_ratio(wav)))


if __name__ == "__main__":
    main()
