# Live2D Companion · 透明桌宠 + 桥接 WorkBuddy

一个透明、置顶、可拖拽/缩放的 Electron 窗口：背景是 Live2D 模型（默认 Hotaru2024），底部是可折叠的聊天面板，聊天通过本机 WorkBuddy 暴露的 **ACP 本地协议**桥接，实现"运行 Live2D 的同时正常与 WorkBuddy 对话"。

> 详细的启动方式、排错与字段速查见 **运行说明.md**（本文档只留安装与原理）。

## 工作原理（已对 127.0.0.1:9418 实测验证）
- WorkBuddy 桌面端在本机监听 ACP 服务（默认 `http://127.0.0.1:9418`）。
- 页面**不直接**访问 9418：页面来自 `127.0.0.1:18765`，直连别的端口属跨域，上游不带 CORS 头时 Chromium 会在网络层拒绝，`fetch` 只抛一句含糊的 `TypeError: Failed to fetch`（分不清是端口没开还是被拒）。
  因此改为**主进程同源代理**：页面请求同源的 `/api/v1/acp*`，`main.js` 再转发到 9418，并把真实失败原因翻成中文。
  该路径是 SSE 流，转发时**必须逐块透传**（且 `setNoDelay`），否则助手回复会一直卡着不出来。
- 另有探活端点 `GET /api/v1/acp/health`（主进程只做一次 TCP 连接，无副作用），页面启动时先探活再连接，失败则每 `acpRetryMs` 自动重试。
- 连接流程 → `POST /api/v1/acp/connect` 取得 `connectionId + sessionToken`（无需鉴权）。
- `initialize` → `session/new`（拿到 sessionId）→ `session/prompt` 发送消息。
- 助手回复以 SSE 流（`session/update` 通知）返回，程序实时渲染到聊天框，并驱动 Live2D 嘴巴开合（lip-sync）。

## 一次性安装（需要联网）
```powershell
$env:ELECTRON_MIRROR  = "https://registry.npmmirror.com/-/binary/electron/"
$env:ELECTRON_CACHE   = "D:\live2d-companion\.electron-cache"
$env:npm_config_cache = "D:\npm-cache"
$env:TEMP = "D:\tmp"; $env:TMP = "D:\tmp"
Set-Location D:\live2d-companion
& "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\npm.cmd" install --no-audit --no-fund
```
> 环境变量务必带上：C 盘剩余空间很小，默认走 C:\Temp 会写满（ENOSPC）；GitHub Releases 在本环境不可达，必须走 npmmirror，否则 electron 的 postinstall 会长时间卡死。
>
> 依赖装好后即可离线运行（模型与 ACP 都在本机）。

## 配置（app/config.json）
| 字段 | 说明 |
|------|------|
| `acpBaseUrl` | WorkBuddy ACP 地址，默认 `http://127.0.0.1:9418` |
| `useAcpProxy` | 默认 `true`：经主进程同源代理访问 ACP。设 `false` 则页面直连 `acpBaseUrl`（仅当上游配了 CORS 才可行） |
| `acpRetryMs` | 链路未就绪时的自动重试间隔（毫秒），默认 `8000` |
| `serverPort` | 本地静态服务端口，默认 `18765` |
| `startupBackground` | 首次启动的背景模式：`"clear"` 透明底 / `"glass"` 毛玻璃底（点过按钮后以 `localStorage` 的 `l2d-bg-glass-v1` 为准） |
| `modelServeBase` | 本机模型根目录（用于绕过 file:// 跨域），默认指向 VTube Studio 的 `Live2DModels` |
| `modelUrl` | 模型入口，默认 `/models/Hotaru2024/hotaru2024.model3.json`（大小写敏感） |
| `cubismCore` | 仅作记录；运行时由 `app/vendor/live2dcubismcore.min.js` 决定 |
| `window` | 窗口宽高 |
| `chromiumSandbox` | 默认 `false`。Chromium 渲染进程沙箱在部分受限环境下起不来，会让窗口永远不出现，故默认关闭 |
| `autoConnectChat` | 启动即连接 WorkBuddy（true） |

## 本地静态服务（main.js）
- 路由：`/api/v1/acp*` → ACP 代理；`/models/*` → `modelServeBase`；`/node_modules/*` → 项目依赖；`/app/*` → `app/`；其余落到 `app/`。
- 所有响应带 `Cache-Control: no-store`。**这一条不能省**：Electron 的磁盘缓存跨启动保留，而 `127.0.0.1` 的无缓存头响应会走启发式缓存 —— 改完 CSS/JS 重启却看到旧样式，就是这么来的（踩过）。
- `safeJoin()` 做目录穿越校验；比较前必须 `path.resolve` 归一化并转小写，否则 `config.json` 里的正斜杠路径会让正常请求被判 403（踩过）。

## 依赖脚本路径（已校准，改动前先读这段）
`index.html` 里三行 UMD 必须是：
- `pixi.js/dist/browser/pixi.min.js` —— pixi v6 的 UMD 在 `dist/browser/` 下，`dist/` 根目录没有该文件。
- `app/vendor/live2dcubismcore.min.js` —— **不是** `node_modules/live2dcubismcore` 里那份。npm 包停在 1.0.2（Core 4.2.2），只支持 moc3 v4，而 Hotaru2024 的 `.moc3` 是 **v5**，会报 `csmReviveMocInPlace is failed`。vendor 里这份取自 Live2D 官方 CDN，Core 5.1.0。
- `pixi-live2d-display/dist/cubism4.min.js` —— 用 cubism4 专用包而**不是** `index.min.js` 全量包；全量包会先注册 Cubism 2 运行时，缺 `live2d.min.js` 时中断，导致 `PIXI.live2d.Live2DModel` 注册不上。

版本约束：`pixi-live2d-display@0.4.0` 必须搭配 **pixi.js v6**（peer 依赖 `@pixi/*@^6`），升级到 v7 会报 `PIXI.core` 未定义。

## 启动器（start.cmd / start-debug.cmd / tools\selfcheck\run.cmd）
三个 `.cmd` 必须保持**纯 ASCII 内容 + CRLF 换行**，不能出现任何中文，连 `rem` 注释和 `echo` 提示都不行。

原因：cmd.exe 是按**当前 OEM 代码页（本机 936/GBK）逐字节**解析 `.cmd` 的，而且是在执行 `chcp` 之前就读完了。中文（含中文标点）的 UTF-8 编码常以 `0x82` 之类的字节收尾，该字节在 GBK 里是双字节首字节，会把行尾的 `\r` 一起吃掉，于是**下一行被并进当前行**，整段脚本被切碎。典型症状：`'rem' 不是内部或外部命令`、`'echo' 不是内部或外部命令`、启动命令被拦腰截断成半截。中文说明请一律写进 `.md` 文档。

另一个容易忽略的点：**换行必须是 CRLF**。只写 LF 的 `.cmd` 在 cmd.exe 下解析不可靠。可用这条命令体检（`nonASCII` 必须为 0、`CRLF` 必须为真）：
```powershell
foreach($f in 'D:\live2d-companion\start.cmd','D:\live2d-companion\start-debug.cmd','D:\live2d-companion\tools\selfcheck\run.cmd'){
  $b=[IO.File]::ReadAllBytes($f); $bad=0
  for($i=0;$i -lt $b.Length;$i++){ if($b[$i] -gt 127){$bad++} }
  $s=[Text.Encoding]::ASCII.GetString($b)
  "$([IO.Path]::GetFileName($f)): nonASCII=$bad CRLF=$($s.Contains(""`r`n""))"
}
```

其余约定：
- `set "ELECTRON_RUN_AS_NODE="` —— 清掉会让 electron.exe 退化成纯 Node 的变量。`main.js` 与 `tools\selfcheck\m.js` 里都另有"重新拉起自己"的自愈兜底；但用 `Start-Process` 直接拉起可执行文件时**不会**自动清变量，务必留着这一行。
- 应用路径传 `%~dp0.`（结尾带点）。`%~dp0` 自带反斜杠，写成 `%~dp0"` 会形成 `\"` 被当成转义引号，报 `Cannot find module 'D:\live2d-companion"'`。
- `start.cmd` 结尾用 `ping -n 3` 作延时（`timeout` 在句柄被重定向时会失败），再用 `tasklist | find` 确认 electron 真的起来了；没起来就把 `app.log` 打印在窗口里并 `pause`，不再静默闪退。

## 其他
3. **文字抽取**：助手回复以 `session/update` 通知返回，桥接模块会递归抽取其中所有 `text` 字段。若某次回复结构特殊导致内容缺失，把 SSE 数据贴回即可微调 `_extractText`。

## 操作
- 窗口**没有标题栏**：拖拽窗口靠**底部控制栏的空白处**（底栏整体是 `-webkit-app-region: drag`，按钮是 `no-drag`）。
- 底栏按钮：聊天（折叠/展开记录）、透明/毛玻璃（背景模式）、锁（锁定模型位置与缩放）、重置、隐藏（到托盘）。
- 模型画面：拖动移动、滚轮缩放；允许拖到几乎完全移出窗口（只留一小块压边），找不回时点「重置」。
- 聊天框 Enter 发送，Shift+Enter 换行；失败时会自动进入重试。
- 模型未加载时窗口仍可用（聊天照常），仅背景为占位提示。

## 验证 ACP 是否存活（可选）
走代理（推荐，无副作用，直接给中文原因）：
```powershell
curl.exe -s http://127.0.0.1:18765/api/v1/acp/health
```
直连上游（会真的建一条连接）：
```powershell
curl.exe http://127.0.0.1:9418/api/v1/acp/connect -X POST -H "x-codebuddy-request: 1" -d "{}"
```
返回含 `connectionId` / `sessionToken` 即正常。
