# -*- coding: utf-8 -*-
"""
GPT-SoVITS v2Pro 独立语音侧车（常驻进程）
========================================
由 Electron 主进程（main.js）以 venv-gptsovits 解释器拉起，监听 127.0.0.1:18767。
仅对本地已加载的模型做推理，零网络、零 token（gptsovits_engine 内部已锁死离线）。

与 tts_server.py 的关系：
  tts_server.py 是"总侧车"（接收前端 /api/tts 请求，按 engine 分发），
  本文件是 GPT-SoVITS 专用的"子侧车"——因为 GPT-SoVITS 需要独立的
  torch cu126 环境（tts/venv-gptsovits），不能与 cosyvoice/indextts 共用一个
  Python 解释器。tts_server 里的 GptSovitsEngine 只做 HTTP 代理，把请求转给这里。

接口：
  GET /health        -> {"ok": true}               （模型可懒加载，health 不依赖已加载）
  GET /tts?text=..   -> audio/wav                 （首次请求时加载模型，之后常驻）

模型加载是懒加载：侧车进程启动很快，真正加载权重发生在第一个 /tts 请求时，
这样"拉起侧车"与"准备模型"解耦，避免每次切换引擎都白等 13 秒。
"""
import argparse
import io
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import soundfile as sf
from gptsovits_engine import init_gptsovits, speak_gptsovits


# 懒加载状态：首请求时才真正把模型权重搬进显存
_REF_WAV = None
_REF_TXT = None
_MODEL_READY = False


def ensure_model():
    """首请求时加载模型并常驻；之后直接复用。"""
    global _MODEL_READY
    if _MODEL_READY:
        return
    sys.stderr.write("[gptsovits] loading model (first request)...\n")
    init_gptsovits(_REF_WAV, _REF_TXT, device="cuda")
    _MODEL_READY = True
    sys.stderr.write("[gptsovits] model ready\n")


class Handler(BaseHTTPRequestHandler):
    server_version = "GptSovitsTTS/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静默访问日志
        pass

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path.rstrip("/") or "/"

        if path == "/health":
            return self._send(200, json.dumps({"ok": True}), "application/json; charset=utf-8")

        if path == "/tts":
            text = (q.get("text", [""])[0] or "").strip()
            if not text:
                return self._send(400, json.dumps({"ok": False, "error": "empty text"}),
                                  "application/json; charset=utf-8")
            try:
                ensure_model()
                sr, audio = speak_gptsovits(text, stream=False)
                buf = io.BytesIO()
                # BytesIO 无扩展名，soundfile 无法推断格式，必须显式指定 WAV
                sf.write(buf, audio, sr, format="WAV")
                data = buf.getvalue()
            except Exception as e:  # noqa: BLE001
                sys.stderr.write("[gptsovits] synth error: %s\n" % e)
                traceback.print_exc(file=sys.stderr)
                return self._send(503,
                                  json.dumps({"ok": False, "error": str(e)}),
                                  "application/json; charset=utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        return self._send(404, json.dumps({"ok": False, "error": "not found", "path": path}),
                          "application/json; charset=utf-8")


def main():
    global _REF_WAV, _REF_TXT
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("GPTSOVITS_PORT", "18767")))
    ap.add_argument("--ref", default=os.environ.get("GPTSOVITS_REF", "") or
                   "D:/live2d-companion/tts/ref/prompt_9s.wav")
    ap.add_argument("--txt", default=os.environ.get("GPTSOVITS_REF_TXT", "") or
                   "D:/live2d-companion/tts/ref/prompt_9s_reftext.txt")
    args = ap.parse_args()

    _REF_WAV = args.ref
    _REF_TXT = args.txt
    if not os.path.isfile(_REF_WAV):
        sys.stderr.write("[gptsovits] WARN: ref audio missing: %s\n" % _REF_WAV)
    sys.stderr.write("[gptsovits] ref=%s\n" % _REF_WAV)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    sys.stderr.write("[gptsovits] listening on http://%s:%d (model lazy-loaded on first /tts)\n"
                     % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
