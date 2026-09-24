# -*- coding: utf-8 -*-
"""声库批量生成到底占多少资源——在决定要不要跑之前先量出来。

量四样：
  A. 显存：加载后常驻多少、生成时峰值多少
  B. GPU 占用率与功耗：会不会把卡占满（影响同时打游戏/跑桌宠）
  C. 内存与 CPU：进程 RSS、CPU 利用率
  D. 磁盘：单个单位多大 → 推算 200/800/1300 单位的总量

用法： python tools/bench-tts/probe-bank-resource.py [生成个数，默认 8]
"""
import os
import sys
import time
import json
import gc
import subprocess
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(os.path.dirname(HERE))
TTS = os.path.join(PROJ, "tts")
for p in (TTS, os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src"),
          os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")):
    if p not in sys.path:
        sys.path.insert(0, p)

import numpy as np
import torch
import psutil

SR = 24000
OUT = os.path.join(HERE, "results")
os.makedirs(OUT, exist_ok=True)
REF_PATH = os.environ.get("COSYVOICE_REF", os.path.join(TTS, "ref", "prompt.wav"))

# 单字素材：覆盖不同声母韵母，模拟真实声库生成
UNITS = ["啊", "哦", "鹅", "衣", "乌", "鱼", "巴", "爬",
         "妈", "发", "大", "他", "那", "啦", "哥", "科",
         "喝", "机", "七", "西", "知", "吃", "诗", "日"]

proc = psutil.Process()
stop = threading.Event()
samples = []


def nvidia_query():
    """返回 (used_MiB, util_%, power_W)"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu,power.draw",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5)
        parts = out.stdout.strip().split(",")
        return float(parts[0]), float(parts[1]), float(parts[2])
    except Exception:
        return None, None, None


def sampler(tag):
    psutil.cpu_percent(None)  # 初始化
    while not stop.is_set():
        gmem, gutil, gpow = nvidia_query()
        samples.append(dict(tag=tag, gpu_mem=gmem, gpu_util=gutil, gpu_power=gpow,
                            rss=proc.memory_info().rss / 2**20,
                            cpu=psutil.cpu_percent(None),
                            ts=time.time()))
        time.sleep(0.3)


def stat(key, tag=None):
    vals = [s[key] for s in samples if s[key] is not None and (tag is None or s["tag"] == tag)]
    if not vals:
        return None
    return dict(avg=sum(vals) / len(vals), mx=max(vals), mn=min(vals), n=len(vals))


def fmt(d, unit=""):
    if not d:
        return "n/a"
    return "%.1f%s（峰值 %.1f%s，谷 %.1f%s）" % (d["avg"], unit, d["mx"], unit, d["mn"], unit)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    print("=" * 74)
    print("声库生成资源占用实测  %s   生成 %d 个单位" % (time.strftime("%H:%M:%S"), n))
    print("=" * 74)
    print("GPU: %s   驱动查询 OK" % torch.cuda.get_device_name(0))
    print()

    # ---------- 空闲基线 ----------
    stop.clear()
    samples.clear()
    th = threading.Thread(target=sampler, args=("idle",), daemon=True)
    th.start()
    time.sleep(3)
    stop.set(); th.join()
    print("-" * 74)
    print("A. 生成前的空闲基线（本机有其他程序在用 GPU，这是它的常态）")
    print("-" * 74)
    print("  显存已用   %s MiB" % fmt(stat("gpu_mem", "idle"), " MiB"))
    print("  GPU 占用   %s %%" % fmt(stat("gpu_util", "idle"), " "))
    print("  功耗       %s W" % fmt(stat("gpu_power", "idle"), " "))
    print()

    # ---------- 加载模型 ----------
    from cosy_gen import load_cosy
    t0 = time.time()
    cosy = load_cosy()
    t_load = time.time() - t0
    vram_load = torch.cuda.memory_allocated() / 2**30
    vram_reserved = torch.cuda.memory_reserved() / 2**30
    rss_load = proc.memory_info().rss / 2**20
    gmem, _, _ = nvidia_query()
    print("-" * 74)
    print("B. 模型加载完成")
    print("-" * 74)
    print("  加载耗时 %.1f s" % t_load)
    print("  进程显存 allocated %.2f GB / reserved %.2f GB" % (vram_load, vram_reserved))
    print("  nvidia-smi 整卡已用 %.0f MiB" % (gmem or 0))
    print("  进程内存 RSS %.0f MB" % rss_load)
    print()

    # ---------- 批量生成（采样资源）----------
    print("-" * 74)
    print("C. 批量生成 %d 个单字（固定 seed=42，与真实声库生成流程一致）" % n)
    print("-" * 74)
    stop.clear()
    samples.clear()
    th = threading.Thread(target=sampler, args=("gen",), daemon=True)
    th.start()

    times = []
    wav_dir = os.path.join(OUT, "bank-probe")
    os.makedirs(wav_dir, exist_ok=True)
    import soundfile as sf
    for i in range(n):
        text = UNITS[i % len(UNITS)]
        torch.manual_seed(42)
        torch.cuda.manual_seed_all(42)
        t0 = time.time()
        out = []
        for chunk in cosy.inference_cross_lingual(tts_text=text, prompt_wav=REF_PATH,
                                                  stream=False, speed=1.0):
            out.append(chunk["tts_speech"])
        w = torch.cat(out, dim=-1)
        el = time.time() - t0
        arr = w.squeeze(0).cpu().numpy().astype(np.float32)
        dur = len(arr) / SR
        sf.write(os.path.join(wav_dir, "u%03d.wav" % i), arr, SR)
        times.append(el)
        print("  %2d 「%s」  %5.2f s   音频 %.2f s   %.0f KB(wav32)" % (
            i + 1, text, el, dur, os.path.getsize(os.path.join(wav_dir, "u%03d.wav" % i)) / 1024))
        del out, w, arr
        torch.cuda.empty_cache()

    stop.set(); th.join()

    # ---------- 统计 ----------
    print()
    print("-" * 74)
    print("D. 生成期间的资源占用")
    print("-" * 74)
    print("  显存（整卡）：%s MiB" % fmt(stat("gpu_mem", "gen"), " "))
    print("  GPU 占用率：  %s %%" % fmt(stat("gpu_util", "gen"), " "))
    print("  功耗：        %s W" % fmt(stat("gpu_power", "gen"), " "))
    print("  进程内存 RSS：%s MB" % fmt(stat("rss", "gen"), " "))
    print("  CPU 占用：    %s %%" % fmt(stat("cpu", "gen"), " "))
    print()
    t_avg = sum(times) / len(times)
    print("  单字生成耗时：平均 %.2f s（%.2f ~ %.2f）" % (t_avg, min(times), max(times)))
    print()

    # ---------- 推算 ----------
    print("-" * 74)
    print("E. 按这个速度推算整库成本")
    print("-" * 74)
    sizes = [os.path.getsize(os.path.join(wav_dir, f)) / 2**20
             for f in os.listdir(wav_dir) if f.endswith(".wav")]
    per_unit_mb = sum(sizes) / max(len(sizes), 1)
    for total in (200, 800, 1300):
        mins = total * t_avg / 60
        print("  %4d 单位：约 %5.1f 分钟（%.1f 小时）   磁盘约 %5.1f MB（32bit wav）" % (
            total, mins, mins / 60, total * per_unit_mb))
    print()
    print("  注：磁盘按 24kHz/32bit float 计；若存 16bit 单声道，再除以 2。")

    res = dict(load=dict(t=t_load, vram_gb=vram_load, reserved_gb=vram_reserved, rss_mb=rss_load),
               idle=dict(gpu_mem=stat("gpu_mem", "idle"), gpu_util=stat("gpu_util", "idle"),
                         power=stat("gpu_power", "idle")),
               gen=dict(gpu_mem=stat("gpu_mem", "gen"), gpu_util=stat("gpu_util", "gen"),
                        power=stat("gpu_power", "gen"), rss=stat("rss", "gen"),
                        cpu=stat("cpu", "gen")),
               per_unit_s=t_avg, per_unit_mb=per_unit_mb, n=n)
    with open(os.path.join(OUT, "probe-bank-resource.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print()
    print("已写 results/probe-bank-resource.json")


if __name__ == "__main__":
    main()
