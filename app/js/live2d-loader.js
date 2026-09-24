// live2d-loader.js
// 用 pixi.js + pixi-live2d-display 加载本机 Cubism 模型（Hotaru2024 / Saki 均为 .moc3，走 Cubism 3/4 运行时）。
// 依赖（由 index.html 以 UMD <script> 注入全局）：
//   window.PIXI                              (pixi.js v6，UMD 在 dist/browser/pixi.min.js)
//   window.Live2DCubismCore                  (live2dcubismcore，注意官方全局名是驼峰大写)
//   window.PIXI.live2d.Live2DModel           (pixi-live2d-display 的 cubism4 专用包)
(function () {
  'use strict';

  // live2dcubismcore 的 UMD 挂的是 window.Live2DCubismCore（驼峰），
  // 但也见过小写写法，两种都认，避免因全局名不一致而误判"依赖未就绪"。
  function cubismCore() {
    return window.Live2DCubismCore || window.live2dcubismcore || null;
  }

  function getLive2DModel() {
    const disp = window.PIXI && window.PIXI.live2d;
    return (disp && (disp.Live2DModel || disp.Cubism4Model)) || window.Live2DModel ||
      (window.PIXI_live2d_display && window.PIXI_live2d_display.Live2DModel) || null;
  }

  // 内置待机台词（当 /app/data/idle-lines.json 缺失或为空时的兜底）。
  // 人设：黑叶萤——12 岁的深海研究所调查员，称呼使用者为"前辈"。
  // 可被同路径的 JSON 覆盖；time 字段：day=白天、night=夜间(22:00–05:00)、any=任意。
  // emo 字段：情绪标签（字符串=整句同一情绪；数组=按标点分句逐句映射，使单句内情绪实时变化）。
  const DEFAULT_IDLE_LINES = [
    { time: 'day',   emo: ['sleepy', 'focus'], text: '前辈，早啊，我昨晚又对着深海录像看到后半夜，现在眼睛沉得睁不开，不过那批水温数据已经整理完了，你要不要先过一眼。' },
    { time: 'day',   emo: ['focus', 'joy'], text: '今天的洋流比预测慢了百分之三，我重新跑了模型，误差应该能压到千分之一以内，前辈尽管放心交给我就好。' },
    { time: 'day',   emo: ['curious', 'focus'], text: '啊，刚才那只小章鱼又趴在观测窗上了，它的腕足吸盘排列得整齐得过分，我就在想，如果按比例放大，能不能做出抓取更稳的机械臂。' },
    { time: 'night', emo: ['sleepy', 'affection'], text: '前辈，所里熄灯了，我也把灯调暗了，就剩屏幕这点光，你陪我说说话好不好，我有点睡不着，又不想到处乱走。' },
    { time: 'night', emo: ['curious', 'focus'], text: '夜里的深海反而更热闹，你看声呐图，那些低频脉冲，像是某种大家伙在很远的地方慢慢游过来，又慢慢沉下去。' },
    { time: 'night', emo: ['shy', 'affection'], text: '我其实有点怕黑，但一想到前辈就在附近那间屋子，就又能盯着屏幕看到天亮，是不是很奇怪。' },
    { time: 'any',   emo: ['focus', 'curious', 'joy'], text: '前辈，我算过了，按照现在的洋流速度，那群大王乌贼再过三天就会经过我们的观测点，这次我一定能拍到，真的不一样，我连机位都标好了。' },
    { time: 'any',   emo: ['curious', 'focus'], text: '章鱼真的好厉害，它们有三颗心脏，血还是蓝色的，我越研究越觉得，人类这点本事在它们面前根本不够看，怪不得我这么着迷。' },
    { time: 'any',   emo: ['shy', 'joy'], text: '前辈，你靠过来一点，我悄悄告诉你，其实我偷偷给每只常来的鱼都起了名字，那只胖胖的狮子鱼我叫它团子，那只胆小的我就叫它前辈二号。' },
    { time: 'any',   emo: ['shy', 'affection'], text: '前辈，我的黑眼圈是不是又重了，你别老盯着我看，我会不好意思的，虽然……被你盯着其实有一点开心，我不说了。' },
    { time: 'any',   emo: ['affection', 'shy'], text: '今天所长夸我了，说我比很多正式研究员都稳，但我第一个想告诉的人是你，前辈，我是不是挺没出息的，明明该高兴却先想到你。' },
    { time: 'any',   emo: ['affection', 'joy'], text: '我把观测点的光调成了你喜欢的暖色，这样你晚上路过窗边会舒服点，别问我是怎么知道的，所里的排班表我又不是没看过。' },
    { time: 'any',   emo: ['curious', 'affection'], text: '前辈，等这趟任务结束，我带你去看我最爱的那片热泉，那里像星星一颗一颗掉进了海里，我只想和你一个人一起看，谁都不叫。' }
  ];

  // —— 情绪/表情层：把每句台词的感情映射成"五官参数目标值"，逐帧缓动逼近 ——
  // 设计原则：嘴部（元音/ParamMouthOpenY）仍由 viseme 引擎负责；本层只驱动
  //   眼睛开合与眯眼、眉毛高低与形状、嘴角弧度、鼓腮/吐舌、脸红——即"拟人表情"。
  // 所有键都是"归一化旋钮"，neutral 为基线；未在预设里出现的键自动取 neutral。
  // eyeOpen 是"乘算"基线（作用于眨眼结果）：<1 半睁、>1 瞪大（上限 1.5）。
  // 参数名以本机 Hotaru2024 调试面板枚举结果为准（ParamEyeLOpen/ROpen、ParamEyeSquintL/R、
  // ParamBrowLY/RY、ParamBrowLForm/RForm、ParamEyeBallX/Y、ParamAngleXYZ、ParamCheekPuff、
  // ParamTongueOut、ParamMouthForm）。脸红参数按可选处理（见 _express 内 _hasParam 探测）。
  const EMO_KEYS = ['eyeOpen', 'eyeSquint', 'browY', 'browForm', 'mouthForm',
    'cheekPuff', 'tongueOut', 'gazeX', 'gazeY', 'angleX', 'angleY', 'angleZ', 'blush'];
  const EMO_NEUTRAL = {
    eyeOpen: 1, eyeSquint: 0, browY: 0, browForm: 0, mouthForm: 0,
    cheekPuff: 0, tongueOut: 0, gazeX: 0, gazeY: 0, angleX: 0, angleY: 0, angleZ: 0, blush: 0
  };
  const EMOTION_PRESETS = {
    neutral:   {},
    focus:     { eyeOpen: 0.80, browY: -0.38, browForm: -0.48, mouthForm: -0.12, gazeY: 0.12 },      // 工作认真：压低眉眼、更专注
    curious:   { eyeOpen: 1.32, browY: 0.72, browForm: 0.40, mouthForm: 0.24, gazeX: 0.15, gazeY: 0.15, angleZ: -6, angleY: 4 }, // 研究兴奋/好奇：瞪眼挑眉、偏头
    joy:       { eyeOpen: 0.80, eyeSquint: 0.85, browY: 0.55, browForm: 0.25, mouthForm: 0.85, angleZ: -8, blush: 0.25 },         // 开心：眯眼大笑
    sleepy:    { eyeOpen: 0.28, eyeSquint: 0.22, browY: -0.42, mouthForm: 0.10, gazeY: -0.20, angleZ: 13, angleX: 6 },           // 犯困：半闭、耷拉、低头
    affection: { eyeOpen: 0.68, eyeSquint: 0.46, browY: 0.30, browForm: 0.25, mouthForm: 0.62, gazeY: 0.22, angleZ: 9, blush: 0.85 }, // 爱慕：柔和、脸红、注视
    shy:       { eyeOpen: 0.52, eyeSquint: 0.60, browY: -0.15, browForm: 0.45, mouthForm: 0.15, gazeX: 0.85, gazeY: -0.25, angleZ: 13, blush: 1.0 }, // 害羞：躲视线、脸红到顶
    tease:     { eyeOpen: 0.80, eyeSquint: 0.92, browY: 0.72, browForm: -0.52, mouthForm: 0.72, tongueOut: 0.55, angleZ: -9 },   // 调皮：吐舌、挤眼、歪头
    serious:   { eyeOpen: 1.18, browY: -0.95, browForm: -0.72, mouthForm: -0.38, gazeY: 0.08 },      // 严肃：拧眉、紧抿
    surprise:  { eyeOpen: 1.5, browY: 1.0, browForm: 0.5, mouthForm: 0.15, gazeY: 0.18, angleZ: -5 },// 惊讶：瞪眼、猛挑眉
    pout:      { eyeOpen: 0.72, browY: -0.44, mouthForm: -0.62, cheekPuff: 1.0, angleZ: -7 },        // 鼓腮/闹别扭
    smug:      { eyeOpen: 0.76, eyeSquint: 0.72, browY: 0.48, browForm: -0.38, mouthForm: 0.72, angleZ: 8 }, // 得意
    enjoy:     { eyeOpen: 0.30, eyeSquint: 0.30, browY: 0.26, browForm: 0.20, mouthForm: 0.45, gazeY: -0.12, angleZ: 5 } // 陶醉听歌：半闭、嘴角轻扬、微歪头（音律识别专用；闭眼程度实际由 music.eyeClose 覆盖）
  };

  class Live2DController {
    constructor() {
      this.app = null;
      this.model = null;
      this.speaking = false;
      this.container = null;
      this.mouthBase = 0;
      this.idle = true; // 待机动作（呼吸 + 轻微头部摆动），由 config.json 的 idleMotion 控制

      // —— 模型位置/缩放的手动控制 ——
      this.baseScale = 1;          // _fit 计算出的基准缩放，用于限制缩放范围
      this.userTransformApplied = false; // 用户是否手动调整过（true 时 resize 不再自动居中）
      this.locked = false;         // 锁定后禁止拖动与缩放
      this.onLockChange = null;    // 锁定状态变化回调（由 app.js 注入，用于刷新"锁"按钮）
      this._dragging = false;
      this._sx = 0; this._sy = 0; this._ox = 0; this._oy = 0;
      this._LS_KEY = 'l2d-layout-v1';
      this._naturalW = 1;   // 模型原始（scale=1）宽高，加载后写入，_fit/重置以此为基准
      this._naturalH = 1;

      // —— 真人感微行为状态（路线 B：视线 / 眨眼 / 呼吸 / 随机微动作）——
      this._mouse = { x: 0, y: 0, inside: false }; // 光标相对窗口中心的归一化坐标(-1..1)，y 向下为正
      this._mouseFollow = true;                     // 鼠标追踪总开关（设置窗/托盘可关；关闭后视线不跟光标，只跟屏幕运动或回正）
      this._gazeX = 0; this._gazeY = 0;            // 平滑后的瞳孔方向
      this._paramCache = {};                       // 各参数最近一次被写入的目标值（供"额外追踪参数"叠加用）
      this._headX = 0; this._headY = 0;            // 平滑后的头部随视线的偏转
      this._gx = 0; this._gy = 0; this._gz = 0;    // 当前微动作的瞬时偏移（由调度器写入）
      this._blink = { next: 0, active: false, t: 0, phase: 'close', long: false,
                       closeDur: 90, openDur: 110, holdDur: 30 }; // 眨眼状态机
      this._wander = null;   // “走神”已移除：不再偶尔把视线/头游离到随机方向（用户要求删掉发呆转头挪开）
      this._gesture = null; this._nextGesture = 0;                // 随机微动作调度器
      this._prevFrame = 0;                                        // 帧间隔(ms)，供时间相关平滑
      this._cursorOk = false;                                     // 全局光标代理是否可用（否则退化为本地兜底）
      this._cursorTimer = null;                                   // /api/cursor 轮询定时器

      // —— 视线/头部跟随可调参数（鼠标追踪 + 屏幕运动追踪共用，二者都只产出归一化方向 tgx/tgy）——
      // smooth: 瞳孔平滑时间常数(ms)，越小越跟手、越大越平滑迟钝；
      // amplitude: 瞳孔(眼球)跟随幅度倍数，0=不转、1=原幅度、>1 更夸张；
      // headAmplitude: 头部随视线偏转的幅度倍数（内部乘到基准 8/6 度）；
      // headSmooth: 头部平滑时间常数(ms)，越小头部越跟手、越大越迟钝。
      const gc = (window.__companionConfig && window.__companionConfig.gaze) || {};
      this._gazeCfg = {
        smooth: (gc.smooth != null) ? Math.max(20, Number(gc.smooth)) : 120,
        amplitude: (gc.amplitude != null) ? Math.max(0, Number(gc.amplitude)) : 1.0,
        headAmplitude: (gc.headAmplitude != null) ? Math.max(0, Number(gc.headAmplitude)) : 1.0,
        headSmooth: (gc.headSmooth != null) ? Math.max(20, Number(gc.headSmooth)) : 220,
        // 额外追踪参数：用户自选「除眼球/头部外还要跟着视线动」的参数列表（_idle 末尾按此写入）
        extra: this._normExtra(gc.extra)
      };

      // —— 屏幕运动追踪专用的"额外牵动参数"（设置 → 屏幕追踪 页配置）——
      // 结构与 gaze.extra 相同，但只在【屏幕追踪生效】时使用（屏幕追踪启用且该列表非空时优先于 gaze.extra）。
      // 这样在屏幕追踪里想让"头向左转、身体也向左转"，只需在屏幕追踪页给 ParamBodyAngleX 加一行，
      // 而不必去改鼠标追踪用的那份列表。
      const scCfg = (window.__companionConfig && window.__companionConfig.screenTrack) || {};
      this._screenExtra = this._normExtra(scCfg.extra);

      // —— 屏幕运动追踪状态（路线 D：让模型像追鼠标一样盯住画面里移动的物体）——
      // enabled+active 时，_idle 优先以 _screenTrack.(x,y) 作为视线目标，否则退回全局光标/走神。
      // x/y 为归一化方向（右正、下正，范围 -1..1），约定与 _mouse 完全一致，故能直接复用视线/头部管道。
      this._screenTrack = { enabled: false, x: 0, y: 0, active: false };

      // —— 音律识别（BPM/节拍驱动闭眼跟拍）——
      // enabled 时 _musicTick 每帧读取追踪器算出的点头脉冲并写到 ParamAngleX，
      // 同时把眼睛压低模拟闭眼欣赏。追踪器实例由 app.js 注入（setMusicTracker）。
      this._musicEnabled = false;
      this._music = null;
      this._musicEmo = null;      // 音律识别期间的表情（'enjoy'）；null = 不接管表情。说话时让位给台词情绪
      this._musicEyeBlend = 0;    // 闭眼程度融合系数 0..1：随"是否在放歌"平滑开合，避免突变
      this._musicEyeVal = 1;     // 音律识别下缓动后的眼睛开合（1=全睁，0=全闭）；缓慢趋近设定值，不眨眼不变动
      // 音律识别**实际写进模型**的参数快照（每帧 _musicTick 更新）。调试面板靠它回答那个
      // 最关键的问题："追踪器算出来的律动，到底有没有变成模型的参数值"——光看追踪器是看不到的。
      this._musicLast = null;
      this._lastAngleXBase = 0;   // _idle 算出的头部偏转基线（yaw，转头；点头脉冲不叠加在它上面）
      this._lastAngleYBase = 0;   // _idle 算出的头部俯仰基线（pitch，低头/抬头；点头脉冲叠加其上）

      // —— 待机台词（路线 C：口型断句/C8，纯本地，不接 WorkBuddy）——
      // _talk 统一驱动口型：active 时按 mode 决定口型来源。
      //   mode='idle'  -> 逐字 + 标点停顿的文本驱动口型（C8 效果）
      //   mode='chat'  -> 沿用原有匀速正弦口型（聊天时）
      this._talk = { active: false, mode: 'idle', text: '', i: 0, t: 0, charDur: 140, peak: 0.8, vowels: null };
      this._audioOpen = 0;       // 音频驱动口型的平滑开合值（TTS 播放期间由响度驱动）
      this._chatText = '';       // 聊天回复文本（用于元音口型驱动）
      this._chatPtr = 0;         // 聊天口型当前字索引
      this._chatT = 0;           // 聊天口型帧内计时
      this._idlePool = null;                                      // 台词池（JSON 覆盖或内置兜底）
      this._idleEnabled = false;                                  // 待机台词调度开关
      this._idleTimer = null;                                     // 下一条待机台词的 setTimeout 句柄
      this._idleGapMin = 14000;                                   // 两条台词最小间隔(ms)
      this._idleGapMax = 38000;                                   // 两条台词最大间隔(ms)
      this.onIdleLine = null;                                     // 台词播放回调（由 app.js 注入，显示气泡）
      this._clickPool = null;                                     // 点击模型专用的交互台词池
      this._idleQueue = null;                                     // 待机台词洗牌队列（一轮内每条都出现才重建，避免重复）
      this._idleQueueSig = '';                                    // 队列对应时段标记（白天/夜间切换时重建）
      this._clickQueue = null;                                    // 点击台词洗牌队列（同上）
      this.onModelClick = null;
      this.onPickLine = null;                                    // 台词被选中回调(pool,idx,entry)，由 app.js 注入（中日切换/预生成播放在此接管）                                   // 点击模型回调（由 app.js 注入）

      // —— 元音口型（对照口型）状态 ——
      // _vowelParam：探测后写入每个元音真实对应的参数名（如 ParamA / ParamMouthA），
      //   空串表示该元音模型未提供。_silenceParam：VTS 的 Silence 参数（默认 1，说话时置 0）。
      this._vowelParam = { a: '', i: '', u: '', e: '', o: '' };
      this._silenceParam = '';
      this._visemeMode = false;                                  // 五个元音参数齐全才走精确对照
      this._visemeDebug = null;                                  // 每次说话的诊断采样状态（无 UI 排查用）
      this._dbgTalksLeft = 3;                                     // 诊断采样仅在前几次说话触发，避免长期运行刷屏
      this._visemeStats = null;                                   // 每条待机台词的元音分布统计，播完发一次整句小结
      this._chatVowels = null;                                   // 聊天文本预取的元音数组（异步拼音结果）
      this._activeVowel = null;                                  // 当前帧正在驱动的元音（one-hot 跟踪，诊断用）

      // —— 元音口型调试开关（可经托盘菜单实时切换，用于定位"写了参数但嘴型不变形"的根因）——
      // 模型里同时存在 ParamA..O / ParamMouthA..O / MouthA..O / VowelA..O / ParamVowelA..O 五族元音参数，
      // 但真正驱动"可见嘴型"的往往只有其中一族（且与 VTS 里配置的未必同名）。_vowelFamily 指定用哪一族，
      // 'auto' 时按优先级自动选第一族齐全的。driveOpenY 控制元音模式下是否额外驱动 ParamMouthOpenY（张合包络）；
      // 若该参数与元音参数叠加导致"只张嘴、不出形状"，关掉它即可。silenceSpeaking 为说话时应写入的 Silence 值
      // （默认 0=口型接管；若模型极性相反则切到 1）。
      this.config = (typeof window !== 'undefined' && window.__companionConfig) ? window.__companionConfig : null;
      this._vowelFamily = 'auto';
      this._availableFamilies = [];
      this._driveOpenY = true;
      this._silenceSpeaking = 0;
      // 参数调试面板：开启时由 setDebugMode 按 ~10Hz 上报全部参数快照到独立调试窗口
      this._debugMode = false;
      this._debugTimer = null;
      this._dbgSeq = 0;        // 快照序号（面板据此判断链路是否活着）
      this._dbgWarned = false; // 枚举方式/失败原因只往 app.log 打一次，避免刷屏

      // —— 情绪/表情层状态 ——
      // _emoCur：当前平滑后的旋钮值（每帧缓动逼近目标）；_emoTarget：目标情绪名。
      // _eyeOpenBase：本帧眨眼/睁眼系统算出的原始眼开合（供情绪层乘算，避免与眨眼互踩）。
      // _emotionEnabled：总开关（托盘可切；config.emotionEnabled=false 时默认关闭）。
      this._emoCur = Object.assign({}, EMO_NEUTRAL);
      this._emoTarget = 'neutral';
      this._eyeOpenBase = 1;
      this._emoLinger = '';                     // 刚播完的情绪名（短暂保持，避免立刻回到呆脸）
      this._emoLingerUntil = 0;
      this._paramSet = null;                    // 参数名集合缓存（探测可选参数用，如脸红）
      this._emotionEnabled = !(this.config && this.config.emotionEnabled === false);

      // —— 模型自带表情 / 动作（R3）——
      // 模型表情是"直接写参数并保持"，与情绪层每帧写五官会打架；模型动作同样会与
      // 参数合成的待机动作（呼吸/摆头）叠加。故播放期间用两个"保持窗口"挂起对应系统：
      //   _exprHoldUntil   此期间 _express 不写五官（让模型表情不被立刻覆盖）
      //   _motionHoldUntil 此期间 _idle 不写躯干/头部/额外参数（让模型动作独占）
      this._exprHoldUntil = 0;
      this._motionHoldUntil = 0;
      this._motionLoopStop = null;              // 循环动作到期后需要停掉（否则会一直循环）
      this._assets = { expressions: [], motions: [] };
      this.onAssetEvent = null;                 // 播放回调（由 app.js 注入，用于把动作名显示到气泡/日志）
    }

    ready() {
      return !!(window.PIXI && getLive2DModel() && cubismCore());
    }

    // 诊断用：把到底缺哪一项说明白，而不是笼统说"依赖未就绪"。
    diagnose() {
      const miss = [];
      if (!window.PIXI) miss.push('pixi.js（/node_modules/pixi.js/dist/browser/pixi.min.js）');
      if (!getLive2DModel()) miss.push('pixi-live2d-display（/node_modules/pixi-live2d-display/dist/cubism4.min.js）');
      if (!cubismCore()) miss.push('live2dcubismcore（app/vendor/live2dcubismcore.min.js）');
      return miss;
    }

    async load(container, modelUrl) {
      this.container = container;
      const PIXI = window.PIXI;
      const Live2DModel = getLive2DModel();
      if (!PIXI || !Live2DModel) {
        throw new Error('Live2D 依赖未加载，缺少：' + this.diagnose().join('、'));
      }

      this.app = new PIXI.Application({
        backgroundAlpha: 0, // 透明
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        width: container.clientWidth || 360,
        height: container.clientHeight || 360
      });
      container.innerHTML = '';
      container.appendChild(this.app.view);

      const model = await Live2DModel.from(modelUrl, { autoInteract: false });
      this.model = model;
      // —— 关闭模型内置眨眼（重要，是"闭眼不生效"的根因） ——
      // model3.json 顶层有 EyeBlink 组（Ids = ParamEyeLOpen/ROpen），而 FileReferences.Motions
      // 不存在（没有任何动作在播）。pixi-live2d 的 InternalModel.update() 里：
      //   const motionUpdated = motionManager.update(...);      // 无动作 → 恒 false
      //   if (!motionUpdated) { eyeBlink?.updateParameters(model, dt); }   // ← 于是每帧都执行
      // 内置眨眼每帧覆盖 ParamEyeLOpen/ROpen，且它挂在 Ticker.shared 上（晚于我们的 app.ticker），
      // 把我们自己写的眼睛值（闭眼/眨眼/情绪）全部吃掉。头部/身体之所以没被吃掉，是因为 updateFocus
      // 用的是 addParameterValueById（累加）而非覆盖。关掉内置眨眼，眼睛完全交给本文件的
      // _blinkUpdate（眨眼）与 _musicTick / 情绪层（闭眼、陶醉），两者才能真正生效。
      try {
        const im = model && model.internalModel;
        if (im && im.eyeBlink) { im.eyeBlink = null; }
      } catch (e) {}
      this.app.stage.addChild(model);
      // 记录模型原始尺寸（scale=1 时的尺寸）。后续 _fit / 重置都以此为准，
      // 否则 _fit 会读取"已被缩放过的" this.model.height，导致每次重置的大小
      // 都取决于当前缩放状态（这就是"点两次重置结果不同"的根因）。
      this._naturalW = model.width / model.scale.x;
      this._naturalH = model.height / model.scale.y;
      this._fit();
      this._initVisemeMode();   // 探测模型是否带 VTS 元音口型五元参数（驱动对照口型）

      // 若此前保存过用户布局（缩放/位置/锁定），则覆盖默认居中
      const L = this._loadLayout();
      if (L) {
        this._applyTransformRaw(L.scale, L.x, L.y);
        this._setLocked(!!L.locked, true);
        this.userTransformApplied = true;
      }

      // 鼠标拖动模型（移动其位置）；滚轮缩放（以光标为锚点）
      const view = this.app.view;
      view.style.touchAction = 'none';
      view.addEventListener('pointerdown', (e) => this._onDown(e));
      view.addEventListener('pointermove', (e) => this._onMove(e));
      // 存起来以便换模型热重载时摘掉：这个监听挂在 window 上，不会随画布一起销毁，
      // 不摘就会每换一次模型多留一份（多个旧实例同时处理 pointerup）。
      if (!this._winUp) this._winUp = (e) => this._onUp(e);
      window.addEventListener('pointerup', this._winUp);
      view.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

      // 点击模型触发台词（便于测试，无需等待随机待机）：用独立监听判定"点击而非拖动"，
      // 与拖动逻辑解耦，锁定状态下点击同样能触发。
      this._downX = null; this._downY = null; this._moved = false;
      view.addEventListener('pointerdown', (e) => { this._downX = e.clientX; this._downY = e.clientY; this._moved = false; });
      view.addEventListener('pointermove', (e) => {
        if (this._downX != null && (Math.abs(e.clientX - this._downX) > 4 || Math.abs(e.clientY - this._downY) > 4)) this._moved = true;
      });
      view.addEventListener('pointerup', () => {
        if (!this._moved) this._onModelClick();
        this._downX = null;
      });

      // 说明：这里**不**手动调用 model.update()。pixi-live2d-display 默认
      // autoUpdate: true，会自己挂到 ticker 上推进物理与动作；再手动调一次会重复推进
      // （而且它的 dt 单位与 pixi ticker 的 deltaTime 并不一致）。此处只负责写参数。
      const t0 = Date.now();
      this._prevFrame = performance.now();
      // 全局视线跟随：由主进程 /api/cursor 提供「跨所有显示器」的光标方向，轮询 ~30Hz。
      // 本地 pointermove 仅作兜底（代理不可用时退化为只看窗口内光标）。
      const viewEl = this.app.view;
      viewEl.addEventListener('pointermove', (e) => { if (!this._cursorOk) this._updateMouse(e); });
      this._cursorTimer = setInterval(() => this._pollCursor(), 33);

      this.app.ticker.add(() => {
        const now = performance.now();
        const dt = now - this._prevFrame; this._prevFrame = now;
        const t = (now - t0) / 1000;
        this._assetExpire(now);   // 模型表情/动作保持窗口到期处理（循环动作到期即停）
        // 模型自带动作播放期间挂起"参数合成的待机动作"（呼吸/摆头/头部偏转），
        // 否则两套驱动会同时写同一批参数，观感是抽搐；二者取其一，动作优先。
        if (this.idle && now >= this._motionHoldUntil) this._idle(t, dt);
        this._mouth(dt);
        this._blinkUpdate(dt);
        this._express(dt);   // 情绪/表情层：缓动逼近目标情绪并写五官参数（在眨眼之后，乘算眼开合）
        this._musicTick(dt); // 音律识别：节拍脉冲驱动下点头 + 闭眼（覆盖在表情层之后，确保闭眼生效）
      });

      // 枚举本模型自带的表情 / 动作并上报主进程，供设置页「表情与动作」分页配置触发器。
      // 必须在模型加载完成后做：动作定义由 pixi-live2d-display 解析 model3.json 后才有。
      try { this.refreshModelAssets(); } catch (e) {}

      return model;
    }

    // pixi-live2d-display 的 Live2DModel 上没有 setParamValue / getParamValue，
    // 必须走 internalModel.coreModel 的 Cubism 原生接口。
    // 旧代码用 typeof === 'function' 做了保护，结果只是静默不生效（口型不动）。
    _core() {
      const m = this.model;
      return (m && m.internalModel && m.internalModel.coreModel) || null;
    }

    _setParam(id, v) {
      this._paramCache[id] = v;   // 记下目标值，供"额外追踪参数"在基础管线之后叠加（如身体随视线转时不丢失呼吸）
      const core = this._core();
      if (core && typeof core.setParameterValueById === 'function') { core.setParameterValueById(id, v); return true; }
      const m = this.model;
      if (m && typeof m.setParamValue === 'function') { m.setParamValue(id, v); return true; }
      return false;
    }

    _getParam(id) {
      const core = this._core();
      if (core && typeof core.getParameterValueById === 'function') return core.getParameterValueById(id) || 0;
      const m = this.model;
      if (m && typeof m.getParamValue === 'function') return m.getParamValue(id) || 0;
      return 0;
    }

    // —— 参数枚举：解析"参数访问器"（名称 + 当前值 + 范围 + 默认值）——
    // 已核实本项目 core = pixi-live2d-display@0.4.0 的 CubismModel（由 cubism4.min.js 注册）：
    //   getParameterCount() / getParameterValueByIndex(i) / getParameterValueById(id)
    //   getParameterMinimumValue(i) / getParameterMaximumValue(i) / getParameterDefaultValue(i)
    //   getModel() -> 原生 Live2DCubismCore.Model
    // 它【没有】getParameterIds()，也【没有】getParameterId(index)——早期实现正是用了这两个
    // 不存在的方法，ids 恒为空数组，调试面板一条快照都发不出去（"尚未收到参数快照"的真因）。
    // 参数名与范围在原生内核里：Model.parameters.ids 是 Array<string>，
    // values / minimumValues / maximumValues / defaultValues 是与 ids 同序的 Float32Array。
    _paramIdToString(x, i) {
      if (typeof x === 'string') return x;
      if (x == null) return '#' + i;
      try { if (typeof x.getString === 'function') { const s = x.getString(); if (typeof s === 'string') return s; } } catch (e) {}
      if (typeof x.s === 'string') return x.s;
      if (typeof x.id === 'string') return x.id;
      try { const s = String(x); if (s && s !== '[object Object]') return s; } catch (e) {}
      return '#' + i;   // 兜底：拿不到名字时用序号，至少保证行不丢
    }

    // 解析参数访问器：read(i) -> { v, mn, mx, df }。全部路径都不可用时返回 null。
    _resolveParamAccessor() {
      const core = this._core();
      if (!core) return null;
      const num = (x, dft) => ((typeof x === 'number' && !isNaN(x)) ? x : dft);
      // A) 首选：原生内核 Model.parameters——一次拿到全部名称/值/范围/默认值
      let raw = null;
      try { if (typeof core.getModel === 'function') raw = core.getModel(); } catch (e) {}
      if (!raw) raw = core._model || null;
      const p = raw && raw.parameters;
      if (p && p.ids && typeof p.ids.length === 'number' && p.ids.length > 0) {
        const ids = [];
        for (let i = 0; i < p.ids.length; i++) ids.push(this._paramIdToString(p.ids[i], i));
        return {
          mode: 'core.getModel().parameters',
          count: ids.length,
          ids: ids,
          read: (i) => ({
            v: num(p.values && p.values[i], 0),
            mn: num(p.minimumValues && p.minimumValues[i], 0),
            mx: num(p.maximumValues && p.maximumValues[i], 1),
            df: num(p.defaultValues && p.defaultValues[i], 0)
          })
        };
      }
      // B) 次选：框架按索引接口（拿不到参数名，用 #序号 占位，但值/范围仍可实时看到）
      if (typeof core.getParameterCount === 'function') {
        let n = 0;
        try { n = core.getParameterCount() || 0; } catch (e) { n = 0; }
        if (n > 0) {
          const ids = [];
          for (let i = 0; i < n; i++) ids.push('#' + i);
          const call = (fn, i, dft) => {
            if (typeof core[fn] !== 'function') return dft;
            try { return num(core[fn](i), dft); } catch (e) { return dft; }
          };
          return {
            mode: 'CubismModel.getParameterCount+ByIndex',
            count: n,
            ids: ids,
            read: (i) => ({
              v: call('getParameterValueByIndex', i, 0),
              mn: call('getParameterMinimumValue', i, 0),
              mx: call('getParameterMaximumValue', i, 1),
              df: call('getParameterDefaultValue', i, 0)
            })
          };
        }
      }
      // C) 兜底：极老版本可能直接给出字符串 ID 数组
      if (typeof core.getParameterIds === 'function') {
        try {
          const r = core.getParameterIds();
          if (Array.isArray(r) && r.length) {
            const ids = r.map((x, i) => this._paramIdToString(x, i));
            return {
              mode: 'getParameterIds',
              count: ids.length,
              ids: ids,
              read: (i) => ({ v: this._getParam(ids[i]), mn: 0, mx: 1, df: 0 })
            };
          }
        } catch (e) {}
      }
      return null;
    }

    // 枚举模型全部参数 ID（字符串数组，按模型声明顺序）。拿不到返回 []，由调用方决定兜底策略。
    _getAllParamIds() {
      const acc = this._resolveParamAccessor();
      return (acc && acc.ids) ? acc.ids.slice() : [];
    }

    // 对外公开：app.js 在模型加载后用它将本模型真实参数列表上报主进程，
    // 供设置窗「额外追踪参数」下拉枚举（而不是只列几个写死的猜测名）。
    getAllParamIds() { return this._getAllParamIds(); }

  // 待机动作：Hotaru2024 的 model3.json 里没有 Motions 段（VTube Studio 是另行驱动
    // idle.motion3.json 的），所以这里用标准参数合成"呼吸 + 轻微头部摆动"，
    // 否则模型就是一张静止立绘。幅度刻意压小，避免抢眼。
    // 待机微行为（路线 B）：视线跟随 + 随机眨眼 + 躯干呼吸 + 随机微动作。
    // 不再用手搓整体正弦摆动（那会显得像不倒翁），改为“注视驱动的头部 + 偶发小动作 + 胸口呼吸”。
    _idle(t, dt) {
      const now = performance.now();
      const G = this._gazeCfg;
      const sm = Math.min(1, dt / Math.max(20, G.smooth));          // 瞳孔平滑系数（时间常数 = gaze.smooth）
      const hsm = Math.min(1, dt / Math.max(20, G.headSmooth));     // 头部平滑系数（时间常数 = gaze.headSmooth）

      // —— 视线目标：仅跟随屏幕运动 / 全局光标 / 回正，不再“走神”游离（发呆转头已移除）——
      let tgx, tgy;
      if (this._screenTrack.enabled && this._screenTrack.active) {  // 屏幕运动追踪：盯住画面里移动的物体
        tgx = this._screenTrack.x; tgy = this._screenTrack.y;
      } else if (this._mouseFollow) {            // 鼠标追踪开启：朝全局光标方向看（跨所有显示器，含外接屏）
        tgx = this._mouse.x; tgy = this._mouse.y;
      } else {                                   // 鼠标追踪关闭且无屏幕运动：视线回正（朝前）
        tgx = 0; tgy = 0;
      }

      // —— 瞳孔平滑跟随（活物感最强的单一信号）——
      this._gazeX += (tgx - this._gazeX) * sm;
      this._gazeY += (tgy - this._gazeY) * sm;
      // 叠加情绪层给出的视线偏置（害羞躲闪等）；emotion 关闭时 _emoCur 恒为 neutral，偏置为 0
      this._setParam('ParamEyeBallX', this._gazeX * G.amplitude + this._emoCur.gazeX);
      this._setParam('ParamEyeBallY', -this._gazeY * G.amplitude + this._emoCur.gazeY); // 翻正：光标在下→瞳孔朝下（按该模型 rig 约定）

      // —— 头部随视线轻微偏转（幅度受 gaze.headAmplitude 控制）——
      this._headX += (tgx * 8 * G.headAmplitude - this._headX) * hsm;
      this._headY += (-tgy * 6 * G.headAmplitude - this._headY) * hsm;

      // —— 呼吸只动躯干（胸口起伏），不再整体晃 ——
      const breath = 0.5 + 0.5 * Math.sin(t * 1.4);
      this._setParam('ParamBreath', breath);
      this._setParam('ParamBodyAngleX', (breath - 0.5) * 1.2);

      // —— 随机微动作调度器：每 8–20s 触发一次小幅头歪/抬头/摆头 ——
      this._gestureUpdate(now);

      // 合成最终头部角度 = 注视偏转 + 微动作偏移 + 极轻微基线呼吸摆动
      // 合成最终头部角度 = 注视偏转 + 微动作偏移 + 情绪层偏置（犯困歪头/害羞低头等）
      const az = this._gz + 0.6 * Math.sin(t * 0.5) + this._emoCur.angleZ;
      this._lastAngleXBase = this._headX + this._gx + this._emoCur.angleX;
      this._lastAngleYBase = this._headY + this._gy + this._emoCur.angleY;
      this._setParam('ParamAngleX', this._lastAngleXBase);
      this._setParam('ParamAngleY', this._lastAngleYBase);
      this._setParam('ParamAngleZ', az);

      // —— 额外追踪参数：除默认的眼球(XY)/头部(XY)外，用户自选的其它参数也跟随同一视线方向动 ——
      // 例如选 ParamBodyAngleX 让"身体随头转"（头向左时身体也向左）；ParamAngleZ 让歪头也跟视线。
      // base 取平滑后的视线方向（_gazeX/_gazeY，范围 -1..1），乘以每参数独立的"抓眼/幅度" amp；
      // 视线回正时这些参数自然归零。flip 用于需要反向的参数（如眼球 Y）。
      // 叠加而非硬覆盖：若该参数本就由基础管线每帧写入（呼吸/头部），则在其基础上加偏移，
      // 这样"身体随头转"不会吃掉呼吸摆动；非基础参数则直接设定（不会逐帧累加）。
      const BASE_GAZE_PARAMS = ['ParamEyeBallX', 'ParamEyeBallY', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBreath'];
      // 列表选择：屏幕追踪正在生效时，优先用「屏幕追踪」页自己的列表（_screenExtra）；
      // 否则用「视线跟随」页的通用列表（gaze.extra）。两份互不干扰。
      const screenModeOn = this._screenTrack.enabled && this._screenTrack.active;
      const ex = (screenModeOn && this._screenExtra && this._screenExtra.length)
        ? this._screenExtra : this._gazeCfg.extra;
      if (ex && ex.length) {
        for (let bi = 0; bi < ex.length; bi++) {
          const b = ex[bi];
          if (!b || !b.id || !this._hasParam(b.id)) continue;
          const base = (b.axis === 'y') ? this._gazeY : this._gazeX;
          let val = (b.flip ? -base : base) * (b.amp != null ? b.amp : 1);
          if (BASE_GAZE_PARAMS.indexOf(b.id) >= 0) val += (this._paramCache[b.id] || 0);
          this._setParam(b.id, val);
        }
      }
    }

    _updateMouse(e) {
      if (!this.container) return;
      const r = this.container.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const nx = (e.clientX - r.left) / r.width;
      const ny = (e.clientY - r.top) / r.height;
      this._mouse.x = Math.max(-1, Math.min(1, (nx - 0.5) * 2));
      this._mouse.y = Math.max(-1, Math.min(1, (ny - 0.5) * 2));
      this._mouse.inside = (e.clientX >= r.left && e.clientX <= r.right &&
                            e.clientY >= r.top && e.clientY <= r.bottom);
    }

    // 全局光标方向（跨所有显示器）：由主进程 /api/cursor 提供归一化向量，轮询 ~30Hz。
    _pollCursor() {
      fetch('/api/cursor').then((r) => r.json()).then((d) => {
        this._cursorOk = true;
        if (typeof d.dx === 'number') this._mouse.x = d.dx;
        if (typeof d.dy === 'number') this._mouse.y = d.dy;
        this._mouse.inside = !!d.inside;
      }).catch(() => { /* 代理暂不可用，继续用本地 pointermove 兜底 */ });
    }

    // 供 UI（输入框抽屉收起）判断光标是否在宠物窗口内
    isCursorOverWindow() { return !!this._mouse.inside; }

    // 鼠标追踪总开关：false 时 _idle 不再把视线指向光标（只跟屏幕运动或回正）
    setMouseFollow(on) { this._mouseFollow = !!on; }

    // 视线/头部跟随参数实时调整（鼠标追踪 + 屏幕运动追踪共用）。设置窗经 pet:setGazeCfg 下发。
    setGazeCfg(cfg) {
      if (!cfg || typeof cfg !== 'object') return;
      if (cfg.smooth != null) this._gazeCfg.smooth = Math.max(20, Number(cfg.smooth));
      if (cfg.amplitude != null) this._gazeCfg.amplitude = Math.max(0, Number(cfg.amplitude));
      if (cfg.headAmplitude != null) this._gazeCfg.headAmplitude = Math.max(0, Number(cfg.headAmplitude));
      if (cfg.headSmooth != null) this._gazeCfg.headSmooth = Math.max(20, Number(cfg.headSmooth));
      if (cfg.extra != null) this._gazeCfg.extra = this._normExtra(cfg.extra);
    }

    // 屏幕追踪专用额外牵动参数（设置 → 屏幕追踪 页）：实时更新；空数组 = 不额外牵动。
    setScreenExtra(arr) { this._screenExtra = this._normExtra(arr); }

    // 归一化「额外追踪参数」列表：只保留 {id, axis, amp, flip}，字段缺失/类型异常时给安全默认，
    // 避免设置窗传入脏数据导致 _idle 每帧抛错。
    _normExtra(arr) {
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        if (!b || typeof b !== 'object' || !b.id) continue;
        const amp = Number(b.amp);
        out.push({
          id: String(b.id),
          axis: (b.axis === 'y') ? 'y' : 'x',
          amp: isFinite(amp) ? amp : 1,
          flip: !!b.flip
        });
      }
      return out;
    }

    // —— 屏幕运动追踪：渲染进程屏幕帧差检测出的"运动物体质心"映射成的归一化方向，喂给视线管道 ——
    // enabled+active 时 _idle 优先看这个；关闭或画面静止(active=false)时退回全局光标/走神。
    setScreenTrackEnabled(on) {
      this._screenTrack.enabled = !!on;
      if (!on) { this._screenTrack.active = false; this._screenTrack.x = 0; this._screenTrack.y = 0; }
    }
    // nx,ny 归一化方向（右正、下正，-1..1）；active=false 时视线解除追踪（平滑退回光标）。
    setScreenTarget(nx, ny, active) {
      this._screenTrack.x = Math.max(-1, Math.min(1, nx));
      this._screenTrack.y = Math.max(-1, Math.min(1, ny));
      this._screenTrack.active = !!active;
    }

    // —— 音律识别：追踪器实例由 app.js 注入；enabled 时由 _musicTick 驱动闭眼跟拍 ——
    setMusicTracker(t) { this._music = t || null; }
    setMusicEnabled(on) {
      this._musicEnabled = !!on;
      // 表情层交给情绪系统（enjoy = 半闭+微笑+微歪头），由 _express 用 240ms 缓动平滑过渡，
      // 比每帧硬写五官自然得多；关闭时置空 → 平滑回到 neutral。
      this._musicEmo = on ? 'enjoy' : null;
      if (!on) {
        // 关闭时把只由音乐层驱动的 ParamBodyAngleZ 归零：该参数没有其它系统接管，
        // _musicTick 一停就没人再写它，身体会僵在最后一次摆动的角度。
        this._setParam('ParamBodyAngleZ', 0);
        this._musicEyeBlend = 0;
        this._musicLast = null;   // 关掉后不再对外报"实际写入值"，免得调试面板显示过期数据
      }
      if (this._music) { if (on) this._music.start(); else this._music.stop(); }
      if (window.desktopPet && window.desktopPet.log) {
        window.desktopPet.log('[music] 音律识别=' + (this._musicEnabled ? 'on' : 'off'));
      }
    }

    // 每帧（在表情层 _express 之后调用）：把"连续律动"+"每拍重音"叠加写到头部俯仰与身体侧摆，
    // 并把眼睛压低（闭眼）。
    //
    // 为什么要分两层（这是"听得见音乐却只是偶尔抽一下"的根因）：
    //   只保留"每拍一次性点头"时，动作**完全由起音触发**。起音检测在响度压缩得厉害的歌上
    //   只会零星触发几次，于是观感就是"偶尔抽动一下"——没有连贯的晃动。
    //   此前把那版自由正弦一刀切掉，是因为它在快歌下频率过高被读成抽搐；
    //   真正的解法不是"取消连续律动"，而是**连续量小幅 + 重音单独加大**：
    //     · 连续项 swing 由追踪器按当前速度（A 方案 aSpeed / B 方案锁定 BPM）连续推进相位得到，
    //       慢速平滑，是"连贯地晃动"的主体；
    //     · 重音项 nodEnv / nodSway 仍是每拍一次性的完整包络，只负责在鼓点上补一脚。
    //   这样既不会在快歌下变成高频抖动（连续项系数小、且速度被 maxTempo 折半限制），
    //   也不会在起音稀疏时整段静止。
    // 轴约定（重要）：ParamAngleX = 偏航(yaw) = 左右转头；ParamAngleY = 俯仰(pitch) = 低头/抬头。
    // 所以"点头"必须叠加在 ParamAngleY 上，ParamAngleX 保持视线基线（转头不被点头干扰）。
    // 闭眼：眼开合 = (1 - eyeClose) * 眨眼基线；eyeClose 越大越闭（0.8 ≈ 只留一条缝）。
    _musicTick(dt) {
      if (!this._musicEnabled || !this._music) return;
      const M = this._music;
      const level = M.getLevel();                                   // A：相对响度 0..1（= 律动幅度；静音→0）
      const swing = M.getSwing ? M.getSwing() : 0;                  // 连续律动 -1..1（按当前速度推进相位；拍点≈+1）
      const nodEnv = M.getNodEnv ? M.getNodEnv() : 0;               // 序列化点头包络 0..1（neutral→低头→neutral 单峰）
      const nodSway = M.getNodSway ? M.getNodSway() : 0;            // 序列化身体摆动 -1..1（一次点头内左右摆一个来回）
      const peak = M.getPeak ? M.getPeak() : 0;                     // 重拍脉冲 0..1
      const nodStrength = M.getNodStrength();                       // 头部起伏幅度 0..3
      const swayStrength = M.getSwayStrength ? M.getSwayStrength() : 1; // 身体摆动幅度 0..3
      const eyeClose = M.getEyeClose();
      const playing = M.isPlaying ? M.isPlaying() : false;

      // 幅度随响度：歌响→晃得明显，歌轻→轻轻晃，静音→彻底停下（不会空摆）
      const amp = Math.max(0, Math.min(1, level));

      // —— 头部俯仰：连续正弦(小,底) + 每拍一次性点头(大,重音) ——
      // 负向 ParamAngleY = 低头（实测）。连续项 2.0 只是让头不至于在拍与拍之间僵住；
      // 重音项 5.0 才是"跟着鼓点点头"的本体。
      const headCont = -swing * nodStrength * 2.0 * amp;
      const headAccent = -nodEnv * nodStrength * 5.0 * amp;
      const bob = headCont + headAccent;
      this._setParam('ParamAngleX', this._lastAngleXBase || 0);     // 转头保持视线基线，律动不加给 yaw
      this._setParam('ParamAngleY', (this._lastAngleYBase || 0) + bob);

      // —— 身体左右摆：连续正弦为主体（"连贯地晃动"），每拍再补一次重音 ——
      // 用 ParamBodyAngleZ：该参数空闲；ParamBodyAngleX 已被呼吸占用，不能抢。
      const bodyCont = swing * swayStrength * 4.0 * amp;
      const bodyAccent = nodSway * swayStrength * 1.5 * amp;
      const sway = bodyCont + bodyAccent;
      this._setParam('ParamBodyAngleZ', sway);

      // —— 眼睛：检测到音乐时缓慢固定到设定开合、绝不眨眼也绝不随拍变动；没声音时缓缓睁开回到常态 ——
      // 1) 融合系数：随"是否在放歌"平滑开合（避免突变）
      const tgt = playing ? 1 : 0;
      this._musicEyeBlend = (this._musicEyeBlend == null ? tgt
        : this._musicEyeBlend + (tgt - this._musicEyeBlend) * Math.min(1, dt / 400));
      // 2) 目标开合：放歌 = (1 - eyeClose) 即按设定闭眼；没放歌 = 全睁（恢复之前的状态）
      const eyeTarget = playing ? Math.max(0, Math.min(1, 1 - eyeClose)) : 1;
      // 缓慢缓动到目标值（"缓慢固定" / "缓缓睁开"），约 700ms 时间常数
      this._musicEyeVal = (this._musicEyeVal == null ? eyeTarget
        : this._musicEyeVal + (eyeTarget - this._musicEyeVal) * Math.min(1, dt / 700));
      // 3) 音乐眼接管期间（blend 明显 > 0）：眼睛完全由本值驱动，固定不动、不眨眼；
      //    blend 趋近 0 时停止写眼，交还给正常眨眼/情绪系统（眼睛已缓动回睁，无突变）。
      const eyeWritten = this._musicEyeBlend > 0.02;
      if (eyeWritten) {
        const eo = this._musicEyeVal;
        this._setParam('ParamEyeLOpen', eo);
        this._setParam('ParamEyeROpen', eo);
        this._eyeOpenBase = 1;   // 眨眼基线保持全睁，确保底层眨眼波形不会从下面把眼睛重新打开/抽动
      }

      // 快照本帧**真正写进模型**的值，供"音律识别调试"面板核对（见 getMusicDebug）。
      this._musicLast = {
        amp: amp, swing: swing, nodEnv: nodEnv, nodSway: nodSway, peak: peak,
        headCont: headCont, headAccent: headAccent, bob: bob,
        bodyCont: bodyCont, bodyAccent: bodyAccent, sway: sway,
        angleX: this._lastAngleXBase || 0,
        angleY: (this._lastAngleYBase || 0) + bob,
        bodyZ: sway,
        eyeClose: eyeClose, eyeBlend: this._musicEyeBlend || 0, eyeVal: this._musicEyeVal,
        eyeWritten: eyeWritten, playing: playing,
        nodStrength: nodStrength, swayStrength: swayStrength
      };
    }

    // 音律识别调试面板用：返回最近一帧 _musicTick 实际写入模型的参数值（未运行时为 null）。
    getMusicDebug() { return this._musicLast; }

    // 随机微动作：被触发后在 dur 内以 sin 包络(0→1→0)平滑施加一次小幅度姿态偏移
    _gestureUpdate(now) {
      if (!this._gesture) {
        if (this._nextGesture === 0) this._nextGesture = now + this._rand(8000, 20000);
        if (now >= this._nextGesture) {
          this._gesture = this._pickGesture();
          this._gesture.start = now;
        }
        this._gx = this._gy = this._gz = 0;
        return;
      }
      const el = now - this._gesture.start;
      const env = el < this._gesture.dur ? Math.sin((el / this._gesture.dur) * Math.PI) : 0;
      this._gx = (this._gesture.ax || 0) * env;
      this._gy = (this._gesture.ay || 0) * env;
      this._gz = (this._gesture.az || 0) * env;
      if (el >= this._gesture.dur) { this._gesture = null; this._nextGesture = now + this._rand(8000, 20000); }
    }

    _pickGesture() {
      const list = [
        { az: 12, dur: 1400 },                 // 歪头
        { ax: -7, dur: 1200 },                 // 侧头看
        { ay: -9, dur: 1600 },                 // 抬头看上方
        { ax: 4, ay: 5, az: -6, dur: 1500 },   // 好奇地凑近
        { az: -9, dur: 1000 }                  // 摆头
      ];
      return list[Math.floor(Math.random() * list.length)];
    }

    // 自然随机眨眼（含约 15% 的长闭眼/打哈欠），间隔 2.2–6.5s
    _blinkUpdate(dt) {
      const now = performance.now();
      if (this._blink.next === 0) this._blink.next = now + this._rand(2200, 6500);
      // 音律识别且眼睛正由音乐层接管时（blend 明显 > 0）**完全跳过眨眼**：
      // 此时若还眨眼，会在固定闭眼值上叠加一次睁合波形 → 观感像"眼皮抽搐/抽动"。
      // 只要音乐眼接管就不眨，眼睛保持设定值不动；blend 趋近 0 后恢复正常眨眼。
      const musicEyeActive = this._musicEnabled && this._music &&
        (this._musicEyeBlend || 0) > 0.05;
      if (musicEyeActive) {
        this._eyeOpenBase = 1;                       // 眨眼基线保持全睁（闭眼由音乐层写固定值）
        this._blink.next = now + this._rand(2200, 6500);
        this._blink.active = false;
        return;
      }
      if (!this._blink.active && now >= this._blink.next) {
        this._blink.active = true; this._blink.t = 0; this._blink.phase = 'close';
        this._blink.long = Math.random() < 0.15;
        this._blink.closeDur = this._blink.long ? 220 : 90;
        this._blink.openDur = this._blink.long ? 520 : 110;
        this._blink.holdDur = this._blink.long ? 320 : 30;
      }
      if (this._blink.active) {
        this._blink.t += dt;
        let open;
        if (this._blink.phase === 'close') {
          open = 1 - Math.min(1, this._blink.t / this._blink.closeDur);
          if (this._blink.t >= this._blink.closeDur) { this._blink.phase = 'hold'; this._blink.t = 0; }
        } else if (this._blink.phase === 'hold') {
          open = 0;
          if (this._blink.t >= this._blink.holdDur) { this._blink.phase = 'open'; this._blink.t = 0; }
        } else {
          open = Math.min(1, this._blink.t / this._blink.openDur);
          if (this._blink.t >= this._blink.openDur) { this._blink.active = false; this._blink.next = now + this._rand(1500, 5000); }
        }
        this._eyeOpenBase = open;   // 供情绪层乘算（情绪只缩放"睁眼基线"，眨眼波形保持原样）
        this._setParam('ParamEyeLOpen', open);
        this._setParam('ParamEyeROpen', open);
      } else {
        this._eyeOpenBase = 1;      // 未眨眼：睁眼基线为 1，情绪层再乘 eyeOpen
      }
    }

    _rand(a, b) { return a + Math.random() * (b - a); }

    // 口型：统一由 _talk 驱动。
    //   mode='idle'  -> 文本驱动（C8 口型断句）：逐字开合，标点处闭口停顿（句号/叹问长停、逗号短停）。
    //   mode='chat'  -> 沿用原有匀速正弦口型（聊天流期间）。
    // 都不在说话时，口型自然回落到闭合。
    _mouth(dt) {
      const tk = this._talk;
      // —— 音频驱动口型（TTS 播放期间）——
      // 文本驱动的时序（90-180ms/字）与真实语音时长并不同步（表现为"嘴比声音快"），
      // 故 TTS 播放时改由音频响度驱动开合、由播放进度推进字指针（元音形状与情绪随之对齐）。
      // 判据来自渲染端写入的 window.__ttsPlaying / __ttsRms / __ttsProgress。
      if (typeof window !== 'undefined' && window.__ttsPlaying && tk.active && tk.mode === 'idle') {
        this._audioMouth(dt, tk);
        return;
      }
      // Silence：模型带该参数时，说话中(任意来源)置 1 切到参数驱动模式(接收我们写的元音/OpenY)，否则置 0 回到面捕/默认。
      // 前置条件从 _visemeMode 改为 _silenceParam 是否存在——否则回退模式(OpenY+Form)同样被
      // Silence=1 门控，嘴完全不动（"元音同步没生效"的根因之一）。
      if (this._silenceParam) this._setSilence(tk.active);
      if (tk.active && tk.mode === 'idle') {
        if (!tk.text) { tk.active = false; this._scheduleIdleLine(); return; }
        if (tk.i >= tk.text.length) {            // 台词播完：发整句小结、闭口、排下一条
          this._emitVisemeSummary(tk);
          this._emoLinger = this._emoAt(tk, tk.text.length);   // 保留末句情绪 ~2.2s，避免说完立刻呆脸
          this._emoLingerUntil = performance.now() + 2200;
          tk.active = false;
          this._clearMouth();
          this._scheduleIdleLine();
          return;
        }
        tk.t += dt;
        const ch = tk.text[tk.i];
        // 标点 = 闭口停顿（C8 口型断句）：句号/叹号/问号/省略号停留更久，逗号/顿号次之
        const isPause = /[，。！？、；：…—,.!?;:\s]/.test(ch);
        if (isPause) {
          const hold = /[。！？!?…]/.test(ch) ? 300 : 150;
          if (tk.t < hold) {
            this._clearMouth();
          } else { tk.i++; tk.t = 0; }
        } else {
          if (tk.t >= tk.charDur) {              // 一个字播完，进下一个，重抽时长/幅度
            tk.i++; tk.t = 0;
            tk.charDur = this._randCharDur();
            tk.peak = this._randPeak();
          } else {
            // 单字半正弦开合：0 -> 峰 -> 0，模拟一次"音节"张合
            const open = tk.peak * Math.sin(Math.PI * (tk.t / tk.charDur));
            // 元音从本行预取的拼音结果取（异步加载完成前为 null，由回退静默闭口）
            const vowel = (tk.vowels && tk.i < tk.vowels.length) ? tk.vowels[tk.i] : null;
            if (this._visemeMode) {
              this._applyViseme(vowel, open);   // 元音对照口型：a/i/u/e/o 各驱动对应参数
              if (this._visemeStats && vowel && open > 0.02) this._accumViseme(vowel);
            } else {
              this._setParam('ParamMouthOpenY', open);
              this._setParam('ParamMouthForm', 0.2 + this._emoCur.mouthForm);
            }
          }
        }
        this._visemeDebugTick();
        return;
      }
      if (tk.active && tk.mode === 'chat') {
        this._driveChatMouth(dt);
        this._visemeDebugTick();
        return;
      }
      // 不在说话：口型回落；同时把五个元音参数强制归 0，杜绝上一句残留的元音与下一句叠加
      for (const v of ['a', 'i', 'u', 'e', 'o']) {
        const id = this._vowelParam[v];
        if (id && this._getParam(id) > 0.004) this._setParam(id, 0);
      }
      const cur = this._getParam('ParamMouthOpenY');
      if (cur > 0.004) this._setParam('ParamMouthOpenY', cur * 0.85);
      const cf = this._getParam('ParamMouthForm');
      if (Math.abs(cf) > 0.004) this._setParam('ParamMouthForm', cf * 0.9);
      this._activeVowel = null;
      this._visemeDebugTick();   // 诊断采样（自节流，仅在每次说话的前若干帧打日志）
    }

    // 音频驱动口型：播放进度 → 字指针（元音形状与情绪随之同步），响度 → 开合。
    _audioMouth(dt, tk) {
      if (this._silenceParam) this._setSilence(true);
      const n = tk.text ? tk.text.length : 0;
      const p = (typeof window.__ttsProgress === 'number') ? window.__ttsProgress : 0;
      const prog = Math.max(0, Math.min(1, p));
      const idx = n > 0 ? Math.min(n - 1, Math.floor(prog * n)) : 0;
      tk.i = idx; tk.t = 0;
      // 响度 → 开合：先扣底噪再开方（拉开"有声/无声"对比），再非对称平滑
      // （快起 25ms、慢落 90ms）——像真人那样每个音节有大小起伏，句内停顿会自然合上。
      const rms = (typeof window.__ttsRms === 'number') ? window.__ttsRms : 0;
      const g = Math.max(0, rms - 0.015) * 4.5;
      const target = Math.max(0, Math.min(1, Math.sqrt(g)));
      const tau = (target > this._audioOpen) ? 25 : 90;
      this._audioOpen += (target - this._audioOpen) * (1 - Math.exp(-dt / tau));
      const open = this._audioOpen;
      const vowel = (tk.vowels && idx < tk.vowels.length) ? tk.vowels[idx] : null;
      if (this._visemeMode) {
        this._applyViseme(vowel, open);   // 内部已一热归零其余元音（停顿处自然闭口）
        if (this._visemeStats && vowel && open > 0.02) this._accumViseme(vowel);
      } else {
        this._setParam('ParamMouthOpenY', open);
        this._setParam('ParamMouthForm', 0.2 + this._emoCur.mouthForm);
      }
      this._visemeDebugTick();
    }

    // 渲染端在 TTS 音频播完时调用：结束当前台词（整句小结、情绪余韵、闭口、排下一条）
    onAudioEnded() {
      const tk = this._talk;
      if (!tk || !tk.active || tk.mode !== 'idle') return;
      this._emitVisemeSummary(tk);
      this._emoLinger = this._emoAt(tk, tk.text.length);
      this._emoLingerUntil = performance.now() + 2200;
      tk.active = false;
      this._audioOpen = 0;
      this._clearMouth();
      this._scheduleIdleLine();
    }

    // 每个字的口型时长与峰值（带随机，避免机械感）
    _randCharDur() { return 90 + Math.random() * 90; }   // 90..180ms
    _randPeak() { return 0.6 + Math.random() * 0.4; }     // 0.6..1.0

    // —— 元音口型（对照口型）——
    // 加载模型后枚举 Cubism 参数，确认是否带 VTS 元音口型五元参数。
    // 每个元音优先认 ParamX（如你的 Hotaru2024 实际命名 ParamA/I/U/E/O），
    // 其次 ParamMouthX；命中即记录真实参数名。五元齐全 -> _visemeMode=true，
    // 口型按当前字元音驱动对应参数；不齐 -> 回退双参数(OpenY+Form)口型（换模型兼容）。
    // 同时探测 VTS 的 Silence 参数（默认 1，说话时置 0，避免面捕与口型冲突），
    // 并把真实参数名写到 app.log，便于确认模型命名。
    // —— 口型调试开关（由托盘菜单经 IPC 实时调用，无需重启即可切换并观察嘴型变化）——
    setVowelFamily(fam) {
      this._vowelFamily = (fam === 'auto' || fam) ? fam : 'auto';
      this._initVisemeMode();   // 用新族重新探测（轻量：仅读参数 ID，不改变模型状态）
      const info = '[viseme] 切换参数族=' + this._vowelFamily + ' -> family=' +
        (this._availableFamilies[0] || '?') + ' mode=' + (this._visemeMode ? 'vowel' : 'fallback') +
        ' vowelParams=' + JSON.stringify(this._vowelParam) +
        ' | availableFamilies=' + JSON.stringify(this._availableFamilies);
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log(info);
    }
    setDriveOpenY(v) {
      this._driveOpenY = !!v;
      const info = '[viseme] driveOpenY=' + this._driveOpenY + '（' +
        (this._driveOpenY ? '元音模式下额外驱动 ParamMouthOpenY 作为张合包络' :
                            '元音模式下不驱动 ParamMouthOpenY，嘴型完全由元音参数本身决定') + '）';
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log(info);
    }
    setSilenceSpeaking(v) {
      this._silenceSpeaking = (v === 1) ? 1 : 0;
      const info = '[viseme] silenceSpeaking=' + this._silenceSpeaking +
        '（说话时 Silence=' + this._silenceSpeaking + '，空闲时=' + (1 - this._silenceSpeaking) + '）';
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log(info);
    }

    // 探测某个 Cubism 参数是否真实存在、且可被写入读回。
    // 旧实现依赖 coreModel 的「参数枚举接口」(getParameterCount/getParameterId)，
    // 但本模型运行时这套接口不存在（日志见 "[viseme] coreModel 无参数枚举接口"），
    // 于是直接回退 OpenY+Form、五元参数从未被驱动——这是"元音同步没生效"的根因。
    // 改用「写-读回环」：setParameterValueById 写特征值 0.123，再 getParameterValueById
    // 读回；读回值≈写入值即说明该参数真实存在且可驱动。不依赖任何枚举接口，对参数
    // 命名差异(PARAM/PARAMMOUTH/小写)完全免疫——只要模型认这个 id 且能写读回环就认定存在。
    // 写-读回环探测：不依赖任何枚举接口，对参数命名差异完全免疫。
    // 注意：这里【不能】叫 _hasParam —— 本类后面还有一个同名方法（基于参数名集合），
    // 同名会被后定义者覆盖，于是这个版本曾长期变成死代码（注释却仍写着"用写-读回环"）。
    // 现改为独立方法，由 _hasParam 在"枚举接口不可用"时兜底调用。
    _paramWritable(id) {
      this._probeCache = this._probeCache || {};
      if (Object.prototype.hasOwnProperty.call(this._probeCache, id)) return this._probeCache[id];
      let ok = false;
      const core = this._core();
      if (core && typeof core.setParameterValueById === 'function' &&
          typeof core.getParameterValueById === 'function') {
        let prev = 0;
        try { const v = core.getParameterValueById(id); if (typeof v === 'number' && !isNaN(v)) prev = v; } catch (e) {}
        const probe = 0.123;
        try {
          core.setParameterValueById(id, probe);
          const after = core.getParameterValueById(id);
          ok = (typeof after === 'number' && !isNaN(after) && Math.abs(after - probe) < 0.01);
          core.setParameterValueById(id, prev);   // 还原，避免影响首帧口型
        } catch (e) { ok = false; }
      }
      this._probeCache[id] = ok;
      return ok;
    }

    _initVisemeMode() {
      const core = this._core();
      this._visemeMode = false;
      this._vowelParam = { a: '', i: '', u: '', e: '', o: '' };
      this._silenceParam = '';
      if (!core) {
        if (window.desktopPet && window.desktopPet.log)
          window.desktopPet.log('[viseme] coreModel 不可用，回退 OpenY+Form');
        return;
      }
      // 1) 枚举模型里"真实的全部参数名"。正确来源是原生内核 core.getModel().parameters.ids
      //    （_getAllParamIds 内部解析，含框架按索引接口的次选与字符串数组兜底）。
      //    注意：CubismModel 既没有 getParameterIds() 也没有 getParameterId(index)，
      //    不要再用它们（用了就恒为空，正是元音探测长期退化成 probe 的原因）。
      //    枚举不到再退化为"写-读回环"探测已知候选名（兜底，对重命名/重新导出的模型仍稳健）。
      let ids = this._getAllParamIds();
      let enumMethod = ids.length ? 'core.enum' : 'probe';
      // 回退：按已知候选名做写-读回环探测
      if (!ids.length) {
        enumMethod = 'probe';
        const cand = ['Param', 'ParamMouth', 'Mouth', 'Vowel', 'ParamVowel'];
        const up = ['A', 'I', 'U', 'E', 'O'];
        for (const p of cand) for (const u of up) {
          const id = p + u;
          if (this._hasParam(id)) ids.push(id);
        }
        for (const id of ['Silence', 'ParamSilence', 'ParamMouthSilence', 'silence']) {
          if (this._hasParam(id)) ids.push(id);
        }
      }
      // 2) 在全部 ID 中，按"参数族"匹配五个元音参数。模型常同时存在多族（ParamA..O /
      //    ParamMouthA..O / MouthA..O / VowelA..O / ParamVowelA..O），但真正驱动"可见嘴型"的
      //    通常只有一族。family='auto' 时按优先级取第一族齐全的；否则强制用指定族（缺则回退 auto）。
      // 自动探测优先级：尊重用户明确告知的 ParamA..O 在前，其后依次是其它常见族，
      // 保证默认行为与用户描述一致、不退化；其余族可由托盘"口型调试"菜单实时切换尝试。
      const famOrder = ['Param', 'ParamMouth', 'Mouth', 'Vowel', 'ParamVowel'];
      let family = (this._vowelFamily && this._vowelFamily !== 'auto') ? this._vowelFamily : null;
      let chosen = null;
      const matchFor = (f) => this._matchFamily(ids, f);
      if (family) {
        const r = matchFor(family);
        if (r.found >= 5) chosen = family;
      }
      if (!chosen) { for (const f of famOrder) { const r = matchFor(f); if (r.found >= 5) { chosen = f; break; } } }
      const r = matchFor(chosen || 'Param');
      this._vowelParam = r.vp;
      // 统计哪些族齐全（供托盘调试菜单标注可选范围）
      this._availableFamilies = famOrder.filter((f) => matchFor(f).found >= 5);
      this._visemeMode = r.found >= 5;
      // Silence：名字含 silence（任意大小写/前缀）即认定
      for (const id of ids) { if (/silence/i.test(id)) { this._silenceParam = id; break; } }
      const found = Object.values(this._vowelParam).filter(Boolean).length;
      const info = '[viseme] mode=' + (this._visemeMode ? 'A/I/U/E/O(元音对照)' : 'fallback OpenY+Form') +
        ' | enum=' + enumMethod +
        ' | family=' + (chosen || 'Param') +
        ' | vowelParams=' + JSON.stringify(this._vowelParam) +
        ' | Silence=' + (this._silenceParam || '(none)') +
        ' | foundVowels=' + found + '/5' +
        ' | availableFamilies=' + JSON.stringify(this._availableFamilies) +
        ' | driveOpenY=' + this._driveOpenY +
        ' | silenceSpeaking=' + this._silenceSpeaking +
        ' | paramCount=' + ids.length;
      console.log(info);
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log(info);
      // 把全部参数名打到日志（最多 400 个）：模型调整/重命名后，据此立即确认命名是否变化
      if (ids.length) {
        const dump = '[viseme-all-params] count=' + ids.length + ' :: ' +
          JSON.stringify(ids.slice(0, 400));
        console.log(dump);
        if (window.desktopPet && window.desktopPet.log) window.desktopPet.log(dump);
      }
    }

    // 在参数 ID 列表中按"族前缀"匹配五个元音参数：返回 {vp, found}。
    // family 决定候选名形态，严格限定在该族内（避免 ParamA 与 ParamMouthA 混用导致"写了但不变形"）。
    _matchFamily(ids, family) {
      const up = ['A', 'I', 'U', 'E', 'O'];
      const lo = ['a', 'i', 'u', 'e', 'o'];
      const forms = (u) => {
        switch (family) {
          case 'ParamMouth': return ['ParamMouth' + u, 'ParamMouthOpen' + u];
          case 'Param': return ['Param' + u];
          case 'Mouth': return ['Mouth' + u];
          case 'Vowel': return ['Vowel' + u];
          case 'ParamVowel': return ['ParamVowel' + u];
          default: return ['Param' + u, 'ParamMouth' + u, 'Mouth' + u, 'Vowel' + u, 'ParamVowel' + u, 'ParamMouthOpen' + u, u];
        }
      };
      const vp = { a: '', i: '', u: '', e: '', o: '' };
      let found = 0;
      for (let k = 0; k < 5; k++) {
        const u = up[k];
        for (const id of ids) { if (forms(u).indexOf(id) >= 0) { vp[lo[k]] = id; found++; break; } }
      }
      return { vp, found };
    }

    // 把一整行文本转成元音数组（与字符一一对应，标点处为 null）。
    // 拼音经主进程异步提供（desktopPet.pinyin 返回 Promise<array>），这里统一兼容
    // 同步/异步两种返回；pinyin 不可用时返回 null（调用方会静默闭口，不崩）。
    _loadVowels(line) {
      return new Promise((resolve) => {
        const done = (arr) => {
          if (!Array.isArray(arr)) return resolve(null);
          resolve(arr.map((s) => this._vowelFromSyllable(s || '')));
        };
        try {
          if (window.desktopPet && typeof window.desktopPet.pinyin === 'function') {
            Promise.resolve(window.desktopPet.pinyin(line)).then(done).catch(() => resolve(null));
          } else {
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    }

    // 从拼音音节取主元音：按开口度优先级 a > o > e > i > u（ü 归 u）。
    // 该顺序让"啊(a)最开口、衣(i)/乌(u)最收"符合中文口型的视觉差异。
    _vowelFromSyllable(syl) {
      const s = String(syl).toLowerCase();
      if (s.indexOf('a') >= 0) return 'a';
      if (s.indexOf('o') >= 0) return 'o';
      if (s.indexOf('e') >= 0) return 'e';
      if (s.indexOf('i') >= 0) return 'i';
      if (s.indexOf('u') >= 0 || s.indexOf('ü') >= 0) return 'u';
      return null;
    }

    // 元音对照口型（回退到 step 2「严格 one-hot 强制归零」之前的那版写法）：
    // 只把当前字的元音参数推到 open，不再强行把其余四个元音归 0。
    // 当时的写法实测嘴型能正常开合变形；引入 one-hot 全归零后才出现「参数写对了但嘴型不变形」。
    // 故回退重测，验证是否正是"全部归零"破坏了可见嘴型。OpenY 仍作张合包络（托盘可关），
    // Form 归 0。
    _applyViseme(vowel, open) {
      // 一热写入：只有当前元音非零，其余元音强制归零。
      // 关键：若只写当前元音而不归零其余，标点/停顿处 vowel 为 null 时，
      // 上一个元音的数值会一直残留 → 嘴合不上、多个元音叠加。
      for (const v of ['a', 'i', 'u', 'e', 'o']) {
        const id = this._vowelParam[v];
        if (id) this._setParam(id, (v === vowel) ? open : 0);
      }
      if (this._driveOpenY) this._setParam('ParamMouthOpenY', open);
      // 嘴角弧度交给情绪层（中性=0；微笑>0、皱眉<0）；元音模式本身不再固定写 0
      this._setParam('ParamMouthForm', this._emoCur.mouthForm);
      this._activeVowel = vowel || null;
    }

    // VTS 的 Silence：说话(元音参数驱动)时置 silenceSpeaking（默认 0=口型接管），
    // 不说话(面捕/默认)时置相反值（默认 1）。极性可由托盘调试开关翻转。
    _setSilence(speaking) {
      if (!this._silenceParam) return;
      const val = speaking ? this._silenceSpeaking : (1 - this._silenceSpeaking);
      this._setParam(this._silenceParam, val);
    }

    // ============================ 情绪/表情层（五官） ============================
    // 目标情绪判定：说话中若有"分句情绪表"，按当前字指针取对应情绪（可在单句内实时切换）；
    // 否则用整句 emo；都不在说话时回 neutral。台词刚结束用 _emoLinger 短暂保持，避免立刻呆脸。
    _setEmotionTarget(name) {
      this._emoTarget = EMOTION_PRESETS[name] ? name : 'neutral';
    }

    // 聊天回复用的公开入口：把模型输出的情绪标签直接应用到五官。
    // 只在表情层开启时才生效（设置里关掉"表情情绪"后聊天也不改脸，尊重用户选择）。
    setChatEmotion(name) {
      if (!this._emotionEnabled) return false;
      this._setEmotionTarget(name);
      return true;
    }

    setEmotionEnabled(on) {
      this._emotionEnabled = !!on;
      if (window.desktopPet && window.desktopPet.log) {
        window.desktopPet.log('[emotion] 表情情绪=' + (this._emotionEnabled ? 'on' : 'off'));
      }
    }

    // 参数名集合（懒构建）；用于判断模型是否有某个可选参数（如脸红 ParamCheek）
    _hasParam(id) {
      if (!this._paramSet) {
        try { this._paramSet = new Set(this._getAllParamIds()); } catch (e) { this._paramSet = new Set(); }
      }
      if (this._paramSet.size) return this._paramSet.has(id);
      // 枚举接口不可用（集合为空）时退回「写-读回环」探测，避免所有可选参数判断恒为 false。
      return this._paramWritable(id);
    }

    // 解析台词情绪规格：
    //   emo 为字符串 -> 整句同一情绪；为数组 -> 按标点把台词切成若干句，逐句 1:1 映射
    //   （数组比句数短则复用最后一项）。这正是"单段台词内感情实时变化"的实现依据。
    // 返回 [{ end, e }]（end 为该句结束的字索引，不含）；无法解析返回 null。
    _buildEmoList(text, emo) {
      if (!emo || !text) return null;
      if (typeof emo === 'string') return EMOTION_PRESETS[emo] ? [{ end: text.length, e: emo }] : null;
      if (!Array.isArray(emo) || !emo.length) return null;
      const ends = [];
      for (let i = 0; i < text.length; i++) {
        if (/[，。！？、；：…—,.!?;:\s]/.test(text[i])) ends.push(i + 1);
      }
      if (!ends.length || ends[ends.length - 1] !== text.length) ends.push(text.length);
      const list = [];
      for (let k = 0; k < ends.length; k++) {
        const e = emo[Math.min(k, emo.length - 1)];
        if (EMOTION_PRESETS[e]) list.push({ end: ends[k], e: e });
      }
      return list.length ? list : null;
    }

    _emoAt(tk, i) {
      const list = tk && tk.emoList;
      if (!list || !list.length) return (tk && tk.emo) || 'neutral';
      for (const seg of list) { if (i < seg.end) return seg.e; }
      return list[list.length - 1].e;
    }

    // 每帧：缓动逼近目标情绪并写五官参数。
    // 时序要求：必须在 _blinkUpdate 之后调用——眼开合用 _eyeOpenBase 乘算，避免覆盖眨眼波形。
    _express(dt) {
      // 模型自带表情播放期间不写五官：模型表情是"直接写参数并保持"，
      // 情绪层若照常每帧覆盖，表情会被立刻吃掉（表现为"点了表情没反应"）。
      if (performance.now() < this._exprHoldUntil) return;
      const tk = this._talk;
      let target = 'neutral';
      if (tk && tk.active) {
        if (tk.emoList && tk.emoList.length) {
          const idx = (tk.mode === 'chat') ? this._chatPtr : tk.i;
          target = this._emoAt(tk, idx);
        } else if (tk.emo) {
          target = tk.emo;
        }
      } else if (this._emoLinger && performance.now() < this._emoLingerUntil) {
        target = this._emoLinger;
      }
      // 音律识别：未说话时切到"陶醉听歌"表情（enjoy）。说话时让位给台词自带情绪，
      // 免得笑着说话或闭着眼念台词。开关由 setMusicEnabled 通过 _musicEmo 控制。
      if (this._musicEmo && !(tk && tk.active)) target = this._musicEmo;
      this._setEmotionTarget(target);

      const P = EMOTION_PRESETS[this._emoTarget] || {};
      const k = 1 - Math.exp(-dt / 240);      // 时间常数 240ms 的指数缓动（与帧率无关，无瞬切）
      const e = this._emoCur;
      for (const key of EMO_KEYS) {
        const tgt = (typeof P[key] === 'number') ? P[key] : EMO_NEUTRAL[key];
        e[key] += (tgt - e[key]) * k;
      }
      if (!this._emotionEnabled) return;      // 关闭时不写五官参数，完全交回原有系统

      const cl = (v, a, b) => Math.max(a, Math.min(b, v));
      // 音律识别：眼睛完全交给 _blinkUpdate（正常眨眼）与 _musicTick（检测到音乐时
      // 按 eyeClose 固定闭眼）。enjoy 预设的 eyeOpen=0.30 若在这里写，会导致"没放歌也半闭、
      // 且改 eyeClose 无效"——所以音律识别下这里不碰眼睛参数，只写眉/嘴/脸红等其它五官。
      if (!this._musicEmo) {
        const o = cl(this._eyeOpenBase * e.eyeOpen, 0, 1.5);
        this._setParam('ParamEyeLOpen', o);
        this._setParam('ParamEyeROpen', o);
        this._setParam('ParamEyeSquintL', cl(e.eyeSquint, 0, 1));
        this._setParam('ParamEyeSquintR', cl(e.eyeSquint, 0, 1));
      }
      this._setParam('ParamBrowLY', cl(e.browY, -1, 1));
      this._setParam('ParamBrowRY', cl(e.browY, -1, 1));
      this._setParam('ParamBrowLForm', cl(e.browForm, -1, 1));
      this._setParam('ParamBrowRForm', cl(e.browForm, -1, 1));
      this._setParam('ParamCheekPuff', cl(e.cheekPuff, 0, 1));
      this._setParam('ParamTongueOut', cl(e.tongueOut, 0, 1));
      // 脸红：各模型命名不一，探测到哪个用哪个（本机若枚举出 ParamCheek 等即生效，否则跳过）
      if (e.blush > 0.002) {
        const cands = ['ParamCheek', 'ParamCheekRed', 'ParamFaceRed', 'ParamBlush'];
        for (const pid of cands) {
          if (this._hasParam(pid)) { this._setParam(pid, cl(e.blush, 0, 1)); break; }
        }
      }
    }
    // ========================== 情绪/表情层（五官）结束 ==========================

    // —— 参数调试面板：开启后按 ~10Hz 把模型全部参数(名称/当前值/最小/最大)快照上报 ——
    // 供独立调试窗口实时列出所有参数，定位"写了参数但嘴不变形"的根因。关闭后停止上报。
    setDebugMode(on) {
      this._debugMode = !!on;
      if (this._debugTimer) { clearInterval(this._debugTimer); this._debugTimer = null; }
      if (this._debugMode) {
        this._emitDebugParams();                                   // 立即发一帧，避免打开面板时空白
        this._debugTimer = setInterval(() => this._emitDebugParams(), 100);
      } else if (window.desktopPet && window.desktopPet.send) {
        window.desktopPet.send('pet:debugParams', { open: false });
      }
    }
    _emitDebugParams() {
      this._dbgSeq = (this._dbgSeq || 0) + 1;
      const snapshot = { open: true, t: Date.now(), seq: this._dbgSeq };
      const acc = this._resolveParamAccessor();
      if (!acc) {
        // 关键：即使枚举失败也照发一帧（带 err），让面板能显示"到底卡在哪一步"，
        // 而不是像以前那样静默 return、面板永远停在"尚未收到参数快照"。
        snapshot.mode = 'none';
        snapshot.rows = [];
        snapshot.err = this._core()
          ? '已取得 coreModel，但解析不到任何参数接口（无 getModel().parameters，也无 getParameterCount）'
          : 'coreModel 尚不可用（模型未加载完成 / 加载失败）';
        if (!this._dbgWarned) {
          this._dbgWarned = true;
          if (window.desktopPet && window.desktopPet.log) window.desktopPet.log('[debug] 参数枚举失败：' + snapshot.err);
        }
      } else {
        const rows = [];
        for (let i = 0; i < acc.count; i++) {
          const s = acc.read(i);
          rows.push({ id: acc.ids[i], v: s.v, mn: s.mn, mx: s.mx, d: s.df });
        }
        snapshot.mode = acc.mode;
        snapshot.rows = rows;
        snapshot.err = '';
        if (!this._dbgWarned) {
          this._dbgWarned = true;
          if (window.desktopPet && window.desktopPet.log) {
            window.desktopPet.log('[debug] 参数枚举方式=' + acc.mode + ' 参数总数=' + rows.length);
          }
        }
      }
      if (window.desktopPet && window.desktopPet.send) {
        window.desktopPet.send('pet:debugParams', snapshot);
      }
    }

    // 诊断采样：每次开始说话触发，连续若干帧把"写入值 vs 回读值"打到 app.log，
    // 确认参数名是否命中、模型是否真的接收了口型参数（无 UI 时排查元音同步的关键证据）。
    // 关键一行：nonzeroVowels=N{...} —— 若 N 恒为 0/1，则"两个元音"来自模型自身 rig 叠加，
    // 需从模型侧调形状权重；若 N 偶尔 >1，则说明有外部写入源（如模型自带口型 motion）需禁用。
    _visemeDebugTick() {
      if (!this._visemeDebug || this._visemeDebug.n <= 0) return;
      this._visemeDebug.n--;
      const tk = this._talk;
      const rows = [];
      if (this._silenceParam) rows.push('Silence=' + this._getParam(this._silenceParam).toFixed(2) + '(target ' + (tk.active ? this._silenceSpeaking : (1 - this._silenceSpeaking)) + ')');
      rows.push('OpenY=' + this._getParam('ParamMouthOpenY').toFixed(2));
      // 逐元音回读 + 统计非零数量（判定"是否有两个元音同时非零"的根因证据）
      let nv = 0; const vm = {};
      for (const v of ['a', 'i', 'u', 'e', 'o']) {
        const id = this._vowelParam[v];
        if (id) { const val = this._getParam(id); vm[v] = +val.toFixed(2); if (val > 0.02) nv++; }
      }
      rows.push('nonzeroVowels=' + nv + JSON.stringify(vm));
      let curVowel = null;
      if (tk.active && tk.mode === 'idle') curVowel = (tk.vowels && tk.i < tk.vowels.length) ? tk.vowels[tk.i] : null;
      else if (tk.active && tk.mode === 'chat') curVowel = (this._chatVowels && this._chatPtr < this._chatVowels.length) ? this._chatVowels[this._chatPtr] : null;
      if (this._visemeMode && curVowel) {
        const id = this._vowelParam[curVowel];
        if (id) {
          const vv = this._getParam(id);
          rows.push('targetVowel=' + curVowel + '(' + id + ')=' + vv.toFixed(2));
          // 写入丢弃告警：元音模式、嘴在张开(OpenY>0.1)但对应元音参数回读≈0，
          // 说明模型没接住我们的元音写入（被 rig/动作/面捕门控覆盖）——属模型侧问题，需据此处理。
          const openY = this._getParam('ParamMouthOpenY');
          if (openY > 0.1 && vv < openY * 0.4) {
            rows.push('[viseme-warn] 元音参数写入被丢弃：OpenY=' + openY.toFixed(2) + ' 但 ' + curVowel + '=' + vv.toFixed(2) + '（模型未接住/被覆盖）');
          }
        }
      } else if (this._visemeMode && tk.active) {
        rows.push('[viseme-warn] 无拼音元音(元音数组未就绪/标点)');
      }
      const msg = '[viseme-dbg#' + (8 - this._visemeDebug.n) + '] mode=' + (this._visemeMode ? 'vowel' : 'fallback') +
        ' active=' + tk.active + ' vowel=' + (curVowel || '-') + ' | ' + rows.join(' ');
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log(msg);
    }

    // 逐帧累计本句元音分布（供整句小结用）。maxNz 取整句每帧非零元音数的最大值，
    // 用于直接证明"任意时刻最多一个元音参数非零"(one-hot)。
    _accumViseme(vowel) {
      const s = this._visemeStats;
      if (!s) return;
      s.seen[vowel] = (s.seen[vowel] || 0) + 1;
      let nz = 0;
      for (const v of ['a', 'i', 'u', 'e', 'o']) {
        const id = this._vowelParam[v];
        if (id && this._getParam(id) > 0.02) nz++;
      }
      if (nz > s.maxNz) s.maxNz = nz;
    }

    // 一条待机台词播完时，把本句元音分布打到 app.log，一眼确认：
    //   vowelsSeen  —— 本句实际出现过的元音种类与次数（a/i/u/e/o 是否都轮到）
    //   distinct    —— 不同元音数（满分 5）
    //   maxNonzeroPerFrame —— 整句任意帧同时非零的元音数（恒为 1 即严格 one-hot）
    _emitVisemeSummary(tk) {
      const s = this._visemeStats;
      this._visemeStats = null;
      if (!s) return;
      const seen = s.seen || {};
      const distinct = Object.keys(seen).length;
      const row = '[viseme-summary] text=' + JSON.stringify(tk.text) +
        ' | mode=' + (this._visemeMode ? 'vowel' : 'fallback') +
        ' | vowelsSeen=' + JSON.stringify(seen) +
        ' | distinct=' + distinct + '/5' +
        ' | maxNonzeroPerFrame=' + s.maxNz +
        (this._silenceParam ? (' | Silence@end=' + this._getParam(this._silenceParam).toFixed(2)) : '');
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log(row);
    }

    // 闭口：清空所有口型参数（元音模式清五元 + OpenY；非元音模式清 OpenY+Form）
    _clearMouth() {
      if (this._visemeMode) for (const v of ['a', 'i', 'u', 'e', 'o']) {
        const id = this._vowelParam[v]; if (id) this._setParam(id, 0);
      }
      this._setParam('ParamMouthOpenY', 0);
      this._setParam('ParamMouthForm', this._emoCur.mouthForm);   // 停顿/闭口时保留情绪嘴角
    }

    // 聊天口型：复用元音引擎，按 _chatText 逐字推进（约 120ms/字），标点处闭口。
    // 这样 chat 回复也能做出 a/i/u/e/o 对照口型，而不是回归匀速张嘴。
    _driveChatMouth(dt) {
      const text = this._chatText || '';
      if (!text) {   // 思考/等待期还没收到文本：闭合嘴唇，不空转（延迟冒泡后这段时间可能很长）
        this._clearMouth();
        return;
      }
      this._chatT += dt;
      if (this._chatT >= 120) { this._chatT = 0; this._chatPtr++; if (this._chatPtr >= text.length) this._chatPtr = 0; }
      const ch = text[this._chatPtr] || '';
      const isPause = /[，。！？、；：…—,.!?;:\s]/.test(ch);
      if (isPause) { this._clearMouth(); return; }
      const vowel = (this._chatVowels && this._chatPtr < this._chatVowels.length) ? this._chatVowels[this._chatPtr] : null;
      const open = 0.8;
      if (this._visemeMode) this._applyViseme(vowel, open);
      else { this._setParam('ParamMouthOpenY', open); this._setParam('ParamMouthForm', 0.2 + this._emoCur.mouthForm); }
    }

    // 渲染进程在聊天文本流式到达时持续喂入，供 _driveChatMouth 取字
    feedChatText(t) {
      this._chatText = String(t || '');
      this._loadVowels(this._chatText).then((v) => { this._chatVowels = v; });
    }

    // 聊天回复的 TTS 音频开始播放时由渲染端调用：把本轮台词交给「音频驱动口型」。
    // 与 playIdleLine 同引擎（mode='idle' 才会走 _audioMouth 分支），差别是不触发
    // onIdleLine 气泡回调、不重排待机计时；口型由 window.__ttsRms 驱动开合、
    // __ttsProgress 推进字指针（元音形状与分句情绪随之对齐），播放结束由 onAudioEnded 收尾闭口。
    // ——这是「新引擎也要元音同步」的关键：聊天回复此前走 mode='chat' 的文本口型，
    //   永远进不了音频分支，于是语音播放时嘴反而不动。
    startAudioChat(text, emo) {
      const line = String(text || '');
      this._talk = {
        active: true, mode: 'idle', text: line,
        i: 0, t: 0, charDur: this._randCharDur(), peak: this._randPeak(), vowels: null,
        emo: (typeof emo === 'string') ? emo : null,
        emoList: this._buildEmoList(line, emo)
      };
      this._emoLinger = ''; this._emoLingerUntil = 0;
      this._audioOpen = 0;
      this._loadVowels(line).then((v) => {
        if (this._talk.mode === 'idle' && this._talk.text === line) this._talk.vowels = v;
      });
      this._visemeStats = { seen: {}, maxNz: 0 };
      if (this._silenceParam) this._setSilence(true);
    }

    // 聊天回复「未开语音」时由渲染端调用：用文本驱动口型（C8 断句，逐字开合），
    // 播完自动闭口（见 _mouth 的 idle 文本分支）。不触发 onIdleLine，气泡由聊天逻辑自管。
    speakTextChat(text, emo) {
      const line = String(text || '');
      this._talk = {
        active: true, mode: 'idle', text: line,
        i: 0, t: 0, charDur: this._randCharDur(), peak: this._randPeak(), vowels: null,
        emo: (typeof emo === 'string') ? emo : null,
        emoList: this._buildEmoList(line, emo)
      };
      this._emoLinger = ''; this._emoLingerUntil = 0;
      this._loadVowels(line).then((v) => {
        if (this._talk.mode === 'idle' && this._talk.text === line) this._talk.vowels = v;
      });
      this._visemeStats = { seen: {}, maxNz: 0 };
    }

    // 点击模型：立即播一条交互台词（同待机口型同步），无需等待随机待机，便于测试
    sayClick() {
      if (this.speaking) return;                 // 聊天进行中不打断
      let text = '', emo = null, pickInfo = null;
      if (this._clickPool && this._clickPool.length) {
        // 洗牌队列：把整池打乱后依次取，取空才重建 —— 一轮内绝不重复，
        // 消除"点十几次就刷到同一句"的观感（随机抽取在 30 条里几乎必然重复）。
        // 队列元素带 idx（原始池索引），供 onPickLine 按 manifest.pools['click'][idx] 定位预生成音频。
        if (!this._clickQueue || !this._clickQueue.length) {
          this._clickQueue = this._shuffle(this._clickPool.map((e, i) => ({ entry: e, idx: i })));
        }
        const pickObj = this._clickQueue.pop();
        const pick = pickObj.entry;
        text = (typeof pick === 'string') ? pick : ((pick && pick.text) || '');
        emo = (pick && typeof pick === 'object') ? (pick.emo || null) : null;
        pickInfo = { pool: 'click', idx: pickObj.idx, entry: pick };
      }
      if (!text && this._idleEnabled) {                 // 无专门点击池时退化播待机台词
        const fb = this._pickIdleLine();
        if (fb) { text = fb.text; emo = fb.emo; pickInfo = { pool: 'idle', idx: fb.idx, entry: fb.entry }; }
      }
      // 优先走 onPickLine：中日切换 + 预生成音频播放都在此接管；未注入时退化显示气泡。
      if (pickInfo && this.onPickLine) { this.onPickLine(pickInfo.pool, pickInfo.idx, pickInfo.entry); return; }
      if (text) this.playIdleLine(text, emo);
    }

    setClickLines(pool) {
      this._clickPool = (pool && Array.isArray(pool) && pool.length) ? pool : null;
      this._clickQueue = null;                   // 换池时重置队列
    }

    // Fisher–Yates 洗牌（返回新数组，不改动原池）
    _shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }

    _onModelClick() { if (this.onModelClick) this.onModelClick(); }

    // —— 待机台词调度（路线 C，纯本地，不接 WorkBuddy）——
    // pool: 字符串数组或 {text,time} 数组；缺失时退化为内置 DEFAULT_IDLE_LINES。
    initIdleChat(pool, opts) {
      this._idlePool = (pool && Array.isArray(pool) && pool.length) ? pool : DEFAULT_IDLE_LINES;
      this._idleEnabled = true;
      this._idleGapMin = (opts && opts.min) || 14000;
      this._idleGapMax = (opts && opts.max) || 38000;
      this._scheduleIdleLine();
    }

    // 待机台词总开关（托盘菜单可实时切换）。关闭只停"自动随机"，
    // 底栏「待机」按钮的手动触发不受影响。
    setIdleEnabled(on) {
      this._idleEnabled = !!on;
      if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
      if (this._idleEnabled) this._scheduleIdleLine();
      if (window.desktopPet && window.desktopPet.log) {
        window.desktopPet.log('[idle] 待机台词（自动随机）=' + (on ? 'on' : 'off'));
      }
    }

    // 立即手动触发一条待机台词（底栏「待机」按钮）。
    // 正在说话时不打断（避免叠音）；触发前清掉待排的自动计时，播完由收尾逻辑重排。
    forceIdleLine() {
      if (this.speaking || (this._talk && this._talk.active)) return false;
      if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
      const line = this._pickIdleLine();
      if (!line) { this._scheduleIdleLine(); return false; }
      if (this.onPickLine && line.entry != null) { this.onPickLine('idle', line.idx, line.entry); return true; }
      this.playIdleLine(line.text, line.emo);
      return true;
    }

    _scheduleIdleLine() {
      if (!this._idleEnabled) return;
      if (this._idleTimer) clearTimeout(this._idleTimer);
      const gap = this._rand(this._idleGapMin, this._idleGapMax);
      this._idleTimer = setTimeout(() => this._tryIdleLine(), gap);
    }

    _tryIdleLine() {
      this._idleTimer = null;
      if (!this._idleEnabled) return;
      if (this._talk.active) { this._scheduleIdleLine(); return; }  // 正在说话（chat），稍后重试
      const line = this._pickIdleLine();
      if (line) {
        // 走 onPickLine：中日切换 + 预生成音频播放都在此接管；未注入时退化显示气泡。
        if (this.onPickLine && line.entry != null) { this.onPickLine('idle', line.idx, line.entry); }
        else { this.playIdleLine(line.text, line.emo); }
      } else { this._scheduleIdleLine(); }
    }

    // 按时间标签过滤（白天/夜间），白天只出不带 night 的，夜间只出不带 day 的
    _pickIdleLine() {
      const pool = this._idlePool || DEFAULT_IDLE_LINES;
      const h = new Date().getHours();
      const isNight = (h >= 22 || h < 5);
      const cand = pool.filter((it) => {
        const t = (typeof it === 'string') ? 'any' : (it.time || 'any');
        if (t === 'any') return true;
        if (t === 'night') return isNight;
        if (t === 'day') return !isNight;
        return true;
      });
      const arr = cand.length ? cand : pool;
      // 洗牌队列：一轮内每条都出现一次才重建，避免随机抽取"同一句很快又刷到"；
      // 白天/夜间切换时（sig 变化）重建队列，保证时段过滤始终生效。
      const sig = isNight ? 'night' : 'day';
      if (!this._idleQueue || !this._idleQueue.length || this._idleQueueSig !== sig) {
        this._idleQueue = this._shuffle(arr);
        this._idleQueueSig = sig;
      }
      const pick = this._idleQueue.pop();
      const idx = pool.indexOf(pick);
      const entry = pick;
      // 返回 {text, emo, idx, entry}：emo 可为字符串(整句同一情绪)或数组(按标点分句 1:1 映射，使单句内情绪实时变化)。
      // idx/entry 供 onPickLine 按池索引定位预生成音频（manifest.pools[pool][idx]）。
      if (typeof pick === 'string') return { text: pick, emo: null, idx: idx, entry: pick };
      return { text: (pick && pick.text) || '', emo: (pick && pick.emo) || null, idx: idx, entry: entry };
    }

    playIdleLine(text, emo) {
      const line = String(text || '');
      this._talk = {
        active: true, mode: 'idle', text: line,
        i: 0, t: 0, charDur: this._randCharDur(), peak: this._randPeak(), vowels: null,
        emo: (typeof emo === 'string') ? emo : null,
        emoList: this._buildEmoList(line, emo)   // 分句情绪表（数组时按标点切分）
      };
      this._emoLinger = ''; this._emoLingerUntil = 0;   // 新台词开始，取消上一句的情绪余韵
      // 整行预取拼音 -> 元音数组（异步经主进程；加载完成前本行前几帧元音为 null，静默闭口，无碍）
      this._loadVowels(line).then((v) => {
        if (this._talk.mode === 'idle' && this._talk.text === line) this._talk.vowels = v;
      });
      this._visemeStats = { seen: {}, maxNz: 0 };   // 每条待机台词都累计元音分布，播完发一次整句小结
      if (this._dbgTalksLeft > 0) { this._visemeDebug = { n: 8 }; this._dbgTalksLeft--; }  // 前几次说话额外逐帧诊断
      if (this.onIdleLine) this.onIdleLine(text, emo);
    }

    // ==================== 模型自带表情 / 动作（R3） ====================
    _motionManager() {
      const m = this.model;
      return (m && m.internalModel && m.internalModel.motionManager) || null;
    }

    // 枚举当前模型可用的表情与动作，并上报主进程（设置页「表情与动作」分页据此渲染列表）。
    // 数据来源：pixi-live2d-display 的 motionManager.definitions（动作组 → 定义数组）
    // 与 motionManager.expressionManager.definitions（表情定义数组）。
    // 注意：动作只会出现在 model3.json 的 FileReferences.Motions 里 —— 这也是为什么
    // 需要主进程在服务层按 config.modelAssets 动态注入引用（见 main.js injectModelAssets）。
    refreshModelAssets() {
      const out = { expressions: [], motions: [] };
      try {
        const mm = this._motionManager();
        if (mm && mm.definitions && typeof mm.definitions === 'object') {
          for (const g of Object.keys(mm.definitions)) {
            const arr = mm.definitions[g] || [];
            for (let i = 0; i < arr.length; i++) {
              const spec = arr[i] || {};
              out.motions.push({
                group: g,
                index: i,
                file: spec.File || spec.file || '',
                loop: !!spec.Loop,
                duration: (spec.Duration != null) ? Number(spec.Duration) : null
              });
            }
          }
        }
        const em = mm && mm.expressionManager;
        const defs = (em && em.definitions) || null;
        if (defs) {
          for (let i = 0; i < defs.length; i++) {
            const d = defs[i] || {};
            out.expressions.push({ name: (d.Name != null ? String(d.Name) : ('expr' + i)), index: i });
          }
        }
      } catch (e) { /* 忽略 */ }
      this._assets = out;
      if (window.desktopPet && window.desktopPet.reportModelAssets) {
        try { window.desktopPet.reportModelAssets(out); } catch (e) {}
      }
      if (window.desktopPet && window.desktopPet.log) {
        const groups = Array.from(new Set(out.motions.map((x) => x.group)));
        window.desktopPet.log('[assets] 表情 ' + out.expressions.length + ' 个 / 动作 ' +
          out.motions.length + ' 个' + (groups.length ? '（组：' + groups.join('、') + '）' : ''));
      }
      return out;
    }

    getModelAssets() { return this._assets || { expressions: [], motions: [] }; }

    // 播放模型自带表情（nameOrIndex = 表情名或索引）。
    // holdMs：挂起情绪层的时长。模型表情没有"时长"概念（写一次参数即保持），
    // 所以给一个默认保持窗口，避免情绪层在下一帧就把五官写回去。
    playExpression(nameOrIndex, holdMs) {
      const m = this.model;
      if (!m || typeof m.expression !== 'function') return false;
      const hold = (holdMs == null) ? 3000 : Math.max(300, Number(holdMs) || 3000);
      this._exprHoldUntil = performance.now() + hold;
      const fail = (why) => {
        this._exprHoldUntil = 0;
        if (window.desktopPet && window.desktopPet.log) window.desktopPet.log('[assets] 表情播放失败：' + nameOrIndex + ' ' + why);
      };
      try {
        const p = m.expression(nameOrIndex);
        if (p && typeof p.then === 'function') {
          p.then((r) => { if (!r) fail('（模型无此表情）'); }).catch((e) => fail(String(e && e.message || e)));
        }
        if (this.onAssetEvent) this.onAssetEvent({ kind: 'expression', target: String(nameOrIndex) });
        return true;
      } catch (e) { fail(String(e && e.message || e)); return false; }
    }

    // 播放模型自带动作。group + index 定位（index 缺省 0）。
    // holdMs = 0 表示"保持到下一次触发"（用于循环动作，如长时间的待机动作）；
    // 不传则用动作自身时长（拿不到定义时长时退化为 4 秒）。
    playMotion(group, index, opts) {
      const m = this.model;
      const o = (opts && typeof opts === 'object') ? opts : {};
      if (!m || typeof m.motion !== 'function' || !group) return false;
      const PRIO = (window.PIXI && window.PIXI.live2d && window.PIXI.live2d.MotionPriority &&
        window.PIXI.live2d.MotionPriority.FORCE != null) ? window.PIXI.live2d.MotionPriority.FORCE : 3;
      let dur = null, loop = !!o.loop;
      try {
        const mm = this._motionManager();
        const arr = (mm && mm.definitions && mm.definitions[group]) || [];
        const spec = arr[Number(index) || 0] || {};
        if (spec.Duration != null) dur = Number(spec.Duration);
        else if (spec.duration != null) dur = Number(spec.duration);
        if (spec.Loop || spec.loop) loop = true;
      } catch (e) { /* 忽略 */ }
      let hold;
      if (o.holdMs != null) hold = Number(o.holdMs);
      else if (dur) hold = Math.min(60000, Math.max(800, dur * 1000 + 400));
      else hold = 6000;
      this._motionHoldUntil = (hold === 0) ? Infinity : (performance.now() + hold);
      // 到期统一停掉本次动作：motion3.json 自带的 Loop 会让它一直循环，
      // 不停就会永久占住头部/躯干参数（参数化待机永远回不来）。
      // hold=0 表示"保持到下一次触发"，此时不自动停。
      this._motionLoopStop = (hold === 0) ? null : String(group);
      const fail = (why) => {
        this._motionHoldUntil = 0; this._motionLoopStop = null;
        if (window.desktopPet && window.desktopPet.log) window.desktopPet.log('[assets] 动作播放失败：' + group + '#' + index + ' ' + why);
      };
      // 用动作文件自身的时长修正保持窗口（model3.json 里没有时长信息，只有加载后才拿得到）
      const fixHold = () => {
        if (o.holdMs != null || this._motionHoldUntil === Infinity) return;
        try {
          const mm = this._motionManager();
          const arr = mm && mm.motionGroups && mm.motionGroups[String(group)];
          const mo = arr && arr[Number(index) || 0];
          const d = (mo && typeof mo.getDuration === 'function') ? Number(mo.getDuration()) : null;
          if (d && d > 0) {
            this._motionHoldUntil = performance.now() + Math.min(60000, Math.max(800, d * 1000 + 400));
          }
        } catch (e) { /* 忽略 */ }
      };
      try {
        const p = m.motion(String(group), Number(index) || 0, PRIO);
        if (p && typeof p.then === 'function') {
          p.then((r) => { if (!r) fail('（模型无此动作）'); else fixHold(); })
            .catch((e) => fail(String(e && e.message || e)));
        } else { fixHold(); }
        if (this.onAssetEvent) this.onAssetEvent({ kind: 'motion', target: String(group) + '#' + (Number(index) || 0) });
        return true;
      } catch (e) { fail(String(e && e.message || e)); return false; }
    }

    // 立刻停止模型动作（解除挂起，参数化待机恢复接管）
    stopMotions() {
      this._motionHoldUntil = 0;
      this._motionLoopStop = null;
      try {
        const mm = this._motionManager();
        if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions();
      } catch (e) { /* 忽略 */ }
    }

    // 每帧：动作保持窗口到期处理（循环动作必须显式停，否则会一直循环下去）
    _assetExpire(now) {
      if (!this._motionHoldUntil || this._motionHoldUntil === Infinity) return;
      if (now < this._motionHoldUntil) return;
      this._motionHoldUntil = 0;
      if (this._motionLoopStop) {
        this._motionLoopStop = null;
        try {
          const mm = this._motionManager();
          if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions();
        } catch (e) { /* 忽略 */ }
      }
    }

    // 卸掉当前模型与渲染器，供"换模型热重载"复用同一个 controller 实例。
    // 不彻底清理会在换模型后留下旧的 PIXI 应用（旧画布仍挂在 DOM 上，两套 ticker 同时写参数）。
    destroy() {
      try { if (this._cursorTimer) { clearInterval(this._cursorTimer); this._cursorTimer = null; } } catch (e) {}
      try { if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; } } catch (e) {}
      try { if (this._debugTimer) { clearInterval(this._debugTimer); this._debugTimer = null; } } catch (e) {}
      try { if (this._winUp) { window.removeEventListener('pointerup', this._winUp); } } catch (e) {}
      this._winUp = null;
      try { if (this.app) this.app.destroy(true, { children: true }); } catch (e) {}
      this.app = null;
      this.model = null;
      this._assets = { expressions: [], motions: [] };
      this._exprHoldUntil = 0;
      this._motionHoldUntil = 0;
      this._motionLoopStop = null;
      this._mouse = { x: 0, y: 0, inside: false };
      this._gazeX = 0; this._gazeY = 0; this._headX = 0; this._headY = 0;
      this._gx = 0; this._gy = 0; this._gz = 0;
      this._gesture = null; this._nextGesture = 0;
      this._blink = { next: 0, active: false, t: 0, phase: 'close', long: false,
        closeDur: 90, openDur: 110, holdDur: 30 };
      this._paramSet = null;
      this._vowelParam = { a: '', i: '', u: '', e: '', o: '' };
      this._silenceParam = '';
      this._visemeMode = false;
      this._talk = { active: false, mode: 'idle', text: '', i: 0, t: 0, charDur: 140, peak: 0.8, vowels: null };
      this._audioOpen = 0;
      this._chatText = ''; this._chatPtr = 0; this._chatT = 0;
      this._emoCur = Object.assign({}, EMO_NEUTRAL);
      this._emoTarget = 'neutral';
      this._emoLinger = ''; this._emoLingerUntil = 0;
      this._eyeOpenBase = 1;
      this.speaking = false;
    }

    _fit() {
      if (!this.model || !this.container) return;
      const w = this.container.clientWidth || 360;
      const h = this.container.clientHeight || 360;
      // 用"原始尺寸"计算基准缩放，保证幂等：无论当前缩放/位置如何，
      // 只要调用 _fit（重置）就一定能回到同一个大小与居中位置。
      // 舞台现在铺满整个窗体（含聊天面板背后），所以模型高度取 0.82 倍、
      // 并整体略偏上 —— 既不顶着灯带，也让头部避开底部玻璃面板。
      const scale = (h * 0.82) / this._naturalH;
      const mh = this._naturalH * scale;
      this.model.scale.set(scale);
      this.model.x = (w - this._naturalW * scale) / 2;
      this.model.y = h * 0.5 - mh / 2 - h * 0.04;
      this.baseScale = scale;
      this.userTransformApplied = false;
      this.app.renderer.resize(w, h);
    }

    // 直接套用一组变换（不改动 baseScale / 不触发持久化以外的事）
    _applyTransformRaw(scale, x, y) {
      if (!this.model) return;
      this.model.scale.set(scale);
      this.model.x = x;
      this.model.y = y;
      this._clamp();
    }

    // 锁定开关。silent=true 时只改内部状态、不回调（用于初始化回放，避免重复触发 UI）
    _setLocked(v, silent) {
      if (this.locked === v) return;
      this.locked = !!v;
      if (this.container) this.container.style.cursor = this.locked ? 'default' : 'move';
      if (!silent && this.onLockChange) this.onLockChange(this.locked);
      this._persist();
    }

    setLocked(v) { this._setLocked(v, false); }

    resetTransform() {
      this.userTransformApplied = false;
      this._setLocked(false, true);
      if (this.onLockChange) this.onLockChange(false);
      if (this.model) this._fit();
      try { window.localStorage.removeItem(this._LS_KEY); } catch (e) {}
      if (this.container) this.container.style.cursor = 'move';
    }

    // 软性边界：允许模型被移到几乎完全离开窗口，只在"整块消失"之前收住。
    // 旧实现把模型中心限制在舞台内，模型一大就只能在小范围里挪，所以"拖不到位"。
    // 现在只要模型还有一小块（最多 40px 或自身的 12%）留在窗口内就放行，
    // 万一真的找不到模型，点底部「重置」一键归位。
    _clamp() {
      if (!this.model || !this.container) return;
      const w = this.container.clientWidth || 360;
      const h = this.container.clientHeight || 360;
      const mw = this.model.width;
      const mh = this.model.height;
      const keepX = Math.min(mw, Math.max(40, mw * 0.12));
      const keepY = Math.min(mh, Math.max(40, mh * 0.12));
      let minX = -mw + keepX, maxX = w - keepX;
      let minY = -mh + keepY, maxY = h - keepY;
      // 模型比可视区还小时上下界会反过来，此时直接居中（保持可见）
      if (minX > maxX) { const c = (w - mw) / 2; minX = c; maxX = c; }
      if (minY > maxY) { const c = (h - mh) / 2; minY = c; maxY = c; }
      this.model.x = Math.min(maxX, Math.max(minX, this.model.x));
      this.model.y = Math.min(maxY, Math.max(minY, this.model.y));
    }

    _persist() {
      try {
        const o = {
          scale: this.model ? this.model.scale.x : 1,
          x: this.model ? this.model.x : 0,
          y: this.model ? this.model.y : 0,
          locked: this.locked
        };
        window.localStorage.setItem(this._LS_KEY, JSON.stringify(o));
      } catch (e) {}
    }

    _loadLayout() {
      try {
        const s = window.localStorage.getItem(this._LS_KEY);
        if (!s) return null;
        const o = JSON.parse(s);
        if (typeof o.scale === 'number' && typeof o.x === 'number' && typeof o.y === 'number') return o;
      } catch (e) {}
      return null;
    }

    // —— 交互：拖动移动 / 滚轮缩放 ——
    _onDown(e) {
      if (this.locked || !this.model) return;
      this._dragging = true;
      this._sx = e.clientX; this._sy = e.clientY;
      this._ox = this.model.x; this._oy = this.model.y;
      if (this.container) this.container.style.cursor = 'grabbing';
      e.preventDefault();
    }
    _onMove(e) {
      if (!this._dragging || !this.model) return;
      this.model.x = this._ox + (e.clientX - this._sx);
      this.model.y = this._oy + (e.clientY - this._sy);
      this._clamp();
      this.userTransformApplied = true;
      this._persist();
    }
    _onUp() {
      if (!this._dragging) return;
      this._dragging = false;
      if (this.container) this.container.style.cursor = this.locked ? 'default' : 'move';
    }
    _onWheel(e) {
      if (this.locked || !this.model) return;
      e.preventDefault();
      const view = this.app.view;
      const rect = view.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const old = this.model.scale.x;
      let ns = e.deltaY < 0 ? old * 1.15 : old / 1.15;
      // 缩放范围：基准的 20% ~ 3000%（上限足够大，可自由放大到想要的大小）
      const min = this.baseScale * 0.2;
      const max = this.baseScale * 30;
      ns = Math.max(min, Math.min(max, ns));
      const k = ns / old;
      // 以光标为锚点缩放，保持光标下的点不动
      this.model.x = cx - (cx - this.model.x) * k;
      this.model.y = cy - (cy - this.model.y) * k;
      this.model.scale.set(ns);
      this._clamp();
      this.userTransformApplied = true;
      this._persist();
    }

    setSpeaking(v) {
      this.speaking = !!v;
      if (v) {
        // 正在播待机台词时被聊天打断：先排好下一条，避免之后永不再播
        if (this._talk.mode === 'idle' && this._talk.active) this._scheduleIdleLine();
        this._talk.active = true;
        this._talk.mode = 'chat';
        this._chatPtr = 0; this._chatT = 0;
        this._visemeStats = null;  // 聊天接管：丢弃待机诊断统计，避免错配台词
        if (this._dbgTalksLeft > 0) { this._visemeDebug = { n: 8 }; this._dbgTalksLeft--; }  // 前几次说话触发诊断采样
      } else {
        this._talk.active = false;
        this._chatText = '';
        if (this._idleEnabled) this._scheduleIdleLine(); // 聊天结束，恢复待机台词调度
      }
    }

    resize() {
      if (!this.app || !this.container) return;
      const w = this.container.clientWidth || 360;
      const h = this.container.clientHeight || 360;
      this.app.renderer.resize(w, h);
      // 用户已手动调整过位置/缩放时，不强行居中，保留当前布局
      if (!this.userTransformApplied && this.model) this._fit();
    }
  }

  window.Live2DController = Live2DController;
})();
