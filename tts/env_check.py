# -*- coding: utf-8 -*-
"""
env_check.py —— IndexTTS-2 / CosyVoice 部署环境体检（纯标准库 + 可选探测）
==========================================================================
回答一个问题：这台机器离"能跑 IndexTTS-2"还差什么。

用法：python tts/env_check.py
"""
import os
import shutil
import subprocess
import sys
import platform

HERE = os.path.dirname(os.path.abspath(__file__))


def line(k, v):
    print('  %-14s: %s' % (k, v))


def has_mod(name):
    try:
        m = __import__(name)
        return getattr(m, '__version__', '已安装')
    except Exception as e:
        return None


def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, shell=False)
        return r.returncode, r.stdout.decode('utf-8', 'ignore') + r.stderr.decode('utf-8', 'ignore')
    except Exception as e:
        return -1, str(e)


def main():
    print('=== 环境体检 ===')
    ok = []
    todo = []

    line('操作系统', '%s %s' % (platform.system(), platform.release()))
    line('Python', '%s  (%s)' % (sys.version.split()[0], sys.executable))
    pyv = sys.version_info
    if pyv.major == 3 and pyv.minor in (10, 11):
        ok.append('Python %d.%d 正好是 IndexTTS-2 推荐版本' % (pyv.major, pyv.minor))
    else:
        todo.append('当前 Python 是 %d.%d；IndexTTS-2 官方建议 3.10（用 uv 会自动装独立的 3.10 环境，不冲突）'
                    % (pyv.major, pyv.minor))

    line('uv 包管理器', shutil.which('uv') or '未安装（IndexTTS-2 用 uv 管理依赖，需先装）')
    if not shutil.which('uv'):
        todo.append('安装 uv：pip install -U uv')

    print('')
    print('  --- Python 依赖 ---')
    for m in ('torch', 'torchaudio', 'numpy', 'scipy', 'librosa', 'soundfile'):
        v = has_mod(m)
        line(m, v if v else '未安装')
    if not has_mod('torch'):
        todo.append('安装 PyTorch（CUDA 版）——IndexTTS-2 的核心依赖')

    print('')
    print('  --- GPU ---')
    smi = shutil.which('nvidia-smi')
    if smi:
        rc, out = run([smi, '--query-gpu=name,driver_version,memory.total,memory.used,memory.free',
                       '--format=csv,noheader'])
        if rc == 0 and out.strip():
            for i, ln in enumerate(out.strip().splitlines()):
                line('GPU%d' % i, ln.strip())
            ok.append('nvidia-smi 可用（已识别到显卡）')
        else:
            rc2, out2 = run([smi])
            line('nvidia-smi', (out2.strip().splitlines() or ['(无输出)'])[0])
    else:
        line('nvidia-smi', '未找到（无 NVIDIA 驱动或不在 PATH）')
        todo.append('安装 NVIDIA 驱动 / 确认 nvidia-smi 在 PATH 中')

    print('')
    print('  --- 磁盘 ---')
    for drv in ('C:/', 'D:/'):
        try:
            t, u, f = shutil.disk_usage(drv)
            line(drv, '可用 %.1f GB / 共 %.1f GB' % (f / 2**30, t / 2**30))
            if drv.startswith('D') and f / 2**30 < 12:
                todo.append('D 盘可用空间不足 12GB，IndexTTS-2 权重约 10GB')
        except Exception as e:
            line(drv, '不可用 (%s)' % e)

    print('')
    print('  --- 引擎环境变量 ---')
    for k in ('INDEXTTS_DIR', 'COSYVOICE_DIR'):
        v = os.environ.get(k)
        line(k, v if v else '未设置')

    print('')
    print('  --- 参考音频 ---')
    for f in ('ref/ref.wav', 'ref/prompt.wav'):
        p = os.path.join(HERE, f)
        if os.path.isfile(p):
            try:
                import wave
                with wave.open(p, 'rb') as w:
                    d = w.getnframes() / float(w.getframerate())
                line(f, '存在  %.2f s  %d Hz  %d 声道' % (d, w.getframerate(), w.getnchannels()))
            except Exception:
                line(f, '存在')
        else:
            line(f, '缺失')

    print('')
    print('=== 结论 ===')
    if ok:
        print('  ✓ 已具备：')
        for x in ok:
            print('    - ' + x)
    if todo:
        print('  待办：')
        for x in todo:
            print('    - ' + x)
    if not todo:
        print('  环境看起来已就绪。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
