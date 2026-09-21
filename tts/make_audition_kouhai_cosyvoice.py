# -*- coding: utf-8 -*-
"""「靠谱后辈 + 模棱两可暗示」人设 —— 用 CosyVoice 2 零样本克隆你的音色，一套引擎出中文+日语。

Purpose:
  CosyVoice2-0.5B 多语种零样本克隆：同一份 ref/prompt.wav 既能说中文也能说日语。
  本脚本一次性产出两套对比试听：
    * 中文版（读 app/data/click-lines.json, idle-lines.json 的真实中文台词）
        -> _out/kouhai_cn_cosyvoice/   （用于和现有 IndexTTS v3 中文版 A/B）
    * 日语版（JP 字典，仅用于 TTS，文字不写入 config）
        -> _out/kouhai_jp_cosyvoice/

接口：CosyVoice2.inference_cross_lingual(tts_text=目标文本, prompt_wav=参考音频, speed=...)
  —— 只需参考音频 + 目标文本，跨语种，无需参考音频文字稿。

前置：
  * CosyVoice 2 已部署：COSYVOICE_DIR 指向仓库根（含 cosyvoice 包）
  * 模型默认 iic/CosyVoice2-0.5B（已下载到 modelscope 缓存）
  * 参考音频：ref/prompt.wav（与 IndexTTS 同一份）
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

COSY_DIR = os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src")
from cosy_model import resolve_cosy_model
COSY_MODEL = resolve_cosy_model()
REF = os.environ.get("COSYVOICE_REF", os.path.join(HERE, "ref", "prompt.wav"))
SPEED = float(os.environ.get("COSYVOICE_SPEED", "1.0"))
FP16 = os.environ.get("COSYVOICE_FP16", "1") not in ("0", "false", "False")

CN_OUT = os.path.join(HERE, "_out", "kouhai_cn_cosyvoice")
JP_OUT = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")
os.makedirs(CN_OUT, exist_ok=True)
os.makedirs(JP_OUT, exist_ok=True)

if COSY_DIR not in sys.path:
    sys.path.insert(0, COSY_DIR)

# matcha 2.0.0 装在本机独立目录（避开 venv 批量删除保护）
EXTRA = os.environ.get("COSYVOICE_EXTRA", "D:/cosyvoice_src/_extramods")
if EXTRA not in sys.path:
    sys.path.insert(0, EXTRA)

# 日语翻译（与 v2 脚本一致；只用于 TTS，不写入 config 中文文字）
JP = {
    ("click", 0): "先輩、データの確認は終わりました。異常はありませんので、ご安心ください。",
    ("click", 1): "この順番通りに操作していただければ大丈夫です。焦らなくていいですよ、私が見ていますから。",
    ("click", 2): "水温がしきい値に近づいていたので、先に調整しておきました。ご心配なく。",
    ("click", 3): "今日の進捗は予想より早いですね……誰かがそばで見てるからかもしれませんが……なかったことにしてください。",
    ("click", 4): "先輩、今日はいつもよりちゃんと来てますね……先輩がいると、今日もうまくいきそうです。",
    ("idle", 0): "先輩、午前の観測ウィンドウが開きました。記録が必要なデータはすべて準備しておきました。",
    ("idle", 1): "コーヒー、ついでに一杯淹れておきましたので机の上に置いておきます……ついでだからですよ、深く考えないでください。",
    ("idle", 2): "先輩のそちらの明かり、まだついてますよ。そろそろ休まないと、明日もデータの処理がありますから。",
    ("idle", 3): "先輩がいない間もさぼってませんよ……別に、先輩が戻ってくるのをわざわざ待ってたわけじゃないですし。",
    ("idle", 4): "今日は順調です……先輩がそばにいてくれると、効率は確かに上がりますね。",
}


def _load(pool):
    name = "click-lines.json" if pool == "click" else "idle-lines.json"
    with open(os.path.join(HERE, "..", "app", "data", name), "r", encoding="utf-8") as f:
        return json.load(f)


def _synth(cosyvoice, out, text):
    if os.path.isfile(out) and os.path.getsize(out) > 4000:
        print("  %-14s (skip)" % os.path.basename(out))
        return
    try:
        gen = cosyvoice.inference_cross_lingual(
            tts_text=text, prompt_wav=REF, stream=False, speed=SPEED)
        speech = None
        for chunk in gen:
            speech = chunk["tts_speech"]
        if speech is None:
            raise RuntimeError("no speech returned")
        import torchaudio
        torchaudio.save(out, speech, cosyvoice.sample_rate)
        dur = speech.shape[-1] / float(cosyvoice.sample_rate)
        print("  %-14s dur=%.2fs | %s" % (os.path.basename(out), dur, text[:20]))
    except Exception as e:  # noqa: BLE001
        print("  %-14s FAILED: %s" % (os.path.basename(out), e))


def _patch_torch_flex_attention():
    """torch<2.5 没有 flex_attention 模块，但 matcha 2.0.0 顶层 import 会触发它。
    CosyVoice2 的 flow_matching 实际不使用 flex_attention，此处仅补一个 stub 让其可导入。"""
    import sys
    import types
    import torch
    ns = "torch.nn.attention.flex_attention"
    if ns in sys.modules:
        return
    if hasattr(torch.nn.attention, "flex_attention"):
        return
    m = types.ModuleType(ns)

    def flex_attention(query, key, value, *args, **kwargs):
        # 真实实现仅在 matcha 模型前向使用；CosyVoice2 不进入此路径。
        raise NotImplementedError("flex_attention stub: not used by CosyVoice2")

    m.flex_attention = flex_attention
    sys.modules[ns] = m
    torch.nn.attention.flex_attention = m  # type: ignore[attr-defined]


def main():
    _patch_torch_flex_attention()
    from cosyvoice.cli.cosyvoice import CosyVoice2

    print("=== CosyVoice 2 中文+日语克隆（你的音色，单一引擎）===")
    print("model : %s" % COSY_MODEL)
    print("ref   : %s" % REF)
    print("speed : %.2f  fp16=%s" % (SPEED, FP16))
    cosyvoice = CosyVoice2(COSY_MODEL, load_jit=False, load_trt=False, fp16=FP16)
    print(">> model loaded. sample_rate=%d" % cosyvoice.sample_rate)

    for pool in ("click", "idle"):
        items = _load(pool)
        for idx in range(len(items)):
            # 中文版
            cn_text = items[idx].get("text", "")
            _synth(cosyvoice, os.path.join(CN_OUT, "%s_%d.wav" % (pool, idx)), cn_text)
            # 日语版
            jp_text = JP.get((pool, idx))
            if jp_text:
                _synth(cosyvoice, os.path.join(JP_OUT, "%s_%d.wav" % (pool, idx)), jp_text)

    print("中文克隆 -> %s" % CN_OUT)
    print("日语克隆 -> %s" % JP_OUT)


if __name__ == "__main__":
    main()
