# -*- coding: utf-8 -*-
"""
桌宠语音侧车（TTS sidecar）
=========================
纯标准库 HTTP 服务，默认监听 127.0.0.1:18766，由 Electron 主进程 spawn 拉起，
前端经同源代理 /api/tts 访问（见 main.js）。

接口：
  GET /health                      -> { ok, engine, engines:[...] }
  GET /voices?engine=xxx           -> { engine, voices:[...] }
  GET /tts?text=..&engine=..&voice=..&emo=..  -> audio/wav

启动：
  python tts_server.py --port 18766 --engine auto
"""
import argparse
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from engines import build_engines, pick_engine_name


class State(object):
    def __init__(self, engine_want):
        self.engines = build_engines()
        self.want = engine_want or "auto"
        self.active = pick_engine_name(self.engines, self.want)

    def refresh(self):
        self.active = pick_engine_name(self.engines, self.want)


STATE = None


class Handler(BaseHTTPRequestHandler):
    server_version = "PetTTS/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[tts] " + (fmt % args) + "\n")

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

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

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
            STATE.refresh()
            return self._json(200, {
                "ok": True,
                "engine": STATE.active,
                "want": STATE.want,
                "engines": [e.info() for e in STATE.engines.values()],
            })

        if path == "/voices":
            want = (q.get("engine", [STATE.active])[0] or STATE.active)
            name = pick_engine_name(STATE.engines, want)
            return self._json(200, {"engine": name, "voices": STATE.engines[name].voices()})

        if path == "/tts":
            text = (q.get("text", [""])[0] or "").strip()
            if not text:
                return self._json(400, {"ok": False, "error": "empty text"})
            want = (q.get("engine", [STATE.want])[0] or STATE.want)
            name = pick_engine_name(STATE.engines, want)
            voice = q.get("voice", [None])[0]
            emo = q.get("emo", [None])[0]
            eng = STATE.engines[name]
            try:
                # 情绪只作为参数交给引擎，绝不能拼进文本——否则会被一起朗读出来。
                # SAPI/tone 忽略 emo；后续 CosyVoice/IndexTTS 在引擎内部把 emo 转成语气指令。
                data, sr = eng.synth(text, voice=voice, emo=emo)
            except Exception as e:
                sys.stderr.write("[tts] synth error (%s): %s\n" % (name, e))
                traceback.print_exc(file=sys.stderr)
                return self._json(503, {
                    "ok": False, "engine": name, "error": str(e),
                    "hint": "该引擎不可用；可在托盘切换引擎，或先部署模型。",
                })
            hdr = {"engine": name, "bytes": len(data)}
            if sr:
                hdr["sampleRate"] = sr
            self.send_response(200)
            # Edge 等引擎返回 mp3，Content-Type 要跟着变，否则浏览器解不出来
            self.send_header("Content-Type", getattr(eng, "mime", "audio/wav"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            for k, v in hdr.items():
                self.send_header("X-TTS-" + k, str(v))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        return self._json(404, {"ok": False, "error": "not found", "path": path})


def main():
    global STATE
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18766)
    ap.add_argument("--engine", default="auto")
    args = ap.parse_args()

    STATE = State(args.engine)
    sys.stderr.write("[tts] engines: %s\n" % ", ".join(
        "%s%s" % (e.name, "" if e.available() else "(unavailable)") for e in STATE.engines.values()))
    sys.stderr.write("[tts] active engine = %s\n" % STATE.active)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    sys.stderr.write("[tts] listening on http://%s:%d\n" % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
