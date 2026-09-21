# -*- coding: utf-8 -*-
"""
audio_server.py —— 音律识别的「原生逐端点回环」音频侧车（Windows / WASAPI）

为什么需要它：
  Electron/Chromium 的桌面回环只能抓「Windows 默认输出设备」的混音，无法指定
  "我要听第 2 个输出设备"。getUserMedia 的 deviceId 也只对输入设备有效（音箱/耳机
  是声音的终点不是源头，没法"录音"）。
  本服务用 soundcard（WASAPI）对**任意指定的输出端点**开 loopback 采集，
  从而实现"想听哪个输出设备就听哪个"。

对外接口（本机 HTTP，端口由主进程在启动时通过 argv 传入）：
  GET  /devices            -> {"devices":[{"id","name"}], "error":null}
  POST /start {"id": ...}  -> 开始对该输出端点做回环采集与节拍分析
  POST /stop               -> 停止
  GET  /state              -> {"active","level","bpm","bpmStable","playing","peak","onsets","error"}
                              level   0..1 相对响度（自适应峰值归一化）
                              bpm     折半后的实际律动速度（0 = 未锁定）
                              peak    重拍脉冲 0..1（副歌/重拍短暂睁眼用）
                              onsets  累计起音计数（渲染进程靠它判断"有新的一拍"，用于相位对齐）
分析算法与 app/js/music-tracker.js 保持一致：频谱通量(spectral flux) -> 自相关
-> 谐波梳状 -> 120BPM 对数高斯先验 -> 抛物线插值 -> 超速折半 -> 投票直方图。
BPM 主估测用 librosa（专业级，与 MixMeister / DJ 扒谱软件同算法族：起音强度谱 ->
自相关 tempogram -> 节奏先验），每 ~1s 一次；自研自相关作为 librosa 不可用/未稳时的
降级与快速首估。两者共用投票直方图做换歌检测与稳定判定。
"""
import json
import math
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

try:
    import soundcard as sc
    HAVE_SC = True
except Exception as e:                      # 没装 soundcard 时优雅降级，不拖垮主程序
    sc = None
    HAVE_SC = False
    SC_ERR = str(e)

# 专业级 BPM 估计：librosa（与 MixMeister / DJ 扒谱软件同算法族：
# 起音强度谱 -> 自相关 tempogram -> 节奏先验）。仅作「精度增强」层，
# 不可用（未安装 / 报错）时整条链路自动回退到自研 estimate_tempo，
# 不影响其它功能。librosa 0.11 的 tempo 在 librosa.feature.rhythm 子模块下，
# 必须显式 import 该子模块（lazy_loader 不会自动触发）。
try:
    from librosa.feature.rhythm import tempo as _librosa_tempo
    HAVE_LIBROSA = True
except Exception as e:
    _librosa_tempo = None
    HAVE_LIBROSA = False
    LIBROSA_ERR = str(e)

SR = 44100
BLOCK = 1024                                 # 每块 1024 帧 ≈ 23.2ms（≈43fps）
FLUX_WIN_SEC = 8.0
RAW_SEC = 10.0                               # 原始音频环形缓冲时长（librosa 估测用）
LIB_EST_MS = 1000                            # librosa 估测间隔（它比自相关重，1s 一次足够）
BPM_MIN, BPM_MAX = 50.0, 200.0
PRIOR_SIG = 0.45                             # 与 JS 侧标定值一致
PRIOR_BASE = 0.35
MIN_GAP_MS = 250
SILENCE_RMS = 0.0025                         # 低于此视为静音（实测本机静默时 rms 约 5.8e-4）
LOUD_HOLD_MS = 1500                          # 有音量后维持"在放歌"判定的时长
DECAY = 0.90                                 # 重拍脉冲每块衰减（配合 ≈43fps 与 JS 侧观感一致）

_state = {
    "active": False, "level": 0.0, "bpm": 0.0, "bpmStable": False,
    "playing": False, "peak": 0.0, "onsets": 0, "error": None,
}
_lock = threading.Lock()
_stop_evt = threading.Event()
_thread = None


def list_devices():
    if not HAVE_SC:
        return [], ("soundcard 未安装：" + SC_ERR)
    try:
        return [{"id": s.id, "name": s.name} for s in sc.all_speakers()], None
    except Exception as e:
        return [], str(e)


def _fold(bpm, max_tempo):
    """超速折半：超过 maxTempo 就不断除以 2（120->60、128->64）。"""
    while bpm > max_tempo and bpm / 2.0 >= BPM_MIN:
        bpm /= 2.0
    return bpm


def _vote(est, votes, vote_max):
    """把一次 BPM 估计值投入直方图投票，返回 (center, stable)。两套估计算法共用。"""
    # 换歌检测：最近 4 票都远离当前共识就清空重投
    cur = _state.get("bpm", 0.0)
    if cur > 0 and len(votes) >= 4 and all(abs(v - cur) > cur * 0.08 for v in votes[-4:]):
        votes.clear()

    votes.append(est)
    if len(votes) > vote_max:
        votes.pop(0)

    srt = sorted(votes)
    best_cnt, best_sum = 0, 0.0
    for v in srt:
        cnt = sum(1 for w in srt if abs(w - v) <= v * 0.03)
        if cnt > best_cnt:
            best_cnt, best_sum = cnt, sum(w for w in srt if abs(w - v) <= v * 0.03)
    if not best_cnt:
        return None
    center = best_sum / best_cnt
    need = max(3, int(math.ceil(min(vote_max, 8) * 0.6)))
    return center, (best_cnt >= need)


def estimate_tempo(flux, fps, max_tempo, votes, vote_max):
    """自相关估 BPM（与 JS 侧 estimateTempo 同构），返回 (bpm, stable)。librosa 不可用时的降级路径。"""
    n = len(flux)
    if n < int(fps * 4):
        return None
    lag_min = max(2, int(fps * 60.0 / BPM_MAX))
    lag_max = min(n - 8, int(math.ceil(fps * 60.0 / BPM_MIN)))
    if lag_max <= lag_min + 2:
        return None

    x = np.asarray(flux, dtype=np.float64)
    x = x - x.mean()
    e0 = float((x * x).mean())
    if e0 <= 1e-12:
        return None

    max_lag = min(n - 4, lag_max * 3 + 4)
    acf = np.zeros(max_lag + 1, dtype=np.float64)
    for lag in range(1, max_lag + 1):
        cnt = n - lag
        if cnt <= 0:
            continue
        acf[lag] = float((x[:cnt] * x[lag:lag + cnt]).mean()) / e0

    best_score, best_lag = -1e18, 0
    for lag in range(lag_min, lag_max + 1):
        b = 60.0 * fps / lag
        if b < BPM_MIN or b > BPM_MAX:
            continue
        score = acf[lag]
        if lag * 2 <= max_lag:
            score += 0.50 * acf[lag * 2]
        if lag * 3 <= max_lag:
            score += 0.25 * acf[lag * 3]
        prior = math.exp(-0.5 * (math.log2(b / 120.0) / PRIOR_SIG) ** 2)
        score *= (PRIOR_BASE + (1.0 - PRIOR_BASE) * prior)
        if score > best_score:
            best_score, best_lag = score, lag
    if not best_lag:
        return None

    # 抛物线插值取亚帧精度
    y0 = acf[best_lag - 1] if best_lag > 1 else 0.0
    y1 = acf[best_lag]
    y2 = acf[best_lag + 1] if best_lag + 1 <= max_lag else 0.0
    denom = y0 - 2 * y1 + y2
    lag_r = float(best_lag)
    if denom != 0:
        d = 0.5 * (y0 - y2) / denom
        if abs(d) <= 1:
            lag_r = best_lag + d
    est = _fold(min(BPM_MAX, max(BPM_MIN, 60.0 * fps / lag_r)), max_tempo)
    return _vote(est, votes, vote_max)


def estimate_tempo_librosa(y, sr, max_tempo, votes, vote_max):
    """librosa 专业级 BPM 估计（起音强度谱 + 自相关 tempogram + 节奏先验）。返回 (bpm, stable)。"""
    if not HAVE_LIBROSA or _librosa_tempo is None:
        return None
    if y is None or len(y) < int(sr * 4.0):      # 至少 4s，太短不可靠
        return None
    try:
        r = _librosa_tempo(y=np.ascontiguousarray(y, dtype=np.float32), sr=sr)
    except Exception:
        return None
    if r is None or len(r) == 0:
        return None
    est = float(r[0])
    if not (BPM_MIN <= est <= BPM_MAX):
        est = _fold(est, max_tempo)
        if not (BPM_MIN <= est <= BPM_MAX):
            return None
    est = _fold(est, max_tempo)
    return _vote(est, votes, vote_max)


def capture_loop(device_id, max_tempo):
    """对指定输出端点开 loopback 采集并做节拍分析（后台线程）。"""
    try:
        try:
            mic = sc.get_microphone(device_id, include_loopback=True)
        except Exception:
            # 某些环境下按 id 取不到，回退按名字匹配
            name = None
            for s in sc.all_speakers():
                if s.id == device_id:
                    name = s.name
                    break
            if not name:
                raise RuntimeError("找不到该输出设备：" + device_id)
            mic = sc.get_microphone(name, include_loopback=True)

        fps = SR / float(BLOCK)
        cap = max(64, int(fps * FLUX_WIN_SEC))
        flux_buf, votes, lvotes = [], [], []
        prev_spec = None
        avg_flux = 0.0
        peak_env = 1e-6
        level = 0.0
        peak = 0.0
        last_onset_ms = 0.0
        last_loud_ms = 0.0
        last_est_ms = 0.0
        last_lib_ms = 0.0
        raw_chunks = []                 # 原始单声道音频块（librosa 估测用环形缓冲）
        raw_cap = int(RAW_SEC * SR)
        onsets = 0
        bpm_local = 0.0
        stable_local = False
        fbpm = 0.0
        fstable = False
        lbpm = 0.0
        lstable = False

        # librosa 的 numba JIT 首次调用较耗时，提前用一段静音 dummy 预热，
        # 避免第一帧真实估测卡顿。放在采集线程里，不阻塞 /start 的 HTTP 响应。
        if HAVE_LIBROSA and _librosa_tempo is not None:
            try:
                _librosa_tempo(y=np.zeros(int(SR * 0.5), dtype=np.float32), sr=SR)
            except Exception:
                pass

        with mic.recorder(samplerate=SR, channels=2) as rec:
            while not _stop_evt.is_set():
                data = rec.record(numframes=BLOCK)
                if data is None or len(data) == 0:
                    continue
                x = np.asarray(data, dtype=np.float64)
                if x.ndim > 1:
                    x = x.mean(axis=1)
                now = time.time() * 1000.0

                # 原始单声道音频入环形缓冲（供 librosa 估测，trim 到 RAW_SEC）
                raw_chunks.append(x)
                if raw_cap > 0:
                    total = sum(c.size for c in raw_chunks)
                    if total > raw_cap:
                        drop = total - raw_cap
                        while raw_chunks and drop > 0:
                            if raw_chunks[0].size <= drop:
                                drop -= raw_chunks[0].size
                                raw_chunks.pop(0)
                            else:
                                raw_chunks[0] = raw_chunks[0][drop:]
                                drop = 0

                rms = float(np.sqrt((x * x).mean()))
                # 相对响度：自适应峰值包络归一化，静音归零
                peak_env = max(rms, peak_env * 0.995)
                target = 0.0 if rms < SILENCE_RMS else min(1.0, rms / max(1e-6, peak_env))
                level += (target - level) * (0.35 if target > level else 0.08)
                if level > 0.08:
                    last_loud_ms = now

                # 频谱通量（只累加变亮的部分）
                spec = np.abs(np.fft.rfft(x, n=BLOCK))
                if prev_spec is None or prev_spec.shape != spec.shape:
                    prev_spec = spec
                    continue
                flux = float(np.maximum(spec - prev_spec, 0.0).mean())
                prev_spec = spec
                flux_buf.append(flux)
                if len(flux_buf) > cap:
                    flux_buf.pop(0)

                # 起音检测（用于重拍脉冲与相位对齐）
                avg_flux = avg_flux * 0.94 + flux * 0.06 if avg_flux else flux
                if (rms > SILENCE_RMS and flux > avg_flux * 1.2
                        and (now - last_onset_ms) > MIN_GAP_MS):
                    last_onset_ms = now
                    peak = 1.0
                    onsets += 1
                peak *= DECAY
                if peak < 0.001:
                    peak = 0.0

                # 每 500ms 跑一次自研自相关（廉价，始终可用，作降级/快速首估）
                if now - last_est_ms >= 500:
                    last_est_ms = now
                    r = estimate_tempo(flux_buf, fps, max_tempo, votes, 24)
                    if r:
                        fbpm, fstable = r[0], r[1]
                    else:
                        fbpm, fstable = 0.0, False

                # 每 1s 跑一次 librosa 专业估测（优先），只在有音量时算，
                # 避免静音段出 120 这种默认先验垃圾值。结果持久化到 lbpm/lstable。
                if HAVE_LIBROSA and now - last_lib_ms >= LIB_EST_MS:
                    last_lib_ms = now
                    if level > 0.02 and len(raw_chunks):
                        yb = np.concatenate(raw_chunks)
                        r = estimate_tempo_librosa(yb, SR, max_tempo, lvotes, 24)
                        if r:
                            lbpm, lstable = r[0], r[1]

                # 决策：librosa 可用且已有估计值时优先用（更准）；否则回退自研自相关。
                if HAVE_LIBROSA and lbpm > 0:
                    bpm_local, stable_local = lbpm, lstable
                elif fbpm > 0:
                    bpm_local, stable_local = fbpm, fstable
                else:
                    bpm_local, stable_local = 0.0, False

                with _lock:
                    _state["active"] = True
                    _state["level"] = level
                    _state["bpm"] = bpm_local if stable_local else 0.0
                    _state["bpmStable"] = bool(stable_local)
                    _state["playing"] = (now - last_loud_ms) < LOUD_HOLD_MS
                    _state["peak"] = peak
                    _state["onsets"] = onsets
                    _state["error"] = None
    except Exception as e:
        with _lock:
            _state["active"] = False
            _state["error"] = str(e)
    finally:
        with _lock:
            _state["active"] = False


def start(device_id, max_tempo=80):
    global _thread, _stop_evt
    stop()
    _stop_evt = threading.Event()
    _thread = threading.Thread(target=capture_loop, args=(device_id, max_tempo), daemon=True)
    _thread.start()
    return {"ok": True}


def stop():
    global _thread, _stop_evt
    if _thread and _thread.is_alive():
        _stop_evt.set()
        _thread.join(timeout=1.5)
    _thread = None
    with _lock:
        _state["active"] = False
        _state["level"] = 0.0
        _state["peak"] = 0.0
        _state["playing"] = False
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def log_message(self, fmt, *args):      # 静音默认日志，避免刷屏
        pass

    def do_OPTIONS(self):
        self._send({})

    def do_GET(self):
        if self.path.startswith("/devices"):
            devs, err = list_devices()
            self._send({"devices": devs, "error": err})
        elif self.path.startswith("/state"):
            with _lock:
                self._send(dict(_state))
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            payload = {}
        if self.path.startswith("/start"):
            did = payload.get("id")
            mt = float(payload.get("maxTempo") or 80)
            if not did:
                self._send({"ok": False, "error": "缺少设备 id"})
            else:
                self._send(start(did, mt))
        elif self.path.startswith("/stop"):
            self._send(stop())
        else:
            self._send({"error": "not found"}, 404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18766
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    sys.stderr.write("audio_server ready on %d\n" % port)
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop()


if __name__ == "__main__":
    main()
