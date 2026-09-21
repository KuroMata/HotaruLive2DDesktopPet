# -*- coding: utf-8 -*-
"""「靠谱后辈 + 模棱两可暗示」人设 —— 日语用 CosyVoice 2 零样本克隆你的音色。

与 Edge 日语版（make_audition_kouhai_v2.py 里 kouhai_jp/）的区别：
  Edge 是微软内置日语音色（Keita），**不是你的声音**；
  本脚本用 CosyVoice2 的 inference_cross_lingual，把 ref/prompt.wav（你的中文克隆样本）
  直接用零样本方式克隆去说日语 —— 音色与你一致。

接口选择：
  CosyVoice2.inference_cross_lingual(prompt_audio, tts_text)
  —— 只需参考音频 + 目标文本（日文），**不需要参考音频的文字稿**，天然跨语种。

前置：
  * 已部署 CosyVoice 2：COSYVOICE_DIR 指向仓库根（含 cosyvoice 包）
  * 模型默认 iic/CosyVoice2-0.5B（首次会经 modelscope 下载到缓存，或 COSYVOICE_MODEL 指定本地路径）
  * 参考音频：ref/prompt.wav（与 IndexTTS 同一份）

输出：_out/kouhai_jp_cosyvoice/click_0.wav ... idle_4.wav（24kHz wav）
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
OUT_DIR = os.path.join(HERE, "_out", "kouhai_jp_cosyvoice")
SPEED = float(os.environ.get("COSYVOICE_SPEED", "1.0"))
FP16 = os.environ.get("COSYVOICE_FP16", "1") not in ("0", "false", "False")
os.makedirs(OUT_DIR, exist_ok=True)

if COSY_DIR not in sys.path:
    sys.path.insert(0, COSY_DIR)

# 同一批台词的日语翻译（与 v2 脚本一致；只用于 TTS，不写入 config 中文文字）
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


def main():
    import torch
    import torchaudio
    from cosyvoice.cli.cosyvoice import CosyVoice2

    print("=== CosyVoice 2 日语克隆（你的音色）===")
    print("model : %s" % COSY_MODEL)
    print("ref   : %s" % REF)
    print("speed : %.2f  fp16=%s" % (SPEED, FP16))
    cosyvoice = CosyVoice2(COSY_MODEL, load_jit=False, load_trt=False, fp16=FP16)
    print(">> model loaded. sample_rate=%d" % cosyvoice.sample_rate)

    for pool in ("click", "idle"):
        items = _load(pool)
        for idx in range(len(items)):
            key = (pool, idx)
            jp = JP.get(key)
            if not jp:
                continue
            out = os.path.join(OUT_DIR, "%s_%d.wav" % (pool, idx))
            if os.path.isfile(out) and os.path.getsize(out) > 4000:
                print("  %-12s (skip)" % os.path.basename(out))
                continue
            try:
                gen = cosyvoice.inference_cross_lingual(
                    tts_text=jp, prompt_wav=REF, stream=False, speed=SPEED)
                speech = None
                for chunk in gen:
                    speech = chunk["tts_speech"]
                if speech is None:
                    raise RuntimeError("no speech returned")
                torchaudio.save(out, speech, cosyvoice.sample_rate)
                dur = speech.shape[-1] / float(cosyvoice.sample_rate)
                print("  %-12s dur=%.2fs | %s" % (os.path.basename(out), dur, jp[:22]))
            except Exception as e:  # noqa: BLE001
                print("  %-12s FAILED: %s" % (os.path.basename(out), e))

    print("日语克隆 -> %s" % OUT_DIR)


if __name__ == "__main__":
    main()
