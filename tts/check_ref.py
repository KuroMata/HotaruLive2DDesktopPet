# -*- coding: utf-8 -*-
"""
check_ref.py —— 声纹参考音频自检（纯标准库）
================================================
录完参考音频后跑一下，确认它适合拿去做音色克隆。

用法：
  python tts/check_ref.py                     # 默认查 tts/ref/ref.wav
  python tts/check_ref.py D:\\path\\my.wav    # 指定文件

检查项：时长 / 采样率 / 声道 / 位深 / 峰值(dBFS) / RMS / 削顶 / 静音比例 / 直流偏置
"""
import os
import sys
import math
import wave
import array

DEFAULT_REF = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ref', 'ref.wav')

MIN_SEC, MAX_SEC, GOOD_SEC = 5.0, 150.0, 90.0


def load_samples(path):
    with wave.open(path, 'rb') as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        comp = w.getcomptype()
        raw = w.readframes(n)
    if comp != 'NONE':
        raise ValueError('压缩格式（%s）不支持，请导出未压缩 PCM WAV' % comp)
    if sw == 1:
        a = array.array('b'); a.frombytes(raw); full = 1 << 7; vals = a
    elif sw == 2:
        a = array.array('h'); a.frombytes(raw); full = 1 << 15; vals = a
    elif sw == 3:
        full = 1 << 23
        vals = []
        for i in range(len(raw) // 3):
            b0 = raw[3 * i]; b1 = raw[3 * i + 1]; b2 = raw[3 * i + 2]
            v = b0 | (b1 << 8) | (b2 << 16)
            if v & 0x800000:
                v -= 0x1000000
            vals.append(v)
    elif sw == 4:
        a = array.array('i'); a.frombytes(raw); full = 1 << 31; vals = a
    else:
        raise ValueError('不支持的位深：%d 字节' % sw)
    return ch, sw * 8, sr, n, vals, full


def dbfs(x):
    if x <= 0:
        return -999.0
    return 20.0 * math.log10(x)


def analyze(path):
    ch, bits, sr, n, vals, full = load_samples(path)
    total = len(vals)
    dur = n / float(sr) if sr else 0.0

    peak = 0
    sumsq = 0.0
    dc = 0
    clipped = 0
    for v in vals:
        av = v if v >= 0 else -v
        if av > peak:
            peak = av
        if av >= full * 0.999:
            clipped += 1
        sumsq += float(v) * v
        dc += v
    rms = math.sqrt(sumsq / total) if total else 0.0
    dc_off = dc / float(total) if total else 0.0

    # 逐 20ms 帧的 RMS，用来估静音比例、语音段与首尾静音
    fs = max(1, int(sr * 0.02)) * ch
    thr = full * 0.005           # ≈ -46 dBFS
    frs = []
    for s in range(0, total - fs + 1, fs):
        f2 = 0.0
        for i in range(s, s + fs):
            f2 += float(vals[i]) * vals[i]
        frs.append(math.sqrt(f2 / fs))
    frames = len(frs)
    silent = sum(1 for x in frs if x < thr)
    lead = 0
    while lead < frames and frs[lead] < thr:
        lead += 1
    tail_frames = 0
    while tail_frames < frames and frs[frames - 1 - tail_frames] < thr:
        tail_frames += 1
    sil_ratio = (silent / float(frames)) if frames else 0.0

    # 语音段：相邻语音帧间隔 ≤3 帧（60ms）视为同一段
    segs = []
    for i, x in enumerate(frs):
        if x >= thr:
            if segs and i - segs[-1][1] <= 3:
                segs[-1][1] = i
            else:
                segs.append([i, i])
    n_segs = len(segs)
    last_speech_s = (segs[-1][1] + 1) * 0.02 if segs else 0.0

    # 最长连续静音
    longest = 0
    cur = 0
    for x in frs:
        if x < thr:
            cur += 1
            if cur > longest:
                longest = cur
        else:
            cur = 0

    return dict(path=path, ch=ch, bits=bits, sr=sr, dur=dur,
                peak_db=dbfs(peak / full), rms_db=dbfs(rms / full),
                clipped=clipped, sil_ratio=sil_ratio,
                lead_s=lead * 0.02, tail_s=tail_frames * 0.02,
                dc=dc_off / full, n_segs=n_segs, last_speech_s=last_speech_s,
                longest_sil_s=longest * 0.02)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_REF
    print('=== 参考音频自检 ===')
    print('文件:', path)
    if not os.path.isfile(path):
        print('  ✗ 文件不存在。请把录音保存到:', DEFAULT_REF)
        return 2

    try:
        r = analyze(path)
    except Exception as e:
        print('  ✗ 读取失败:', e)
        return 2

    print('  时长      : %.2f s' % r['dur'])
    print('  采样率    : %d Hz' % r['sr'])
    print('  声道      : %d (%s)' % (r['ch'], '单声道' if r['ch'] == 1 else '多声道'))
    print('  位深      : %d bit' % r['bits'])
    print('  峰值      : %.1f dBFS' % r['peak_db'])
    print('  整体 RMS  : %.1f dBFS' % r['rms_db'])
    print('  削顶采样  : %d' % r['clipped'])
    print('  静音比例  : %.1f%%  (首 %.2fs / 尾 %.2fs)' % (r['sil_ratio'] * 100, r['lead_s'], r['tail_s']))
    print('  语音段数  : %d 段' % r['n_segs'])
    print('  最后一句止: %.1f s  （总长 %.1f s）' % (r['last_speech_s'], r['dur']))
    print('  最长静音  : %.2f s' % r['longest_sil_s'])
    print('  直流偏置  : %+.4f' % r['dc'])

    warn = []
    if r['dur'] < MIN_SEC:
        warn.append('时长不足 %.0fs，克隆会不稳（建议 60–90s）' % MIN_SEC)
    if r['dur'] > MAX_SEC:
        warn.append('时长超过 %.0fs，收益递减，可截取其中一段' % MAX_SEC)
    if r['dur'] < GOOD_SEC and r['dur'] >= MIN_SEC:
        warn.append('时长 %.1fs，够用；想更稳可补到 60s 以上' % r['dur'])
    if r['ch'] != 1:
        warn.append('建议导出单声道（Mono）')
    if r['sr'] not in (16000, 22050, 32000, 44100, 48000):
        warn.append('采样率 %d Hz 不受推荐（建议 44100 或 48000）' % r['sr'])
    if r['sr'] < 16000:
        warn.append('采样率偏低，高频细节会丢')
    if r['peak_db'] > -1.0:
        warn.append('峰值接近 0 dBFS，可能已削顶（失真不可逆）')
    if r['clipped'] > 0:
        warn.append('检测到 %d 个削顶采样' % r['clipped'])
    if r['peak_db'] < -20.0:
        warn.append('电平偏低（峰值 %.1f dBFS），建议 Normalize 到 -3 dB 左右' % r['peak_db'])
    if r['rms_db'] < -34.0:
        warn.append('整体过轻或录音距离过远')
    if r['sil_ratio'] > 0.65:
        warn.append('静音过多（%.0f%%），建议剪掉多余的空白' % (r['sil_ratio'] * 100))
    if r['n_segs'] == 0:
        warn.append('未检测到人声——确认录的不是空白轨')
    elif r['last_speech_s'] < r['dur'] - 3.0:
        warn.append('最后一句在 %.1fs 结束，之后还有 %.1fs 空白，可剪掉' % (r['last_speech_s'], r['dur'] - r['last_speech_s']))
    if r['longest_sil_s'] > 3.0:
        warn.append('存在 %.1fs 的连续空白（中途停顿过久？），建议剪掉' % r['longest_sil_s'])
    if abs(r['dc']) > 0.02:
        warn.append('存在直流偏置，建议做一次 High-Pass 80Hz')

    print('')
    if warn:
        print('结论：⚠ 可用，但有 %d 处建议：' % len(warn))
        for x in warn:
            print('  - ' + x)
    else:
        print('结论：✓ 合格，可以直接用于音色克隆。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
