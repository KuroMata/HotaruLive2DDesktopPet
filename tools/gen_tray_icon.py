#!/usr/bin/env python3
# 生成托盘图标：64x64 RGBA 粉色圆形 + 内圈高光，带 2px 抗锯齿软边。
import zlib, struct, os

W = H = 64
cx = cy = 32.0
r = 27.0
buf = bytearray(W * H * 4)

for y in range(H):
    for x in range(W):
        dx = (x + 0.5 - cx)
        dy = (y + 0.5 - cy)
        d = (dx * dx + dy * dy) ** 0.5
        if d > r:
            continue
        # 软边
        a = 1.0 if d <= r - 2 else (r - d) / 2.0
        # 主体粉色，内圈(<=r-9)略微提亮做高光
        R, G, B = 255, 95, 162
        if d <= r - 9:
            lift = 1.0 - (d / (r - 9)) * 0.18
            R = min(255, int(R * lift) + 18)
            G = min(255, int(G * lift) + 14)
            B = min(255, int(B * lift) + 16)
        # 顶部一点高光
        if dy < -r * 0.35 and dx > -r * 0.45 and dx < r * 0.1:
            R = min(255, R + 30); G = min(255, G + 22); B = min(255, B + 24)
        i = (y * W + x) * 4
        buf[i] = R & 0xff
        buf[i + 1] = G & 0xff
        buf[i + 2] = B & 0xff
        buf[i + 3] = int(255 * max(0.0, min(1.0, a)))

def chunk(typ, data):
    return (struct.pack('>I', len(data)) + typ + data +
            struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))

sig = b'\x89PNG\r\n\x1a\n'
ihdr = struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)
raw = bytearray()
for y in range(H):
    raw.append(0)
    raw.extend(buf[y * W * 4:(y + 1) * W * 4])
idat = zlib.compress(bytes(raw), 9)
out = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
dst = os.path.join(os.path.dirname(__file__), '..', 'app', 'assets', 'tray.png')
dst = os.path.abspath(dst)
with open(dst, 'wb') as f:
    f.write(out)
print('wrote', dst, len(out), 'bytes')
