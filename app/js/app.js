// app.js —— 界面逻辑：加载 Live2D + 桥接 WorkBuddy 对话
(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const live2dBox = document.getElementById('live2d');
  const hintEl = document.getElementById('live2d-hint');
  const frameEl = document.getElementById('window-frame');

  const GREETING_KEY = 'l2d-greeted-v1';
  const GLASS_KEY = 'l2d-bg-glass-v1';

  let CONFIG = {};
  let persona = null;        // 人设（app/data/persona.json，三种大脑共用）
  let brain = null;          // 当前聊天后端实例
  let brainKind = 'cloud';   // local | cloud | workbuddy
  let connected = false;     // 当前后端是否探活成功
  let bootAttempts = 0;
  let acpPort = 0;           // 主进程自动发现的 ACP 端口（仅用于状态栏展示）
  const l2d = new window.Live2DController();
  // 调试/自检句柄：tools/selfcheck 与一次性探针靠它读取模型状态（缩放、位置、锁定）。
  // 只挂在 window 上，不参与业务逻辑。
  window.__l2d = l2d;

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  // 秒级时长格式化（思考 / 合成计时用）
  function fmtSec(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + 's'; }

  // 发送框自适应高度：默认一行；随内容增长，超过约第 6 行后内部滚动。
  function autoGrow() {
    inputEl.style.height = 'auto';
    const max = 140;
    const h = Math.min(inputEl.scrollHeight, max);
    inputEl.style.height = h + 'px';
    inputEl.style.overflowY = inputEl.scrollHeight > max ? 'auto' : 'hidden';
  }

  // 只改气泡正文，保留「停止思考」按钮等兄弟节点不被 textContent 清掉
  function setBubbleText(bubble, text) {
    const t = bubble.querySelector('.bubble-text');
    if (t) t.textContent = text;
    else bubble.textContent = text;
  }

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const t = document.createElement('span');
    t.className = 'bubble-text';
    t.textContent = text;
    div.appendChild(t);
    if (role === 'assistant') {
      // 鼠标悬停到正在生成的气泡时才浮现的「停止思考」
      const stop = document.createElement('span');
      stop.className = 'stop-think';
      stop.textContent = '停止思考';
      stop.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (div.classList.contains('generating') && brain && typeof brain.abort === 'function') {
          brain.abort();
        }
      });
      div.appendChild(stop);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // 系统提示（居中的窄条），用于链路状态一类的"非对话"信息
  function addSystem(text) { return addMsg('system', text); }

  function showMessages() {
    const chat = document.getElementById('chat');
    if (chat && chat.classList.contains('compact')) {
      chat.classList.remove('compact');
      setTimeout(() => l2d.resize(), 30);
    }
  }

  // 语音（TTS）总开关：初值取自 config.json，托盘菜单可运行时切换（pet:setTTS）
  let ttsOn = false;          // 是否启用语音
  let ttsVoice = '';          // 指定音色（空 = 引擎默认）
  let idleOn = true;          // 待机台词（自动随机）开关：托盘可实时切换
  let displayLang = 'cn';     // 台词显示语言（'cn'/'jp'/'en'），托盘可切
  let voiceLang = 'cn';       // 语音语言（'cn'/'jp'/'en'），托盘可切

  async function loadConfig() {
    try {
      CONFIG = await fetch('/config.json').then(r => r.json());
    } catch (e) {
      CONFIG = {};
    }
    ttsOn = CONFIG.ttsEnabled !== false;
    ttsVoice = CONFIG.ttsVoice || '';
    idleOn = CONFIG.idleLinesEnabled !== false;
    displayLang = CONFIG.idleDisplayLang || 'cn';
    voiceLang = CONFIG.idleVoiceLang || 'cn';
    let vol = Number(CONFIG.ttsVolume);
    if (!isFinite(vol)) vol = 10;
    try { const sv = localStorage.getItem('l2d-tts-volume'); if (sv !== null) vol = Number(sv); } catch (e) { /* 忽略 */ }
    ttsVolume = Math.max(0, Math.min(100, Math.round(isFinite(vol) ? vol : 10)));
    // 把口型调试开关同步给 live2d-loader（托盘菜单可运行时改写这些值）
    window.__companionConfig = CONFIG;
    if (window.__l2d) {
      window.__l2d.config = CONFIG;
      window.__l2d._vowelFamily = CONFIG.vowelParamFamily || 'auto';
      window.__l2d._driveOpenY = CONFIG.vowelModeDriveOpenY !== false;
      window.__l2d._silenceSpeaking = (CONFIG.silenceSpeakingValue === 1) ? 1 : 0;
      window.__l2d._emotionEnabled = CONFIG.emotionEnabled !== false;   // 情绪/表情层总开关
    }
    loadBindings();
  }

  // ---------------------------------------------------------------- 背景模式
  // 透明底：模型浮在桌面上，除聊天面板与底栏外全部透空。
  // 毛玻璃：给窗口套一层半透明磨砂底，可以透出下方的窗口内容。
  function applyBackground(glass, persist) {
    if (frameEl) frameEl.classList.toggle('glass-mode', !!glass);
    const b = document.getElementById('btn-glass');
    if (b) {
      b.textContent = glass ? '毛玻璃' : '透明';
      b.classList.toggle('active', !!glass);
      b.title = glass
        ? '当前：毛玻璃底（半透明，可透出下方窗口）— 点击切回透明底'
        : '当前：透明底（模型直接浮在桌面上）— 点击切换为毛玻璃底';
    }
    if (persist) { try { localStorage.setItem(GLASS_KEY, glass ? '1' : '0'); } catch (e) { /* 忽略 */ } }
  }

  function initBackground() {
    let saved = null;
    try { saved = localStorage.getItem(GLASS_KEY); } catch (e) { /* 忽略 */ }
    const glass = saved !== null ? saved === '1' : (CONFIG.startupBackground === 'glass');
    applyBackground(glass, false);
  }

  // ---------------------------------------------------------------- Live2D
  // 把本模型真实存在的参数 ID 列表上报给主进程，供设置窗「额外追踪参数」下拉枚举。
  // 优先公开方法 getAllParamIds()，无则退回内部的 _getAllParamIds()；拿不到就静默跳过。
  function reportModelParamsToMain(ctrl) {
    try {
      if (!window.desktopPet || !window.desktopPet.reportModelParams) return;
      const ids = ctrl
        ? (ctrl.getAllParamIds ? ctrl.getAllParamIds()
          : (ctrl._getAllParamIds ? ctrl._getAllParamIds() : []))
        : [];
      if (Array.isArray(ids) && ids.length) window.desktopPet.reportModelParams(ids);
    } catch (e) {}
  }

  // 枚举本机音频输入设备并上报主进程，供设置窗「监听设备」下拉使用。
  // 主窗口已持有媒体权限上下文，能拿到真实设备名；设置窗自己枚举 label 会是空的。
  function reportAudioDevicesToMain() {
    try {
      if (!window.desktopPet || !window.desktopPet.reportAudioDevices) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices.enumerateDevices().then((list) => {
        // 同时上报输入与输出设备：输出设备不能直接采集，但列出便于用户核对
        // （回环抓的是"Windows 默认输出设备"的混音，用户需要知道自己默认的是哪个）。
        // 注意：未获媒体授权时 label 为空，所以开启音律识别后还会再补报一次（见 pet:setMusic）。
        const all = (list || []).filter((d) => d && (d.kind === 'audioinput' || d.kind === 'audiooutput'))
          .map((d) => ({
            deviceId: d.deviceId,
            label: d.label || ((d.kind === 'audiooutput' ? '输出设备 ' : '输入设备 ') + String(d.deviceId || '').slice(0, 8)),
            kind: d.kind
          }));
        window.desktopPet.reportAudioDevices(all);
      }).catch(() => {});
    } catch (e) {}
  }

  // 音律识别状态上报（供设置窗「音律识别」的观测面板显示）。
  // 设置窗是独立窗口，读不到主窗渲染进程里的追踪器，所以这里每 500ms 把状态发给主进程缓存。
  //   mode: '-' 未检测到音乐 / 'A' 只跑连续律动（BPM 未锁定）/ 'B' 已锁定 BPM 的正弦律动
  let musicReportTimer = null;
  function startMusicStateReport() {
    if (musicReportTimer) return;
    const tick = () => {
      try {
        if (!window.desktopPet || !window.desktopPet.reportMusicState) return;
        const M = window.__musicTracker;
        if (!M) { window.desktopPet.reportMusicState({ enabled: false, active: false, playing: false, mode: '-', bpm: 0, level: 0 }); return; }
        const playing = M.isPlaying ? M.isPlaying() : false;
        const locked = M.isBpmStable ? M.isBpmStable() : false;
        const bpm = (M.getBpm ? M.getBpm() : 0) || 0;
        // 实际跑的方案：tracker.getMode() 已综合 enableA/enableB 开关与 BPM 是否测稳；
        // 旧逻辑（playing ? locked?'B':'A' : '-'）仅作兜底。
        const mode = (M.getMode ? M.getMode() : (playing ? (locked ? 'B' : 'A') : '-'));
        window.desktopPet.reportMusicState({
          enabled: !!(M.isEnabled ? M.isEnabled() : false),   // 音律识别开关（区分"没开"与"开了但没采到音频"）
          active: !!(M.isActive ? M.isActive() : false),      // 采集是否真的跑起来了
          playing: !!playing,
          mode: mode,
          bpm: (mode === 'B') ? bpm : 0,
          level: M.getLevel ? M.getLevel() : 0
        });
      } catch (e) {}
    };
    tick();
    musicReportTimer = setInterval(tick, 500);
  }

  // 追踪器（屏幕运动 / 音律识别）只在首次加载模型时初始化：换模型热重载时复用同一实例，
  // 重复 init 会在同一份渲染进程里拉起两套采集循环。
  let trackersInited = false;

  function initLive2D() {
    if (!l2d.ready()) {
      const miss = l2d.diagnose ? l2d.diagnose() : [];
      hintEl.textContent = 'Live2D 依赖未就绪，缺少：' + (miss.join('、') || '未知') +
        '。请先 npm install，并确认 index.html 引用的 UMD 路径（见 SETUP.md / 运行说明.md）。';
      return;
    }
    const url = (CONFIG.modelUrl) || '/models/Hotaru2024/hotaru2024.model3.json';
    l2d.idle = CONFIG.idleMotion !== false;
    l2d.load(live2dBox, url).then(() => {
      hintEl.style.display = 'none';
      // 把从本地存储恢复的锁定状态同步到 UI 与主进程（托盘菜单标签）
      updateLockButton(l2d.locked);
      if (window.desktopPet) window.desktopPet.lockModel(l2d.locked);
      // 拖动提示几秒后淡出
      const tip = document.getElementById('drag-tip');
      if (tip) setTimeout(() => tip.classList.add('faded'), 6000);
      // 待机台词（路线 C，纯本地、不接 WorkBuddy）：台词以浮动气泡显示，
      // 口型由 live2d-loader 按文本逐字驱动（C8 口型断句）。
      l2d.onIdleLine = onIdleShown;          // 气泡仅显示（音频由 onPickLine 统一接管）
      l2d.onPickLine = onPickLine;           // 按显示/语音语言选预置音频、自录音频或运行时合成
      l2d.onModelClick = onModelClick;       // 点击模型：播台词（行为不变）+ 触发绑定的表情/动作
      l2d.onAssetEvent = (ev) => {
        if (window.desktopPet && window.desktopPet.log) {
          window.desktopPet.log('[assets] 播放 ' + ev.kind + ' ' + ev.target);
        }
      };
      startIdleChat();
      if (!trackersInited) {
        trackersInited = true;
        // 屏幕运动追踪（路线 D）：模型像追鼠标一样盯住画面里移动的物体。默认关闭，
        // 由托盘菜单「屏幕运动追踪」或快捷键 Ctrl+Shift+M 开启；开启后会经 getUserMedia 采集主屏。
        if (window.ScreenTracker && window.ScreenTracker.init) {
          window.__screenTracker = window.ScreenTracker.init(l2d);
        }
        // 音律识别（BPM/节拍驱动闭眼跟拍）：经系统音频回环检测节拍，驱动头部下点头 + 闭眼。
        if (window.MusicTracker && window.MusicTracker.init) {
          window.__musicTracker = window.MusicTracker.init();
          l2d.setMusicTracker(window.__musicTracker);
          // 让追踪器能读到"实际写进模型的参数值"（真身是 live2d-loader 的 _musicTick）。
          // 调试面板上最关键的一列就是它：分辨"算出来有律动但没写进模型"与"根本没算出律动"。
          if (window.__musicTracker.setModelProbe) {
            window.__musicTracker.setModelProbe(() => (l2d.getMusicDebug ? l2d.getMusicDebug() : null));
          }
          const men = window.__companionConfig && window.__companionConfig.music;
          if (men && men.enabled) l2d.setMusicEnabled(true);
        }
        if (window.__musicTracker && window.__companionConfig && window.__companionConfig.music) {
          window.__musicTracker.setParams(window.__companionConfig.music);
        }
      }
      // 重要：把持久化的视线跟随 / 音律识别参数在启动时推给渲染进程。否则上次在设置窗改过的值
      // 只写进了 config.json（菜单里看得到），但 live2d 仍用旧默认值——要等下次改任意参数触发
      // 一次保存（applyConfigKey → pet:setGazeCfg/pet:setMusicCfg）才生效。这里补上初始下发。
      const g = window.__companionConfig && window.__companionConfig.gaze;
      if (l2d && l2d.setGazeCfg && g) l2d.setGazeCfg(g);
      // 模型参数列表上报主进程：设置窗「额外追踪参数」下拉要枚举本模型真实存在的参数 ID
      reportModelParamsToMain(l2d);
      // 启动音律识别状态上报（设置窗观测面板：是否检测到音乐 / A 还是 B / BPM）
      startMusicStateReport();
      // 上报本机音频输入设备（设置窗「监听设备」下拉用）
      reportAudioDevicesToMain();
      // 鼠标追踪总开关：按配置初值设定（默认开；设置窗/托盘可关）
      if (l2d && l2d.setMouseFollow) {
        const mf = window.__companionConfig && window.__companionConfig.mouseFollow;
        l2d.setMouseFollow(mf !== false);
      }
      // 屏幕运动追踪：启动时按配置初始化（含"额外牵动参数"），并把"配置里已打开"的追踪直接拉起——
      // 否则重启程序后托盘虽显示已勾选、实际却没在采集，必须先到设置里关开一次才动（问题①相关）。
      // 采集本身的首次失败/卡死由追踪器内的"健康守护"自动重试，这里只管把状态对齐配置。
      if (window.__screenTracker && window.__companionConfig && window.__companionConfig.screenTrack) {
        const st = window.__companionConfig.screenTrack;
        try {
          if (window.__screenTracker.setParams) window.__screenTracker.setParams(st);
          if (st.screenIndex != null && window.__screenTracker.setScreen) window.__screenTracker.setScreen(st.screenIndex);
          if (st.enabled) window.__screenTracker.setEnabled(true);
        } catch (e) { /* 追踪器未就绪时忽略，后续由设置窗/托盘触发 */ }
      }
    }).catch((e) => {
      console.error(e);
      hintEl.textContent = '模型加载失败：' + e.message;
    });
  }

  // 换模型：热重载（不重启程序，保住聊天记录与 WorkBuddy 链路）。
  // 顺序很重要：先卸旧模型 → 重读 config（模型绑定/台词档/绑定可能一起变了）→ 重读台词档 → 加载新模型。
  let reloading = false;
  async function reloadModel(url) {
    if (reloading) return;
    reloading = true;
    try {
      if (url) CONFIG.modelUrl = url;
      try { if (l2d.destroy) l2d.destroy(); } catch (e) { /* 忽略 */ }
      hintEl.style.display = '';
      hintEl.textContent = '正在载入模型…';
      await loadConfig();
      applyUIFont(window.__companionConfig);
      await loadLineProfile();
      initLive2D();
    } finally {
      reloading = false;
    }
  }

  // ---------------------------------------------------------------- 待机台词（路线 C）
  // 随机播放待机台词，不接 WorkBuddy；台词以浮动气泡显示，口型由 live2d-loader 按文本驱动。
  let idleBubbleTimer = null;
  // 气泡默认停留时长：随文本长度，最少 3.5s、最多 8s
  function bubbleDefaultMs(text) {
    return Math.min(8000, Math.max(3500, (text ? text.length : 0) * 220 + 1500));
  }
  // 统一的气泡隐藏计时：若语音还在播，则暂不隐藏、稍后重试，
  // 避免"文字在语音播完前就消失"。语音结束后由 onended 重新计时。
  function armBubbleHide(ms) {
    if (idleBubbleTimer) clearTimeout(idleBubbleTimer);
    idleBubbleTimer = setTimeout(() => {
      if (window.__ttsPlaying) { armBubbleHide(400); return; }
      const b = document.getElementById('idle-bubble');
      if (b) b.classList.remove('show');
    }, ms);
  }
  function showIdleBubble(text, holdMs) {
    const b = document.getElementById('idle-bubble');
    if (!b) return;
    b.textContent = text;
    b.classList.add('show');
    armBubbleHide(holdMs != null ? holdMs : bubbleDefaultMs(text));
  }
  // 让气泡再停留 ms（TTS 播完时调用 → 语音结束后约 2 秒才消失）
  function holdBubble(ms) { armBubbleHide(ms); }
  function startIdleChat() {
    const opts = { min: Number(CONFIG.idleLineMin) || 14000, max: Number(CONFIG.idleLineMax) || 38000 };
    // 台词池来自"台词档"（见 loadLineProfile）。档里为空时不注入任何池，
    // loader 会退化为内置兜底台词 —— 也就是"新模型默认不沿用原语音"的落地表现。
    if (lineProfile.idle.length) l2d.initIdleChat(lineProfile.idle, opts);
    l2d.setIdleEnabled(idleOn);
    l2d.setClickLines(lineProfile.click.length ? lineProfile.click : null);
  }

  // ---------------------------------------------------------------- 语音（TTS）
  // 台词气泡出现时，并行请求本地 TTS 侧车合成语音并播放（/api/tts 由主进程同源代理）。
  // 侧车不可用时静默失败，不影响气泡与口型。
  // 本步只做"文本 → WAV → 播放"；下一步将用 AnalyserNode 的 RMS 驱动 ParamMouthOpenY，
  // 因此这里已把 analyser 接在播放链上，RMS 暂存到 window.__ttsRms 备用。
  let ttsCtx = null;
  let ttsSrc = null;
  let ttsAnalyser = null;
  let ttsGain = null;
  let ttsData = null;
  let ttsRaf = 0;
  let ttsVolume = 10;          // 播放音量 0-100（默认 10，避免一打开就震耳朵）
  let ttsMuted = false;        // 静音开关（点「音量」二字切换；不改动 ttsVolume）
  let ttsStartAt = 0;          // 本次播放的 AudioContext 起始时间
  let ttsDuration = 0;         // 本次音频时长（秒），用于算播放进度

  function onIdleShown(text, emo) {
    showIdleBubble(text);
  }

  // ---------------------------------------------------------------- 台词档（profile）
  // 台词不再写死在 click-lines.json / idle-lines.json，而是读"台词档"：
  //   app/data/lines/profiles/<id>.json  →  { name, click:[...], idle:[...] }
  // 每条台词含中/日/英文本 + emo + **三语言各自独立的语音来源**：
  //   { src:'file', file:'click_cn_00.wav' }   项目内预生成音频（相对 app/data/lines/）
  //   { src:'abs',  file:'D:/我的录音/a.wav' }  使用者自己录的音频（引用原路径，不复制）
  //   { src:'tts',  engine:'edge', voice:'en-US-AriaNeural' }  运行时合成
  // 模型 ↔ 台词档的绑定写在 config.lineProfile；未绑定的模型落到 default 档 ——
  // 这就是"替换后的模型默认不沿用原来做好的语音"的落实方式。
  let lineProfile = { id: '', name: '', click: [], idle: [] };

  function modelKeyFromUrl(url) {
    return String(url || '').replace(/^\/models\//, '').replace(/\\/g, '/');
  }
  function profileIdForModel() {
    const key = modelKeyFromUrl(CONFIG.modelUrl);
    const map = CONFIG.lineProfile || {};
    const hit = map && map[key];
    return hit ? String(hit) : 'default';
  }
  // 取某条台词在指定语言下的文本（英文/日文缺失时回退中文，避免念不出来）
  function lineText(entry, lang) {
    if (!entry) return '';
    if (lang === 'jp') return entry.jp || entry.text || '';
    if (lang === 'en') return entry.en || entry.text || '';
    return entry.text || '';
  }

  // 取某条台词在指定语言下该用的"语音来源"。
  // 关键点：若该语言没有文本（例如 hotaru 档没有英文台词），实际会被念的是中文，
  // 此时必须用中文的语音来源，否则会出现"用英文音色念中文"的怪声。
  function voiceFor(entry, lang) {
    if (!entry || !entry.voice) return null;
    const has = (lang === 'jp') ? !!entry.jp : (lang === 'en') ? !!entry.en : true;
    const use = has ? lang : 'cn';
    return entry.voice[use] || null;
  }

  async function loadLineProfile() {
    const id = profileIdForModel();
    let prof = null;
    try {
      if (window.desktopPet && window.desktopPet.getLineProfile) {
        const r = await window.desktopPet.getLineProfile(id);
        if (r && r.ok && r.profile) prof = r.profile;
      }
      if (!prof) {
        const r2 = await fetch('/app/data/lines/profiles/' + encodeURIComponent(id) + '.json');
        if (r2 && r2.ok) prof = await r2.json();
      }
    } catch (e) { /* 忽略：档缺失时用空池 */ }
    lineProfile = {
      id: id,
      name: (prof && prof.name) || id,
      click: (prof && Array.isArray(prof.click)) ? prof.click : [],
      idle: (prof && Array.isArray(prof.idle)) ? prof.idle : []
    };
    if (window.desktopPet && window.desktopPet.log) {
      window.desktopPet.log('[lines] 台词档=' + id + ' 点击 ' + lineProfile.click.length +
        ' 条 / 待机 ' + lineProfile.idle.length + ' 条');
    }
    return lineProfile;
  }

  // ---------------------------------------------------------------- 表情与动作触发（R3）
  // config.assets.bindings 结构：
  //   { id, kind:'expression'|'motion', target:<表情名>, group/index/holdMs/loop（动作用）,
  //     onClick:bool, onIdle:bool, onLine:'off'|'all'|'pick', lineRefs:['click:0', ...],
  //     hotkey:'Alt+1' }
  let bindings = [];
  let hotkeyScope = 'window';

  function loadBindings() {
    const A = (window.__companionConfig && window.__companionConfig.assets) || CONFIG.assets || {};
    bindings = Array.isArray(A.bindings) ? A.bindings.filter((b) => b && b.id) : [];
    hotkeyScope = (A.hotkeyScope === 'global') ? 'global' : 'window';
    if (window.desktopPet && window.desktopPet.log) {
      window.desktopPet.log('[assets] 触发绑定 ' + bindings.length + ' 条，快捷键范围=' + hotkeyScope);
    }
  }

  function playBinding(b) {
    if (!b || !window.__l2d) return false;
    if (b.kind === 'motion') {
      const hold = (b.holdMs == null || b.holdMs === '') ? undefined : Number(b.holdMs);
      return window.__l2d.playMotion(b.group, Number(b.index) || 0,
        { holdMs: isFinite(hold) ? hold : undefined, loop: !!b.loop });
    }
    const hold = (b.holdMs == null || b.holdMs === '') ? undefined : Number(b.holdMs);
    return window.__l2d.playExpression(b.target, isFinite(hold) ? hold : undefined);
  }

  // 收集某触发点该播的绑定。同一触发点若绑了多个动作，只随机挑一个播
  // （两个动作同时写同一批参数会互相打架）；表情可以都播（后写的覆盖前者）。
  function pickBound(trigger, ctx) {
    const hit = [];
    for (const b of bindings) {
      if (trigger === 'click') { if (b.onClick) hit.push(b); continue; }
      if (trigger === 'idle') { if (b.onIdle) hit.push(b); continue; }
      if (trigger === 'line') {
        const mode = b.onLine || 'off';
        if (mode === 'all') hit.push(b);
        else if (mode === 'pick' && ctx && Array.isArray(b.lineRefs) &&
          b.lineRefs.indexOf(ctx.pool + ':' + ctx.idx) >= 0) hit.push(b);
      }
    }
    const motions = hit.filter((b) => b.kind === 'motion');
    const exprs = hit.filter((b) => b.kind !== 'motion');
    const out = [];
    if (motions.length) out.push(motions[Math.floor(Math.random() * motions.length)]);
    return out.concat(exprs);
  }

  function playBound(trigger, ctx) {
    const list = pickBound(trigger, ctx);
    for (const b of list) { try { playBinding(b); } catch (e) { /* 忽略 */ } }
    return list.length;
  }

  window.__playAssetById = (id) => {
    const b = bindings.find((x) => x && x.id === id);
    if (!b) return false;
    return playBinding(b);
  };

  // 快捷键规格解析（"Alt+1" / "ctrl+shift+m"）；与主进程 normalizeAccelerator 的写法对齐。
  function parseKeySpec(s) {
    const out = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
    String(s || '').split('+').forEach((p) => {
      const t = p.trim(); if (!t) return;
      const l = t.toLowerCase();
      if (l === 'ctrl' || l === 'control') out.ctrl = true;
      else if (l === 'alt') out.alt = true;
      else if (l === 'shift') out.shift = true;
      else if (l === 'meta' || l === 'cmd' || l === 'super' || l === 'win') out.meta = true;
      else out.key = (t.length === 1) ? t.toUpperCase() : t;
    });
    return out;
  }
  function bindingMatchesHotkey(b, e) {
    if (!b || !b.hotkey) return false;
    const k = parseKeySpec(b.hotkey);
    if (!k.key) return false;
    const evKey = String(e.key || '');
    const keyOk = (k.key.length === 1)
      ? evKey.toUpperCase() === k.key
      : evKey.toLowerCase() === k.key.toLowerCase();
    return keyOk && !!e.ctrlKey === k.ctrl && !!e.altKey === k.alt &&
      !!e.shiftKey === k.shift && !!e.metaKey === k.meta;
  }

  // 点击模型：先播绑定的表情/动作，再播台词（台词行为保持不变）。
  function onModelClick() {
    playBound('click', null);
    l2d.sayClick();
  }

  // ---------------------------------------------------------------- 预生成 / 自录 / 合成 音频播放
  function ttsPlayWav(url, onFail) {
    const ctx = ttsEnsureCtx();
    if (!ctx) { if (onFail) onFail(); return; }
    // 立刻进入"音频嘴"状态，避免文本驱动抢先（嘴比声音快）
    window.__ttsPlaying = true; window.__ttsProgress = 0; window.__ttsRms = 0;
    fetch(url).then((r) => {
      if (!r.ok) throw new Error('audio ' + r.status);
      return r.arrayBuffer();
    }).then((ab) => ctx.decodeAudioData(ab)).then((buf) => {
      if (ttsSrc) { try { ttsSrc.stop(); } catch (e) { /* 忽略 */ } }
      ttsSrc = ctx.createBufferSource();
      ttsSrc.buffer = buf;
      ttsSrc.connect(ttsAnalyser);
      ttsStartAt = ctx.currentTime;
      ttsDuration = buf.duration || 0.001;
      ttsSrc.onended = () => {
        ttsSrc = null;
        window.__ttsRms = 0;
        window.__ttsPlaying = false;
        window.__ttsProgress = 1;
        holdBubble(2000);
        if (window.__l2d && typeof window.__l2d.onAudioEnded === 'function') window.__l2d.onAudioEnded();
      };
      ttsSrc.start();
      ttsRmsLoop();
    }).catch((e) => {
      window.__ttsPlaying = false;
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log('[audio] ' + e.message);
      // 音频文件缺失 / 解码失败 → 回落到运行时合成，避免"点了没声音"
      if (onFail) { try { onFail(); } catch (e2) { /* 忽略 */ } }
    });
  }

  // 台词被选中（来自 live2d-loader 的 sayClick / _tryIdleLine / forceIdleLine）。
  // pool: 'click'|'idle'；idx: 池内索引；entry: 台词档里的原始条目。
  function onPickLine(pool, idx, entry) {
    const dlang = displayLang, vlang = voiceLang;
    const displayText = lineText(entry, dlang);
    const audioText = lineText(entry, vlang);
    const emo = (entry && entry.emo) ? entry.emo : null;
    // 气泡显示（显示语言）；口型元音跟随音频语言（playIdleLine 的第三个参数）。
    if (window.__l2d) window.__l2d.playIdleLine(displayText || audioText, emo, audioText || displayText);
    // R3：绑定"播放台词时触发"的表情/动作（先触发，避免被语音加载拖后）
    playBound('line', { pool: pool, idx: idx });
    if (pool === 'idle') playBound('idle', null);
    if (!ttsOn) return;
    const v = voiceFor(entry, vlang);
    if (v && v.src === 'file' && v.file) {
      ttsPlayWav('/app/data/lines/' + String(v.file).replace(/^[\/\\]+/, ''),
        () => ttsSpeak(audioText, emo, v));
      return;
    }
    if (v && v.src === 'abs' && v.file) {
      ttsPlayWav('/api/user-audio?path=' + encodeURIComponent(v.file),
        () => ttsSpeak(audioText, emo, v));
      return;
    }
    if (audioText) ttsSpeak(audioText, emo, v);   // TTS 合成（含"沿用旧预生成"缺失时的兜底）
  }

  function ttsEnsureCtx() {
    if (!ttsCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ttsCtx = new AC();
      ttsAnalyser = ttsCtx.createAnalyser();
      ttsAnalyser.fftSize = 512;
      ttsGain = ttsCtx.createGain();
      ttsGain.gain.value = ttsEffectiveGain();
      // 链路：源 → 分析器（取 RMS，音量无关）→ 增益（音量）→ 输出
      ttsAnalyser.connect(ttsGain);
      ttsGain.connect(ttsCtx.destination);
      ttsData = new Uint8Array(ttsAnalyser.fftSize);
    }
    if (ttsCtx.state === 'suspended') { try { ttsCtx.resume(); } catch (e) {} }
    return ttsCtx;
  }

  function ttsSpeak(text, emo, src, opts) {
    if (!text) return false;
    // onStart：音频真正开始播放（ttsSrc.start）时回调——用于"先不冒泡、等语音就绪再一起放出来"
    const onStart = (opts && typeof opts.onStart === 'function') ? opts.onStart : null;
    const onEnd = (opts && typeof opts.onEnd === 'function') ? opts.onEnd : null;     // 播放结束（收尾说话态）
    const onFail = (opts && typeof opts.onFail === 'function') ? opts.onFail : null;   // 合成/解码失败
    const ctx = ttsEnsureCtx();
    if (!ctx) return false;
    // 立刻进入"音频嘴"状态：合成/网络期间响度=0 → 嘴闭合等待，
    // 避免文本驱动抢先跑完（那就是"嘴比 TTS 快"的观感）。
    window.__ttsPlaying = true;
    window.__ttsProgress = 0;
    window.__ttsRms = 0;
    // 引擎/音色优先级：台词自身指定 > 设置里"按语言"的预设 > 全局音色。
    const perLang = (CONFIG.ttsLang && CONFIG.ttsLang[voiceLang]) || {};
    const engine = (src && src.engine) || perLang.engine || '';
    const voice = (src && src.voice) || perLang.voice || ttsVoice || '';
    let q = '/api/tts?text=' + encodeURIComponent(text);
    if (emo) q += '&emo=' + encodeURIComponent(Array.isArray(emo) ? emo.join(',') : emo);
    if (engine) q += '&engine=' + encodeURIComponent(engine);
    if (voice) q += '&voice=' + encodeURIComponent(voice);
    fetch(q).then((r) => {
      if (!r.ok) throw new Error('TTS ' + r.status);
      return r.arrayBuffer();
    }).then((ab) => ctx.decodeAudioData(ab)).then((buf) => {
      if (ttsSrc) { try { ttsSrc.stop(); } catch (e) { /* 忽略 */ } }
      ttsSrc = ctx.createBufferSource();
      ttsSrc.buffer = buf;
      ttsSrc.connect(ttsAnalyser);
      ttsStartAt = ctx.currentTime;
      ttsDuration = buf.duration || 0.001;
      ttsSrc.onended = () => {
        ttsSrc = null;
        window.__ttsRms = 0;
        window.__ttsPlaying = false;
      window.__ttsProgress = 1;
      // 音频播完 → 气泡再停留 2 秒才消失
      holdBubble(2000);
      // 并由 loader 结束当前台词（闭口、排下一条）
      if (window.__l2d && typeof window.__l2d.onAudioEnded === 'function') window.__l2d.onAudioEnded();
      if (onEnd) { try { onEnd(); } catch (e) { /* 忽略回调异常 */ } }
      };
      ttsSrc.start();
      if (onStart) { try { onStart(); } catch (e) { /* 忽略回调异常 */ } }
      ttsRmsLoop();
    }).catch((e) => {
      window.__ttsPlaying = false;   // 合成/解码失败：交回文本驱动口型
      if (window.desktopPet && window.desktopPet.log) window.desktopPet.log('[tts] ' + e.message);
      if (onFail) { try { onFail(e); } catch (e2) { /* 忽略回调异常 */ } }
      else if (onStart) { try { onStart(); } catch (e2) { /* 无 onFail：至少把文字放出来 */ } }
    });
    return true;   // 合成/播放已发起（失败走 onFail / onStart 回调收尾）
  }

  // 计算播放中的 RMS 与播放进度（下一步驱动口型）
  function ttsRmsLoop() {
    if (!ttsAnalyser || ttsRaf) return;
    const step = () => {
      if (!ttsSrc) { ttsRaf = 0; window.__ttsRms = 0; return; }
      ttsAnalyser.getByteTimeDomainData(ttsData);
      let sum = 0;
      for (let i = 0; i < ttsData.length; i++) { const v = (ttsData[i] - 128) / 128; sum += v * v; }
      window.__ttsRms = Math.sqrt(sum / ttsData.length);
      if (ttsDuration > 0) {
        window.__ttsProgress = Math.min(1, Math.max(0, (ttsCtx.currentTime - ttsStartAt) / ttsDuration));
      }
      ttsRaf = requestAnimationFrame(step);
    };
    ttsRaf = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- 音量控制
  // 底栏上方的音量条：控制 TTS 播放增益（0-100）。实时生效并写入 localStorage。
  function ttsEffectiveGain() { return ttsMuted ? 0 : ttsVolume / 100; }

  function ttsApplyVolume() {
    if (ttsGain) ttsGain.gain.value = ttsEffectiveGain();
    const bar = document.getElementById('volume-bar');
    if (bar) bar.style.setProperty('--vol-pct', ttsMuted ? '0%' : (ttsVolume + '%'));
    const num = document.getElementById('vol-num');
    if (num) num.textContent = ttsMuted ? '静音' : String(ttsVolume);
    const lab = document.getElementById('vol-label');
    if (lab) {
      lab.textContent = ttsMuted ? '已静音' : '音量';
      lab.classList.toggle('muted', ttsMuted);
    }
    const sl = document.getElementById('vol');
    if (sl && Number(sl.value) !== ttsVolume) sl.value = String(ttsVolume);
  }

  function initVolume() {
    const sl = document.getElementById('vol');
    if (sl) {
      sl.value = String(ttsVolume);
      sl.addEventListener('input', () => {
        ttsVolume = Math.max(0, Math.min(100, Math.round(Number(sl.value) || 0)));
        ttsMuted = false;    // 拖动滑块即解除静音（符合常见播放器习惯）
        try { localStorage.setItem('l2d-tts-volume', String(ttsVolume)); } catch (e) { /* 忽略 */ }
        ttsApplyVolume();
      });
    }
    const lab = document.getElementById('vol-label');
    if (lab) {
      lab.addEventListener('click', () => { ttsMuted = !ttsMuted; ttsApplyVolume(); });
    }
    ttsApplyVolume();
  }

  // 托盘切换语音总开关
  if (window.desktopPet && typeof window.desktopPet.on === 'function') {
    window.desktopPet.on('pet:setIdleEnabled', (v) => {
      idleOn = !!v;
      if (l2d.setIdleEnabled) l2d.setIdleEnabled(idleOn);
    });
    window.desktopPet.on('pet:setTTS', (v) => {
      ttsOn = !!(v && v.enabled);
      if (!ttsOn) {
        if (ttsSrc) { try { ttsSrc.stop(); } catch (e) { /* 忽略 */ } ttsSrc = null; }
        window.__ttsPlaying = false;    // 关语音时交回文本驱动口型
      }
    });
    window.desktopPet.on('pet:setLang', (v) => {
      if (v && v.display) displayLang = v.display;
      if (v && v.voice) voiceLang = v.voice;
    });
    // 主进程的选择窗决定用哪个大脑；warm=true 时顺带预热（本地模型要加载权重）
    window.desktopPet.on('pet:setBrain', (v) => {
      const kind = (v && v.backend) || brainKind;
      rebuildBrain(kind, !!(v && v.warm));
    });
    // 人设被改：换提示词并清空历史，让新人格从下一句开始生效
    window.desktopPet.on('pet:setPersona', (p) => {
      persona = p || persona;
      if (brain) rebuildBrain(brainKind, false);
    });
  }

  // ---------------------------------------------------------------- 聊天大脑
  // 三种后端（本地 Ollama / 云端 OpenAI 兼容 / WorkBuddy ACP）对外同一组方法，
  // 由主进程的选择窗决定用哪个（pet:setBrain 下发），这里只按当前选择建实例。
  function brainLabel(k) {
    return ({ local: '本地模型', cloud: '云端接口', workbuddy: 'WorkBuddy' })[k] || '云端接口';
  }

  function brainCfg() {
    const c = CONFIG.chat || {};
    return {
      persona: persona || {},
      local: c.local || {},
      cloud: c.cloud || {},
      workbuddy: { cwd: (c.workbuddy && c.workbuddy.cwd) || CONFIG.acpCwd || '.' },
      timeoutMs: (typeof c.thinkTimeoutMs === 'number') ? c.thinkTimeoutMs : 15000
    };
  }

  // 建（或重建）后端。warm=true 时顺手预热——本地模型要把几 GB 权重装进显存，
  // 第一次不预热的话，用户开口后要干等十几秒才出第一个字。
  async function applyBrain(kind, warm) {
    brainKind = (kind === 'local' || kind === 'workbuddy') ? kind : 'cloud';
    brain = window.ChatBackends.create(brainKind, brainCfg());
    connected = false;
    setStatus('正在检查「' + brainLabel(brainKind) + '」…');
    let p;
    try { p = await brain.probe((t) => setStatus(t)); }
    catch (e) { p = { ok: false, message: (e && e.message) || String(e) }; }
    if (!p.ok) {
      setStatus(brainLabel(brainKind) + ' 不可用 · ' + p.message);
      showMessages();
      addSystem('⚠ ' + brainLabel(brainKind) + '：' + p.message);
      return false;
    }
    connected = true;
    setStatus(brainLabel(brainKind) + ' 就绪 · ' + p.message);
    // 服务是我们自己拉起来的：说清楚，并告知退出时会一起关掉
    if (p.started) {
      showMessages();
      addSystem('本地模型服务已启动（' + (p.elapsedMs || 0).toFixed(1) + 's）· 退出桌宠时会一并关闭。');
    }
    if (warm && brain.warmup) {
      const t0 = Date.now();
      if (brainKind === 'local') {
        // 冷启动要把几 GB 权重读进显存，实测 30~60 秒。不说明的话会像卡死。
        showMessages();
        addSystem('正在把本地模型载入显存，首次约需 30~60 秒，之后是毫秒级。');
      }
      const w = await brain.warmup((t) => setStatus(t));
      if (!w.ok) {
        setStatus('载入失败：' + (w.message || '未知原因'));
        return false;
      }
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      setStatus(brainLabel(brainKind) + ' 就绪 · 载入耗时 ' + sec + 's');
      if (brainKind === 'local') {
        addSystem('本地模型已就绪（载入 ' + sec + ' 秒），可以说话了。');
        notify('本地模型已就绪', '载入耗时 ' + sec + ' 秒，现在可以和她说话了。');
      }
    }
    return true;
  }

  // 系统通知（加载完成这类"不在眼前"的提醒用它）。权限被拒就静默降级。
  function notify(title, body) {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'denied') return;
      if (Notification.permission === 'default') Notification.requestPermission();
      new Notification(title, { body: body || '', silent: true });
    } catch (e) {}
  }

  // 换人设或换大脑后重建一次后端（历史会清空，新人格才生效）
  function rebuildBrain(kind, warm) {
    const k = kind || brainKind;
    if (brain && brain.reset) brain.reset();
    applyBrain(k, warm);
  }

  async function ensureConnected() {
    if (connected && brain) return;
    await applyBrain(brainKind, false);
  }

  // 启动时建一次链路。失败不重试——多半是没装 Ollama、没填 Key，
  // 或 WorkBuddy 没开，轮询重试只会刷状态栏；用户改完配置会经
  // pet:setBrain 重新触发一次。
  async function tryConnect(warm) {
    if (connected) return true;
    bootAttempts++;
    const ok = await applyBrain(brainKind, warm);
    if (ok && bootAttempts > 1) {
      showMessages();
      addSystem('「' + brainLabel(brainKind) + '」已就绪，可以说话了。');
    }
    return ok;
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autoGrow();
    showMessages();
    addMsg('user', text);
    const bubble = addMsg('assistant', '…');

    // 思考/合成计时：状态栏实时显示已用时长（用户想知道"它想了多久"）。
    // phaseTick 只负责刷新状态栏；各阶段收尾（reveal / onError / catch）会 stopTick。
    let tThink0 = performance.now();
    let phaseTick = null;
    const stopTick = () => { if (phaseTick) { clearInterval(phaseTick); phaseTick = null; } };
    const tickThinking = () => {
      stopTick();
      const lbl = brainLabel(brainKind);
      const upd = () => setStatus('思考中… ' + fmtSec(performance.now() - tThink0) + ' · ' + lbl);
      phaseTick = setInterval(upd, 200); upd();
    };
    const tickSynth = (prefix, thinkMs) => {
      stopTick();
      const tS = performance.now();
      const tail = (thinkMs > 0) ? ('（思考 ' + fmtSec(thinkMs) + '）') : '';
      const upd = () => setStatus(prefix + ' ' + fmtSec(performance.now() - tS) + tail + ' · ' + brainLabel(brainKind));
      phaseTick = setInterval(upd, 200); upd();
    };

    // 时钟快通道：问时间/日期时直接查系统时钟。
    // 本地小模型没有实时感知，让它回答"几点了"基本等于让它编一个 —— 既错又慢，
    // 而这类问题的答案是确定的，没必经过模型。
    if ((CONFIG.chat || {}).clockFastPath !== false) {
      const cr = window.ChatBackends.clockReply(text, persona);
      if (cr) {
        const parsed = window.ChatBackends.parseEmotion(cr);
        setBubbleText(bubble, parsed.text);
        if (l2d.setChatEmotion) l2d.setChatEmotion(parsed.emo);
        setStatus('本机时钟 · ' + brainLabel(brainKind) + '（未调用模型）');
        if (ttsOn && parsed.text) {
          l2d.setSpeaking(true);   // 占位说话态（无文本时不空转嘴唇，见 _driveChatMouth）
          tickSynth('本机时钟 · 生成语音中…', 0);   // 状态栏实时显示合成耗时
          const clockReady = () => {
            stopTick();
            setStatus('本机时钟 · ' + brainLabel(brainKind) + '（未调用模型）');
            if (typeof l2d.startAudioChat === 'function') l2d.startAudioChat(parsed.text, parsed.emo);
            else l2d.feedChatText(parsed.text);
          };
          const clockFallback = () => {
            stopTick();
            if (typeof l2d.speakTextChat === 'function') l2d.speakTextChat(parsed.text, parsed.emo);
            else l2d.feedChatText(parsed.text);
            setTimeout(() => { try { l2d.setSpeaking(false); } catch (e) {} },
              Math.min(6000, 800 + parsed.text.length * 120));
          };
          const started = ttsSpeak(parsed.text, [parsed.emo], null, {
            onStart: clockReady,
            onEnd: () => { stopTick(); try { l2d.setSpeaking(false); } catch (e) {} },
            onFail: clockFallback
          });
          if (!started) clockFallback();
          return;
        }
        l2d.setSpeaking(true);
        if (typeof l2d.speakTextChat === 'function') l2d.speakTextChat(parsed.text, parsed.emo);
        else l2d.feedChatText(parsed.text);
        try {
          await new Promise((r) => setTimeout(r, Math.min(2600, 500 + parsed.text.length * 90)));
        } finally {
          l2d.setSpeaking(false);
        }
        return;
      }
    }

    l2d.setSpeaking(true);
    // 延迟收尾：语音开启时说话态要延续到音频播完；关闭语音时用估时兜底。
    // 一旦交给 onDone 接管，finally 就不再抢先 setSpeaking(false)（否则嘴在音频开始前就被掐掉）。
    let deferSpeakingEnd = false;
    try {
      if (!brain || !connected) {
        const ok = await applyBrain(brainKind, false);
        if (!ok) throw new Error('「' + brainLabel(brainKind) + '」当前不可用，请看状态栏提示');
      }
      let acc = '';
      // 进入「思考中」状态：气泡显示提示、状态栏提示，并标记 generating 以露出停止按钮
      bubble.classList.add('thinking', 'generating');
      setBubbleText(bubble, '思考中…');
      tThink0 = performance.now();
      tickThinking();   // 状态栏：思考中… X.Xs · 本地模型
      // 情绪标签清洗器（见 chat-backends.js）：标签可能跨片段到达、可能前面多一个空格、
      // 也可能夹在句子中间，这里统一处理，保证气泡里只出现正文。
      let stripper = window.ChatBackends.createTagStripper();
      await brain.send(text, {
        onDelta: (piece) => {
          const r = stripper.push(piece);
          if (!r) return;
          acc += r;
          // 不在流式阶段冒泡：保持"思考中…"直到语音生成好再一起放出来
          // （见 onDone 的延迟放音逻辑）。这里只累加清洗后的正文。
        },
        // WorkBuddy 大脑专属：上游会先把整段会话历史回放一遍，回放段不渲染
        onReplay: (active) => {
          if (active) {
            stopTick();
            acc = '';
            bubble.classList.add('syncing');
            bubble.classList.remove('thinking');
            setBubbleText(bubble, '（正在同步 WorkBuddy 会话历史…）');
            setStatus('正在同步会话历史…');
          } else {
            acc = '';
            bubble.classList.remove('syncing');
            bubble.classList.add('thinking');
            setBubbleText(bubble, '思考中…');
            tThink0 = performance.now();   // 历史回放不算思考，重新起算
            tickThinking();
            stripper = window.ChatBackends.createTagStripper();   // 回放段不算本轮，清洗器重置
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
        },
        onDone: (full, meta) => {
          bubble.classList.remove('syncing', 'thinking', 'generating');
          // 先把清洗器里剩下的尾巴放出来（正常情况为空；被"停止"截断时会丢掉半截标签）
          const tail = stripper.flush();
          if (tail.text) acc += tail.text;
          let emo = tail.tagged ? tail.emo : null;
          let tagged = !!tail.tagged;
          let shown = acc;
          if (!shown) {
            // 没走到流式（或整条回复只有一个标签）：拿完整文本兜底清洗一次
            const parsed = window.ChatBackends.parseEmotion(full || '');
            shown = parsed.text;
            if (!emo) { emo = parsed.emo; tagged = tagged || parsed.tagged; }
          }
          // 模型一枚标签都没写：按关键词猜一个，别让表情卡在上一轮的状态
          if (!emo) emo = window.ChatBackends.guessEmotion(shown);
          const stopped = !!(meta && meta.stopped);
          if (!shown) shown = stopped ? '（已停止）' : '(无文本回复)';
          else if (stopped) shown += '（已停止）';
          // 本轮"思考"到此结束（LLM 已出稿）：冻结思考耗时，供合成阶段与最终状态显示
          const thinkMs = performance.now() - tThink0;
          // 延迟放音：文本先不冒泡、表情也不切，保持"思考中…"直到语音开始播放，
          // 再由 onStart 把文字 + 表情 + 口型参照一起放出来（与音频同步出现）。
          const reveal = () => {
            stopTick();
            setBubbleText(bubble, shown);
            if (l2d.setChatEmotion) l2d.setChatEmotion(emo);
            if (ttsOn && shown) {
              // 语音就绪：交给「音频驱动口型」（RMS 开合 + 播放进度推元音）
              if (typeof l2d.startAudioChat === 'function') l2d.startAudioChat(shown, emo);
              else l2d.feedChatText(shown);
            } else if (shown) {
              // 未开语音：用文本驱动口型（逐字开合），播完自动闭口
              if (typeof l2d.speakTextChat === 'function') l2d.speakTextChat(shown, emo);
              else l2d.feedChatText(shown);
            }
            setStatus(brainLabel(brainKind) + (stopped ? ' · 已停止' : ' · ' + (tagged ? '情绪[' + emo + ']' : '已回复'))
              + ' · 思考 ' + fmtSec(thinkMs));
          };
          // 说话态估时（仅「未开语音」的文本口型需要），120ms/字与 _driveChatMouth 对齐
          const speakEndMs = Math.min(6000, 800 + shown.length * 120);
          const endSpeaking = () => { deferSpeakingEnd = false; stopTick(); try { l2d.setSpeaking(false); } catch (e) {} };
          if (ttsOn && shown) {
            deferSpeakingEnd = true;
            // 模型已出稿，进入语音合成阶段：状态栏实时显示合成耗时（并保留思考耗时）
            tickSynth('生成语音中…', thinkMs);
            const started = ttsSpeak(shown, [emo], null, {
              onStart: reveal,
              onEnd: endSpeaking,
              onFail: () => { reveal(); setTimeout(endSpeaking, speakEndMs); }   // 合成失败：仍放文字 + 文本口型
            });
            // 无音频上下文（ttsSpeak 未发起）：回退到文本口型，别让说话态卡住
            if (!started) { reveal(); setTimeout(endSpeaking, speakEndMs); }
          } else {
            deferSpeakingEnd = true;
            reveal();   // 语音关着：没音频可等，直接显示文字
            setTimeout(endSpeaking, speakEndMs);
          }
        },
        onError: (e) => {
          stopTick();
          bubble.classList.remove('thinking', 'generating');
          setBubbleText(bubble, '[错误] ' + ((e && e.message) || e));
          setStatus(brainLabel(brainKind) + ' 出错 · ' + ((e && e.message) || e));
        }
      });
    } catch (e) {
      stopTick();
      const msg = (e && e.message) ? e.message : String(e);
      bubble.classList.remove('thinking', 'generating');
      setBubbleText(bubble, '无法送达：' + msg);
      setStatus('链路未就绪 · ' + msg);
    } finally {
      // 已交给音频/文本口型收尾时不抢先掐嘴；此时计时刷新也由 reveal/onEnd 收尾
      if (!deferSpeakingEnd) { l2d.setSpeaking(false); stopTick(); }
    }
  }

  // ---------------------------------------------------------------- 按钮
  // 锁定按钮：与托盘菜单共用同一入口（desktopPet.lockModel），保证状态一致
  function updateLockButton(v) {
    const b = document.getElementById('btn-lock');
    if (!b) return;
    b.textContent = v ? '解锁' : '锁定';
    b.classList.toggle('active', v);
    b.title = v ? '已锁定窗口与模型位置/缩放（点击解锁）' : '锁定窗口与模型位置/缩放';
    // 锁定同时关掉底栏的窗口拖拽区，避免误拖窗口位置（main 进程还会 setResizable(false)）
    const bar = document.getElementById('bottom-bar');
    if (bar) bar.classList.toggle('locked-win', v);
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', autoGrow);

  // ---------------------------------------------------------------- 输入框抽屉收起
  // 聊天窗收起（compact）且光标长期未靠近窗口、且输入框为空时，输入框+发送键像抽屉一样向下隐藏；
  // 光标回到窗口 / 输入框获焦 / 输入有文字 / 聊天窗展开 任一发生即展开。
  const RETRACT_DELAY = 2500;
  let composerTimer = null;
  function chatCompact() {
    const c = document.getElementById('chat');
    return !!(c && c.classList.contains('compact'));
  }
  function inputEmpty() { return inputEl.value.trim() === ''; }
  function showComposer() {
    const row = document.getElementById('input-row');
    if (row) row.classList.remove('retracted');
    if (composerTimer) { clearTimeout(composerTimer); composerTimer = null; }
  }
  function scheduleRetract() {
    const row = document.getElementById('input-row');
    if (!row || row.classList.contains('retracted')) return;
    if (composerTimer) return;
    composerTimer = setTimeout(() => {
      composerTimer = null;
      if (chatCompact() && inputEmpty()) {
        const r = document.getElementById('input-row');
        if (r) r.classList.add('retracted');
      }
    }, RETRACT_DELAY);
  }
  function refreshComposer() {
    if (!chatCompact() || !inputEmpty()) { showComposer(); return; }
    if (l2d.isCursorOverWindow && l2d.isCursorOverWindow()) showComposer();
    else scheduleRetract();
  }
  inputEl.addEventListener('input', refreshComposer);
  inputEl.addEventListener('focus', showComposer);
  const chatEl = document.getElementById('chat');
  if (chatEl) chatEl.addEventListener('mouseenter', showComposer);
  const barEl = document.getElementById('bottom-bar');
  if (barEl) barEl.addEventListener('mouseenter', showComposer);
  setInterval(refreshComposer, 350);

  document.getElementById('btn-chat').addEventListener('click', () => {
    const chat = document.getElementById('chat');
    chat.classList.toggle('compact');
    // 面板展开/收起会改变可用高度，重新适配（用户已调整过则保留布局）
    setTimeout(() => l2d.resize(), 30);
    refreshComposer();
  });
  document.getElementById('btn-idle').addEventListener('click', () => {
    // 手动触发一条待机台词（即使托盘里关掉了"自动随机待机"也可用）
    if (l2d.forceIdleLine) l2d.forceIdleLine();
  });
  document.getElementById('btn-glass').addEventListener('click', () => {
    const on = frameEl && frameEl.classList.contains('glass-mode');
    applyBackground(!on, true);
  });
  document.getElementById('btn-lock').addEventListener('click', () => {
    if (window.desktopPet) window.desktopPet.lockModel(!l2d.locked);
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (window.desktopPet) window.desktopPet.resetTransform();
  });
  document.getElementById('btn-settings').addEventListener('click', () => {
    // 打开设置窗口（与托盘菜单「设置」同一入口）；隐藏窗口改由托盘菜单「隐藏」完成
    if (window.desktopPet && window.desktopPet.openSettings) window.desktopPet.openSettings();
  });

  // 界面字体：把字号/字体族应用到整个窗口（CSS 变量驱动，所有文字统一跟随）
  function applyUIFont(state) {
    if (!state) return;
    const root = document.documentElement;
    const size = (typeof state.fontSize === 'number') ? state.fontSize : 14;
    const scale = size / 14;                       // 设计基准 14px
    root.style.setProperty('--ui-scale', String(scale));
    const fam = (typeof state.fontFamily === 'string' && state.fontFamily) ? state.fontFamily : '';
    // 空串 -> 清掉变量，回退到 :root 的默认字体族（系统默认）
    if (fam) root.style.setProperty('--ui-font-family', fam);
    else root.style.removeProperty('--ui-font-family');
  }

  // 主进程（托盘）下发的指令
  if (window.desktopPet) {
    window.desktopPet.onApplyLock((v) => l2d.setLocked(v));
    window.desktopPet.onApplyReset(() => l2d.resetTransform());
    // 口型调试（托盘"口型调试"子菜单）：实时切换元音参数族 / OpenY 驱动 / Silence 极性
    window.desktopPet.on('pet:setVowelFamily', (fam) => { if (l2d.setVowelFamily) l2d.setVowelFamily(fam); });
    window.desktopPet.on('pet:setDriveOpenY', (v) => { if (l2d.setDriveOpenY) l2d.setDriveOpenY(v); });
    window.desktopPet.on('pet:setSilenceSpeaking', (v) => { if (l2d.setSilenceSpeaking) l2d.setSilenceSpeaking(v); });
    // 表情情绪总开关（托盘下发）
    window.desktopPet.on('pet:setEmotionEnabled', (v) => { if (l2d.setEmotionEnabled) l2d.setEmotionEnabled(v); });
    // 参数调试面板：托盘点击后主进程发来开/关指令，这里转交 loader 启动/停止全参数上报
    window.desktopPet.on('pet:setDebugMode', (v) => { if (l2d.setDebugMode) l2d.setDebugMode(v); });
    // 界面字体（托盘"界面字体"子菜单）：实时切换全窗口字号/字体族
    window.desktopPet.on('pet:setUIFont', (state) => { applyUIFont(state); });
    // 屏幕运动追踪：托盘菜单勾选后主进程下发开/关，这里转发给追踪器实启停
    window.desktopPet.on('pet:setScreenTrack', (v) => {
      if (window.__screenTracker) window.__screenTracker.setEnabled(!!v);
    });
    // 屏幕运动追踪：设置窗调整灵敏度等子参数时实时下发，追踪器立即生效（无需重启）
    window.desktopPet.on('pet:setScreenTrackParams', (p) => {
      if (window.__screenTracker && window.__screenTracker.setParams) window.__screenTracker.setParams(p || {});
    });
    // 屏幕运动追踪：设置窗切换要追踪的显示器后实时下发，追踪器重启采集以应用新源
    window.desktopPet.on('pet:setScreenTrackScreen', (idx) => {
      if (window.__screenTracker && window.__screenTracker.setScreen) window.__screenTracker.setScreen(idx);
    });
    // 屏幕追踪调试窗就绪 / 主进程请求时，立即把最近一帧诊断补发给调试窗（绕过限流，确保一开就见画面）
    window.desktopPet.on('pet:requestScreenDiag', () => {
      if (window.__screenTracker && window.__screenTracker.requestDiag) window.__screenTracker.requestDiag();
    });
    // 鼠标追踪总开关：设置窗/托盘切换后实时下发，立即生效（无需重启）
    window.desktopPet.on('pet:setMouseFollow', (v) => {
      if (l2d && l2d.setMouseFollow) l2d.setMouseFollow(!!v);
    });
    // 视线/头部跟随参数：设置窗调整"视线跟随"标签页后实时下发，渲染进程立即应用（无需重启）
    window.desktopPet.on('pet:setGazeCfg', (cfg) => {
      if (l2d && l2d.setGazeCfg) l2d.setGazeCfg(cfg || {});
    });
    // 设置窗请求音频设备列表（其自身未获媒体授权，拿不到设备名，故由主窗枚举后上报）
    window.desktopPet.on('pet:requestAudioDevices', () => { reportAudioDevicesToMain(); });
    // 音律识别：设置窗/托盘切换后实时下发，立即启停系统音频采集与跟拍
    window.desktopPet.on('pet:setMusic', (v) => {
      if (l2d && l2d.setMusicEnabled) l2d.setMusicEnabled(!!v);
      if (window.__musicTracker) window.__musicTracker.setEnabled(!!v);
      // 开启后延迟再枚举一次：拿到媒体授权后 enumerateDevices 才会返回真实设备名，
      // 否则设置窗的下拉里全是"输入设备 xxxxx"这种占位名。
      if (v) setTimeout(reportAudioDevicesToMain, 1500);
    });
    // 音律识别参数（闭眼程度/点头幅度/灵敏度）：设置窗调整后实时下发，追踪器立即生效
    window.desktopPet.on('pet:setMusicCfg', (cfg) => {
      if (window.__musicTracker && window.__musicTracker.setParams) window.__musicTracker.setParams(cfg || {});
    });
    // 音律识别调试面板：开/关时通知追踪器（开着才上报 + 跑心跳，没开就不占 IPC）
    window.desktopPet.on('pet:musicDebugOpen', (v) => {
      if (window.__musicTracker && window.__musicTracker.setDebugOpen) window.__musicTracker.setDebugOpen(!!v);
    });
    // 调试窗就绪 / 主进程请求：立即补发最近一份诊断快照（绕过限流）
    window.desktopPet.on('pet:requestMusicDiag', () => {
      if (window.__musicTracker && window.__musicTracker.requestDiag) window.__musicTracker.requestDiag();
    });
    // 模型参数列表：设置窗打开时若缓存尚未就绪，主进程请主窗口补报一次
    window.desktopPet.on('pet:requestModelParams', () => {
      reportModelParamsToMain(l2d);
    });
    // 素材清单：设置窗打开「表情与动作」分页时若缓存为空，主窗口补报一次
    window.desktopPet.on('pet:requestModelAssets', () => {
      if (l2d && l2d.refreshModelAssets) { try { l2d.refreshModelAssets(); } catch (e) {} }
    });
    // 换模型（设置页选模型 / 改注入配置）：热重载模型，不重启程序
    window.desktopPet.on('pet:setModel', (url) => { reloadModel(url); });
    // 台词档内容或"模型→台词档"映射变了：重读台词池并热替换（不必重启）
    window.desktopPet.on('pet:reloadLines', async () => {
      await loadConfig();
      await loadLineProfile();
      startIdleChat();
      if (l2d.setIdleEnabled) l2d.setIdleEnabled(idleOn);
    });
    // 触发绑定 / 快捷键范围变了：重新装载绑定（全局热键由主进程注册，这里只管窗口内）
    window.desktopPet.on('pet:setBindings', (A) => {
      window.__companionConfig = window.__companionConfig || {};
      window.__companionConfig.assets = A || {};
      loadBindings();
    });
    // 手动触发 / 主进程全局热键：播放指定绑定
    window.desktopPet.on('pet:triggerAsset', (id) => {
      if (!window.__playAssetById(id)) {
        if (window.desktopPet.log) window.desktopPet.log('[assets] 未找到绑定：' + id);
      }
    });
  }

  window.addEventListener('resize', () => l2d.resize());

  // 快捷键 Ctrl+Shift+M：切换屏幕运动追踪（与托盘菜单同效，并回传状态同步勾选）
  // 另外：绑定在「表情与动作」里的快捷键，当范围为"仅桌宠窗口内"时由这里分发；
  // 范围为"全局"时由主进程 globalShortcut 注册并回发 pet:triggerAsset。
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
      e.preventDefault();
      if (window.__screenTracker) window.__screenTracker.toggle();
      return;
    }
    if (hotkeyScope !== 'window') return;
    // 输入框里打字时不抢键（否则数字/字母热键根本没法输入）
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    for (const b of bindings) {
      if (bindingMatchesHotkey(b, e)) { e.preventDefault(); playBinding(b); return; }
    }
  });

  // ---------------------------------------------------------------- 启动
  (async function boot() {
    await loadConfig();
    applyUIFont(window.__companionConfig);   // 启动时按 config.json 当前值应用字号/字体（兜底）
    await loadLineProfile();                 // 台词档：按 config.lineProfile 的模型绑定决定用哪一份
    l2d.onLockChange = updateLockButton;
    initBackground();
    initVolume();
    autoGrow();
    initLive2D();

    // 首次打开写入一句问候；之后每次启动只留一行简短的就绪提示。
    let greeted = null;
    try { greeted = localStorage.getItem(GREETING_KEY); } catch (e) { /* 忽略 */ }
    if (!greeted) {
      addSystem('▎神经链路已同步\n\n渲染核心在线，口型与呼吸同步模块已加载。\n待机中，请下达指令。');
      try { localStorage.setItem(GREETING_KEY, '1'); } catch (e) { /* 忽略 */ }
    } else {
      addSystem('渲染核心已挂载 · 正在建立链路…');
    }

    // 人设先加载：后面建后端时要用它拼提示词
    try { persona = await window.desktopPet.getPersona(); } catch (e) { persona = null; }
    brainKind = (CONFIG.chat && CONFIG.chat.backend) || 'cloud';

    if (CONFIG.autoConnectChat !== false) {
      // 本地模型在启动时预热：此时主窗口还没建好、主进程的 pet:setBrain 会落空，
      // 所以由渲染进程自己判断。冷加载 7B 权重要十几秒，不预热的话
      // 用户开口后会干等半天才出第一个字。
      tryConnect(brainKind === 'local');
    } else {
      setStatus('未连接（autoConnectChat=false）· 可在托盘菜单「切换聊天大脑」里启用');
    }
  })();
})();
