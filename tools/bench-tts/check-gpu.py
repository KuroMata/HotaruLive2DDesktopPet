# -*- coding: utf-8 -*-
"""快检：这台机器的 torch / GPU 是否正常（用来区分"环境慢"和"CosyVoice 路径慢"）

如果 4096³ 的 fp16 矩阵乘只要几十毫秒，说明 GPU 本身没问题 →
那 CosyVoice 的 RTF 4.4 就是它那条推理路径的问题（多候选 + empty_cache + 未开 JIT 等），
而不是"机器不行"。
"""
import time

import torch

print('torch        =', torch.__version__)
print('cuda 可用    =', torch.cuda.is_available())
print('cuda 版本    =', torch.version.cuda)
if torch.cuda.is_available():
    print('设备         =', torch.cuda.get_device_name(0))
    free, total = torch.cuda.mem_get_info()
    print('显存 空闲/总 = %.2f / %.2f GB' % (free / 1073741824, total / 1073741824))

    for dtype, tag in ((torch.float16, 'fp16'), (torch.float32, 'fp32')):
        a = torch.randn(4096, 4096, device='cuda', dtype=dtype)
        b = torch.randn(4096, 4096, device='cuda', dtype=dtype)
        for _ in range(2):                      # 预热
            c = a @ b
        torch.cuda.synchronize()
        t0 = time.time()
        n = 10
        for _ in range(n):
            c = a @ b
        torch.cuda.synchronize()
        ms = (time.time() - t0) / n * 1000
        tflops = (2 * 4096 ** 3) / (ms / 1000) / 1e12
        print('%s 4096³ 矩阵乘 = %7.2f ms   ≈ %6.1f TFLOPS' % (tag, ms, tflops))
        del a, b, c
        torch.cuda.empty_cache()

    # empty_cache 的代价：量一下反复清空分配器缓存有多贵
    x = torch.randn(1024, 1024, device='cuda')
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(50):
        torch.cuda.empty_cache()
    torch.cuda.synchronize()
    print('empty_cache ×50 = %.1f ms（单次 %.2f ms）' % ((time.time() - t0) * 1000, (time.time() - t0) * 20))
else:
    print('！！ CUDA 不可用 —— 那就是全部跑在 CPU 上，RTF 4 完全解释得通')
