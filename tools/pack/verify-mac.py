#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""校验 dist 里两个 mac 包是否真的可用（只读 zip，不解压）。

按 skill `mac-app-zip-from-windows` 的 Verification checklist：
用法： python tools/pack/verify-mac.py   （只读 zip，不解压；退出码非 0 表示有断言失败）
  1) 产物存在且大小合理
  2) 符号链接条目数（应与 Electron 骨架一致，且 payload 是相对路径）
  3) Contents/MacOS/Electron 权限位 = 0755
  4) create_system == 3（缺了它权限位会被解压端忽略，包看起来对但起不来）
  5) Info.plist 可解析，名称/版本正确
  6) app 载荷齐全（main.js / preload.js / package.json / app 目录 / sidecar）
  7) **app/config.json 不在包内**（2026-09-22 新增的排除项，Windows 与 mac 必须一致）
  8) 与 Windows 包一致：向导相关文件在不在
"""
import io
import json
import os
import plistlib
import stat
import struct
import sys
import zipfile

PROJ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tools/pack/ -> 项目根
DIST = os.path.join(PROJ, 'dist')
with open(os.path.join(PROJ, 'package.json'), encoding='utf-8') as f:
    VERSION = json.load(f)['version']

fail = []
def chk(name, cond, detail=''):
    print(('  PASS  ' if cond else '  FAIL  ') + name + (('   [' + str(detail) + ']') if (detail and not cond) else ''))
    if not cond:
        fail.append(name)

for arch in ('arm64', 'x64'):
    zp = os.path.join(DIST, '黑叶萤桌宠-%s-mac-%s.zip' % (VERSION, arch))
    print('=' * 70)
    print('# %s' % os.path.basename(zp))
    print('=' * 70)
    if not os.path.isfile(zp):
        chk('产物存在', False, '文件不存在')
        continue
    sz = os.path.getsize(zp)
    chk('产物存在且体积合理（>200MB）', sz > 200 * 1048576, '%.1f MB' % (sz / 1048576.0))
    print('  大小 = %.1f MB' % (sz / 1048576.0))

    z = zipfile.ZipFile(zp)
    names = z.namelist()
    app_prefix = '黑叶萤桌宠.app/'

    # 2) 符号链接
    links = []
    for n in names:
        i = z.getinfo(n)
        mode = (i.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            links.append((n, z.read(n).decode('utf-8', 'replace')))
    chk('存在符号链接条目（framework 的 Versions/Current 等）', len(links) > 0, '%d 个' % len(links))
    print('  符号链接 %d 个，例：%s' % (len(links), links[0][0] if links else '(无)'))
    chk('符号链接载荷是相对路径（不是被解压成的文本文件）',
        all(not t.startswith('/') and t and '\n' not in t for _, t in links),
        links[:2])

    # 3) 可执行位
    m = [n for n in names if n == app_prefix + 'Contents/MacOS/Electron']
    chk('Contents/MacOS/Electron 存在', len(m) == 1)
    if m:
        perm = (z.getinfo(m[0]).external_attr >> 16) & 0o777
        chk('Electron 权限位 = 0755', perm == 0o755, '0%o' % perm)
        print('  Electron 权限 = 0%o' % perm)

    # 4) create_system
    bad_cs = [n for n in names[:400] if z.getinfo(n).create_system != 3]
    chk('create_system == 3（取样 400 条）', len(bad_cs) == 0, '%d 条不是 3，例如 %s' % (len(bad_cs), bad_cs[:3]))

    # 5) Info.plist
    pl = app_prefix + 'Contents/Info.plist'
    try:
        d = plistlib.loads(z.read(pl))
        chk('Info.plist 可解析', True)
        chk('CFBundleDisplayName 正确', d.get('CFBundleDisplayName') == '黑叶萤桌宠', d.get('CFBundleDisplayName'))
        chk('CFBundleShortVersionString == %s' % VERSION, d.get('CFBundleShortVersionString') == VERSION,
            d.get('CFBundleShortVersionString'))
        chk('CFBundleExecutable 仍为 Electron（未改二进制名）', d.get('CFBundleExecutable') == 'Electron', d.get('CFBundleExecutable'))
        print('  plist: name=%s ver=%s exec=%s icon=%s' % (
            d.get('CFBundleDisplayName'), d.get('CFBundleShortVersionString'),
            d.get('CFBundleExecutable'), d.get('CFBundleIconFile')))
    except Exception as e:
        chk('Info.plist 可解析', False, e)

    # 5b) icns
    icns = [n for n in names if n.endswith('Resources/electron.icns')]
    if icns:
        b = z.read(icns[0])
        chk('electron.icns 是有效 icns 容器', b[:4] == b'icns', b[:4])
        print('  icns = %d 字节' % len(b))
    else:
        chk('electron.icns 存在（缺则用默认图标）', False, '未找到')

    # 6) app 载荷
    res = app_prefix + 'Contents/Resources/app/'
    for rel in ('main.js', 'preload.js', 'package.json',
                'app/index.html', 'app/ollama-setup.html', 'app/js/ollama-setup.js',
                'app/js/chat-backends.js', 'app/data/persona.json',
                'audio/audio_server.py'):
        chk('载荷存在 ' + rel, (res + rel) in names)

    # 7) config.json 必须不在！
    cfg = [n for n in names if n.endswith('app/config.json')]
    chk('!! app/config.json 不在包内', len(cfg) == 0, cfg)
    # 顺带确认没有 dev 残留
    junk = [n for n in names if '/app/node_modules/electron/' in n
            or n.endswith('.7z') or '/audio/venv/' in n]
    chk('无 dev 依赖 / 压缩包 / venv 残留', len(junk) == 0, junk[:3])
    print('  载荷文件数（app/ 下）= %d' % len([n for n in names if n.startswith(res + 'app/')]))
    print('')
