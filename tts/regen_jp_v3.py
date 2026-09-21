# -*- coding: utf-8 -*-
"""日语修复 v3 —— 针对三类问题：
  问题A 语速过高: 提速从 1.2/1.4 折中到 1.0~1.12 的候选带，按音质选最自然者(不再硬拉到 1.4)。
  问题B click_0 音乐/哼鸣伪影: 硬性拒绝含「长时段稳定基频(死平音)」的候选
        (真人语音不会长时间死平；CosyVoice 偶发幻觉会输出一段持续低频嗡鸣/旋律)。
  问题C 莫名兴奋: 评分同时惩罚「太平(棒读)」与「过高(兴奋)」，
        以 F0 峰值/中位(exc) 与 语音内峰值/平稳(sor) 双指标打压突然拔高的语气，
        而非单纯奖励 F0 起伏(那样会反过来选中兴奋候选)。
依赖：cosyvoice_src venv + _extramods；PYTHONPATH 含 cosyvoice 与 _extramods。
"""
import os
import sys
import types
import numpy as np
import torch
import torchaudio
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
COSY_DIR = os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src")
EXTRA = os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")
REF = os.environ.get("COSYVOICE_REF", os.path.join(HERE, "ref", "prompt.wav"))
from cosy_model import resolve_cosy_model
MODEL = resolve_cosy_model()
FP16 = os.environ.get("COSYVOICE_FP16", "1") not in ("0", "false", "False")
SPEED_GRID = [float(x) for x in os.environ.get("COSY_SPEED_GRID", "1.0,1.06,1.12").split(",")]
K = int(os.environ.get("COSY_K", "3"))
ONLY = os.environ.get("COSY_ONLY", "")
only_set = set()
if ONLY:
    for pair in ONLY.split():
        p, i = pair.split(",")
        only_set.add((p, int(i)))

for p in (HERE, COSY_DIR, EXTRA):
    if p not in sys.path:
        sys.path.insert(0, p)

import pyworld  # 需要 _extramods 里的 pkg_resources

_ns = "torch.nn.attention.flex_attention"
if _ns not in sys.modules and not hasattr(torch.nn.attention, "flex_attention"):
    m = types.ModuleType(_ns)
    m.flex_attention = lambda *a, **k: (_ for _ in ()).throw(NotImplementedError("stub"))
    sys.modules[_ns] = m
    torch.nn.attention.flex_attention = m  # type: ignore

SR = 24000
HOP = 240
WIN = 960
GATE_DB = -45.0
THR = 10 ** (GATE_DB / 20.0)
# 音高上限(Hz): 正常 JP 基频约 113~140，「平常语气」基准(prompt)≈113。
# 超过此值的候选被重罚，抑制「莫名拔高音调」(如 click_1 曾到 262Hz)。
# 允许一定向上起伏(到 155 仅轻罚)，但不允许成倍拉高。
PITCH_CEIL = 155.0

from fix_cosy_issues import (clean_silence, tame_spike, peak_median_ratio,
                             speech_only_ratio, synth, _patch_flex)
from make_audition_kouhai_cosyvoice import JP


# ---------- F0 分析 ----------
def f0_stats(wav):
    if wav.ndim > 1:
        wav = wav.mean(1)
    wav = wav.astype(np.float64)
    f0, _ = pyworld.harvest(wav, fs=SR, f0_floor=50.0, f0_ceil=500.0)
    v = f0[f0 > 0]
    if len(v) < 10:
        return 0.0, 1.0, 0.0, 0.0  # cv, exc, med, max
    cv = float(v.std() / v.mean())
    med = float(np.median(v))
    mx = float(np.max(v))
    exc = mx / (med + 1e-9)
    return cv, exc, med, mx


def voiced_runs(f0, voiced_mask):
    idxs = np.where(voiced_mask)[0]
    if len(idxs) < 5:
        return []
    runs = []
    s = idxs[0]
    prev = idxs[0]
    for x in idxs[1:]:
        if x - prev <= 2:
            prev = x
        else:
            runs.append((s, prev))
            s = x
            prev = x
    runs.append((s, prev))
    return runs


def music_severity(wav):
    """返回最严重的一段『死平长音』时长(秒)；0 表示没有伪影。
    判定: 连续浊音段 >=0.7s 且 F0 抖动 std<10Hz 且能量>2×静音阈值。"""
    if wav.ndim > 1:
        wav = wav.mean(1)
    wav = wav.astype(np.float64)
    f0, _ = pyworld.harvest(wav, fs=SR, f0_floor=50.0, f0_ceil=500.0)
    voiced = f0 > 0
    # 帧级能量
    n = len(wav)
    nf = 1 + (n - WIN) // HOP
    env = np.zeros(nf)
    peak = float(np.max(np.abs(wav))) + 1e-9
    x = wav / peak
    for i in range(nf):
        seg = x[i * HOP: i * HOP + WIN]
        env[i] = float(np.sqrt(np.mean(seg ** 2) + 1e-12))
    worst = 0.0
    for a, b in voiced_runs(f0, voiced):
        L = (b - a) * HOP / SR
        if L < 0.7:
            continue
        seg = f0[a:b + 1]
        seg = seg[seg > 0]
        if len(seg) < 10:
            continue
        std = float(np.std(seg))
        meanf = float(np.mean(seg))
        emean = float(np.mean(env[a:b + 1]))
        # 两类伪影:
        #  (a) 低频嗡鸣: 基频低于人声(如 click_0 的 70Hz 持续音) -> 明显不是语音
        #  (b) 长时死平音: 持续 >=1s 且基频抖动极小 -> 旋律/电子音/模型幻觉
        # 正常语音元音通常 <0.7s 或带自然微扰(std>8)，不会被误伤。
        is_hum = meanf < 90.0
        # 仅对「严重死平」做硬拒绝：基频抖动极小(std<5Hz) 且 持续>=1.5s。
        # 日语元音天然长且平稳(std~5-9、L~1.0-1.2)，原阈值(std<8,L>=1.0)会误伤正常日语，
        # 导致每条 JP 候选全被拒、生成卡死。放宽后只拦真正的模型幻觉/电子死平音。
        is_flat_tone = (std < 5.0 and L >= 1.5)
        if (is_hum or is_flat_tone) and emean > THR * 2.0:
            worst = max(worst, L)
    return worst


def prosody_score(wav):
    """奖励自然起伏，惩罚太平(棒读)与过高(兴奋)双端，并打压能量尖峰/过拖。
    返回 (score, cv, exc, pmr, sor, dur)。"""
    cv, exc, med, mx = f0_stats(wav)
    pmr = peak_median_ratio(wav)
    sor = speech_only_ratio(wav)
    dur = len(wav) / SR
    score = cv
    if cv < 0.12:                       # 棒读：过平
        score *= float(np.exp(-(0.12 - cv) / 0.04))
    if exc > 1.7:                       # 兴奋：基频峰值过高
        score *= float(np.exp(-(exc - 1.7) / 0.5))
    if pmr > 3.5:                       # 能量尖峰
        score *= float(np.exp(-(pmr - 3.5) / 8.0))
    if sor > 2.6:                       # 语音内突发拔高
        score *= float(np.exp(-(sor - 2.6) / 1.0))
    # 音高稳定: 抑制「向上拉高音调」。medF0 超过 PITCH_CEIL 即重罚，
    # 让选取的候选尽量贴近平常语气(基准≈113Hz，正常起伏在 155Hz 内仅轻罚)。
    if med > PITCH_CEIL:
        score *= float(np.exp(-(med - PITCH_CEIL) / 35.0))
    if dur > 8.0:                       # 过拖
        score *= 8.0 / dur
    return score, cv, exc, pmr, sor, dur


def main():
    _patch_flex()
    from cosyvoice.cli.cosyvoice import CosyVoice2
    cosy = CosyVoice2(MODEL, load_jit=False, load_trt=False, fp16=FP16)
    print(">> model loaded  speed_grid=%s  K=%d" % (SPEED_GRID, K))

    JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")
    for (pool, idx), text in sorted(JP.items()):
        if only_set and (pool, idx) not in only_set:
            continue
        out_path = os.path.join(JP_OUT, "%s_%d.wav" % (pool, idx))
        best = None          # 通过音乐过滤的最佳
        best_any = None      # 全候选中最不烂(防全员带音乐)
        for sp in SPEED_GRID:
            for k in range(K):
                sp_tensor = synth(cosy, text, sp)
                wav = sp_tensor.squeeze(0).cpu().numpy().astype(np.float32)
                wav = wav / (np.max(np.abs(wav)) + 1e-9)
                music = music_severity(wav)
                score, cv, exc, pmr, sor, dur = prosody_score(wav)
                tag = "music!" if music > 0 else "ok"
                print("  %s sp=%.2f k%d  %s cv=%.3f exc=%.2f pmr=%.2f sor=%.2f dur=%.1f score=%.3f"
                      % (os.path.basename(out_path), sp, k, tag, cv, exc, pmr, sor, dur, score))
                cand = (score, wav, cv, exc, pmr, sor, dur, sp, music)
                if best_any is None or score > best_any[0]:
                    best_any = cand
                if music <= 0 and (best is None or score > best[0]):
                    best = cand
        chosen = best if best is not None else best_any
        if best is None:
            print("  %s 警告: 所有候选都含音乐伪影，已退选最不烂者" % os.path.basename(out_path))
        _, wav, cv, exc, pmr, sor, dur, sp, music = chosen
        # 兴奋保护(仅对仍偏兴奋者)
        if sor > 2.4 or pmr > 3.5:
            wav = tame_spike(wav)
            print("  %s 触发软限幅(sor=%.2f pmr=%.2f)" % (os.path.basename(out_path), sor, pmr))
        cleaned = clean_silence(wav)
        cleaned = cleaned / (np.max(np.abs(cleaned)) + 1e-9)
        sf.write(out_path, cleaned, SR)
        ndur = len(cleaned) / SR
        print(">> %s 选用 speed=%.2f cv=%.3f exc=%.2f 时长=%.1fs%s"
              % (os.path.basename(out_path), sp, cv, exc, ndur,
                 "  [含音乐!]" if music > 0 else ""))


if __name__ == "__main__":
    main()
