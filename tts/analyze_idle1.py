# -*- coding: utf-8 -*-
"""更敏感的 idle_1.wav 排查：列出所有窄带(纯音/双音)段与突发瞬态，定位挂断音。"""
import numpy as np
import soundfile as sf

PATH = r'D:\live2d-companion\tts\_out\kouhai_jp_cosyvoice\idle_1.wav'
x, sr = sf.read(PATH)
if x.ndim > 1:
    x = x[:, 0]
x = x.astype(np.float64)
x /= (np.max(np.abs(x)) + 1e-9)

N = 1024
HOP = 256
n = len(x)
nfr = (n - N) // HOP + 1

frames = []
for i in range(nfr):
    s = x[i * HOP:i * HOP + N]
    w = s * np.hanning(N)
    sp = np.abs(np.fft.rfft(w)) + 1e-12
    spn = sp / sp.sum()
    freqs = np.fft.rfftfreq(N, 1.0 / sr)
    g = np.exp(np.mean(np.log(spn)))
    a = spn.mean()
    flat = g / a
    order = np.argsort(spn)[::-1]
    pr1 = spn[order[0]]
    pr2 = spn[order[1]] if len(order) > 1 else 0
    f0 = freqs[order[0]]
    f1 = freqs[order[1]] if len(order) > 1 else 0
    env = np.sqrt(np.mean(s ** 2))
    frames.append((i * HOP / sr, flat, pr1, pr2, f0, f1, env))
frames = np.array(frames)
t, flat, pr1, pr2, f0, f1, env = (frames[:, k] for k in range(7))

print('dur=%.2fs frames=%d  medianEnv=%.4f' % (n / sr, nfr, np.median(env)))

# 窄带段（纯音或双音）：flat 低 或 双峰明显
narrow = (flat < 0.10) & ((pr1 > 0.3) | (pr2 > 0.2))
segs = []
i = 0
while i < len(narrow):
    if narrow[i]:
        j = i
        while j < len(narrow) and narrow[j]:
            j += 1
        dur = (j - i) * HOP / sr
        if dur >= 0.04:
            segs.append((t[i], t[j], dur, np.median(f0[i:j]), np.median(f1[i:j]),
                         np.median(pr1[i:j]), np.median(pr2[i:j])))
        i = j
    else:
        i += 1
print('\n[narrowband 段 >=40ms]  count=%d' % len(segs))
for s0, s1, d, a, b, p1, p2 in segs:
    print('  %.2f-%.2f (%.0fms) f1~%.0f f2~%.0f pr1=%.2f pr2=%.2f' % (s0, s1, d * 1000, a, b, p1, p2))

# 突发瞬态：能量尖峰 >4x 中位数 且 宽带(flat>0.2)
med = np.median(env)
trans = (env > 4 * med) & (flat > 0.2)
segs2 = []
i = 0
while i < len(trans):
    if trans[i]:
        j = i
        while j < len(trans) and trans[j]:
            j += 1
        dur = (j - i) * HOP / sr
        if dur <= 0.15:
            segs2.append((t[i], t[j], dur, np.max(env[i:j])))
        i = j
    else:
        i += 1
print('\n[突发瞬态 <=150ms, env>4x中位]  count=%d' % len(segs2))
for s0, s1, d, e in segs2:
    print('  %.2f-%.2f (%.0fms) peakEnv=%.3f' % (s0, s1, d * 1000, e))

# 头尾 400ms 细看
for edge, (a, b) in (('HEAD', (0.0, 0.4)), ('TAIL', (n / sr - 0.4, n / sr))):
    m = (t >= a) & (t <= b)
    if m.any():
        print('\n[%s %.2f-%.2f] narrow frames:' % (edge, a, b))
        idx = np.where(m & narrow)[0]
        for k in idx[:12]:
            print('  t=%.3f flat=%.3f f1=%.0f f2=%.0f pr1=%.2f pr2=%.2f env=%.3f' %
                  (t[k], flat[k], f0[k], f1[k], pr1[k], pr2[k], env[k]))
