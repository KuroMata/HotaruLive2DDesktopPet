# 模型目录

本目录**不包含** Live2D 模型文件。

## 为什么不包含

桌宠默认使用的模型（`Hotaru2024`）是**第三方版权资产**，不是本项目的原创内容，因此不随仓库分发。这也是加密 `.enc` 文件与密钥都不在仓库里的原因——项目本身有「防止模型被随意取用」的设计，公开分发与这个意图相悖。

## 怎么让它跑起来

1. 准备一个 Live2D Cubism 3/4 模型，包含：
   - `xxx.moc3`（**必须是 v5 或以下**；npm 上的 `live2dcubismcore` 只支持到 v4，本项目用 `app/vendor/live2dcubismcore.min.js`，Core 5.1.0）
   - 贴图 PNG
   - `xxx.model3.json`
2. 放进本目录，比如：

   ```
   app/models/你的模型名/你的模型名.model3.json
   ```

3. 改 `app/config.json` 的两个字段：

   ```json
   {
     "modelServeBase": "",
     "modelUrl": "/models/你的模型名/你的模型名.model3.json"
   }
   ```

   `modelServeBase` 留空表示从本目录读取；也可以填一个绝对路径指向本机模型库。

4. 模型文件**不需要加密**。`main.js` 的 `sendModelFile()` 是「明文优先」——磁盘上存在同名 `.enc` 才走 AES 解密，明文文件会直接服务。

## 可选：自己加密（如果你也想防盗）

加密由 `tools/encrypt-models.js` 完成，密钥派生参数与 `main.js:851` 必须一致，否则运行时会解密失败。格式为 **前 16 字节 IV + AES-256-CBC 密文**。

> 注意：这只是混淆级防护，不是 DRM。密钥在 `main.js` 里可推导，对能读代码的人无效——它的作用是让随手解包的人拿到打不开的文件。

## 关于自制模型

如果你要做一个完全属于自己的模型（这样就能合法开源了）：

- `E:\Live2D Cubism 5.3`（本机已装 Cubism Editor）可以完成 rigging 与导出
- 给现有参数打关键帧即可产出 `motion3.json`，**不需要重新 rigging**
- 表情可以用 `exp3.json`（本项目的 `exp3/` 里那些单参数开关就是最小形式）
