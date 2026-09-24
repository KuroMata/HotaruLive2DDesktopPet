#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""在 Windows 上手工组装 macOS「解压即用」包（.zip）。

=== 为什么需要这个脚本 ===

`electron-builder --mac` 在 Windows/Linux 上会被它自己拒绝：

    ⨯ Build for macOS is supported only on macOS, please see
      https://electron.build/multi-platform-build

而 7-Zip「先把 .app 落盘、再压成 zip」同样不行，因为 Electron 的
`*.framework` 靠 **14 个 Unix 符号链接**组织（例如 `Versions/Current -> A`），
且 `Contents/MacOS/Electron` 需要 **可执行位**。Windows 文件系统里这两样都不存在
（建 symlink 需要特权），落盘再压缩必然丢失，解压出来的 app 根本起不来。

=== 做法 ===

整个组装**只在 zip 层面进行，一个字节都不落盘**：
读源 zip 的条目（symlink 条目的"内容"就是目标路径字符串，权限位在
`external_attr` 里），改名后原样写进目标 zip。

**关键一步**：必须显式 `zi.create_system = 3`（Unix）。
Python 在 Windows 上新建 `ZipInfo` 时 `create_system = 0`，
解压端会据此**忽略 Unix 权限位** —— 这一个字段决定了包能不能用。

=== 用法 ===

    # 1) 下载对应架构的 Electron 二进制（放到 dist/_mac_src/）
    #    https://npmmirror.com/mirrors/electron/<ver>/electron-v<ver>-darwin-arm64.zip
    #    https://npmmirror.com/mirrors/electron/<ver>/electron-v<ver>-darwin-x64.zip
    # 2) 生成发布配置（见 tools/pack/release-config.js）
    # 3) 组装
    python tools/pack/build-mac.py arm64
    python tools/pack/build-mac.py x64

图标（icns）需要 Pillow。本机可用 `D:\\index-tts\\.venv\\Scripts\\python.exe`
（已装 Pillow 11.3.0）来跑本脚本；缺 Pillow 时会跳过图标、沿用 Electron 默认图标，
不影响能否启动。

日志写到 `<输出.zip>.log`。
"""
import os
import sys
import io
import json
import time
import shutil
import struct
import fnmatch
import plistlib
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(os.path.dirname(HERE))          # tools/pack/ -> 项目根
DIST = os.path.join(PROJ, 'dist')
SRC_DIR = os.path.join(DIST, '_mac_src')

SRC_APP = 'Electron.app'
APP_BUNDLE = '黑叶萤桌宠.app'                            # zip 内的顶层目录名
RES_APP = APP_BUNDLE + '/Contents/Resources/app/'

# ---- 与 package.json 的 build.files 白名单对齐 ----
# ⚠ 两边的排除项必须同步：Windows 包用 build.files 的 "!..." 行，mac 包用下面这两个列表。
#   2026-09-22 踩过：build.files 加了 "!app/config.json"（不再带开发机配置），
#   但这里没跟着改，于是 mac 包仍然把 config.json 带了进去 —— 同一个坑只修了一半。
ALLOW_TOP_FILES = ['main.js', 'preload.js', 'package.json']
ALLOW_TOP_DIRS = ['app', 'tts']
ALLOW_TOP_SINGLE = ['audio/audio_server.py']

# 注：electron-builder 只打包 dependencies，这些 devDependencies 本来就不在包里。
# 这里再列一次是防御 —— 万一将来有人把它们挪进 dependencies 也不会被误打包。
NM_DROP = [
    'electron', 'electron-builder', 'electron-publish',
    'app-builder-bin', 'app-builder-lib', 'builder-util',
    'builder-util-runtime', 'dmg-builder', '7zip-bin',
    'typescript', '@types',
]

EXCLUDE_PREFIXES = ['node_modules/' + x for x in NM_DROP] + [
    'audio/venv', 'audio/__pycache__', 'tts/__pycache__', 'tts/_out',
    # 运行时状态 / 本机专属：进了包使用者首启就是开发机的设置（对应 build.files 的 "!app/config.json"）
    'app/config.json',
]
EXCLUDE_GLOBS = ['*.log', '*.7z', '*.pyc', '.DS_Store']

STORED_EXT = ('.enc', '.png', '.jpg', '.jpeg', '.icns', '.gz', '.zip',
              '.7z', '.webp', '.m4a', '.mp3', '.wav')

LOG_PATH = None


def log(msg):
    line = str(msg)
    sys.stdout.write(line + '\n')
    if LOG_PATH:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line + '\n')


def excluded(rel):
    rel = rel.replace('\\', '/').strip('/')
    for p in EXCLUDE_PREFIXES:
        if rel == p or rel.startswith(p + '/'):
            return True
    base = rel.rsplit('/', 1)[-1]
    for g in EXCLUDE_GLOBS:
        if fnmatch.fnmatch(base, g):
            return True
    if rel.startswith('tts/') and base.startswith('_'):
        return True
    if rel == 'tts/ref/_idx_ref.wav':
        return True
    return False


def collect():
    """按白名单收集要放进 Contents/Resources/app 的相对路径。"""
    files = []
    for f in ALLOW_TOP_FILES + ALLOW_TOP_SINGLE:
        if os.path.isfile(os.path.join(PROJ, f)):
            files.append(f)
    for d in ALLOW_TOP_DIRS:
        base = os.path.join(PROJ, d)
        if not os.path.isdir(base):
            continue
        for root, dirs, fns in os.walk(base):
            rel_root = os.path.relpath(root, PROJ).replace('\\', '/')
            rel_root = '' if rel_root == '.' else rel_root
            dirs[:] = sorted(x for x in dirs if not excluded(rel_root + '/' + x))
            for fn in sorted(fns):
                rel = (rel_root + '/' + fn).strip('/')
                if not excluded(rel):
                    files.append(rel)
    nmm = os.path.join(PROJ, 'node_modules')
    if os.path.isdir(nmm):
        for root, dirs, fns in os.walk(nmm):
            rel_root = os.path.relpath(root, PROJ).replace('\\', '/')
            dirs[:] = sorted(x for x in dirs if not excluded(rel_root + '/' + x))
            for fn in sorted(fns):
                rel = rel_root + '/' + fn
                if not excluded(rel):
                    files.append(rel)
    return files


def pick_compress(name):
    """已压缩过的格式直接 STORED：省下大量压缩时间，体积几乎不变。"""
    return zipfile.ZIP_STORED if name.lower().endswith(STORED_EXT) else zipfile.ZIP_DEFLATED


def packaged_package_json():
    """写一份裁剪过的 package.json，与 electron-builder 的行为一致。"""
    with open(os.path.join(PROJ, 'package.json'), encoding='utf-8') as f:
        j = json.load(f)
    for k in ('build', 'devDependencies', 'scripts'):
        j.pop(k, None)
    return json.dumps(j, indent=2, ensure_ascii=False).encode('utf-8')


def make_icns(png_path):
    """内嵌 PNG 的 icns（macOS 10.7+ 支持）。Pillow 不可用时返回 None。"""
    try:
        from PIL import Image
    except Exception:
        return None
    im = Image.open(png_path).convert('RGBA')
    if min(im.size) < 512:
        return None
    entries = []
    for code, size in (('icp4', 16), ('icp5', 32), ('icp6', 64),
                       ('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024)):
        buf = io.BytesIO()
        im.resize((size, size), Image.LANCZOS).save(buf, format='PNG')
        entries.append((code, buf.getvalue()))
    body = b''
    for code, data in entries:
        body += code.encode('ascii') + struct.pack('>I', len(data) + 8) + data
    return b'icns' + struct.pack('>I', len(body) + 8) + body


def build_plist(src, version):
    pl = plistlib.loads(src.read(SRC_APP + '/Contents/Info.plist'))
    pl['CFBundleDisplayName'] = '黑叶萤桌宠'
    pl['CFBundleName'] = '黑叶萤桌宠'
    pl['CFBundleIdentifier'] = 'com.natsumesaki.live2d-companion'
    pl['CFBundleShortVersionString'] = version
    pl['CFBundleVersion'] = version
    pl['LSApplicationCategoryType'] = 'public.app-category.entertainment'
    # CFBundleExecutable 保持 'Electron'：这样不必重命名 Contents/MacOS 下的二进制。
    return plistlib.dumps(pl, fmt=plistlib.FMT_XML)


def main():
    global LOG_PATH
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    arch = sys.argv[1]
    if arch not in ('arm64', 'x64'):
        print('usage: python build-mac.py <arm64|x64>')
        sys.exit(1)

    with open(os.path.join(PROJ, 'package.json'), encoding='utf-8') as f:
        version = json.load(f)['version']
    try:
        with open(os.path.join(PROJ, 'node_modules', 'electron', 'package.json'),
                  encoding='utf-8') as f:
            e_ver = json.load(f)['version']
    except Exception:
        e_ver = '30.5.1'

    src_path = os.path.join(SRC_DIR, 'electron-v%s-darwin-%s.zip' % (e_ver, arch))
    out_path = os.path.join(DIST, '黑叶萤桌宠-%s-mac-%s.zip' % (version, arch))
    if not os.path.isfile(src_path):
        print('missing source zip: ' + src_path)
        print('download: https://npmmirror.com/mirrors/electron/%s/electron-v%s-darwin-%s.zip'
              % (e_ver, e_ver, arch))
        sys.exit(1)
    LOG_PATH = out_path + '.log'
    if os.path.exists(LOG_PATH):
        os.remove(LOG_PATH)

    t0 = time.time()
    log('=== build mac %s  (app %s / electron %s) ===' % (arch, version, e_ver))
    if os.path.exists(out_path):
        os.remove(out_path)
    now = time.localtime()[:6]

    icns = make_icns(os.path.join(PROJ, 'build', 'mac_icon.png'))
    log('icns = %s' % ('generated %d bytes' % len(icns) if icns
                       else 'SKIPPED (Pillow unavailable) - default icon kept'))

    src = zipfile.ZipFile(src_path, 'r')
    out = zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=1)

    # ---------- 1) Electron 框架：原样搬运（保留 symlink 与权限位）----------
    n_link = n_exec = n_ent = 0
    for info in src.infolist():
        name = info.filename
        if name != SRC_APP + '/' and not name.startswith(SRC_APP + '/'):
            continue
        rel = name[len(SRC_APP):].lstrip('/')
        newname = APP_BUNDLE + ('/' + rel if rel else '')

        fmt = (info.external_attr >> 16) & 0o170000
        mode = (info.external_attr >> 16) & 0o7777
        if fmt == 0o120000:
            n_link += 1
        elif mode & 0o111:
            n_exec += 1
        n_ent += 1

        zi = zipfile.ZipInfo(newname, date_time=now)
        zi.external_attr = info.external_attr
        zi.create_system = 3              # ← 关键：Unix，否则权限位被解压端忽略

        if rel == 'Contents/Info.plist':
            zi.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(zi, build_plist(src, version))
        elif rel == 'Contents/Resources/electron.icns' and icns:
            zi.compress_type = zipfile.ZIP_STORED
            out.writestr(zi, icns)
        elif rel.endswith('/'):
            zi.compress_type = zipfile.ZIP_STORED
            out.writestr(zi, b'')
        else:
            zi.compress_type = pick_compress(newname)
            with src.open(info) as sf, out.open(zi, 'w') as df:
                shutil.copyfileobj(sf, df, 1 << 20)

    log('electron: carried %d entries (symlinks=%d, exec=%d)' % (n_ent, n_link, n_exec))

    # ---------- 2) 应用本体：写进 Contents/Resources/app/ ----------
    files = collect()
    log('app files to write: %d' % len(files))
    total = done = 0
    for rel in files:
        src_file = os.path.join(PROJ, rel.replace('/', os.sep))
        if not os.path.isfile(src_file):
            continue
        zi = zipfile.ZipInfo(RES_APP + rel, date_time=now)
        zi.external_attr = 0o100644 << 16
        zi.create_system = 3
        zi.compress_type = pick_compress(rel)
        try:
            if rel == 'package.json':
                out.writestr(zi, packaged_package_json())
            else:
                with open(src_file, 'rb') as sf, out.open(zi, 'w') as df:
                    shutil.copyfileobj(sf, df, 1 << 20)
        except Exception as e:
            log('WARN skipped %s: %s' % (rel, e))
            continue
        total += os.path.getsize(src_file)
        done += 1
        if done % 1000 == 0:
            log('  ... %d files, %.1f MB raw' % (done, total / 1048576.0))

    log('app written: %d files, %.1f MB raw' % (done, total / 1048576.0))
    src.close()
    out.close()
    log('OUTPUT %s  %.1f MB  (%.1fs)'
        % (out_path, os.path.getsize(out_path) / 1048576.0, time.time() - t0))


if __name__ == '__main__':
    main()
