# -*- coding: utf-8 -*-
"""把 flow.decoder.estimator.fp32.onnx 构建成 TRT plan（TRT 10/11 兼容版）。

官方 convert_onnx_to_trt 用了旧 API（EXPLICIT_BATCH / tensor.dtype 赋值），
在 tensorrt>=10 上会挂，这里按新 API 重写。

用法： python tools/bench-tts/build-trt-plan.py [half|float]
产物： <模型目录>/flow.decoder.estimator.<half|float>.mygpu.plan
"""
import os
import sys
import time

sys.path.insert(0, os.environ.get("COSYVOICE_DIR", "D:/cosyvoice_src"))

import tensorrt as trt

MODEL_DIR = r"C:/Users/Administrator/.cache/modelscope/hub/iic/CosyVoice2-0___5B"
ONNX = os.path.join(MODEL_DIR, "flow.decoder.estimator.fp32.onnx")

# 与 cosyvoice/cli/model.py get_trt_kwargs 保持一致
PROFILES = {
    "x":    ((2, 80, 4), (2, 80, 500), (2, 80, 3000)),
    "mask": ((2, 1, 4),  (2, 1, 500),  (2, 1, 3000)),
    "mu":   ((2, 80, 4), (2, 80, 500), (2, 80, 3000)),
    "cond": ((2, 80, 4), (2, 80, 500), (2, 80, 3000)),
    # t (2,) 与 spks (2,80) 是静态形状，不需要 profile
}


def main():
    io_dtype = sys.argv[1] if len(sys.argv) > 1 else "half"
    out = os.path.join(MODEL_DIR, "flow.decoder.estimator.%s.mygpu.plan" % io_dtype)
    print("TRT:", trt.__version__)
    print("ONNX:", ONNX, "%.1f MB" % (os.path.getsize(ONNX) / 2**20))
    print("输出:", out)
    print("IO dtype:", io_dtype, flush=True)

    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(0)  # TRT10+ 默认 explicit batch
    parser = trt.OnnxParser(network, logger)
    with open(ONNX, "rb") as f:
        if not parser.parse(f.read()):
            for i in range(parser.num_errors):
                print(parser.get_error(i))
            sys.exit(1)
    print("onnx 解析 OK, inputs=%d outputs=%d" % (network.num_inputs, network.num_outputs))
    for i in range(network.num_inputs):
        t = network.get_input(i)
        print("  in %-5s %-10s %s" % (t.name, t.dtype, t.shape))

    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 1 << 32)
    config.set_flag(trt.BuilderFlag.FP16)

    profile = builder.create_optimization_profile()
    for name, (mn, opt, mx) in PROFILES.items():
        profile.set_shape(name, mn, opt, mx)
    config.add_optimization_profile(profile)

    # IO dtype：官方 fp16 plan 会把 IO 设为 HALF；TRT10/11 可能不允许直接赋值
    if io_dtype == "half":
        try:
            for i in range(network.num_inputs):
                network.get_input(i).dtype = trt.DataType.HALF
            for i in range(network.num_outputs):
                network.get_output(i).dtype = trt.DataType.HALF
            print("IO dtype 已设为 HALF")
        except Exception as e:
            print("设 HALF 失败（%r），改用 FLOAT IO + 内部 FP16" % e)
            io_dtype = "float"
            out = os.path.join(MODEL_DIR, "flow.decoder.estimator.%s.mygpu.plan" % io_dtype)

    print("开始构建 plan（可能 5~15 分钟）……", flush=True)
    t0 = time.time()
    engine = builder.build_serialized_network(network, config)
    assert engine is not None, "build_serialized_network 返回 None"
    with open(out, "wb") as f:
        f.write(engine)
    print("构建完成: %.1f 分钟  文件 %.1f MB" % (
        (time.time() - t0) / 60, os.path.getsize(out) / 2**20))


if __name__ == "__main__":
    main()
