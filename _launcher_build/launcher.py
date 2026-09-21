# -*- coding: utf-8 -*-
"""黑叶萤桌宠 启动器：等价于双击 start.cmd。

- 清除 ELECTRON_RUN_AS_NODE（否则 electron.exe 会退化成纯 Node，不显示窗口）
- 以「项目根目录 + 尾点」为参数拉起同目录的 electron.exe
  （尾点很关键：start.cmd 用 %~dp0. ，少一个反斜杠会让 Electron 报「找不到模块」）
- 出错时弹窗显示真实原因，并把诊断写入 launcher_debug.log
"""
import os
import sys
import subprocess
import traceback
import datetime


def _proj_root():
    here = os.path.dirname(os.path.abspath(sys.executable))
    cands = [here, os.getcwd(), os.path.dirname(os.path.abspath(sys.argv[0]))]
    seen = set()
    for c in cands:
        if not c or c in seen:
            continue
        seen.add(c)
        if os.path.isfile(os.path.join(c, "main.js")) and \
           os.path.isfile(os.path.join(c, "node_modules", "electron", "dist", "electron.exe")):
            return c
    return here


def _log(msg, root):
    try:
        with open(os.path.join(root, "launcher_debug.log"), "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (datetime.datetime.now().isoformat(timespec="seconds"), msg))
    except Exception:
        pass


def _err(title, text):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)
    except Exception:
        pass


def main():
    root = _proj_root()
    try:
        electron = os.path.join(root, "node_modules", "electron", "dist", "electron.exe")
        if not os.path.isfile(electron):
            _err("黑叶萤桌宠 启动失败",
                 "找不到 Electron 运行时：\n%s\n\n请确认启动器与 node_modules 在同一目录。" % electron)
            return 2

        env = dict(os.environ)
        env.pop("ELECTRON_RUN_AS_NODE", None)

        app_arg = root + "\\."          # 与 start.cmd 的 %~dp0. 完全一致
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        p = subprocess.Popen([electron, app_arg], cwd=root, env=env,
                             startupinfo=si, close_fds=True)
        _log("spawned electron pid=%s arg=%s" % (p.pid, app_arg), root)
        return 0
    except Exception:
        tb = traceback.format_exc()
        _log(tb, root)
        _err("黑叶萤桌宠 启动失败", tb)
        return 1


if __name__ == "__main__":
    sys.exit(main())
