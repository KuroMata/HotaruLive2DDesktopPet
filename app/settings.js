// settings.js —— 黑叶萤桌宠设置窗（纯渲染进程，经 preload 的 desktopPet.getConfig/setConfig 读写）
(function () {
  'use strict';
  const api = window.desktopPet;
  if (!api) { document.body.innerHTML = '<p style="color:#f88;padding:20px">错误：主进程接口未就绪（desktopPet 不存在）。</p>'; return; }

  // ---- 选项常量（与主进程 TTS_ENGINE_IDS / VOWEL_FAMILIES / UI_FONT_FAMILIES 保持一致）----
  const TTS_ENGINES = [
    { value: 'auto', label: '自动（克隆优先 → 在线音色 → 内置）' },
    { value: 'cosyvoice', label: 'CosyVoice 3（流式·实时）' },
    { value: 'indextts', label: 'IndexTTS-2（离线·克隆你的音色）' },
    { value: 'edge', label: 'Edge TTS（在线·微软专业音色）' },
    { value: 'sapi', label: 'Windows 内置语音（占位）' },
    { value: 'tone', label: '提示音（仅链路自检）' }
  ];
  const VOWEL_FAMS = [
    { value: 'auto', label: '自动探测' },
    { value: 'Param', label: 'Param (A/I/U/E/O)' },
    { value: 'ParamMouth', label: 'ParamMouth' },
    { value: 'Mouth', label: 'Mouth' },
    { value: 'Vowel', label: 'Vowel' },
    { value: 'ParamVowel', label: 'ParamVowel' }
  ];
  const FONT_FAMS = [
    { value: '', label: '系统默认' },
    { value: 'Microsoft YaHei', label: '微软雅黑' },
    { value: 'Sarasa Mono SC', label: '等距更纱黑体 Sarasa Mono SC' },
    { value: 'Sarasa SC', label: '更纱黑体 Sarasa SC' },
    { value: 'SimHei', label: '黑体' },
    { value: 'DengXian', label: '等线' }
  ];
  const YESNO = [
    { value: 0, label: '说话时 Silence=0（口型接管）' },
    { value: 1, label: '说话时保持 Silence=1' }
  ];
  const CNJP = [
    { value: 'cn', label: '中文' },
    { value: 'jp', label: '日本語' },
    { value: 'en', label: 'English' }
  ];
  // 台词情绪标签（与 live2d-loader.js 的 EMOTION_PRESETS 一一对应）
  const EMO_LIST = [
    { value: 'neutral', label: '平静 neutral' },
    { value: 'focus', label: '专注 focus' },
    { value: 'curious', label: '好奇 curious' },
    { value: 'joy', label: '开心 joy' },
    { value: 'sleepy', label: '困倦 sleepy' },
    { value: 'affection', label: '爱慕 affection' },
    { value: 'shy', label: '害羞 shy' },
    { value: 'tease', label: '调皮 tease' },
    { value: 'serious', label: '严肃 serious' },
    { value: 'surprise', label: '惊讶 surprise' },
    { value: 'pout', label: '鼓腮 pout' },
    { value: 'smug', label: '得意 smug' },
    { value: 'enjoy', label: '陶醉 enjoy' }
  ];
  const LANGS = ['cn', 'jp', 'en'];
  const LANG_LABEL = { cn: '中文', jp: '日文', en: '英文' };
  // 「触发方式 → 台词触发」的取值
  const ON_LINE_OPTS = [
    { value: 'off', label: '不随台词触发' },
    { value: 'all', label: '所有台词都触发' },
    { value: 'pick', label: '仅选中的台词' }
  ];
  const BG = [
    { value: 'clear', label: '透明背景' },
    { value: 'glass', label: '磨砂玻璃' }
  ];
  const CUBISM = [
    { value: 'cubism3', label: 'Cubism 3' },
    { value: 'cubism4', label: 'Cubism 4' }
  ];
  const POLISH = [
    { value: 'natural', label: '自然' },
    { value: 'formal', label: '正式' },
    { value: 'cute', label: '可爱' }
  ];
  // “额外追踪参数”下拉的兜底候选（当模型参数列表尚未就绪时使用）。
  // 实际运行时下拉会优先用本模型真实枚举到的全部参数 ID（更全面）。
  const DEFAULT_EXTRA_PARAMS = [
    'ParamBodyX', 'ParamBodyY', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY',
    'ParamMouthX', 'ParamMouthForm', 'ParamHairFront', 'ParamHairBack', 'ParamArmLA', 'ParamArmRA'
  ];

  // ---- 配置大纲（schema）：每个参数含 key / label / 类型 / 帮助 ----
  // type: toggle | select | range | number | text
  // reload:true 表示该改动需重启桌宠程序后才生效（仅在配置中保存）
  const SCHEMA = [
    {
      tab: '通用', title: '外观与行为',
      items: [
        { key: 'emotionEnabled', label: '表情情绪', type: 'toggle',
          help: '开启后，桌宠在说话 / 显示台词时会自动做出对应五官表情（开心 / 专注 / 亲昵等）。\n关闭则表情不随台词变化。\n参考：开 / 关' },
        { key: 'mouseFollow', label: '鼠标追踪', type: 'toggle',
          help: '开启后桌宠视线跟随鼠标光标（跨所有显示器，含外接屏）。\n关闭后视线只跟随屏幕运动追踪（若已开启），否则回正朝前——不再追鼠标。\n若你开着屏幕追踪却总感觉在追鼠标，可先关掉本项排查。\n参考：开 / 关' },
        { key: 'idleLinesEnabled', label: '待机台词', type: 'toggle',
          help: '开启后桌宠按随机间隔自动冒出待机台词。\n关闭后仅在底栏点「待机」时手动触发一次。\n参考：开 / 关' },
        { key: 'idleMotion', label: '待机动作（呼吸/摆头）', type: 'toggle', reload: true,
          help: '开启后模型有轻微呼吸与头部摆动的待机动画；关闭则完全静止。\n参考：开 / 关（重启桌宠生效）' },
        { key: 'lipSync', label: '口型同步', type: 'toggle', reload: true,
          help: '开启后语音 / 音节驱动嘴型开合；关闭则嘴不动。\n参考：开 / 关（重启桌宠生效）' },
        { key: 'autoConnectChat', label: '自动连接聊天（WorkBuddy）', type: 'toggle', reload: true,
          help: '开启后启动即尝试连接 WorkBuddy 桥接，可接收聊天文本驱动桌宠。\n关闭则不自动连接。\n参考：开 / 关（重启桌宠生效）' },
        { key: 'idleDisplayLang', label: '台词显示语言', type: 'select', options: CNJP,
          help: '待机 / 点击台词在气泡里显示的文字语言。\n参考：中文 / 日本語' },
        { key: 'idleVoiceLang', label: '语音语言', type: 'select', options: CNJP,
          help: '朗读台词时使用的语音语言（需对应语音引擎支持）。\n参考：中文 / 日本語' },
        { key: 'vowelParamFamily', label: '元音参数族（口型）', type: 'select', options: VOWEL_FAMS,
          help: '驱动嘴型的 Live2D 参数族。不同模型命名不同；\n选「自动探测」会按常见前缀匹配，不行再逐一切试。\n参考：auto / Param / ParamMouth / Mouth / Vowel / ParamVowel' },
        { key: 'vowelModeDriveOpenY', label: '驱动 OpenY（张合）', type: 'toggle',
          help: '开启后用元音参数驱动嘴的纵向开合（OpenY）；关闭则只调横向。\n多数模型建议开。\n参考：开 / 关' },
        { key: 'silenceSpeakingValue', label: '说话时 Silence 值', type: 'select', options: YESNO,
          help: '合成 / 口型引擎在“非发音”帧写入的 Silence 值。\n若发现不说话时嘴也动，把它切到另一项。\n参考：0 / 1' },
        { key: 'uiFontFamily', label: '界面字体', type: 'select', options: FONT_FAMS, allowCustom: true,
          help: '气泡与界面文字字体。选「系统默认」用系统字体；\n也可在下方填任意已安装字体名（如 Sarasa Mono SC）。\n参考：字体名字符串' },
        { key: 'uiFontSize', label: '界面字号', type: 'range', min: 8, max: 64, step: 1, unit: 'px',
          help: '气泡 / 界面文字大小。\n参考：8–64 px，默认 18' },
        { key: 'startupBackground', label: '启动背景', type: 'select', options: BG, reload: true,
          help: 'clear = 完全透明背景；glass = 半透明磨砂玻璃质感。\n参考：clear / glass（重启桌宠生效）' }
      ]
    },
    {
      tab: '模型', title: '模型库与模型切换（可换任意 Live2D 模型，无需重启）',
      items: [
        { type: 'modelLibrary', label: '模型库与模型',
          help: '**模型库目录**：存放 Live2D 模型的根目录（也可指向 VTube Studio 的 Live2DModels 目录）。\n点「浏览…」选目录；换目录后无需重启程序，模型列表会立刻按新目录重新扫描。\n\n**模型列表**：自动扫描该目录下所有 model3.json（含加密的 .model3.json.enc），按 Name 括注显示。\n选中后点「载入模型」即可热切换，**不重启程序、不打断聊天**。\n\n**关于语音**：切换模型不会沿用原模型的台词与语音 —— 新模型默认使用「台词」分页里为它绑定的台词档；\n未绑定时落到通用档（default，只有通用话术，走 TTS 现场合成）。\n\n参考：模型库目录 = 绝对路径；模型 = 下拉里的任一项' }
      ]
    },
    {
      tab: '台词', title: '台词内容 · 三语言 · 语音来源（TTS 合成 / 自录音频 / 预生成）',
      items: [
        { type: 'lineProfilePicker', label: '台词档与语言',
          help: '**台词档**：一整套台词（点击台词池 + 待机台词池）。每个模型可以绑定不同的档；\n换到新模型时若没有绑定，就用 default 通用档（不含任何预生成语音）。\n\n**显示语言 / 语音语言**：分别控制气泡里显示哪种文字、朗读哪种语言。\n三种语言都支持；若某条台词没有对应语言的文本，会回退到中文文本（并用中文语音来源）。\n\n**默认引擎 / 音色**：供"语音来源 = TTS"的台词使用。\nEdge TTS 的中/日/英预设音色最全（需联网）；CosyVoice / IndexTTS 为本地克隆音色。\n\n参考：可随时新建台词档，互不影响' },
        { type: 'lineEditor', label: '台词列表',
          help: '逐条编辑台词：中文 / 日文 / 英文文本 + 情绪 + **每种语言各自的语音来源**。\n\n语音来源三选一（每种语言可不同）：\n· **预生成文件**：项目内 app/data/lines 下的 wav（零延迟，就是原来那批离线语音）\n· **自录音频**：选你自己录的 wav/mp3，**引用原路径不复制**（文件位置别乱动）\n· **TTS 合成**：运行时现场合成，可单独指定引擎与音色（留空则用上面的默认值）\n\n每行有「试听」：按当前设置朗读该条台词；「删除」移除该条。\n待机台词还可设 time（any/day/night）控制白天/夜间是否出现。\n\n参考：改动即时保存到 app/data/lines/profiles/<档 id>.json' }
      ]
    },
    {
      tab: '表情与动作', title: '模型自带的 exp3 表情 / motion 动作 · 触发方式',
      items: [
        { type: 'assetLink', label: '素材关联（写入模型引用）',
          help: '**为什么需要这一步**：很多模型（比如当前的 Hotaru2024）目录里明明有 idle.motion3.json、sleep.motion3.json，\n却没写进 model3.json 的 FileReferences.Motions —— 引擎根本不会加载它们，于是"选了也播不出来"。\n这里勾选并填组名后，程序会在**服务层动态补写** model3.json 的引用（不改磁盘上的模型文件），\n保存后自动重新载入模型即可生效。\n\n**组名怎么填**：动作组名就是 playlist 的名字，绑定与播放时按"组名 + 序号"定位。\n⚠️ 组名若写成 `Idle`（首字母大写），引擎会把它当作**自动循环的待机动作**一直播（与程序中"参数合成的呼吸/摆头"冲突，二者只能取其一）。\n建议用 `idle`（小写）之类不会自动触发的名字，让它只在被绑定的触发点播放。\n\n**表情**：model3.json 已列出的表情会自动出现在下面的触发表格里，无需在此重复添加。\n\n参考：勾选 + 填组名 → 保存并重新载入' },
        { type: 'assetBinder', label: '触发方式与绑定',
          help: '给每个表情 / 动作配置**怎么被触发**，可同时勾选多种：\n· **点击模型**：点一下模型就播（播台词的行为不变，两者同时发生）\n· **待机随机**：每次出现待机台词时一起播\n· **快捷键**：填 `Alt+1`、`Ctrl+Shift+K` 这类写法\n· **台词触发**：所有台词都触发，或只勾选特定几条台词\n\n**快捷键范围**：\n· 仅桌宠窗口内 —— 只有焦点在桌宠上时才响应（不抢系统键，安全）\n· 全局 —— 系统级热键，任何程序前台都响应（注意别与其它软件冲突）\n\n底部「＋ 添加绑定」新增一行；「试播」可立刻在桌宠上看到效果。\n\n参考：动作若同时绑了多个，只会随机播其中一个（避免两套动作抢同一批参数）' }
      ]
    },
    {
      tab: '语音', title: 'TTS 语音',
      items: [
        { key: 'ttsEnabled', label: '启用语音', type: 'toggle',
          help: '总开关。关闭后桌宠静默（仅文字，不出声）。\n参考：开 / 关' },
        { key: 'ttsEngine', label: 'TTS 引擎', type: 'select', options: TTS_ENGINES,
          help: '语音合成引擎。auto = 按可用情况自动选；\ncosyvoice = 流式克隆；indextts = 离线克隆；edge = 微软在线；sapi = Windows 占位。\n参考：见下拉' },
        { key: 'ttsVoice', label: '音色名', type: 'text',
          help: '部分引擎用的说话人 / 音色名，如 Edge 的 zh-CN-XiaoxiaoNeural。\n留空用引擎默认。\n参考：字符串（因引擎而异）' },
        { key: 'ttsVolume', label: '音量', type: 'range', min: 0, max: 100, step: 1, unit: '%',
          help: '语音播放音量。\n参考：0–100（默认 10）' },
        { key: 'indexttsRef', label: 'IndexTTS 参考音频', type: 'text',
          help: '克隆音色用的参考音频文件路径（.wav / .mp3）。留空用内置默认。\n参考：本机文件绝对路径' },
        { key: 'indexttsEmoAlpha', label: 'IndexTTS 情感强度', type: 'range', min: 0, max: 1, step: 0.05,
          help: '情绪注入强度，越大越夸张。\n参考：0–1，默认 0.3' },
        { key: 'indexttsBoyify', label: 'IndexTTS 男声化', type: 'toggle',
          help: '把克隆音色向男声偏移。\n参考：开 / 关' },
        { key: 'indexttsSemitones', label: 'IndexTTS 变调', type: 'range', min: -12, max: 12, step: 1, unit: '半音',
          help: '整体音高偏移（半音）。0 = 不变。\n参考：-12–12，默认 0' },
        { key: 'indexttsPolish', label: 'IndexTTS 文本润色', type: 'toggle',
          help: '合成前对文本做口语化润色，使朗读更自然。\n参考：开 / 关' },
        { key: 'indexttsPolishMode', label: 'IndexTTS 润色风格', type: 'select', options: POLISH,
          help: '文本润色的语气风格。\n参考：natural / formal / cute' },
        { key: 'cosyvoiceRef', label: 'CosyVoice 参考音频', type: 'text',
          help: 'CosyVoice 克隆用的参考音频路径。留空用内置默认。\n参考：本机文件绝对路径' },
        { key: 'cosyvoiceFp16', label: 'CosyVoice FP16', type: 'toggle',
          help: '用半精度推理，更快更省显存但可能略降质。\n参考：开 / 关' },
        { key: 'ttsPython', label: 'IndexTTS Python 路径', type: 'text',
          help: '启动 IndexTTS 侧车的 Python 解释器绝对路径（如虚拟环境 Scripts/python.exe）。\n填错语音不可用。\n参考：文件绝对路径（重启桌宠生效）' },
        { key: 'cosyvoicePython', label: 'CosyVoice Python 路径', type: 'text',
          help: '同上，CosyVoice 用的 Python。\n参考：文件绝对路径（重启桌宠生效）' },
        { key: 'cosyvoiceDir', label: 'CosyVoice 项目目录', type: 'text',
          help: 'CosyVoice 源码 / 模型所在目录。\n参考：目录绝对路径（重启桌宠生效）' },
        { key: 'indexttsDir', label: 'IndexTTS 项目目录', type: 'text',
          help: 'IndexTTS-2 项目目录。\n参考：目录绝对路径（重启桌宠生效）' },
        { key: 'indexttsModelDir', label: 'IndexTTS 模型目录', type: 'text',
          help: 'IndexTTS 检查点子目录名（相对 indexttsDir）。\n参考：目录名' }
      ]
    },
    {
      tab: '屏幕追踪', title: '屏幕运动追踪（让桌宠追着运动的物体看）',
      items: [
        { key: 'screenTrack.enabled', label: '启用屏幕运动追踪', type: 'toggle',
          help: '开启后桌宠像追鼠标一样盯住屏幕里移动的物体（如视频中快速平移的角色）。\n需要屏幕录制权限（macOS 首次会弹窗授权，拒绝则自动回退关闭）。\n参考：开 / 关' },
        { key: 'screenTrack.screenIndex', label: '追踪屏幕', type: 'screenSelect',
          help: '选择屏幕运动追踪要捕捉哪块显示器（多屏时尤其有用）。\n下拉里的编号 1/2/3 与 Windows 显示设置中的"显示器 N"一致。\n点右侧"标识屏幕"按钮，会像 Windows 那样在每块屏上闪出大数字，当前选中的那块会高亮并标"✓已选"。\n参考：显示器 1（主屏）/ 显示器 2 / 显示器 3 …' },
        { key: 'screenTrack.threshold', label: '变化阈值', type: 'range', min: 1, max: 80, step: 1,
          help: '单像素灰度变化超过此值才算“动”。\n越小越灵敏（也更易被微噪误触），越大越迟钝。\n参考：5–60，默认 22' },
        { key: 'screenTrack.motionMin', label: '触发占比', type: 'range', min: 0.001, max: 0.1, step: 0.001,
          help: '画面中变化像素占比超过此值才认为“有物体在动”。\n越小越灵敏。\n参考：0.003–0.05，默认 0.012' },
        { key: 'screenTrack.spread', label: '跟手范围', type: 'range', min: 0.2, max: 2, step: 0.05,
          help: '运动物体偏离屏幕中心多远算“全偏转”。\n越小越跟手（轻微移动也让桌宠大幅转头）。\n参考：0.4–1.5，默认 0.85' },
        { key: 'screenTrack.fps', label: '检测帧率', type: 'range', min: 5, max: 30, step: 1, unit: 'fps',
          help: '帧差检测每秒帧数。越高越跟手但越吃 CPU。\n参考：8–20，默认 15' },
        { key: 'screenTrack.width', label: '采样宽度', type: 'number', min: 80, max: 1280, step: 1,
          help: '降采样后的检测宽度（非显示尺寸）。越小越快。\n参考：160–640，默认 320' },
        { key: 'screenTrack.height', label: '采样高度', type: 'number', min: 45, max: 720, step: 1,
          help: '降采样后的检测高度。\n参考：90–360，默认 180' },
        { key: 'screenTrack.releaseFrames', label: '解除帧数', type: 'range', min: 1, max: 60, step: 1,
          help: '画面静止多少帧后停止追踪、视线退回光标。越大越“黏”。\n参考：3–30，默认 10' }
      ]
    },
    {
      tab: '视线跟随', title: '视线 / 头部跟随（鼠标追踪 + 屏幕运动追踪共用）',
      items: [
        { key: 'gaze.smooth', label: '视线平滑', type: 'range', min: 40, max: 400, step: 10, unit: 'ms',
          help: '瞳孔跟随的平滑时间常数。\n越小越跟手、越灵敏（光标一动眼睛立刻跟上）；越大越平滑、越迟钝（像慢慢转头看过去）。\n鼠标追踪与屏幕运动追踪都受此影响。\n参考：40–400 ms，默认 120' },
        { key: 'gaze.amplitude', label: '眼球幅度', type: 'range', min: 0, max: 1.5, step: 0.05,
          help: '眼球（瞳孔）转动的幅度倍数。\n0 = 眼睛不随视线转；1 = 原始幅度；>1 眼睛转得更夸张。\n鼠标追踪与屏幕运动追踪都受此影响。\n参考：0–1.5，默认 1.0' },
        { key: 'gaze.headAmplitude', label: '头部幅度', type: 'range', min: 0, max: 2, step: 0.05,
          help: '头部随视线偏转的幅度倍数。\n0 = 头不转（只动眼睛）；1 = 原始幅度；>1 头转得更明显、更“活”。\n鼠标追踪与屏幕运动追踪都受此影响。\n参考：0–2.0，默认 1.0' },
        { key: 'gaze.headSmooth', label: '头部平滑', type: 'range', min: 80, max: 600, step: 10, unit: 'ms',
          help: '头部转动的平滑时间常数。\n越小头部越跟手（转得快）；越大头部越迟钝、越稳（转头缓慢）。\n鼠标追踪与屏幕运动追踪都受此影响。\n参考：80–600 ms，默认 220' },
        { key: 'gaze.extra', label: '额外追踪参数', type: 'extraParams',
          help: '默认的追踪只牵动眼球(X/Y)与头部(X/Y)。这里可以再指定其它参数跟着同一视线方向动。\n每行：参数（下拉列出本模型真实存在的全部参数 ID）+ 方向(X/Y) + 幅度(0–8) + 翻转 + 删除。\n例：选 ParamBodyX / ParamBodyY 让身体随视线轻微移动；选 ParamAngleZ 让歪头也跟着转。\n幅度 1 ≈ 与眼球同量级；若参数反向（如眼球 Y），勾「翻转」。\n注意：勾选的参数每帧会被本功能写入，若模型自带动画也驱动同一参数可能互相打架。\n参考：留空 = 不额外牵动任何参数' }
      ]
    },
    {
      tab: '音律识别', title: '音律识别（BPM/节拍驱动闭眼跟拍）',
      items: [
        { key: 'music.enabled', label: '启用音律识别', type: 'toggle',
          help: '开启后桌宠捕获系统正在播放的全部声音，检测节拍并跟着点头、闭眼欣赏（像在听歌）。\n关闭则恢复正常。\n注意：目前捕获的是整块声卡的混音（所有程序的声音），按程序单独捕捉后续再做。\n需要屏幕/音频捕获权限（Windows 一般无需额外设置；macOS 首次会弹授权）。\n参考：开 / 关' },
        { key: 'music.audioSource', label: '监听设备', type: 'audioSource',
          help: '默认项**就是在听"输出设备里播放的音乐"**，一般不用改。\n\n· 系统声音：默认输出设备的混音（推荐）\n  Windows 把声音送到默认输出设备（音箱/耳机）时，回环把这一路抓回来分析 —— 也就是你此刻听到的音乐。\n  注意它是所有程序混在一起的一整路（音乐+游戏+系统提示音都在内）。\n· 输出设备（逐端点回环，可任选）★\n  直接指定要听哪个音箱/耳机，**不必再去改 Windows 默认输出设备**。\n  这条走的是音频侧车（Python soundcard → WASAPI 逐端点 loopback），绕开了 Chromium 只能跟默认设备的限制。\n  仅 Windows 可用；若侧车不可用（未装 soundcard / 非 Windows），这一组不会出现，用其它两项即可。\n· 输入设备（浏览器采集）\n  具体的采集源：如"立体声混音 Stereo Mix"、虚拟声卡、麦克风。\n\n为什么浏览器本身做不到？\nChromium 只能从"声音的源头"取声（麦克风 / 线路输入 / 立体声混音），音箱耳机是终点不是源头、没法"录音"，\n其回环也只跟随"默认输出设备"这一个端点。所以逐端点选择由侧车完成。\n\n切换后会立即用新来源重新采集。' },
        { key: 'music.eyeClose', label: '闭眼程度', type: 'range', min: 0, max: 1, step: 0.05,
          help: '音律识别时眼睛闭上多少。\n0 = 完全睁眼（不闭眼）；1 = 完全闭眼。\n建议 0.7–0.85（留一条缝，像陶醉地眯着眼）。\n参考：0–1，默认 0.8' },
        { key: 'music.nodStrength', label: '头部起伏幅度', type: 'range', min: 0, max: 3, step: 0.1,
          help: '头部随节拍上下起伏的幅度（连续正弦，不是每拍抽一下）。\n0 = 头不动（只身体晃+闭眼）；1 = 适中；更大更夸张。\n幅度还会随当前音量自动缩放：歌响晃得大，歌轻轻晃，静音停下。\n参考：0–3，默认 1.0' },
        { key: 'music.swayStrength', label: '身体摆幅', type: 'range', min: 0, max: 3, step: 0.1,
          help: '身体左右摆动的幅度。真人听歌最明显的是身体在晃，只动头会显得单薄。\n0 = 身体不动（只点头）；1 = 适中；更大更夸张。\n同样随音量自动缩放。\n参考：0–3，默认 1.0' },
        { key: 'music.sensitivity', label: '节拍灵敏度', type: 'range', min: 1.05, max: 3, step: 0.05,
          help: '节拍检测的灵敏度（能量超过滑动均值的倍数才记为一拍）。\n越小越灵敏（轻响也点头，但易受噪声误触）；越大越迟钝（只跟明显的鼓点）。\n参考：1.05–3，默认 1.3' },
        { key: 'music.maxTempo', label: '律动速度上限', type: 'range', min: 40, max: 200, step: 5, unit: 'BPM',
          help: '律动速度上限（BPM）：估测出的速度超过它就不断除以 2，避免快歌把角色晃得过快。\n例如上限 80 时：120→60、128→64、174→87；低于 80 的速度保持原样。\n觉得晃得太快就把这里调小（如 70）；觉得太慢就调大（如 100~120）。\n观测面板显示的 BPM 就是折半后实际用于律动的速度。\n参考：40–200，默认 80' },
        { key: 'music.enableA', label: '启用A方案（连续律动）', type: 'toggle',
          help: 'A 方案：用音量大小驱动头部/身体的连续起伏（不锁定具体节拍，平滑自然）。\n开 → 没测准 BPM 时也按「A方案速度」平稳摆动；关 → 只跑 B 方案（必须测准 BPM 才晃）。\n两个方案都关时角色完全静止（不点头不摆）。\n音律识别总开关关闭时本项不可调。' },
        { key: 'music.enableB', label: '启用B方案（BPM锁定）', type: 'toggle',
          help: 'B 方案：实时测出歌曲 BPM，让摆动与鼓点同频（最"合拍"）。\n开 → 测稳 BPM 后切换到本方案；关 → 不尝试锁定 BPM，只用 A 方案按固定速度摆。\n两个方案都关时角色完全静止（不点头不摆）。\n音律识别总开关关闭时本项不可调。' },
        { key: 'music.aSpeed', label: 'A方案速度', type: 'range', min: 40, max: 200, step: 5, unit: 'BPM',
          help: 'A 方案的基础摆动速度（BPM）：BPM 还没测稳时，连续律动就按这个速度晃。\n可调快/调慢，找到你喜欢的"随性轻晃"节奏。\n仅对 A 方案生效；B 方案锁定后会改用测得的真实 BPM。\n参考：40–200，默认 90' },
        { type: 'musicStatus', field: 'mode', label: '观测：检测状态',
          help: '实时观测（只读，不可改）：当前有没有检测到音乐，以及正在跑哪个方案。\n· 未开启 —— 音律识别已关闭。\n· 已开启·未采集到音频 —— 开了但没拿到声音（未授权捕获 / 声卡无回环音频）。\n· 未检测到音乐（采集中） —— 采集正常但此刻没有明显声音。\n· A 方案（连续律动） —— 检测到音乐，但 BPM 还没测稳，按默认速度平滑摆动。\n· B 方案（BPM 锁定） —— 已测出稳定 BPM，摆动与该 BPM 同频。\n每 0.5 秒刷新一次。' },
        { type: 'musicStatus', field: 'bpm', label: '观测：当前 BPM',
          help: '实时观测（只读，不可改）：检测到音乐并成功测出 BPM 后，这里显示当前 BPM。\n· 测量中… —— 已在听歌，但节奏还不够稳定（样本不足或拍间隔太散）。\n· 音律识别未开启 / 未检测到音乐 —— 显示 —。\nBPM 由最近若干拍的间隔取中位数并做一致性检查得出，只有多数拍间隔都接近才算测稳（避免忽快忽慢）。\n每 0.5 秒刷新一次。' }
      ]
    },
    {
      tab: '高级', title: '高级（端口 / 模型 / 环境，改后多需重启程序）',
      items: [
        { key: 'serverPort', label: '本地服务端口', type: 'number', min: 1024, max: 65535, step: 1, reload: true,
          help: '主程序 HTTP / 静态服务端口。\n参考：1024–65535，默认 18765（重启程序生效）' },
        { key: 'ttsPort', label: 'TTS 侧车端口', type: 'number', min: 1024, max: 65535, step: 1, reload: true,
          help: 'Python 语音侧车监听端口。\n参考：1024–65535，默认 18766（重启程序生效）' },
        { key: 'acpAutoDiscover', label: '自动发现 WorkBuddy 端口', type: 'toggle', reload: true,
          help: '自动扫描 WorkBuddy 本地端口建立桥接。关闭则需手动填基址。\n参考：开 / 关（重启桌宠生效）' },
        { key: 'useAcpProxy', label: '经本地代理访问 ACP', type: 'toggle', reload: true,
          help: '走主进程同源代理访问 WorkBuddy（避开跨域）。关闭则直连 acpBaseUrl（需上游配 CORS）。\n参考：开 / 关（重启桌宠生效）' },
        { key: 'acpRetryMs', label: 'ACP 重试间隔', type: 'number', min: 1000, max: 60000, step: 500, unit: 'ms', reload: true,
          help: '桥接断开后自动重连间隔。\n参考：2000–30000，默认 8000（重启桌宠生效）' },
        { key: 'acpCwd', label: 'ACP 工作目录', type: 'text', reload: true,
          help: 'WorkBuddy 桥接的工作目录（命令执行上下文）。\n参考：目录绝对路径（重启桌宠生效）' },
        { key: 'acpBaseUrl', label: 'ACP 基址', type: 'text', reload: true,
          help: '关闭代理时直连的 WorkBuddy 基址，如 http://127.0.0.1:10925。\n参考：URL（重启桌宠生效）' },
        { key: 'modelUrl', label: '模型 URL', type: 'text', reload: true,
          help: 'Live2D model3.json 的 HTTP 路径（相对本地服务）。换模型时改。\n参考：/models/.../xxx.model3.json（重启桌宠生效）' },
        { key: 'modelServeBase', label: '模型根目录', type: 'text', reload: true,
          help: '模型资源本地根目录（留空用程序内 app/models）。\n参考：目录绝对路径（重启桌宠生效）' },
        { key: 'cubismCore', label: 'Cubism 内核', type: 'select', options: CUBISM, reload: true,
          help: 'Live2D Cubism 运行时版本。一般不用改。\n参考：cubism3 / cubism4（重启桌宠生效）' },
        { key: 'chromiumSandbox', label: 'Chromium 沙箱', type: 'toggle', reload: true,
          help: 'Electron 渲染进程沙箱。若启动异常可关；开启更安全。\n参考：开 / 关（重启程序生效）' }
      ]
    }
  ];

  // ---- 工具 ----
  function getByPath(obj, p) {
    return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  let CONFIG = {};
  let reloadNeeded = false;
  const banner = document.getElementById('banner');
  const tooltip = document.getElementById('tooltip');
  const toast = document.getElementById('toast');

  function showToast(msg) {
    toast.textContent = msg; toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 1400);
  }
  function markReload() {
    reloadNeeded = true;
    banner.classList.add('show');
  }

  // 保存单个键
  function save(key, value, item) {
    if (api && api.setConfig) {
      Promise.resolve(api.setConfig({ key: key, value: value }))
        .then((r) => {
          if (!r || !r.ok) { showToast('保存失败：' + ((r && r.error) || '未知')); return; }
          showToast('已保存');
          if (item && item.reload) markReload();
        })
        .catch((e) => showToast('保存异常：' + e));
    }
  }

  // ---- 帮助气泡 ----
  function bindHelp(btn, text) {
    const show = () => {
      tooltip.innerHTML = text.replace(/\n/g, '<br>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      tooltip.classList.add('show');
      const r = btn.getBoundingClientRect();
      // 先显示以测量尺寸
      const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      let left = r.left - tw - 10;
      if (left < 8) left = r.right + 10;
      if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
      let top = r.top + r.height / 2 - th / 2;
      top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
    };
    const hide = () => tooltip.classList.remove('show');
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('focus', show);
    btn.addEventListener('blur', hide);
  }

  // ---- 各类型控件 ----
  function makeToggle(item, val) {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = !!val;
    const span = document.createElement('span'); span.className = 'slider';
    wrap.appendChild(input); wrap.appendChild(span);
    input.addEventListener('change', () => save(item.key, input.checked, item));
    return wrap;
  }
  function makeSelect(item, val) {
    const sel = document.createElement('select');
    item.options.forEach((o) => {
      const op = document.createElement('option');
      op.value = String(o.value); op.textContent = o.label;
      if (String(o.value) === String(val)) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', () => save(item.key, sel.value, item));
    return sel;
  }
  function makeRange(item, val) {
    const wrap = document.createElement('div');
    wrap.className = 'range-ctrl';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = item.min; input.max = item.max; input.step = item.step || 1;
    const cur = (val == null) ? item.min : Number(val);
    input.value = cur;
    // 可编辑数字框：允许直接键入数值（不再只能拖滑条）。固定宽度，拖动滑条时不会改变布局，
    // 避免右侧读数文字宽度变化把滑条整体挤来挤去 → 表现为“拖动时抽动/参数来回跳”的观感。
    const num = document.createElement('input');
    num.type = 'number';
    if (item.min != null) num.min = item.min;
    if (item.max != null) num.max = item.max;
    if (item.step != null) num.step = item.step;
    num.value = cur; num.className = 'range-num';
    const unit = document.createElement('span'); unit.className = 'unit';
    unit.textContent = item.unit || '';
    function commit(v) {
      let n = Number(v);
      if (isNaN(n)) return;
      if (item.min != null) n = Math.max(item.min, n);
      if (item.max != null) n = Math.min(item.max, n);
      save(item.key, n, item);
    }
    input.addEventListener('input', () => { num.value = fmt(Number(input.value)); commit(input.value); });
    num.addEventListener('input', () => { input.value = num.value; });        // 键入时滑条实时跟随
    num.addEventListener('change', () => { commit(num.value); });             // 失焦/回车提交并夹紧
    wrap.appendChild(input); wrap.appendChild(num); wrap.appendChild(unit);
    return wrap;
  }
  function makeNumber(item, val) {
    const input = document.createElement('input');
    input.type = 'number';
    if (item.min != null) input.min = item.min;
    if (item.max != null) input.max = item.max;
    if (item.step != null) input.step = item.step;
    input.value = (val == null) ? '' : val;
    input.addEventListener('change', () => {
      let n = Number(input.value);
      if (isNaN(n)) return;
      if (item.min != null) n = Math.max(item.min, n);
      if (item.max != null) n = Math.min(item.max, n);
      save(item.key, n, item);
    });
    return input;
  }
  function makeText(item, val) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = (val == null) ? '' : String(val);
    input.placeholder = '留空 = 默认';
    input.addEventListener('change', () => save(item.key, input.value, item));
    return input;
  }
  function fmt(n) { return (Math.round(Number(n) * 1000) / 1000).toString(); }

  // 带“自定义字体名”的 select
  function makeFontSelect(item, val) {
    const box = document.createElement('div');
    const sel = makeSelect(item, val);
    const txt = document.createElement('input');
    txt.type = 'text'; txt.placeholder = '或自定义字体名（如 Sarasa Mono SC）';
    txt.style.minWidth = '200px';
    const inPreset = item.options.some((o) => String(o.value) === String(val));
    if (!inPreset && val) txt.value = String(val);
    function commit() {
      const v = txt.value.trim() ? txt.value.trim() : sel.value;
      save(item.key, v, item);
    }
    sel.addEventListener('change', () => { txt.value = ''; commit(); });
    txt.addEventListener('change', commit);
    box.appendChild(sel); box.appendChild(txt);
    return box;
  }

  function makeCtrl(item, val) {
    switch (item.type) {
      case 'toggle': return makeToggle(item, val);
      case 'select': return item.allowCustom ? makeFontSelect(item, val) : makeSelect(item, val);
      case 'range': return makeRange(item, val);
      case 'number': return makeNumber(item, val);
      case 'text': return makeText(item, val);
      case 'screenSelect': return makeScreenSelect(item, val);
      case 'extraParams': return makeExtraParams(item, val);
      case 'musicStatus': return makeMusicStatus(item);
      case 'audioSource': return makeAudioSourceSelect(item, val);
      case 'modelLibrary': return makeModelLibrary(item);
      case 'lineProfilePicker': return makeLineProfilePicker(item);
      case 'lineEditor': return makeLineEditor(item);
      case 'assetLink': return makeAssetLink(item);
      case 'assetBinder': return makeAssetBinder(item);
      default: return document.createTextNode('');
    }
  }

  // 音律识别的"监听设备"下拉：默认「系统声音（回环·整块混音）」，其余为枚举到的音频输入设备。
  // 设备列表由主窗口枚举后上报主进程缓存（设置窗自己枚举拿不到设备名），这里异步取一次并填充。
  function makeAudioSourceSelect(item, val) {
    const sel = document.createElement('select');
    let cur = (val == null || val === '') ? 'loopback' : String(val);

    // outs：Python 侧车枚举到的输出端点（方案③，可任选）；ins：浏览器枚举到的输入设备
    let outs = [], ins = [];

    function build() {
      sel.innerHTML = '';
      const defOpt = document.createElement('option');
      defOpt.value = 'loopback';
      // 这一项抓的就是"Windows 送到默认输出设备（音箱/耳机）的声音" = 你听到的音乐。
      defOpt.textContent = '系统声音：默认输出设备的混音（推荐，就是你在听的音乐）';
      sel.appendChild(defOpt);

      // —— 方案③：逐端点回环，输出设备可任选 ——
      if (outs && outs.length) {
        const g = document.createElement('optgroup');
        g.label = '输出设备（逐端点回环，可任选）';
        outs.forEach((d) => {
          const op = document.createElement('option');
          op.value = 'wasapi:' + d.id;               // 前缀标识走 Python 侧车
          op.textContent = d.name;
          g.appendChild(op);
        });
        sel.appendChild(g);
      }
      // —— 浏览器采集：输入设备（立体声混音 / 虚拟声卡 / 麦克风）——
      if (ins && ins.length) {
        const g = document.createElement('optgroup'); g.label = '输入设备（浏览器采集）';
        ins.forEach((d) => {
          const op = document.createElement('option');
          op.value = d.deviceId; op.textContent = d.label || d.deviceId;
          g.appendChild(op);
        });
        sel.appendChild(g);
      }
      // 配置里的设备当前不在列表里（已拔出/侧车不可用）→ 留占位项，避免显示错乱
      if (cur !== 'loopback' && !sel.querySelector('option[value="' + cur + '"]')) {
        const op = document.createElement('option');
        op.value = cur; op.textContent = '（当前不可用）' + cur.slice(0, 14);
        sel.appendChild(op);
      }
      sel.value = cur;
    }
    build();
    // 两条来源并发取，各自到位就重绘一次
    Promise.resolve(api.getOutputDevices ? api.getOutputDevices() : [])
      .then((l) => { outs = l || []; build(); }).catch(() => {});
    Promise.resolve(api.getAudioDevices ? api.getAudioDevices() : [])
      .then((l) => { ins = (l || []).filter((d) => d && d.kind === 'audioinput'); build(); }).catch(() => {});
    sel.addEventListener('change', () => {
      cur = sel.value; save(item.key, cur, item);
    });
    return sel;
  }

  // 音乐检测观测面板（只读）：显示"是否检测到音乐 + 当前跑 A 还是 B"（field='mode'）
  // 或"测得的 BPM"（field='bpm'）。设置窗是独立窗口，读不到主窗渲染进程里的追踪器，
  // 故每 0.5s 向主进程查一次它缓存的状态（由 app.js 每 500ms 上报）。
  function makeMusicStatus(item) {
    const box = document.createElement('div');
    box.className = 'music-status';
    const val = document.createElement('span');
    val.className = 'ms-val';
    val.textContent = '读取中…';
    box.appendChild(val);

    function setText(t, cls) { val.textContent = t; val.className = 'ms-val' + (cls ? ' ' + cls : ''); }

    function render(s) {
      if (!s) { setText('读取中…'); return; }
      if (item.field === 'bpm') {
        if (!s.enabled) { setText('—（音律识别未开启）', 'off'); return; }
        if (!s.playing) { setText('—（未检测到音乐）', 'off'); return; }
        if (s.mode === 'B' && s.bpm > 0) { setText(s.bpm + ' BPM', 'on'); return; }
        setText('测量中…', 'wait');
        return;
      }
      // field === 'mode'
      if (!s.enabled) { setText('未开启', 'off'); return; }
      if (!s.active) { setText('已开启 · 未采集到音频', 'wait'); return; }
      if (!s.playing) { setText('未检测到音乐（采集中）', 'wait'); return; }
      if (s.mode === 'B') { setText('检测到音乐 · B 方案（BPM ' + (s.bpm || '-') + ' 锁定正弦）', 'on'); return; }
      setText('检测到音乐 · A 方案（连续律动，BPM 未锁定）', 'on');
    }

    function poll() {
      Promise.resolve(api.getMusicState ? api.getMusicState() : null).then(render).catch(() => {});
    }
    poll();
    setInterval(poll, 500);
    return box;
  }

  // 追踪屏幕选择器：下拉列出本机所有显示器（编号与 Windows 显示设置一致），
  // 右侧"标识屏幕"按钮调用主进程接口在每块屏上短暂弹出大数字（选中项高亮）。
  function makeScreenSelect(item, val) {
    const box = document.createElement('div');
    box.className = 'screen-select';
    const sel = document.createElement('select');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'identify-btn'; btn.textContent = '标识屏幕';
    let cur = (val == null) ? 0 : Number(val);
    function fill(list) {
      sel.innerHTML = '';
      if (list && !list.error && Array.isArray(list) && list.length) {
        list.forEach((d) => {
          const op = document.createElement('option');
          op.value = String(d.index); op.textContent = d.label;
          sel.appendChild(op);
        });
        if (list.some((d) => String(d.index) === String(cur))) sel.value = String(cur);
      } else {
        const op = document.createElement('option');
        op.value = '0'; op.textContent = '显示器 1（主屏）'; sel.appendChild(op);
        sel.value = '0';
      }
    }
    Promise.resolve(api.getDisplays ? api.getDisplays() : []).then(fill).catch(() => fill(null));
    sel.addEventListener('change', () => { cur = Number(sel.value); save(item.key, cur, item); });
    btn.addEventListener('click', () => {
      if (api.identifyDisplays) {
        Promise.resolve(api.identifyDisplays(cur)).catch(() => {});
        showToast('已在各屏幕显示标识（' + (cur + 1) + ' 为当前选中）');
      }
    });
    box.appendChild(sel); box.appendChild(btn);
    return box;
  }

  // 额外追踪参数：让用户自由添加多行，每行 = 参数 + 方向(X/Y) + 幅度 + 翻转 + 删除。
  // 参数候选优先用本模型真实枚举到的全部 ID（经 api.getModelParams），未就绪时回退 DEFAULT_EXTRA_PARAMS。
  function makeExtraParams(item, val) {
    const box = document.createElement('div');
    box.className = 'extra-params';
    const list = Array.isArray(val) ? val.map((b) => ({
      id: String(b.id || ''), axis: (b.axis === 'y') ? 'y' : 'x',
      amp: (b.amp != null) ? Number(b.amp) : 1, flip: !!b.flip
    })) : [];
    let paramIds = [];

    function buildOptions(sel, selectedId) {
      sel.innerHTML = '';
      const ids = paramIds.length ? paramIds : DEFAULT_EXTRA_PARAMS;
      ids.forEach((id) => {
        const op = document.createElement('option');
        op.value = id; op.textContent = id;
        if (id === selectedId) op.selected = true;
        sel.appendChild(op);
      });
      if (!ids.length) {
        const op = document.createElement('option');
        op.value = ''; op.textContent = '（模型参数未就绪）'; op.disabled = true;
        sel.appendChild(op);
      }
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'add-btn'; addBtn.textContent = '+ 添加追踪参数';
    addBtn.addEventListener('click', () => {
      list.push({ id: (paramIds[0] || DEFAULT_EXTRA_PARAMS[0] || ''), axis: 'x', amp: 1, flip: false });
      commit(); render();
    });
    box.appendChild(addBtn);

    function commit() { save(item.key, list.slice(), item); }

    function render() {
      Array.from(box.querySelectorAll('.extra-row')).forEach((r) => r.remove());
      list.forEach((b, i) => {
        const row = document.createElement('div'); row.className = 'extra-row';
        const pid = document.createElement('select');
        buildOptions(pid, b.id);
        pid.addEventListener('change', () => { list[i].id = pid.value; commit(); });
        const ax = document.createElement('select');
        [['x', 'X 方向'], ['y', 'Y 方向']].forEach(([v, l]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = l;
          if (v === b.axis) o.selected = true; ax.appendChild(o);
        });
        ax.addEventListener('change', () => { list[i].axis = ax.value; commit(); });
        const amp = document.createElement('input');
        amp.type = 'range'; amp.min = 0; amp.max = 8; amp.step = 0.1; amp.value = (b.amp != null) ? b.amp : 1;
        const ampNum = document.createElement('input');
        ampNum.type = 'number'; ampNum.min = 0; ampNum.max = 8; ampNum.step = 0.1;
        ampNum.value = (b.amp != null) ? b.amp : 1; ampNum.className = 'range-num';
        amp.addEventListener('input', () => { ampNum.value = fmt(Number(amp.value)); list[i].amp = Number(amp.value); commit(); });
        amp.addEventListener('change', () => { list[i].amp = Number(amp.value); commit(); });
        ampNum.addEventListener('input', () => { amp.value = ampNum.value; });
        ampNum.addEventListener('change', () => {
          let n = Number(ampNum.value); if (isNaN(n)) return;
          n = Math.max(0, Math.min(8, n)); list[i].amp = n; amp.value = n; commit();
        });
        const flipWrap = document.createElement('label'); flipWrap.className = 'flip';
        const flip = document.createElement('input'); flip.type = 'checkbox'; flip.checked = !!b.flip;
        flip.addEventListener('change', () => { list[i].flip = flip.checked; commit(); });
        flipWrap.appendChild(flip); flipWrap.appendChild(document.createTextNode(' 翻转'));
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'del-btn'; del.textContent = '删除';
        del.addEventListener('click', () => { list.splice(i, 1); commit(); render(); });
        row.appendChild(pid); row.appendChild(ax); row.appendChild(amp); row.appendChild(ampNum);
        row.appendChild(flipWrap); row.appendChild(del);
        box.insertBefore(row, addBtn);
      });
    }

    // 列表未到先渲染已有行（用兜底候选）；模型参数到后再刷新一次选项
    render();
    Promise.resolve(api.getModelParams ? api.getModelParams() : []).then((ids) => {
      if (Array.isArray(ids) && ids.length) { paramIds = ids; render(); }
    }).catch(() => {});
    return box;
  }

  // ========================================================================
  // R1 · 模型库与模型切换
  // ========================================================================
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function miniBtn(text, cls) {
    const b = el('button', 'mini-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    return b;
  }
  function pickSel(options, cur) {
    const s = document.createElement('select');
    options.forEach((o) => {
      const op = el('option'); op.value = String(o.value); op.textContent = o.label;
      if (String(o.value) === String(cur)) op.selected = true;
      s.appendChild(op);
    });
    return s;
  }
  function textIn(val, ph) {
    const i = document.createElement('input');
    i.type = 'text'; i.value = (val == null) ? '' : String(val);
    if (ph) i.placeholder = ph;
    return i;
  }

  function currentModelRel() { return String(CONFIG.modelUrl || '').replace(/^\/models\//, ''); }

  // ---- 当前模型的上下文（设置窗内共享）----
  // 「模型」「台词」「表情与动作」三个分页都以"当前模型"为基准：
  //   台词页 → 按模型相对路径查 CONFIG.lineProfile 决定用哪个台词档；
  //   素材页 → 按模型相对路径查 CONFIG.modelAssets 决定注入哪些动作/表情。
  // 所以换模型必须走 setModelUrl()：它统一更新 CONFIG.modelUrl 并广播一次，
  // 各分页收到后重算自己的上下文。若哪一页各自缓存一份 modelKey，
  // 就会出现"模型页已切到新模型、台词页还写着旧模型"的错位，只能靠重新打开设置窗纠正。
  const modelCtx = { rel: '', listeners: [] };
  function emitModelCtx() {
    modelCtx.listeners.forEach((f) => { try { f(); } catch (e) { /* 忽略 */ } });
  }
  function setModelUrl(url) {
    CONFIG.modelUrl = String(url || '');
    modelCtx.rel = currentModelRel();
    emitModelCtx();
  }
  function onModelChange(fn) { modelCtx.listeners.push(fn); }

  function makeModelLibrary(item) {
    const box = el('div', 'wide-ctrl model-lib');
    const dirIn = textIn(CONFIG.modelServeBase || '', '留空 = 程序内 app/models');
    dirIn.style.flex = '1';
    const bDir = miniBtn('浏览…');
    const bRescan = miniBtn('重新扫描');
    const sel = document.createElement('select');
    sel.style.flex = '1';
    const bLoad = miniBtn('载入模型');
    const status = el('div', 'ml-status', '');
    let models = [];

    function showCurrent() {
      const rel = currentModelRel();
      const hit = models.find((m) => m.rel === rel);
      status.textContent = '当前模型：' + (rel || '(未设置)') + (hit ? '（' + hit.name + '）' : '');
    }
    function fill(list) {
      models = list || [];
      sel.innerHTML = '';
      if (!models.length) {
        const op = el('option', null, '（该目录下没找到 model3.json）');
        op.value = ''; op.disabled = true; sel.appendChild(op);
        return;
      }
      models.forEach((m) => {
        const op = el('option', null, m.name + '  ·  ' + m.rel);
        op.value = m.rel;
        if (m.rel === currentModelRel()) op.selected = true;
        sel.appendChild(op);
      });
    }
    let scanSeq = 0;
    function scan(dir) {
      const my = ++scanSeq;
      status.textContent = '正在扫描…';
      Promise.resolve(api.scanModels ? api.scanModels(dir || '') : { ok: false })
        .then((r) => {
          if (my !== scanSeq) return;
          if (!r || !r.ok) { status.textContent = '扫描失败：' + ((r && r.error) || '未知'); fill([]); return; }
          fill(r.models);
          status.textContent = '库根目录：' + r.base + '　·　共 ' + ((r.models || []).length) + ' 个模型';
          showCurrent();
        }).catch((e) => { if (my === scanSeq) status.textContent = '扫描异常：' + e; });
    }

    bDir.addEventListener('click', () => {
      Promise.resolve(api.chooseDirectory ? api.chooseDirectory({ title: '选择模型库目录', defaultPath: dirIn.value || '' }) : null)
        .then((r) => {
          if (r && r.ok) { dirIn.value = r.path; save('modelServeBase', r.path, item); scan(r.path); }
        }).catch(() => {});
    });
    bRescan.addEventListener('click', () => scan(dirIn.value.trim()));
    dirIn.addEventListener('change', () => { save('modelServeBase', dirIn.value.trim(), item); scan(dirIn.value.trim()); });
    bLoad.addEventListener('click', () => {
      if (!sel.value) { showToast('请先选择一个模型'); return; }
      const want = '/models/' + sel.value;
      status.textContent = '正在切换并同步台词 / 素材…';
      Promise.resolve(api.switchModel ? api.switchModel(want) : null).then((r) => {
        if (r && r.ok) {
          // 关键：先把本地 CONFIG.modelUrl 更新并广播出去，台词页与表情与动作页会据此
          // 切换到新模型的上下文（台词档按模型查表、素材重新扫描 + 重取引擎清单）。
          setModelUrl(r.url || want);
          showCurrent();
          showToast('已切换模型，台词与表情动作已同步到新模型');
        } else {
          const msg = ((r && r.error) || '未知');
          showToast('切换失败：' + msg);
          status.textContent = '切换失败：' + msg;
          showCurrent();
        }
      }).catch((e) => { showToast('切换异常：' + e); showCurrent(); });
    });

    // 模型上下文若被别处改变，保持下拉选中项与状态行一致
    onModelChange(() => {
      const rel = currentModelRel();
      if (models.some((m) => m.rel === rel)) sel.value = rel;
      showCurrent();
    });

    const r1 = el('div', 'ml-row');
    r1.appendChild(el('span', 'ml-lab', '模型库目录')); r1.appendChild(dirIn); r1.appendChild(bDir);
    const r2 = el('div', 'ml-row');
    r2.appendChild(el('span', 'ml-lab', '模型')); r2.appendChild(sel); r2.appendChild(bLoad); r2.appendChild(bRescan);
    const r3 = el('div', 'ml-row');
    r3.appendChild(el('span', 'ml-lab', '')); r3.appendChild(status);
    box.appendChild(r1); box.appendChild(r2); box.appendChild(r3);
    scan(CONFIG.modelServeBase || '');
    return box;
  }

  // ========================================================================
  // R2 · 台词档 / 语言 / 默认音色 / 台词编辑
  // ========================================================================
  // 台词档状态由「台词档与语言」与「台词列表」两个控件共享：
  // 前者换档 → 后者重新载入，避免两处各读一份导致显示不一致。
  const lineState = { profileId: '', profile: null, listeners: [] };
  function emitLineState() {
    lineState.listeners.forEach((f) => { try { f(); } catch (e) { /* 忽略 */ } });
  }
  function profileIdForModelKey(key) {
    const map = CONFIG.lineProfile || {};
    return (map && map[key]) ? String(map[key]) : 'default';
  }
  function loadProfileInto(id, cb) {
    lineState.profileId = id || 'default';
    Promise.resolve(api.getLineProfile ? api.getLineProfile(lineState.profileId) : { ok: false })
      .then((r) => {
        lineState.profile = (r && r.ok && r.profile) ? r.profile
          : { name: lineState.profileId, click: [], idle: [] };
        if (!Array.isArray(lineState.profile.click)) lineState.profile.click = [];
        if (!Array.isArray(lineState.profile.idle)) lineState.profile.idle = [];
        if (cb) cb();
        emitLineState();
      }).catch(() => {
        lineState.profile = { name: lineState.profileId, click: [], idle: [] };
        if (cb) cb(); emitLineState();
      });
  }
  function saveProfile(profileId, profile) {
    Promise.resolve(api.setLineProfile ? api.setLineProfile({ id: profileId, profile: profile }) : null)
      .then((r) => {
        if (r && r.ok) showToast('台词已保存');
        else showToast('保存失败：' + ((r && r.error) || '未知'));
      }).catch((e) => showToast('保存异常：' + e));
  }

  function makeLineProfilePicker(item) {
    const box = el('div', 'wide-ctrl lp-picker');
    let profiles = [];
    let modelKey = currentModelRel();
    let map = Object.assign({}, CONFIG.lineProfile || {});
    let curId = map[modelKey] || 'default';

    const labModel = el('span', 'lp-model', '当前模型：' + (modelKey || '(未设置)'));
    const selProf = document.createElement('select');
    selProf.style.minWidth = '200px';
    const bNew = miniBtn('新建档');
    const bAssign = miniBtn('绑定到此模型');
    // Electron 渲染进程不支持 window.prompt，新建档用内联输入框
    const newIdIn = textIn('', '新档 id（字母/数字/-/_）');
    newIdIn.style.display = 'none';
    newIdIn.style.minWidth = '180px';
    const bNewOk = miniBtn('确定新建');
    bNewOk.style.display = 'none';

    function fillProfiles() {
      selProf.innerHTML = '';
      profiles.forEach((p) => {
        const op = el('option', null, p.name + '（' + p.id + '）　点击 ' + p.clickCount + ' / 待机 ' + p.idleCount);
        op.value = p.id;
        if (p.id === curId) op.selected = true;
        selProf.appendChild(op);
      });
      if (!profiles.some((p) => p.id === curId)) {
        const op = el('option', null, curId + '（文件不存在）');
        op.value = curId; selProf.appendChild(op);
      }
    }
    function reloadProfiles(cb) {
      Promise.resolve(api.listLineProfiles ? api.listLineProfiles() : [])
        .then((list) => { profiles = Array.isArray(list) ? list : []; fillProfiles(); if (cb) cb(); })
        .catch(() => { profiles = []; fillProfiles(); if (cb) cb(); });
    }

    // 行1：模型 → 台词档
    const r1 = el('div', 'ml-row');
    r1.appendChild(el('span', 'ml-lab', '台词档'));
    r1.appendChild(selProf); r1.appendChild(bNew); r1.appendChild(bAssign);
    const r1n = el('div', 'ml-row');
    r1n.appendChild(el('span', 'ml-lab', ''));
    r1n.appendChild(newIdIn); r1n.appendChild(bNewOk);
    const note = el('div', 'lp-note', '');
    const r1b = el('div', 'ml-row');
    r1b.appendChild(el('span', 'ml-lab', '')); r1b.appendChild(labModel); r1b.appendChild(note);

    // 把本控件对齐到「当前模型」：重算绑定键 modelKey、档 id，刷新档列表与内容。
    // 换模型后必须走这里——新模型多半还没绑档，此时回退到通用档 default，
    // 并在页面上说明原因，免得让人以为"切了模型但台词没跟着变"是故障。
    function syncToModel() {
      modelKey = currentModelRel();
      map = Object.assign({}, CONFIG.lineProfile || {});
      curId = map[modelKey] || 'default';
      labModel.textContent = '当前模型：' + (modelKey || '(未设置)');
      note.textContent = map[modelKey] ? ''
        : '（该模型未绑定台词档，已回退到通用档 default；可点右侧「绑定到此模型」改绑）';
      reloadProfiles(() => loadProfileInto(curId));
    }

    // 行2：显示语言 / 语音语言
    const selDisplay = pickSel(CNJP, CONFIG.idleDisplayLang || 'cn');
    const selVoice = pickSel(CNJP, CONFIG.idleVoiceLang || 'cn');
    const r2 = el('div', 'ml-row');
    r2.appendChild(el('span', 'ml-lab', '语言'));
    r2.appendChild(el('span', 'ml-tag', '显示'));
    r2.appendChild(selDisplay);
    r2.appendChild(el('span', 'ml-tag', '语音'));
    r2.appendChild(selVoice);

    // 行3：三语言的默认引擎 / 音色（供"语音来源 = TTS"的台词使用）
    const langBox = el('div', 'lp-langs');
    const ttsLang = Object.assign({}, CONFIG.ttsLang || {});
    LANGS.forEach((lg) => {
      ttsLang[lg] = Object.assign({ engine: '', voice: '' }, ttsLang[lg] || {});
      const row = el('div', 'ml-row');
      row.appendChild(el('span', 'ml-tag', LANG_LABEL[lg]));
      const engSel = pickSel([{ value: '', label: '（跟随总开关的引擎）' }].concat(TTS_ENGINES), ttsLang[lg].engine || '');
      engSel.style.minWidth = '150px';
      const voiceIn = textIn(ttsLang[lg].voice || '', '音色名，留空 = 引擎默认');
      voiceIn.style.minWidth = '190px';
      const bList = miniBtn('音色▾');
      const voiceSel = document.createElement('select');
      voiceSel.style.display = 'none';
      function commitLang() {
        ttsLang[lg] = { engine: engSel.value, voice: voiceIn.value.trim() };
        save('ttsLang', ttsLang, item);
      }
      engSel.addEventListener('change', () => { commitLang(); voiceSel.style.display = 'none'; });
      voiceIn.addEventListener('change', commitLang);
      bList.addEventListener('click', () => {
        Promise.resolve(api.listVoices ? api.listVoices(engSel.value) : { voices: [] }).then((r) => {
          const vs = (r && r.voices) || [];
          if (!vs.length) { showToast('该引擎没有可用音色（可能未安装或侧车未启动）'); return; }
          voiceSel.innerHTML = '';
          vs.forEach((v) => { const op = el('option', null, String(v)); op.value = String(v); voiceSel.appendChild(op); });
          if (ttsLang[lg].voice) voiceSel.value = ttsLang[lg].voice;
          voiceSel.style.display = '';
        }).catch(() => showToast('取音色失败'));
      });
      voiceSel.addEventListener('change', () => { voiceIn.value = voiceSel.value; commitLang(); });
      row.appendChild(engSel); row.appendChild(voiceIn); row.appendChild(bList); row.appendChild(voiceSel);
      langBox.appendChild(row);
    });

    selProf.addEventListener('change', () => { curId = selProf.value; loadProfileInto(curId); });
    selDisplay.addEventListener('change', () => save('idleDisplayLang', selDisplay.value, item));
    selVoice.addEventListener('change', () => save('idleVoiceLang', selVoice.value, item));
    bAssign.addEventListener('click', () => {
      modelKey = currentModelRel();
      map = Object.assign({}, CONFIG.lineProfile || {});
      map[modelKey] = curId;
      CONFIG.lineProfile = map;
      save('lineProfile', map, item);
      labModel.textContent = '当前模型：' + (modelKey || '(未设置)');
      note.textContent = '';   // 已经绑上了，撤掉「回退到 default」的说明
      showToast('已把「' + curId + '」绑定到当前模型');
    });
    bNew.addEventListener('click', () => {
      const show = newIdIn.style.display === 'none';
      newIdIn.style.display = show ? '' : 'none';
      bNewOk.style.display = show ? '' : 'none';
      if (show) newIdIn.focus();
    });
    bNewOk.addEventListener('click', () => {
      const id = String(newIdIn.value || '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { showToast('id 只能用字母/数字/-/_，且非空'); return; }
      saveProfile(id, { name: id, click: [], idle: [] });
      curId = id;
      newIdIn.value = '';
      newIdIn.style.display = 'none';
      bNewOk.style.display = 'none';
      reloadProfiles(() => loadProfileInto(id));
    });

    box.appendChild(r1); box.appendChild(r1n); box.appendChild(r1b); box.appendChild(r2); box.appendChild(langBox);

    onModelChange(syncToModel);
    syncToModel();
    return box;
  }

  // 台词编辑器：点击/待机两个池，逐条编辑三语文本 + 情绪 + 每语言语音来源
  function makeLineEditor(item) {
    const box = el('div', 'wide-ctrl line-editor');
    let pool = 'click';
    let prof = null;

    const selPool = pickSel([
      { value: 'click', label: '点击台词（点模型时播）' },
      { value: 'idle', label: '待机台词（自动随机出现）' }
    ], pool);
    const head = el('div', 'ml-row');
    head.appendChild(el('span', 'ml-lab', '台词池')); head.appendChild(selPool);
    const stat = el('span', 'ml-status', '');
    head.appendChild(stat);
    const listBox = el('div', 'le-list');
    const bAdd = miniBtn('＋ 添加台词');

    function commit() { if (prof) saveProfile(lineState.profileId, prof); }

    function langRow(entry, lg) {
      const row = el('div', 'le-voice-row');
      row.appendChild(el('span', 'ml-tag', LANG_LABEL[lg]));
      entry.voice = entry.voice || {};
      const v = Object.assign({ src: 'tts', engine: '', voice: '', file: '' }, entry.voice[lg] || {});
      entry.voice[lg] = v;
      const selSrc = pickSel([
        { value: 'tts', label: 'TTS 合成' },
        { value: 'file', label: '预生成文件' },
        { value: 'abs', label: '自录音频' }
      ], v.src);
      selSrc.style.minWidth = '120px';
      const fileIn = textIn(v.file || '', '音频文件路径');
      fileIn.style.flex = '1'; fileIn.style.minWidth = '180px';
      const engSel = pickSel([{ value: '', label: '（用默认引擎）' }].concat(TTS_ENGINES), v.engine || '');
      engSel.style.minWidth = '150px';
      const voiceIn = textIn(v.voice || '', '音色名（留空=默认）');
      voiceIn.style.minWidth = '150px';
      const bPick = miniBtn('选择文件…');
      const bPrev = miniBtn('试听');
      function refreshVis() {
        const s = selSrc.value;
        bPick.style.display = (s === 'abs') ? '' : 'none';
        fileIn.style.display = (s === 'tts') ? 'none' : '';
        engSel.style.display = (s === 'tts') ? '' : 'none';
        voiceIn.style.display = (s === 'tts') ? '' : 'none';
        fileIn.placeholder = (s === 'file') ? '文件名（相对 app/data/lines）' : '音频绝对路径';
      }
      function commitVoice() {
        entry.voice[lg] = { src: selSrc.value, file: fileIn.value.trim(), engine: engSel.value, voice: voiceIn.value.trim() };
        commit();
      }
      selSrc.addEventListener('change', () => { refreshVis(); commitVoice(); });
      fileIn.addEventListener('change', commitVoice);
      engSel.addEventListener('change', commitVoice);
      voiceIn.addEventListener('change', commitVoice);
      bPick.addEventListener('click', () => {
        Promise.resolve(api.chooseFile ? api.chooseFile({ title: '选择' + LANG_LABEL[lg] + '音频文件', defaultPath: fileIn.value || '' }) : null)
          .then((r) => { if (r && r.ok) { fileIn.value = r.path; commitVoice(); } }).catch(() => {});
      });
      bPrev.addEventListener('click', () => {
        const txt = lineTextOf(entry, lg);
        if (!txt) { showToast('该语言没有文本，无法试听'); return; }
        if (selSrc.value === 'file' && v.file) { playUrl('/app/data/lines/' + String(v.file).replace(/^[\/\\]+/, '')); return; }
        if (selSrc.value === 'abs' && v.file) { playUrl('/api/user-audio?path=' + encodeURIComponent(v.file)); return; }
        showToast('合成中…');
        Promise.resolve(api.previewTTS ? api.previewTTS({ text: txt, engine: engSel.value, voice: voiceIn.value.trim() }) : null)
          .then((r) => {
            if (r && r.ok) { playDataUrl(r.dataUrl); showToast('试听中（' + Math.round(r.bytes / 1024) + ' KB）'); }
            else showToast('合成失败：' + ((r && r.error) || '未知'));
          }).catch((e) => showToast('合成异常：' + e));
      });
      refreshVis();
      row.appendChild(selSrc); row.appendChild(fileIn); row.appendChild(engSel); row.appendChild(voiceIn);
      row.appendChild(bPick); row.appendChild(bPrev);
      return row;
    }

    function render() {
      prof = lineState.profile;
      listBox.innerHTML = '';
      if (!prof) { listBox.appendChild(el('div', 'ml-status', '载入中…')); return; }
      const arr = Array.isArray(prof[pool]) ? prof[pool] : (prof[pool] = []);
      stat.textContent = '台词档「' + lineState.profileId + '」　本池 ' + arr.length + ' 条';
      arr.forEach((entry, i) => {
        const card = el('div', 'le-card');
        const top = el('div', 'le-top');
        top.appendChild(el('span', 'le-idx', String(i + 1)));
        const cn = textIn(entry.text || '', '中文文本'); cn.style.flex = '2';
        const jp = textIn(entry.jp || '', '日文文本'); jp.style.flex = '2';
        const en = textIn(entry.en || '', '英文文本'); en.style.flex = '2';
        const emo = pickSel(EMO_LIST, (Array.isArray(entry.emo) ? entry.emo[0] : entry.emo) || 'neutral');
        emo.style.minWidth = '140px';
        const bDel = miniBtn('删除', 'del');
        cn.addEventListener('change', () => { entry.text = cn.value; commit(); });
        jp.addEventListener('change', () => { entry.jp = jp.value; commit(); });
        en.addEventListener('change', () => { entry.en = en.value; commit(); });
        emo.addEventListener('change', () => { entry.emo = [emo.value]; commit(); });
        bDel.addEventListener('click', () => {
          arr.splice(i, 1); commit(); render();
        });
        top.appendChild(cn); top.appendChild(jp); top.appendChild(en); top.appendChild(emo); top.appendChild(bDel);
        card.appendChild(top);

        if (pool === 'idle') {
          const trow = el('div', 'le-voice-row');
          trow.appendChild(el('span', 'ml-tag', '时段'));
          const timeSel = pickSel([
            { value: 'any', label: '任意（白天+夜间）' },
            { value: 'day', label: '仅白天' },
            { value: 'night', label: '仅夜间' }
          ], entry.time || 'any');
          timeSel.style.minWidth = '160px';
          timeSel.addEventListener('change', () => { entry.time = timeSel.value; commit(); });
          trow.appendChild(timeSel);
          card.appendChild(trow);
        }

        const det = document.createElement('details');
        det.className = 'le-voice';
        const sum = el('summary', null, '语音来源（中 / 日 / 英 可各不相同）');
        det.appendChild(sum);
        LANGS.forEach((lg) => det.appendChild(langRow(entry, lg)));
        card.appendChild(det);
        listBox.appendChild(card);
      });
      if (!arr.length) listBox.appendChild(el('div', 'ml-status', '这个池里还没有台词，点下方「添加台词」新增一条。'));
    }

    selPool.addEventListener('change', () => { pool = selPool.value; render(); });
    bAdd.addEventListener('click', () => {
      if (!prof) return;
      const arr = Array.isArray(prof[pool]) ? prof[pool] : (prof[pool] = []);
      const e = {
        text: '', jp: '', en: '', emo: ['neutral'],
        voice: {
          cn: { src: 'tts', engine: '', voice: '' },
          jp: { src: 'tts', engine: '', voice: '' },
          en: { src: 'tts', engine: '', voice: '' }
        }
      };
      if (pool === 'idle') e.time = 'any';
      arr.push(e); commit(); render();
    });

    box.appendChild(head);
    box.appendChild(listBox);
    box.appendChild(bAdd);
    lineState.listeners.push(render);
    render();
    return box;
  }

  function lineTextOf(entry, lang) {
    if (!entry) return '';
    if (lang === 'jp') return entry.jp || entry.text || '';
    if (lang === 'en') return entry.en || entry.text || '';
    return entry.text || '';
  }
  let previewAudio = null;
  function playDataUrl(u) { if (previewAudio) { try { previewAudio.pause(); } catch (e) {} } previewAudio = new Audio(u); previewAudio.volume = 1; previewAudio.play().catch(() => {}); }
  function playUrl(u) {
    if (previewAudio) { try { previewAudio.pause(); } catch (e) {} }
    previewAudio = new Audio(u);
    previewAudio.play().catch(() => showToast('播放失败（文件可能不存在）'));
  }

  // ========================================================================
  // R3 · 素材关联 + 触发绑定
  // ========================================================================
  const assetState = { scan: null, live: { expressions: [], motions: [] }, listeners: [] };
  function emitAssetState() {
    assetState.listeners.forEach((f) => { try { f(); } catch (e) { /* 忽略 */ } });
  }
  function loadLiveAssets(cb) {
    Promise.resolve(api.getModelAssets ? api.getModelAssets() : { expressions: [], motions: [] })
      .then((a) => {
        assetState.live = {
          expressions: (a && Array.isArray(a.expressions)) ? a.expressions : [],
          motions: (a && Array.isArray(a.motions)) ? a.motions : []
        };
        if (cb) cb();
        emitAssetState();
      }).catch(() => { if (cb) cb(); emitAssetState(); });
  }
  function loadScan(cb) {
    Promise.resolve(api.scanModelAssets ? api.scanModelAssets(CONFIG.modelUrl || '') : { ok: false })
      .then((r) => { assetState.scan = (r && r.ok) ? r : null; if (cb) cb(); emitAssetState(); })
      .catch(() => { assetState.scan = null; if (cb) cb(); emitAssetState(); });
  }

  // 素材关联：把模型目录里"没被 model3.json 引用"的动作/表情挂上去
  function makeAssetLink(item) {
    const box = el('div', 'wide-ctrl asset-link');
    const info = el('div', 'ml-status', '');
    const listBox = el('div', 'al-list');
    const bReload = miniBtn('保存并重新载入模型');
    const bRescan = miniBtn('重新扫描目录');
    const head = el('div', 'ml-row');
    head.appendChild(el('span', 'ml-lab', '模型目录'));
    head.appendChild(info); head.appendChild(bRescan); head.appendChild(bReload);

    function modelKey() { return currentModelRel(); }
    function cfgNow() {
      CONFIG.modelAssets = CONFIG.modelAssets || {};
      return CONFIG.modelAssets;
    }
    // 已配置的组名（按文件路径找）
    function groupOf(entry, file) {
      const m = (entry.motions || []).find((x) => x && x.file === file);
      return m ? (m.group || '') : '';
    }

    function render() {
      const key = modelKey();
      const all = cfgNow();
      const entry = all[key] || { motions: [], expressions: [] };
      const liveMo = assetState.live.motions.map((m) => (m.group || '') + '#' + (m.index || 0));
      const liveEx = assetState.live.expressions.map((e) => e.name);
      info.textContent = '当前模型：' + (key || '(未设置)') +
        '　·　引擎已加载：动作 ' + liveMo.length + ' / 表情 ' + liveEx.length;
      listBox.innerHTML = '';

      const sc = assetState.scan;
      if (!sc) { listBox.appendChild(el('div', 'ml-status', '正在扫描模型目录…（若长时间无结果，说明模型库目录不可读）')); return; }

      // —— 动作候选 ——
      listBox.appendChild(el('div', 'al-sec', '动作文件（*.motion3.json）：勾选并填组名后会被写进模型引用'));
      if (!sc.motions.length) listBox.appendChild(el('div', 'ml-status', '该模型目录下没有找到 .motion3.json 文件。'));
      sc.motions.forEach((mo) => {
        const row = el('div', 'al-row');
        const chk = document.createElement('input'); chk.type = 'checkbox';
        const cur = groupOf(entry, mo.file);
        chk.checked = !!cur;
        const lab = el('span', 'al-file', mo.file);
        const gIn = textIn(cur, '组名，如 idle');
        gIn.style.minWidth = '130px';
        const loopWrap = el('label', 'flip');
        const loopChk = document.createElement('input'); loopChk.type = 'checkbox';
        const existM = (entry.motions || []).find((x) => x && x.file === mo.file);
        loopChk.checked = !!(existM && existM.loop);
        loopWrap.appendChild(loopChk); loopWrap.appendChild(document.createTextNode('循环'));
        const tag = el('span', 'al-live', liveMo.indexOf((cur || gIn.value) + '#0') >= 0 ? '已加载' : '');
        function commit() {
          entry.motions = (entry.motions || []).filter((x) => x && x.file !== mo.file);
          if (chk.checked && gIn.value.trim()) {
            entry.motions.push({ group: gIn.value.trim(), file: mo.file, loop: loopChk.checked, fadeIn: 0.5, fadeOut: 0.5 });
          }
          all[key] = entry;
          save('modelAssets', all, null);
        }
        chk.addEventListener('change', commit);
        gIn.addEventListener('change', commit);
        loopChk.addEventListener('change', commit);
        row.appendChild(chk); row.appendChild(lab); row.appendChild(gIn); row.appendChild(loopWrap); row.appendChild(tag);
        listBox.appendChild(row);
      });

      // —— 表情候选（model3.json 已列出的不用加；这里给"目录里有但没被引用"的用）——
      const listed = assetState.live.expressions.map((e) => e.name);
      const extra = sc.expressions.filter((e) => listed.indexOf(e.name) < 0);
      listBox.appendChild(el('div', 'al-sec', '表情文件（*.exp3.json）：模型已引用的会自动可用，下面只列"没被引用"的'));
      if (!extra.length) listBox.appendChild(el('div', 'ml-status', '没有未引用的表情文件。'));
      extra.forEach((ex) => {
        const row = el('div', 'al-row');
        const chk = document.createElement('input'); chk.type = 'checkbox';
        const existE = (entry.expressions || []).find((x) => x && x.file === ex.file);
        chk.checked = !!existE;
        const lab = el('span', 'al-file', ex.file);
        const nameIn = textIn((existE && existE.name) || ex.name, '表情名');
        nameIn.style.minWidth = '130px';
        function commit() {
          entry.expressions = (entry.expressions || []).filter((x) => x && x.file !== ex.file);
          if (chk.checked) entry.expressions.push({ name: nameIn.value.trim() || ex.name, file: ex.file });
          all[key] = entry;
          save('modelAssets', all, null);
        }
        chk.addEventListener('change', commit);
        nameIn.addEventListener('change', commit);
        row.appendChild(chk); row.appendChild(lab); row.appendChild(nameIn);
        listBox.appendChild(row);
      });
    }

    bRescan.addEventListener('click', () => loadScan());
    // 「保存并重新载入模型」只用于"素材关联改了、但不想换模型"的场景（改完让桌宠重读注入配置）。
    // 换模型的场景不需要它：切模型本身就会让桌宠热重载，并按新模型的注入配置生效。
    bReload.addEventListener('click', () => {
      Promise.resolve(api.switchModel ? api.switchModel(CONFIG.modelUrl || '') : null)
        .then(() => { showToast('正在重新载入模型…素材清单会在载入完成后自动刷新'); setTimeout(() => loadLiveAssets(), 3000); })
        .catch(() => {});
    });
    box.appendChild(head); box.appendChild(listBox);
    assetState.listeners.push(render);
    // 换模型时：旧模型目录的扫描结果与旧模型引擎里的素材都不再成立，整批丢弃后重取。
    // 先把 scan 置空并立即 render，让列表切到「正在扫描」，避免继续显示上一个模型的文件。
    onModelChange(() => {
      assetState.scan = null;
      assetState.live = { expressions: [], motions: [] };
      render();
      loadScan();
      loadLiveAssets();
    });
    if (!assetState.scan) loadScan(); else render();
    if (!assetState.live.expressions.length && !assetState.live.motions.length) loadLiveAssets();
    return box;
  }

  // 触发绑定：每个表情/动作怎么被触发
  function makeAssetBinder(item) {
    const box = el('div', 'wide-ctrl asset-binder');
    let assets = {
      hotkeyScope: ((CONFIG.assets && CONFIG.assets.hotkeyScope) === 'global') ? 'global' : 'window',
      bindings: (CONFIG.assets && Array.isArray(CONFIG.assets.bindings)) ? JSON.parse(JSON.stringify(CONFIG.assets.bindings)) : []
    };
    const selScope = pickSel([
      { value: 'window', label: '仅桌宠窗口内（不抢系统键）' },
      { value: 'global', label: '全局（任何程序前台都响应）' }
    ], assets.hotkeyScope);
    const head = el('div', 'ml-row');
    head.appendChild(el('span', 'ml-lab', '快捷键范围'));
    head.appendChild(selScope);
    const bAdd = miniBtn('＋ 添加绑定');
    const bRefresh = miniBtn('刷新素材');
    head.appendChild(bRefresh);
    const listBox = el('div', 'ab-list');

    function commit() {
      CONFIG.assets = { hotkeyScope: assets.hotkeyScope, bindings: assets.bindings };
      Promise.resolve(api.setBindings ? api.setBindings(CONFIG.assets) : null)
        .then((r) => { if (!r || !r.ok) showToast('保存失败'); else showToast('绑定已保存'); })
        .catch(() => showToast('保存异常'));
    }

    // 目标候选：优先用引擎实际加载到的；没有则退回配置里注入的
    function targetOptions(kind) {
      const out = [];
      if (kind === 'expression') {
        assetState.live.expressions.forEach((e) => out.push({ value: e.name, label: e.name + '（表情）' }));
        if (!out.length) {
          const key = currentModelRel();
          const cfg = (CONFIG.modelAssets || {})[key] || {};
          (cfg.expressions || []).forEach((e) => out.push({ value: e.name, label: e.name + '（表情·待生效）' }));
        }
      } else {
        assetState.live.motions.forEach((m) => out.push({ value: (m.group || '') + '#' + (m.index || 0), label: (m.group || '') + ' #' + (m.index || 0) + (m.file ? '　' + m.file : '') }));
        if (!out.length) {
          const key = currentModelRel();
          const cfg = (CONFIG.modelAssets || {})[key] || {};
          (cfg.motions || []).forEach((m) => out.push({ value: m.group + '#0', label: m.group + ' #0（动作·待生效）' }));
        }
      }
      if (!out.length) out.push({ value: '', label: kind === 'expression' ? '（本模型没有可用表情）' : '（本模型没有可用动作，请先在上方关联）' });
      return out;
    }
    function lineRefOptions() {
      const p = lineState.profile;
      const out = [];
      if (!p) return out;
      ['click', 'idle'].forEach((pool) => {
        (Array.isArray(p[pool]) ? p[pool] : []).forEach((e, i) => {
          out.push({ value: pool + ':' + i, label: pool + ':' + i + '　' + String(e && e.text || '').slice(0, 18) });
        });
      });
      return out;
    }

    function render() {
      listBox.innerHTML = '';
      if (!assets.bindings.length) {
        listBox.appendChild(el('div', 'ml-status', '还没有绑定。点「＋ 添加绑定」为某个表情或动作配置触发方式。'));
        return;
      }
      assets.bindings.forEach((b, i) => {
        const card = el('div', 'ab-card');
        const r1 = el('div', 'ab-row');
        r1.appendChild(el('span', 'le-idx', String(i + 1)));
        const selKind = pickSel([{ value: 'expression', label: '表情' }, { value: 'motion', label: '动作' }], b.kind || 'expression');
        selKind.style.minWidth = '90px';
        const selTarget = pickSel(targetOptions(b.kind || 'expression'), b.kind === 'motion' ? ((b.group || '') + '#' + (b.index || 0)) : (b.target || ''));
        selTarget.style.flex = '1';
        const bPlay = miniBtn('试播');
        const bDel = miniBtn('删除', 'del');
        function syncTarget() {
          const v = selTarget.value || '';
          if ((b.kind || 'expression') === 'motion') {
            const parts = v.split('#');
            b.group = parts[0] || '';
            b.index = Number(parts[1]) || 0;
          } else { b.target = v; }
        }
        syncTarget();
        selKind.addEventListener('change', () => {
          b.kind = selKind.value;
          const opts = targetOptions(b.kind);
          selTarget.innerHTML = '';
          opts.forEach((o) => { const op = el('option', null, o.label); op.value = o.value; selTarget.appendChild(op); });
          selTarget.value = opts[0] ? opts[0].value : '';
          syncTarget(); commit();
        });
        selTarget.addEventListener('change', () => { syncTarget(); commit(); });
        bDel.addEventListener('click', () => { assets.bindings.splice(i, 1); commit(); render(); });
        bPlay.addEventListener('click', () => {
          syncTarget();
          if (!assets.bindings[i].id) assets.bindings[i].id = 'b' + Date.now();
          commit();
          Promise.resolve(api.triggerAsset ? api.triggerAsset(assets.bindings[i].id) : null)
            .then((r) => { if (!r || !r.ok) showToast('试播失败：' + ((r && r.error) || '桌宠未运行')); else showToast('已让桌宠播放'); })
            .catch(() => showToast('试播失败'));
        });
        r1.appendChild(selKind); r1.appendChild(selTarget); r1.appendChild(bPlay); r1.appendChild(bDel);
        card.appendChild(r1);

        // 触发方式
        const r2 = el('div', 'ab-row ab-triggers');
        r2.appendChild(el('span', 'ml-tag', '触发'));
        const cClick = document.createElement('label'); cClick.className = 'flip';
        const iClick = document.createElement('input'); iClick.type = 'checkbox'; iClick.checked = !!b.onClick;
        iClick.addEventListener('change', () => { b.onClick = iClick.checked; commit(); });
        cClick.appendChild(iClick); cClick.appendChild(document.createTextNode('点击模型'));
        const cIdle = document.createElement('label'); cIdle.className = 'flip';
        const iIdle = document.createElement('input'); iIdle.type = 'checkbox'; iIdle.checked = !!b.onIdle;
        iIdle.addEventListener('change', () => { b.onIdle = iIdle.checked; commit(); });
        cIdle.appendChild(iIdle); cIdle.appendChild(document.createTextNode('待机随机'));
        const hk = textIn(b.hotkey || '', '快捷键，如 Alt+1');
        hk.style.minWidth = '150px';
        hk.addEventListener('change', () => {
          b.hotkey = hk.value.trim();
          if (b.hotkey && !b.id) b.id = 'b' + Date.now();
          commit();
        });
        const onLine = pickSel(ON_LINE_OPTS, b.onLine || 'off');
        onLine.style.minWidth = '150px';
        r2.appendChild(cClick); r2.appendChild(cIdle);
        r2.appendChild(el('span', 'ml-tag', '快捷键')); r2.appendChild(hk);
        r2.appendChild(el('span', 'ml-tag', '台词')); r2.appendChild(onLine);
        card.appendChild(r2);

        const r3 = el('div', 'ab-row');
        r3.appendChild(el('span', 'ml-tag', ''));
        const bLoopWrap = el('label', 'flip');
        const iLoop = document.createElement('input'); iLoop.type = 'checkbox'; iLoop.checked = !!b.loop;
        iLoop.addEventListener('change', () => { b.loop = iLoop.checked; commit(); });
        bLoopWrap.appendChild(iLoop); bLoopWrap.appendChild(document.createTextNode('循环'));
        const holdIn = document.createElement('input');
        holdIn.type = 'number'; holdIn.min = 0; holdIn.max = 600000; holdIn.step = 500;
        holdIn.value = (b.holdMs == null) ? 4000 : b.holdMs;
        holdIn.style.width = '110px';
        holdIn.addEventListener('change', () => { b.holdMs = Number(holdIn.value) || 0; commit(); });
        r3.appendChild(bLoopWrap);
        r3.appendChild(el('span', 'ml-tag', '保持时长(ms)'));
        r3.appendChild(holdIn);
        r3.appendChild(el('span', 'ml-status', '0 = 一直保持到下次触发'));
        card.appendChild(r3);

        // 台词触发：选中具体台词
        if ((b.onLine || 'off') === 'pick') {
          const r4 = el('div', 'ab-row');
          r4.appendChild(el('span', 'ml-tag', '哪些台词'));
          const msel = document.createElement('select');
          msel.multiple = true; msel.size = 5;
          msel.style.flex = '1'; msel.style.minWidth = '260px';
          const opts = lineRefOptions();
          if (!opts.length) {
            const op = el('option', null, '（当前台词档没有台词）'); op.disabled = true; msel.appendChild(op);
          }
          opts.forEach((o) => {
            const op = el('option', null, o.label);
            op.value = o.value;
            if (Array.isArray(b.lineRefs) && b.lineRefs.indexOf(o.value) >= 0) op.selected = true;
            msel.appendChild(op);
          });
          msel.addEventListener('change', () => {
            b.lineRefs = Array.from(msel.selectedOptions).map((o) => o.value);
            commit();
          });
          r4.appendChild(msel);
          card.appendChild(r4);
        }
        onLine.addEventListener('change', () => { b.onLine = onLine.value; commit(); render(); });

        listBox.appendChild(card);
      });
    }

    selScope.addEventListener('change', () => { assets.hotkeyScope = selScope.value; commit(); });
    bAdd.addEventListener('click', () => {
      const kind = 'expression';
      const opts = targetOptions(kind);
      const b = {
        id: 'b' + Date.now(),
        kind: kind,
        target: opts[0] ? opts[0].value : '',
        holdMs: 3000,
        hotkey: '',
        onClick: false, onIdle: false,
        onLine: 'off', lineRefs: []
      };
      assets.bindings.push(b);
      commit(); render();
    });
    bRefresh.addEventListener('click', () => { loadLiveAssets(); loadScan(); });

    box.appendChild(head); box.appendChild(listBox); box.appendChild(bAdd);
    assetState.listeners.push(render);
    // 换模型后素材候选要换；换台词档后「哪些台词」多选也要换
    //（render 里会读 lineState.profile，原先没人触发重渲染，换档后那份多选还是旧的）。
    onModelChange(() => { loadLiveAssets(); render(); });
    lineState.listeners.push(render);
    if (!assetState.live.expressions.length && !assetState.live.motions.length) loadLiveAssets(render);
    render();
    return box;
  }

  // ---- 渲染 ----
  // 音律识别标签页：主开关关闭时，其下子控件（含 A/B 开关与 A 方案速度滑块）置灰不可调。
  let musicMasterCtrl = null;
  const musicSubCtrls = [];
  function setMusicSubDisabled(off) {
    musicSubCtrls.forEach((c) => {
      c.querySelectorAll('input, select, textarea, button').forEach((el) => { el.disabled = off; });
      c.classList.toggle('disabled', off);
    });
  }
  function buildUI() {
    const tabsEl = document.getElementById('tabs');
    const content = document.getElementById('content');
    // 清空（保留 banner）
    while (content.firstChild && content.firstChild !== banner) content.removeChild(content.firstChild);
    if (banner.parentNode === content) content.removeChild(banner);

    const groups = SCHEMA;
    // 标签页
    groups.forEach((g, gi) => {
      const t = document.createElement('div');
      t.className = 'tab' + (gi === 0 ? ' active' : '');
      t.textContent = g.tab;
      t.dataset.idx = gi;
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        document.querySelectorAll('.group').forEach((x) => x.style.display = (Number(x.dataset.idx) === gi) ? '' : 'none');
      });
      tabsEl.appendChild(t);
    });

    groups.forEach((g, gi) => {
      const sec = document.createElement('section');
      sec.className = 'group'; sec.dataset.idx = gi;
      if (gi !== 0) sec.style.display = 'none';
      const gt = document.createElement('div'); gt.className = 'gtitle'; gt.textContent = g.title;
      sec.appendChild(gt);
      g.items.forEach((item) => {
        const row = document.createElement('div'); row.className = 'row';
        const label = document.createElement('div'); label.className = 'label';
        label.textContent = item.label;
        if (item.reload) {
          const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '↻重启生效';
          label.appendChild(tag);
        }
        const ctrl = document.createElement('div'); ctrl.className = 'ctrl';
        ctrl.appendChild(makeCtrl(item, getByPath(CONFIG, item.key)));
        const help = document.createElement('button');
        help.className = 'help'; help.type = 'button'; help.textContent = '?';
        help.setAttribute('aria-label', '帮助：' + item.label);
        bindHelp(help, item.help);
        row.appendChild(label); row.appendChild(ctrl); row.appendChild(help);
        sec.appendChild(row);
        // 音律识别标签页：记录主开关与子控件，实现"总开关关闭时子控件置灰不可调"。
        if (g.tab === '音律识别') {
          if (item.key === 'music.enabled') musicMasterCtrl = ctrl;
          else if (item.key && item.key.indexOf('music.') === 0) musicSubCtrls.push(ctrl);
        }
        if (item.type === 'text' && (item.key.indexOf('Dir') >= 0 || item.key.indexOf('Python') >= 0 || item.key === 'acpCwd' || item.key === 'modelServeBase')) {
          const note = document.createElement('div'); note.className = 'subnote';
          note.textContent = '本机绝对路径，填错可能导致对应功能不可用。';
          sec.appendChild(note);
        }
      });
      content.appendChild(sec);
    });
    // 音律识别：按主开关初值先置灰一次；主开关变化实时同步子控件可编辑状态。
    if (musicMasterCtrl) {
      const mi = musicMasterCtrl.querySelector('input');
      if (mi) {
        setMusicSubDisabled(!mi.checked);
        mi.addEventListener('change', () => setMusicSubDisabled(!mi.checked));
      }
    }
    content.appendChild(banner);
  }

  // ---- 启动 ----
  // 主窗每次加载 / 热重载模型后会上报素材清单，主进程收到后转发到此。
  // 用它替代"等固定秒数再取一次"的猜测，保证「表情与动作」页显示的就是当前模型真正加载到的素材。
  api.on('pet:modelAssetsUpdated', (a) => {
    assetState.live = {
      expressions: (a && Array.isArray(a.expressions)) ? a.expressions : [],
      motions: (a && Array.isArray(a.motions)) ? a.motions : []
    };
    emitAssetState();
  });

  Promise.resolve(api.getConfig ? api.getConfig() : {}).then((cfg) => {
    CONFIG = cfg && typeof cfg === 'object' ? cfg : {};
    buildUI();
  }).catch(() => {
    CONFIG = {}; buildUI();
  });
})();
