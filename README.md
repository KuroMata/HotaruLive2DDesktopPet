# 黑叶萤桌宠 · Live2D Companion

<p align="center">
  <img src="build/mac_icon.png" width="340" alt="黑叶萤桌宠">
</p>

一个运行在桌面上的**透明 Live2D 桌宠**。她住在你的屏幕上：可以拖动、缩放、锁定；点击她会有台词和表情；播放音乐时她会跟着节拍点头闭眼；接入 [WorkBuddy](https://www.workbuddy.cn) 后，你在对话框里说一句话，她会回答，并用口型说出来。

## 功能特性

- **透明桌宠**：拖动 / 缩放 / 锁定 / 置顶，自动记住位置与大小
- **点击互动**：点击不同部位触发台词与表情 / 动作绑定
- **待机台词**：随机冒出一句话，以气泡呈现，口型随文本逐字驱动
- **音乐律动**：检测系统播放的声音节拍，她跟着节奏点头、闭眼
- **屏幕运动追踪**：她盯着屏幕里动的东西看（可开关）
- **多语言台词档**：cn / jp / en，可切换人设档
- **TTS 语音**：支持 Edge TTS / CosyVoice / IndexTTS / Windows SAPI，可插拔
- **聊天大脑（独立思考）**：不依赖 WorkBuddy 也能聊天——可选「本地模型（Ollama）/ 云端 API / WorkBuddy」三种大脑，自定义人设；问时间/节日走快通道，带思考超时保护与气泡「思考中…」提示 + 悬停手动停止
- **WorkBuddy 桥接**：作为可选聊天大脑之一，通过本地 ACP 协议对话
- **设置界面**：换模型、换台词档、调参数、选聊天大脑，无需改代码

## ⚠ 重要：模型需要自备

出于版权原因，**本仓库不包含任何 Live2D 模型文件**。程序兼容 Cubism 3/4 标准导出的模型（`.model3.json` + `.moc3` + 贴图）。

**三步放好模型：**

1. 把模型文件夹放进 `app/models/`，例如 `app/models/MyModel/MyModel.model3.json`
2. 复制 `app/config.example.json` 为 `app/config.json`
3. 把其中的 `modelUrl` 改成 `/models/MyModel/MyModel.model3.json`

**模型从哪来：**

- 自己用 [Live2D Cubism Editor](https://www.live2d.com/en/download/) 制作（社区版免费）
- 使用有授权许可的模型（请遵守原作者的利用规约）
- VTube Studio / nizima 用户可直接复制 `Live2DModels` 目录下的模型文件夹

> 程序同时支持明文模型与 `.enc` 加密模型（加密工具见 `tools/encrypt-models.js`）。
> 模型自带的表情（exp3）与动作（motion3）会被自动扫描并接入点击与热键系统。

## 快速开始

前置要求：[Node.js](https://nodejs.org) 18 或更高版本。

```bash
git clone https://github.com/KuroMata/live2d-companion.git
cd live2d-companion
npm install
```

放好模型（见上一节）后启动：

- **Windows**：双击 `start.cmd`（推荐——会自动处理环境变量，以托盘方式启动，不占任务栏）
- 命令行：`npm start`

启动后她在系统托盘里（右下角图标），右键托盘图标可打开设置。

## 可选功能

| 功能 | 需要什么 | 缺少时 |
|---|---|---|
| 语音（TTS） | Python 3.10+，见 `tts/README.md` | 全部静默降级，只显示字幕 |
| 音乐律动 | Python + 回环采集，见 `audio/audio_server.py` | 功能关闭，其余正常 |
| WorkBuddy 对话 | 本机运行 WorkBuddy（ACP） | 只用本地待机台词 |

**注意**：仓库同样不含预生成的台词语音（体积与音色版权原因）。点击互动时文字气泡正常显示；需要声音请配置 TTS。

## 打包

```bash
npm run dist          # Windows NSIS 安装包 → dist/
npm run dist:mac      # macOS（需在 macOS 上执行）
```

## 常见问题

**启动后一直显示「正在载入模型…」**
没有找到模型。检查 `config.json` 的 `modelUrl` 路径、目录名与文件名大小写是否完全一致。

**双击 start.cmd 一闪而过 / 没有窗口**
先双击 `start-debug.cmd` 看真实报错；`app.log` 记录了每次启动的详细日志。

**报 `Cannot find module`**
`ELECTRON_RUN_AS_NODE` 环境变量被污染（非空时 electron.exe 会退化成纯 Node）。`start.cmd` 会自动清掉它；手动启动前请先清空。

**npm install 很慢 / electron 下载失败**
国内镜像：

```bash
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
```

**端口占用**
默认占用 18765（本地服务）与 18766（TTS），可在 `config.json` 里改。

## 更新日志（自上次提交以来的改动）

> 本批改动构成「独立聊天大脑」体系：桌宠从「必须接入 WorkBuddy 才能对话」升级为「自带思考能力」。

### 新增功能
- **三种聊天大脑**：本地模型（Ollama）/ 云端 API（OpenAI 兼容）/ WorkBuddy 三选一。首次启动弹窗选择，**默认云端**；记住上次选择；可勾选「下次不再询问」。
- **可定制人设**（`app/data/persona.json`，首次使用内置默认）：默认人设为**男性助理**，称呼用户为「博士」。使用者可改称呼、性格、语气、禁忌等。
- **本地模型生命周期托管**：选「本地」时才自动拉起 Ollama（带 `OLLAMA_MODELS` 环境变量，避免读空目录）；加载时提示耗时、就绪时弹系统通知；**关闭桌宠时跟随关闭**（仅关闭自己拉起的那个，借用外部已运行的不会误杀）。
- **选择窗提示**：顶部提示「不知道选哪个先选云端」；选中本地时在确认键旁显示显存占用警告。
- **托盘菜单瘦身**：表情/待机/屏幕追踪/鼠标/音律/语音/语言/字体等开关已迁入设置界面，托盘只留常用项；原「参数调试」「口型调试」收进「调试」父级。
- **三块调试面板**（托盘「调试」下）：`参数调试面板`（全部参数实时值）、`屏幕追踪调试`（捕捉画面 + 识别到的运动物体）、`音律识别调试`（能量/起音阈值/起音时刻、连续相位与每拍包络、**实际写进模型的参数值**，并直接给出"为什么不动"的结论）。

### 问题修复
- **问时间答错**：本地小模型不知道真实时间。改为在 system prompt 注入本机实时时钟，并新增「时钟快通道」——纯问时间/日期/星期/月份/年份/距某日天数直接查系统时钟秒回。
- **节日答不出**：中秋等农历节日本地模型不会算。新增「节日快通道」，内置核对过的公历日期表（中秋/春节/元宵/端午/国庆/元旦），秒回且准确。
- **思考卡顿干等**：新增**思考超时保护**（默认 15 秒），超时没吐字就敷衍一句「一时答不上来」而非让用户干等；已开始输出的不会被误杀。
- **气泡体验**：生成首字前显示「思考中…」；正在生成的气泡悬停时浮现「停止思考」，可手动中断本地/云端/WorkBuddy 三条链路。

### 文件变动
核心新增 `app/js/chat-backends.js`（后端抽象）、`app/js/brain-chooser.js` + `app/brain-chooser.html`（选择窗）、`app/data/persona.json`（人设）、`docs/方案-桌宠独立大脑.md`（设计稿）。`main.js` 新增 Ollama 侧车与代理路由，`preload.js` 暴露大脑接口，`app.js` / `app/styles.css` 接入思考与停止状态。

## 目录结构

```
main.js                Electron 主进程（本地服务器 / 托盘 / ACP 桥接 / 模型加解密）
preload.js             渲染进程安全桥
app/                   桌宠页面（渲染层）
  js/live2d-loader.js  Live2D 加载与全部参数驱动（眨眼/视线/口型/情绪/律动）
  js/app.js            交互、台词调度与聊天发送
  js/chat-backends.js  聊天大脑后端抽象（本地/云端/WorkBuddy + 时钟/节日快通道）
  js/brain-chooser.js  启动选择窗逻辑
  js/settings…         设置窗口
  data/                台词档与人设档（JSON），含 persona.json
  models/              ← 把你的模型放这里（仓库内只有说明文档）
tts/                   语音侧车（Python，可选）
audio/                 音乐律动侧车（Python，可选）
tools/                 模型加密、打包、自检脚本
docs/                  设计文档（功能扩展 / 面部捕捉 / 模型切换）
```

## 许可

- **代码**：尚未附加开源许可证。在添加之前，默认保留所有权利——你可以阅读和学习，但请勿直接二次分发。
- **模型、立绘、语音**：归原权利人所有，与本仓库无关。
