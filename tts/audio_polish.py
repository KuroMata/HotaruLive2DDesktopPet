# -*- coding: utf-8 -*-
"""音频润色模块 —— 把 TTS 原始输出/干音处理到"能听"的商业级水准。

设计依据（本机实测 D:\\live2d-companion\\tts\\ref\\ref.wav 与生成的 sample_indextts.wav）：

  问题1  生成音频 5-8kHz 能量占比 9.2%，而干音只有 2.8%（翻了 3 倍）。
         这是相位声码器变调(librosa.effects.pitch_shift)留下的 artifacts，
         听感就是"电音感/金属感"。→ 解决：不再对输出做变调；已产生的用 PeakFilter 压掉。
  问题2  干音 80-300Hz 占了 48.8%（过低频过重 → 闷/轰），8kHz 以上仅 2.9%（高频缺失）。
         → 解决：低架削减 + 高频架补偿。
  问题3  动态起伏大、响度偏低（rms -28dBFS）。→ 解决：压缩 + 限幅 + 响度归一。

依赖 pedalboard（Spotify，内置 Rubber Band 变调算法）；缺失时自动降级，保证不崩。
"""
import io
import os

import numpy as np
import soundfile as sf

try:
    import pedalboard
except Exception:  # noqa: BLE001
    pedalboard = None


# --------------------------------------------------------------------------- 基础 IO
def read_wav(path_or_bytes):
    """读 WAV，返回 (float64 单声道 ndarray, 采样率)。"""
    if isinstance(path_or_bytes, (bytes, bytearray)):
        x, sr = sf.read(io.BytesIO(path_or_bytes), always_2d=False)
    else:
        x, sr = sf.read(path_or_bytes, always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x.astype(np.float64), int(sr)


def write_wav(x, sr, subtype="PCM_16"):
    """把 ndarray 写成 WAV 字节。"""
    buf = io.BytesIO()
    sf.write(buf, np.clip(x, -1.0, 1.0), sr, format="WAV", subtype=subtype)
    return buf.getvalue()


def _pb(board, x, sr):
    """用 pedalboard 处理；pedalboard 缺失时原样返回。"""
    if pedalboard is None:
        return x
    return board.process(x.astype(np.float32), sr).astype(np.float64)


# --------------------------------------------------------------------------- 变调
def pitch_shift(x, sr, semitones):
    """变调（保持时长）。

    优先用 pedalboard 的 PitchShift（Rubber Band 实现，金属感远小于 librosa 的
    相位声码器）；pedalboard 缺失时退回 librosa。
    """
    if abs(semitones) < 1e-6:
        return x
    if pedalboard is not None:
        try:
            return _pb(pedalboard.PitchShift(semitones=float(semitones)), x, sr)
        except Exception:  # noqa: BLE001
            pass
    try:
        import librosa
        return librosa.effects.pitch_shift(y=x, sr=sr, n_steps=float(semitones))
    except Exception:  # noqa: BLE001
        return x


# --------------------------------------------------------------------------- 响度
def normalize_loudness(x, target_rms_db=-20.0, peak_ceiling_db=-1.5, fallback=True):
    """把响度拉到目标 RMS（并对峰值封顶，避免削顶）。

    商业配音常见参考：播客约 -16 LUFS，这里用 RMS 近似。
    """
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return x
    rms = float(np.sqrt((x ** 2).mean()))
    if rms < 1e-9:
        return x
    cur_db = 20.0 * np.log10(rms)
    g = 10.0 ** ((target_rms_db - cur_db) / 20.0)
    y = x * g
    peak = float(np.abs(y).max())
    ceil = 10.0 ** (peak_ceiling_db / 20.0)
    if peak > ceil:
        y = y * (ceil / peak)
    return y


# --------------------------------------------------------------------------- 干音清洁
def clean_reference(x, sr,
                    hp_cut=90.0,
                    low_shelf_gain=-4.0, low_shelf_cut=260.0,
                    high_shelf_gain=4.0, high_shelf_cut=5200.0,
                    box_gain=-2.5, box_cut=420.0,
                    comp_threshold=-22.0, comp_ratio=2.2,
                    target_rms=-20.0,
                    deartifact_gain=0.0, deartifact_cut=11000.0):
    """清洁/美化参考音频（干音），让 TTS 学到更干净的音色。

    针对本机干音的实测问题：
      - 80-300Hz 占 48.8% → 低架削减 + 切除 90Hz 以下（去闷、去轰）
      - 8kHz 以上仅 2.9% → 高频架补偿（补空气感/清晰度）
      - 底噪 -49.5dBFS、动态起伏 → 轻度压缩

    ⚠️ deartifact_gain（默认 0=关闭）：**做过变调时必须开启**。
    变调(pitch_shift)会在高频留下 artifacts，若此时还用 high_shelf_gain 提升高频，
    等于把 artifacts 一起放大——实测会让合成结果的 8kHz 以上能量从 1.7% 涨到 6%，
    听感就是"毛刺/电音"。所以变调场景要 (1) 别提高频 (2) 削掉高频 artifacts。
    """
    y = np.asarray(x, dtype=np.float64)
    if pedalboard is not None:
        chain = [
            pedalboard.HighpassFilter(cutoff_frequency_hz=hp_cut),
            pedalboard.LowShelfFilter(cutoff_frequency_hz=low_shelf_cut, gain_db=low_shelf_gain, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=box_cut, gain_db=box_gain, q=1.0),
            pedalboard.HighShelfFilter(cutoff_frequency_hz=high_shelf_cut, gain_db=high_shelf_gain, q=0.7),
        ]
        if deartifact_gain:
            chain.append(pedalboard.PeakFilter(cutoff_frequency_hz=deartifact_cut,
                                               gain_db=deartifact_gain, q=0.9))
        chain.append(pedalboard.Compressor(threshold_db=comp_threshold, ratio=comp_ratio,
                                           attack_ms=8.0, release_ms=140.0))
        board = pedalboard.Pedalboard(chain)
        y = _pb(board, y, sr)
    else:
        # 降级：仅做响度归一
        pass
    return normalize_loudness(y, target_rms_db=target_rms, peak_ceiling_db=-2.0)


# --------------------------------------------------------------------------- 输出润色
def master(x, sr,
           hp_cut=80.0,
           low_shelf_gain=-2.5, low_shelf_cut=250.0,
           artifact_gain=-5.0, artifact_cut=6400.0, artifact_q=1.1,
           air_gain=2.5, air_cut=8500.0,
           presence_gain=1.5, presence_cut=3200.0,
           comp_threshold=-24.0, comp_ratio=2.0,
           limit_threshold=-1.5,
           target_rms=-18.0):
    """TTS 输出润色链（mastering）。

    核心是 artifact_gain/artifact_cut：压掉 5-8kHz 那堆积的"电音感"能量。
    再用低架削减去闷、高频架补空气、压缩稳动态、限幅防削顶、最后归一响度。
    """
    y = np.asarray(x, dtype=np.float64)
    if pedalboard is not None:
        board = pedalboard.Pedalboard([
            pedalboard.HighpassFilter(cutoff_frequency_hz=hp_cut),
            pedalboard.LowShelfFilter(cutoff_frequency_hz=low_shelf_cut, gain_db=low_shelf_gain, q=0.7),
            # 去"电音感"：压掉变调 artifacts 堆积的 5-8kHz
            pedalboard.PeakFilter(cutoff_frequency_hz=artifact_cut, gain_db=artifact_gain, q=artifact_q),
            # 齿音区轻收，避免"嘶"
            pedalboard.PeakFilter(cutoff_frequency_hz=7600.0, gain_db=-2.0, q=1.4),
            # 临场感：3kHz 附近轻提，让声音更"靠前"
            pedalboard.PeakFilter(cutoff_frequency_hz=presence_cut, gain_db=presence_gain, q=0.9),
            # 空气感
            pedalboard.HighShelfFilter(cutoff_frequency_hz=air_cut, gain_db=air_gain, q=0.7),
            pedalboard.Compressor(threshold_db=comp_threshold, ratio=comp_ratio,
                                  attack_ms=6.0, release_ms=120.0),
            pedalboard.Limiter(threshold_db=limit_threshold, release_ms=80.0),
        ])
        y = _pb(board, y, sr)
    return normalize_loudness(y, target_rms_db=target_rms, peak_ceiling_db=limit_threshold)


def clean_reference_formant(x, sr,
                            hp_cut=90.0,
                            low_shelf_gain=-5.0, low_shelf_cut=300.0,
                            adult_f1_gain=-3.0, adult_f1_cut=450.0,
                            boy_f1_gain=3.5, boy_f1_cut=900.0,
                            boy_f2_gain=3.0, boy_f2_cut=2200.0,
                            high_shelf_gain=-1.0, high_shelf_cut=4500.0,
                            deartifact_gain=-8.0, deartifact_cut=11000.0,
                            comp_threshold=-22.0, comp_ratio=2.2,
                            target_rms=-20.0):
    """参考音频清洁 + **模拟少年声道（共振峰上移）**。

    为什么需要它：只提高音调(f0)仍会"像大人装小孩"——儿童的声道更短，
    共振峰 F1/F2 也更高。这里在变调之后用 EQ 模拟更短的声道：
      削 450Hz（成人 F1）→ 提 900Hz（少年 F1）→ 提 2200Hz（少年 F2）
    高频保持克制(-1dB)，避免把变调 artifacts 一起放大。
    """
    y = np.asarray(x, dtype=np.float64)
    if pedalboard is not None:
        board = pedalboard.Pedalboard([
            pedalboard.HighpassFilter(cutoff_frequency_hz=hp_cut),
            pedalboard.LowShelfFilter(cutoff_frequency_hz=low_shelf_cut, gain_db=low_shelf_gain, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=adult_f1_cut, gain_db=adult_f1_gain, q=1.0),
            pedalboard.PeakFilter(cutoff_frequency_hz=boy_f1_cut, gain_db=boy_f1_gain, q=1.2),
            pedalboard.PeakFilter(cutoff_frequency_hz=boy_f2_cut, gain_db=boy_f2_gain, q=1.2),
            pedalboard.HighShelfFilter(cutoff_frequency_hz=high_shelf_cut, gain_db=high_shelf_gain, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=deartifact_cut, gain_db=deartifact_gain, q=0.9),
            pedalboard.Compressor(threshold_db=comp_threshold, ratio=comp_ratio,
                                  attack_ms=8.0, release_ms=140.0),
        ])
        y = _pb(board, y, sr)
    return normalize_loudness(y, target_rms_db=target_rms, peak_ceiling_db=-2.0)


def master_broadcast(x, sr,
                     hp_cut=110.0,
                     low_shelf_gain=-4.0, low_shelf_cut=320.0,
                     mid_gain=3.0, mid_cut=2000.0,
                     bright_gain=2.0, bright_cut=4500.0,
                     air_gain=-2.0, air_cut=9000.0,
                     comp_threshold=-30.0, comp_ratio=4.0,
                     limit_threshold=-1.2,
                     target_rms=-16.0):
    """广播级/视频配音风格（比 master 更"贴"、更平稳、更响）。

    网上常见的 AI 配音视频，听感特征是：饱满的中频（字字清楚）、几乎没有动态起伏、
    响度统一、没有齿音毛刺。这里对应地：
      - 切更高的低频（110Hz）：去掉轰鸣，让声音"干净"
      - 中频 +3dB@2kHz：这是播报清晰感的核心
      - 高频不提反压（-2dB@9k）：避免金属/毛刺感
      - 重压缩（4:1，阈值 -30dB）：把动态压平，声音更"稳"
      - 响度归一到 -16 dBFS RMS：接近视频平台的常用响度
    """
    y = np.asarray(x, dtype=np.float64)
    if pedalboard is not None:
        board = pedalboard.Pedalboard([
            pedalboard.HighpassFilter(cutoff_frequency_hz=hp_cut),
            pedalboard.LowShelfFilter(cutoff_frequency_hz=low_shelf_cut, gain_db=low_shelf_gain, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=mid_cut, gain_db=mid_gain, q=0.9),
            pedalboard.PeakFilter(cutoff_frequency_hz=bright_cut, gain_db=bright_gain, q=1.0),
            pedalboard.PeakFilter(cutoff_frequency_hz=6300.0, gain_db=-4.0, q=1.2),
            pedalboard.HighShelfFilter(cutoff_frequency_hz=air_cut, gain_db=air_gain, q=0.7),
            pedalboard.Compressor(threshold_db=comp_threshold, ratio=comp_ratio,
                                  attack_ms=4.0, release_ms=100.0),
            pedalboard.Limiter(threshold_db=limit_threshold, release_ms=60.0),
        ])
        y = _pb(board, y, sr)
    return normalize_loudness(y, target_rms_db=target_rms, peak_ceiling_db=limit_threshold)


def smooth_muffled(x, sr,
                   hp_cut=70.0,
                   low_shelf_gain=3.0, low_shelf_cut=180.0,
                   deartifact_gain=-8.0, deartifact_cut=6500.0,
                   presence_gain=-3.0, presence_cut=4000.0,
                   air_gain=-5.0, air_cut=3500.0,
                   lowpass_cut=6000.0, lowpass_q=0.7,
                   comp_threshold=-22.0, comp_ratio=2.5,
                   limit_threshold=-1.5,
                   target_rms=-18.0):
    """圆滑沉闷版润色 —— 用户要回到的「最初版本」风格。

    与 master（明亮靠前、临场感强）相反，这里要的是「圆滑、沉闷、不刺耳」，
    所以整体压低高频：

      - 低架 +3dB@180：补一点胸腔厚度，声音更"实"、不单薄
      - 去电音峰 -8dB@6.5k：压掉 BigVGAN vocoder 在 5-8kHz 堆的 artifacts（去电音感）
      - 临场峰 -3dB@4k + 高频架 -5dB@3.5k：把明亮度收回，听感变柔
      - 低通 6k：最终兜底，滤掉最刺的高频尾巴，保证"圆滑"不毛
      - 压缩 2.5:1 + 限幅：动态放平，听感更"圆"更稳
    """
    y = np.asarray(x, dtype=np.float64)
    if pedalboard is not None:
        board = pedalboard.Pedalboard([
            pedalboard.HighpassFilter(cutoff_frequency_hz=hp_cut),
            pedalboard.LowShelfFilter(cutoff_frequency_hz=low_shelf_cut, gain_db=low_shelf_gain, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=deartifact_cut, gain_db=deartifact_gain, q=1.3),
            pedalboard.PeakFilter(cutoff_frequency_hz=presence_cut, gain_db=presence_gain, q=1.0),
            pedalboard.HighShelfFilter(cutoff_frequency_hz=air_cut, gain_db=air_gain, q=0.7),
            pedalboard.LowpassFilter(cutoff_frequency_hz=lowpass_cut),
            pedalboard.Compressor(threshold_db=comp_threshold, ratio=comp_ratio,
                                  attack_ms=6.0, release_ms=120.0),
            pedalboard.Limiter(threshold_db=limit_threshold, release_ms=80.0),
        ])
        y = _pb(board, y, sr)
    return normalize_loudness(y, target_rms_db=target_rms, peak_ceiling_db=limit_threshold)


def speed_up(x, sr, rate=1.12):
    """保 Pitch 变速（加速不跑调）——优先用 pedalboard 的 Rubber Band time_stretch。

    背景：IndexTTS-2 的 use_speed 被硬编码为 0，原生没有语速旋钮，默认偏慢；
    慢速 + 句中省略号长停顿 → 部分句子"断句"听起来发散。

    ⚠️ 关键：必须用 Rubber Band（pedalboard.time_stretch），**绝不能用 librosa 的
    相位声码器**——后者会在语音里留下明显的"相位模糊/金属感"，听感就是机器人/
    变形金刚/守望先锋拉玛刹。Rubber Band 是保共振峰的时间拉伸，金属感极小。
    pedalboard 缺失时才退回 librosa（不推荐）。
    """
    if abs(rate - 1.0) < 1e-3:
        return np.asarray(x, dtype=np.float64)
    if pedalboard is not None:
        try:
            y = pedalboard.time_stretch(x.astype(np.float32), int(sr), float(rate))
            y = np.asarray(y, dtype=np.float64)
            if y.ndim == 2:        # pedalboard 对单声道返回 (1, N)，压回 1D
                y = y[0]
            return y
        except Exception:  # noqa: BLE001
            pass
    try:
        import librosa
    except Exception:  # noqa: BLE001
        return np.asarray(x, dtype=np.float64)
    try:
        y = librosa.effects.time_stretch(y=np.asarray(x, dtype=np.float32), rate=float(rate))
        return np.asarray(y, dtype=np.float64)
    except Exception:  # noqa: BLE001
        return np.asarray(x, dtype=np.float64)


def deartifact_stretch(x, sr,
                       hp_cut=80.0,
                       low_shelf_gain=-2.5, low_shelf_cut=250.0,
                       artifact_gain=-7.0, artifact_cut=6000.0, artifact_q=1.2,
                       deess_gain=-3.0, deess_cut=7600.0, deess_q=1.4,
                       lowpass_cut=9000.0,
                       comp_threshold=-24.0, comp_ratio=2.0,
                       limit_threshold=-1.5, target_rms=-18.0):
    """变速后专用润色：只压毛刺、**不提亮**。

    变速（尤其相位声码器残留）会在 5-9kHz 留下"相位模糊/金属感"，若此时还像
    master() 那样用 HighShelf +2.5dB@8.5k 提亮，等于把金属感放大 → 机器人声。
    所以这里：压掉 6kHz 堆积 + 收齿音 7.6kHz + 低通 9kHz 兜底，**高频架增益=0**，
    压缩稳动态 + 归一响度。音色保持自然，不再"发光发亮"。
    """
    y = np.asarray(x, dtype=np.float64)
    if pedalboard is not None:
        board = pedalboard.Pedalboard([
            pedalboard.HighpassFilter(cutoff_frequency_hz=hp_cut),
            pedalboard.LowShelfFilter(cutoff_frequency_hz=low_shelf_cut, gain_db=low_shelf_gain, q=0.7),
            pedalboard.PeakFilter(cutoff_frequency_hz=artifact_cut, gain_db=artifact_gain, q=artifact_q),
            pedalboard.PeakFilter(cutoff_frequency_hz=deess_cut, gain_db=deess_gain, q=deess_q),
            pedalboard.LowpassFilter(cutoff_frequency_hz=lowpass_cut),
            pedalboard.Compressor(threshold_db=comp_threshold, ratio=comp_ratio,
                                  attack_ms=6.0, release_ms=120.0),
            pedalboard.Limiter(threshold_db=limit_threshold, release_ms=80.0),
        ])
        y = _pb(board, y, sr)
    return normalize_loudness(y, target_rms_db=target_rms, peak_ceiling_db=limit_threshold)


def polish_bytes(wav_bytes, master_on=True, **kw):
    """对 WAV 字节做润色，返回新的 WAV 字节。"""
    x, sr = read_wav(wav_bytes)
    if master_on:
        x = master(x, sr, **kw)
    return write_wav(x, sr)


def report(path):
    """返回该音频的关键指标（用于对比润色前后）。"""
    x, sr = read_wav(path)
    fl = int(0.025 * sr)
    hop = int(0.010 * sr)
    frames = [x[s:s + fl] for s in range(0, max(1, len(x) - fl + 1), hop)]
    F = np.array(frames) if frames else np.zeros((1, fl))
    W = np.hanning(fl)
    P = np.abs(np.fft.rfft(F * W, axis=1)) ** 2 + 1e-12
    freqs = np.fft.rfftfreq(fl, 1.0 / sr)
    e_db = 20 * np.log10((F ** 2).mean(axis=1) + 1e-12)
    v = e_db > (e_db.max() - 40)
    Pv = P[v] if v.sum() > 3 else P
    tot = Pv.sum(axis=1)
    out = {"sr": sr, "dur": round(len(x) / sr, 2),
           "peak_db": round(20 * np.log10(max(np.abs(x).max(), 1e-9)), 1),
           "rms_db": round(20 * np.log10(max(np.sqrt((x ** 2).mean()), 1e-9)), 1)}
    for name, (lo, hi) in {"80-300": (80, 300), "300-1k": (300, 1000),
                           "1k-3k": (1000, 3000), "3k-5k": (3000, 5000),
                           "5k-8k": (5000, 8000)}.items():
        m = (freqs >= lo) & (freqs < hi)
        out[name] = round(100 * float((Pv[:, m].sum(axis=1) / (tot + 1e-12)).mean()), 2)
    return out


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        if os.path.isfile(p):
            print(p, "->", report(p))
