#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""analyze.py —— 量"同一个引擎多次合成，音色稳不稳"（针对"变声期"这个担心）

为什么不能只看耗时：用户明确要求"直播时只用一个引擎，以免出现变声期"。
换引擎会变声是显然的，但**同一个引擎内部也会漂**：多候选选优、情绪参考音频、
润色（mastering）、随机性都会让同一个人声在同一天里听起来不一样。
这里用两个便宜的客观量去逼近"听起来是不是同一个声音"：

  1. **F0 中位数**（自相关基频，只看有声帧）——对应"音高/年龄感"。跨次差 >1 半音就容易被听出来。
  2. **谱心均值**（spectral centroid）——对应"明亮/闷"的音色感。跨次差 >10% 就会觉得换了个人。

再加上时长离散度（同一句话的语速稳定性）。三项都稳，才算能撑一场直播。

用法： python tools/bench-tts/analyze.py
输入： tools/bench-tts/results/<engine>/<S#_run#>.wav（由 bench.js 产出）
输出： 终端表格 + results/consistency.json
"""
import io
import json
import os
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'results')
SENT = ['S1', 'S2', 'S3']


def read_wav(p):
    """读成单声道 float32 + 采样率。16/32 位、单双声道都能吃。"""
    with wave.open(p, 'rb') as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif sw == 4:
        x = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    else:
        x = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def f0_median(x, sr, fmin=60.0, fmax=400.0):
    """自相关基频中位数（只看有声帧）。返回 (f0, 有声帧占比)。"""
    win = int(0.040 * sr)
    hop = int(0.020 * sr)
    lo = int(sr / fmax)
    hi = int(sr / fmin)
    vals = []
    frames = 0
    for s in range(0, max(1, len(x) - win), hop):
        seg = x[s:s + win]
        if len(seg) < win:
            break
        frames += 1
        e = float(np.sqrt(np.mean(seg * seg)))
        if e < 0.02:                     # 静音/很轻：跳过
            continue
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, mode='full')[len(seg) - 1:]
        if ac[0] <= 0:
            continue
        seg_ac = ac[lo:hi + 1]
        if not len(seg_ac):
            continue
        k = int(np.argmax(seg_ac))
        if seg_ac[k] / (ac[0] + 1e-9) < 0.30:   # 峰不够突出：多半是无音高段
            continue
        vals.append(sr / float(lo + k))
    if len(vals) < 5:
        return 0.0, 0.0
    return float(np.median(vals)), float(len(vals)) / max(1, frames)


def centroid(x, sr, nfft=1024):
    """谱心均值（Hz）：音色明暗的粗略代理。"""
    hop = nfft // 2
    acc, cnt = 0.0, 0
    w = np.hanning(nfft)
    for s in range(0, max(1, len(x) - nfft), hop):
        seg = x[s:s + nfft]
        if len(seg) < nfft:
            break
        if float(np.sqrt(np.mean(seg * seg))) < 0.02:
            continue
        sp = np.abs(np.fft.rfft(seg * w))
        tot = sp.sum()
        if tot <= 1e-9:
            continue
        freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
        acc += float((freqs * sp).sum() / tot)
        cnt += 1
    return acc / cnt if cnt else 0.0


def semitones(a, b):
    if a <= 0 or b <= 0:
        return 0.0
    return 12.0 * np.log2(b / a)


def main():
    if not os.path.isdir(RES):
        print('没有结果目录，先跑 node tools/bench-tts/bench.js')
        return
    engines = [d for d in sorted(os.listdir(RES)) if os.path.isdir(os.path.join(RES, d))]
    report = {}
    print('=' * 96)
    print('音色稳定性（同一句合成 3 次；F0 差 >1 半音 / 谱心差 >10% 就算能被听出来）')
    print('=' * 96)
    for eng in engines:
        rows = {}
        for sid in SENT:
            shots = []
            for n in (1, 2, 3):
                p = os.path.join(RES, eng, '%s_run%d.wav' % (sid, n))
                if not os.path.isfile(p):
                    continue
                try:
                    x, sr = read_wav(p)
                except Exception as e:
                    print('  读不了 %s: %s' % (p, e))
                    continue
                f0, voiced = f0_median(x, sr)
                shots.append({
                    'run': n, 'dur': len(x) / float(sr), 'f0': f0, 'voiced': voiced,
                    'centroid': centroid(x, sr), 'sr': sr
                })
            if shots:
                rows[sid] = shots
        if not rows:
            continue
        report[eng] = rows
        print('')
        print('【%s】' % eng)
        for sid in SENT:
            if sid not in rows:
                continue
            ss = rows[sid]
            durs = [s['dur'] for s in ss]
            f0s = [s['f0'] for s in ss if s['f0'] > 0]
            cts = [s['centroid'] for s in ss if s['centroid'] > 0]
            dsp = (max(durs) - min(durs)) if durs else 0
            f0sp = semitones(min(f0s), max(f0s)) if len(f0s) > 1 else 0.0
            ctsp = ((max(cts) - min(cts)) / (sum(cts) / len(cts)) * 100.0) if len(cts) > 1 else 0.0
            flag = []
            if f0sp > 1.0:
                flag.append('音高漂 ' + ('%.2f' % f0sp) + ' 半音')
            if ctsp > 10.0:
                flag.append('音色亮度漂 ' + ('%.1f' % ctsp) + '%')
            if dsp > 0.25:
                flag.append('时长差 ' + ('%.2f' % dsp) + ' s')
            print('  %s  n=%d   时长 %.2f~%.2f s    F0 中位 %.1f Hz   谱心 %.0f Hz   %s'
                  % (sid, len(ss), min(durs), max(durs),
                     (sum(f0s) / len(f0s)) if f0s else 0,
                     (sum(cts) / len(cts)) if cts else 0,
                     ('⚠ ' + '；'.join(flag)) if flag else '✓ 稳定'))
        # 跨句一致性：同一个人说不同的话，F0 与谱心应落在同一带里
        allf0 = [s['f0'] for sid in rows for s in rows[sid] if s['f0'] > 0]
        allct = [s['centroid'] for sid in rows for s in rows[sid] if s['centroid'] > 0]
        if len(allf0) > 1 and len(allct) > 1:
            print('  跨句：F0 %.1f~%.1f Hz（%.2f 半音）   谱心 %.0f~%.0f Hz（%.1f%%）'
                  % (min(allf0), max(allf0), semitones(min(allf0), max(allf0)),
                     min(allct), max(allct), (max(allct) - min(allct)) / (sum(allct) / len(allct)) * 100))
    out = os.path.join(RES, 'consistency.json')
    with io.open(out, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print('')
    print('明细 → tools/bench-tts/results/consistency.json')


if __name__ == '__main__':
    main()
