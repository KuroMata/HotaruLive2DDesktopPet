# -*- coding: utf-8 -*-
"""
make_prompt.py —— 从长参考录音里截出一段适合做零样本克隆的 prompt（纯标准库）
================================================================================
为什么需要：多数零样本引擎（IndexTTS-2 / CosyVoice）的参考音频只要 3–30 秒，
喂 90 多秒通常会被内部截取，浪费且不可控。这里按"整句边界"截一段连续、少静音的片段。

做法：
  1) 逐 20ms 帧算 RMS，标出语音帧；
  2) 把语音帧合并成"句段"（间隔 ≤60ms 视为同一段）；
  3) 搜索由**完整句段**组成、时长最接近目标、内部静音最少的连续区间；
  4) 按该区间裁剪，首尾各做 20ms 淡入淡出（防咔哒声）；
  5) 输出单声道 16-bit WAV（保持原采样率）。

用法：
  python tts/make_prompt.py                     # 默认 20 秒，源 tts/ref/ref.wav
  python tts/make_prompt.py -t 25               # 目标 25 秒
  python tts/make_prompt.py -i a.wav -o b.wav
"""
import argparse
import array
import math
import os
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DEFAULT = os.path.join(HERE, 'ref', 'ref.wav')
DST_DEFAULT = os.path.join(HERE, 'ref', 'prompt.wav')

FRAME_S = 0.02          # 20ms 分析帧
MERGE_GAP = 3           # 句段合并容差（帧），3 帧 = 60ms
SIL_RATIO = 0.005       # ≈ -46 dBFS
FADE_S = 0.02


def load_pcm16(path):
    with wave.open(path, 'rb') as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit('本脚本仅处理 16-bit WAV（当前 %d bit）。请先用 Audition 导出 16-bit。' % (sw * 8))
    if ch != 1:
        print('  提示：源文件是 %d 声道，将只取第 1 声道。' % ch)
    a = array.array('h')
    a.frombytes(raw)
    if ch > 1:
        mono = array.array('h', a[0::ch])
    else:
        mono = a
    return sr, mono


def frame_rms(vals, fs, ch=1):
    step = max(1, int(fs * FRAME_S))
    out = []
    for s in range(0, len(vals) - step + 1, step):
        acc = 0.0
        for i in range(s, s + step):
            v = vals[i]
            acc += float(v) * v
        out.append(math.sqrt(acc / step))
    return out, step


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-i', '--input', default=SRC_DEFAULT)
    ap.add_argument('-o', '--output', default=DST_DEFAULT)
    ap.add_argument('-t', '--target', type=float, default=20.0, help='目标时长（秒），建议 15–30')
    args = ap.parse_args()

    print('=== 截取参考 prompt ===')
    if not os.path.isfile(args.input):
        print('  ✗ 源文件不存在:', args.input)
        return 2

    sr, vals = load_pcm16(args.input)
    dur = len(vals) / float(sr)
    print('  源文件    : %s' % args.input)
    print('  源时长    : %.2f s @ %d Hz' % (dur, sr))

    frs, step = frame_rms(vals, sr)
    thr = 32768.0 * SIL_RATIO

    runs = []
    for i, x in enumerate(frs):
        if x >= thr:
            if runs and i - runs[-1][1] <= MERGE_GAP:
                runs[-1][1] = i
            else:
                runs.append([i, i])
    if not runs:
        print('  ✗ 未检测到语音，无法截取')
        return 2
    print('  语音句段  : %d 段，最长单段 %.2f s' % (
        len(runs), max((r[1] - r[0] + 1) for r in runs) * FRAME_S))

    want = int(round(args.target / FRAME_S))
    best = None
    for s in range(len(runs)):
        for e in range(s, len(runs)):
            span = runs[e][1] - runs[s][0] + 1
            if span < want:
                continue
            sil = 0
            for i in range(runs[s][0], runs[e][1] + 1):
                if frs[i] < thr:
                    sil += 1
            d = span * FRAME_S
            # 分数：内部静音 + 超出目标时长的惩罚（1 秒超出 ≈ 1 秒静音）
            score = sil * FRAME_S + (d - args.target)
            if best is None or score < best[0]:
                best = (score, runs[s][0], runs[e][1], d, sil * FRAME_S)
            break
    if best is None:
        print('  ! 没有足够长的连续片段；改用整段')
        st, en = runs[0][0], runs[-1][1]
        d = (en - st + 1) * FRAME_S
        sil = None
    else:
        _, st, en, d, sil = best
        if sil is None:
            sil = 0.0

    a = st * step
    b = min(len(vals), (en + 1) * step)
    seg = array.array('h', vals[a:b])

    # 首尾淡入淡出
    fade = max(1, int(sr * FADE_S))
    for i in range(min(fade, len(seg))):
        seg[i] = int(seg[i] * (i / float(fade)))
    for i in range(min(fade, len(seg))):
        seg[len(seg) - 1 - i] = int(seg[len(seg) - 1 - i] * (i / float(fade)))

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with wave.open(args.output, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(seg.tobytes())

    print('  截取区间  : %.2f s → %.2f s  （%.2f s）' % (a / float(sr), b / float(sr), len(seg) / float(sr)))
    if best is not None:
        print('  内部静音  : %.2f s' % sil)
    print('  输出      : %s  (%d bytes)' % (args.output, os.path.getsize(args.output)))
    print('')
    print('  下一步：把它作为参考音频交给引擎（IndexTTS-2 的 spk_audio_prompt / CosyVoice 的 prompt_wav）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
