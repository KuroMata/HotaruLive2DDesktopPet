# -*- coding: utf-8 -*-
"""「靠谱后辈 + 模棱两可暗示喜欢」人设，v2 试听：

  * 中文：IndexTTS 克隆音色（不变调 / natural 润色），额外做 1.15x 保 Pitch 变速，
          修掉上一版"语速偏慢导致断句发散"的问题。
  * 日语：IndexTTS 的 BPE 词表不含假名（会出乱码），所以日语改用 Edge TTS 日语音色
          （ja-JP-KeitaNeural，男声后辈感）。config 里的文字仍保持中文，不单独做
          日语版文字；这里只是把同一句的意思翻成日语念出来供试听。

人设参数（与已认可版一致，独立脚本不读 config.json，必须显式锁死）：
  BOYIFY=0  SEMITONES=0  FORMANT=0  EMO_ALPHA=0.3  POLISH=0(脚本内自己 master)
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("INDEXTTS_DIR", "D:/index-tts")
os.environ.setdefault("INDEXTTS_MODEL_DIR", "checkpoints_2")
os.environ["INDEXTTS_BOYIFY"] = "0"
os.environ["INDEXTTS_FORMANT"] = "0"
os.environ["INDEXTTS_SEMITONES"] = "0"
os.environ["INDEXTTS_EMO_ALPHA"] = "0.3"
os.environ["INDEXTTS_POLISH"] = "0"          # 脚本内自己跑 master，方便在变速后再压一次 artifacts
os.environ["INDEXTTS_POLISH_MODE"] = "natural"
os.environ["INDEXTTS_REF"] = os.path.join(HERE, "ref", "prompt.wav")

from engines import IndexTTSEngine, EdgeTTSEngine
from audio_polish import read_wav, write_wav, speed_up, deartifact_stretch, report

SPEED = 1.12
CN_DIR = os.path.join(HERE, "_out", "kouhai_audition_v3")
JP_DIR = os.path.join(HERE, "_out", "kouhai_jp")
os.makedirs(CN_DIR, exist_ok=True)
os.makedirs(JP_DIR, exist_ok=True)

# 同一批台词的日语翻译（仅用于 TTS 试听，不写入 config 文字）
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
JP_VOICES = ["ja-JP-KeitaNeural", "ja-JP-DaichiNeural", "ja-JP-NanamiNeural"]


def _load(pool):
    name = "click-lines.json" if pool == "click" else "idle-lines.json"
    with open(os.path.join(HERE, "..", "app", "data", name), "r", encoding="utf-8") as f:
        return json.load(f)


def synth_jp(text, out):
    """用 Edge TTS 日语音色念日语；多候选音色，前一个失败自动换下一个。"""
    os.environ["EDGE_RATE"] = "-3%"
    os.environ["EDGE_PITCH"] = "+0Hz"
    last_err = None
    for v in JP_VOICES:
        os.environ["EDGE_VOICE"] = v
        try:
            eng = EdgeTTSEngine()
            data, _ = eng.synth(text, emo=None)
            with open(out, "wb") as f:
                f.write(data)
            return v
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError("Edge TTS 日语全部失败：%s" % last_err)


def main():
    cn = IndexTTSEngine()
    cn._ensure()
    print("=== 中文（克隆音色 + 变速 %.2fx）===" % SPEED)
    for pool in ("click", "idle"):
        items = _load(pool)
        for idx, item in enumerate(items):
            out = os.path.join(CN_DIR, "%s_%d.wav" % (pool, idx))
            if os.path.isfile(out) and os.path.getsize(out) > 20000:
                print("  %-12s (skip)" % os.path.basename(out))
                continue
            raw, _ = cn.synth(item["text"], emo=item["emo"][0] if item.get("emo") else "neutral")
            x, sr = read_wav(raw)
            x = speed_up(x, sr, SPEED)
            x = deartifact_stretch(x, sr)
            with open(out, "wb") as f:
                f.write(write_wav(x, sr))
            r = report(out)
            print("  %-12s emo=%-9s rms=%sdB 5k-8k=%s%% dur=%ss | %s"
                  % (os.path.basename(out), item["emo"][0], r["rms_db"],
                     r["5k-8k"], r["dur"], item["text"][:18]))

    print("=== 日语（Edge TTS 日语音色）===")
    for pool in ("click", "idle"):
        items = _load(pool)
        for idx, item in enumerate(items):
            key = (pool, idx)
            jp = JP.get(key)
            if not jp:
                continue
            out = os.path.join(JP_DIR, "%s_%d.mp3" % (pool, idx))
            if os.path.isfile(out) and os.path.getsize(out) > 2000:
                print("  %-12s (skip)" % os.path.basename(out))
                continue
            used = synth_jp(jp, out)
            print("  %-12s voice=%-20s | %s" % (os.path.basename(out), used, jp[:24]))

    print("中文 -> %s" % CN_DIR)
    print("日语 -> %s" % JP_DIR)


if __name__ == "__main__":
    main()
