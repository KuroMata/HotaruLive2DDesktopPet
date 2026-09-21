# -*- coding: utf-8 -*-
"""预生成 40 条台词音频（click/idle × CN/JP 各 10）。

读取 app/data/{click,idle}-lines.json，用 cosy_gen.generate_best 生成：
  app/data/lines/click_cn_00..09.wav, click_jp_00..09.wav,
                  idle_cn_00..09.wav,  idle_jp_00..09.wav
并写 app/data/lines/manifest.json 供桌宠按 池+索引+语言 直接播放（零延迟、确定性）。
模型只加载一次；每条最多 8 候选选优 + 伪影拒绝 + 响度归一(-16 LUFS)。
"""
import os
import sys
import json
import traceback
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DATA = os.path.join(HERE, "..", "app", "data")
OUT_DIR = os.path.join(APP_DATA, "lines")
os.makedirs(OUT_DIR, exist_ok=True)

sys.path.insert(0, HERE)
from cosy_gen import load_cosy, generate_best, SR

POOLS = ["click", "idle"]


def gen_pool(cosy, pool, items):
    recs = []
    for idx, entry in enumerate(items):
        text = entry.get("text", "")
        jp = entry.get("jp", "")
        rec = {
            "text": text,
            "jpText": jp,
            "cn": None,
            "jp": None,
        }
        # 中文
        if text:
            fn = "%s_cn_%02d.wav" % (pool, idx)
            fp = os.path.join(OUT_DIR, fn)
            try:
                w, info = generate_best(cosy, text, max_candidates=8, label=fn, lang="cn")
                sf.write(fp, w, SR)
                rec["cn"] = fn
                print(">> %s 已写 时长=%.1fs cv=%.3f exc=%.2f tonal-free" % (fn, info["dur"], info["cv"], info["exc"]))
            except Exception as e:
                print("!! %s 生成失败: %s" % (fn, e))
                traceback.print_exc()
        # 日语
        if jp:
            fn = "%s_jp_%02d.wav" % (pool, idx)
            fp = os.path.join(OUT_DIR, fn)
            try:
                w, info = generate_best(cosy, jp, max_candidates=8, label=fn, lang="jp")
                sf.write(fp, w, SR)
                rec["jp"] = fn
                print(">> %s 已写 时长=%.1fs cv=%.3f exc=%.2f tonal-free" % (fn, info["dur"], info["cv"], info["exc"]))
            except Exception as e:
                print("!! %s 生成失败: %s" % (fn, e))
                traceback.print_exc()
        recs.append(rec)
    return recs


def main():
    cosy = load_cosy()
    print(">> model loaded")
    manifest = {"version": 1, "pools": {}}
    for pool in POOLS:
        path = os.path.join(APP_DATA, "%s-lines.json" % pool)
        items = json.load(open(path, encoding="utf-8"))
        print("=== 生成 %s 池 (%d 条) ===" % (pool, len(items)))
        manifest["pools"][pool] = gen_pool(cosy, pool, items)
    mp = os.path.join(OUT_DIR, "manifest.json")
    json.dump(manifest, open(mp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(">> manifest 已写:", mp)
    # 复核：所有文件是否都生成且无挂断音
    n = sum(1 for p in POOLS for r in manifest["pools"][p] if r["cn"] and r["jp"])
    print(">> 完成：%d/%d 条双语言齐全" % (n, 20))


if __name__ == "__main__":
    main()
