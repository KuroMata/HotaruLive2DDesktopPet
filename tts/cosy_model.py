"""CosyVoice2 模型加载辅助。

两个作用：

1. 离线安全加载
   本机模型已完整缓存到 modelscope 缓存目录。CosyVoice2 内部调用
   `snapshot_download(model_dir)` 时默认会去联网校验 revision，断网直接报错。
   这里在导入时给 `modelscope.hub.snapshot_download.snapshot_download` 打补丁，
   默认 `local_files_only=True`（模型已缓存，优先用本地），从而支持离线重跑。
   如需下载全新模型，设置环境变量 `COSYVOICE_ALLOW_DOWNLOAD=1` 关闭该补丁。

   注意：补丁必须在 `import cosyvoice` 之前生效。各生成脚本均在文件顶部
   `from cosy_model import resolve_cosy_model`，而 CosyVoice2 在 main() 内才导入，
   故补丁一定先于 cosyvoice 绑定 snapshot_download，可正确生效。

2. resolve_cosy_model()
   返回 `COSYVOICE_MODEL` 环境变量或默认模型 ID `iic/CosyVoice2-0.5B`。
   注意 modelscope 会自动把名里的点号替换（`0.5B` -> `0___5B`）来计算缓存目录
   （hub/iic/CosyVoice2-0___5B），用模型 ID 即可正确解析，无需手写本地路径。
"""
import os

_ALLOW_DOWNLOAD = os.environ.get("COSYVOICE_ALLOW_DOWNLOAD", "0") not in (
    "0", "false", "False")

if not _ALLOW_DOWNLOAD:
    try:
        import modelscope.hub.snapshot_download as _msdl
        _orig = _msdl.snapshot_download

        def _patched_snapshot_download(model_id, **kwargs):
            if "local_files_only" not in kwargs:
                kwargs["local_files_only"] = True
            return _orig(model_id, **kwargs)

        _msdl.snapshot_download = _patched_snapshot_download
    except Exception:
        # 补丁失败不影响在线行为（默认仍会联网校验）
        pass


def resolve_cosy_model(default_id="iic/CosyVoice2-0.5B", env_key="COSYVOICE_MODEL"):
    return os.environ.get(env_key, default_id)
