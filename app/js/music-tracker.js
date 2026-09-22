// music-tracker.js —— 音律识别（BPM/节拍驱动闭眼跟拍）
//
// 思路：用 desktopCapturer 枚举屏幕源（与屏幕运动追踪共用），以系统回环方式抓取
// 系统正在播放的全部声音（不区分程序，后续可加按程序过滤）；用 Web Audio AnalyserNode
// 做实时起音/能量检测，检测到一个"拍子"就触发一次头部下点脉冲（nod），
// 由 live2d-loader 的 _musicTick 把 nod 写到 ParamAngleX（点头）并把眼睛压低（闭眼欣赏）。
//
// 默认关闭，由设置窗「音律识别」标签页或托盘菜单「音律识别」开启。
// 开启后会经 getUserMedia(chromeMediaSource:'desktop') 采集系统音频（无需指定程序，
// 抓的是整块声卡的混音）。
(function () {
  'use strict';

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function log(msg) { if (window.desktopPet && window.desktopPet.log) window.desktopPet.log('[music] ' + msg); }

  function create() {
    // 可调参数（config.json 的 music 段；缺省用下列默认值）。设为可变，
    // 以便设置窗经 pet:setMusicCfg 实时调整（闭眼程度/点头幅度/灵敏度）而无需重启。
    const cfg = (window.__companionConfig && window.__companionConfig.music) || {};
    let eyeClose = (cfg.eyeClose != null) ? Number(cfg.eyeClose) : 0.8;
    let nodStrength = (cfg.nodStrength != null) ? Number(cfg.nodStrength) : 1.0;
    let swayStrength = (cfg.swayStrength != null) ? Number(cfg.swayStrength) : 1.0;
    let sensitivity = (cfg.sensitivity != null) ? Number(cfg.sensitivity) : 1.3;
    // 音频来源：'loopback' = 系统回环（整块声卡混音，跟随 Windows 默认输出设备）；
    // 或某个音频输入设备的 deviceId（如"立体声混音"、虚拟声卡），用于监听特定设备。
    let audioSource = (cfg.audioSource && typeof cfg.audioSource === 'string') ? cfg.audioSource : 'loopback';
    // 律动速度上限（BPM）：估测超过它就不断折半，避免快歌把角色晃成"疯狂点头"。
    // 例如 120 → 60、128 → 64、174 → 87。低于该值的速度保持原样。
    let maxTempo = (cfg.maxTempo != null) ? Number(cfg.maxTempo) : 80;
    // 方案开关：enableA=连续律动（A 方案），enableB=BPM 锁定正弦（B 方案）。两者可独立开关。
    // 默认都开 → 检测到稳定 BPM 跑 B、否则跑 A（用 aSpeed 作基础速度）。
    let enableA = (cfg.enableA != null) ? !!cfg.enableA : true;
    let enableB = (cfg.enableB != null) ? !!cfg.enableB : true;
    // A 方案基础速度（BPM）：BPM 还没测稳时，连续律动按这个速度摆动（可调，替代固定 90）。
    let aSpeed = (cfg.aSpeed != null) ? Number(cfg.aSpeed) : 90;
    function applyCfg(c) {
      if (!c || typeof c !== 'object') return;
      if (typeof c.audioSource === 'string' && c.audioSource) audioSource = c.audioSource;
      if (c.maxTempo != null) maxTempo = clamp(Number(c.maxTempo), 40, 200);
      if (c.eyeClose != null) eyeClose = clamp(Number(c.eyeClose), 0, 1);
      if (c.nodStrength != null) nodStrength = clamp(Number(c.nodStrength), 0, 3);
      if (c.swayStrength != null) swayStrength = clamp(Number(c.swayStrength), 0, 3);
      if (c.sensitivity != null) sensitivity = clamp(Number(c.sensitivity), 1.05, 3);
      if (c.enableA != null) enableA = !!c.enableA;
      if (c.enableB != null) enableB = !!c.enableB;
      if (c.aSpeed != null) aSpeed = clamp(Number(c.aSpeed), 40, 200);
    }
    applyCfg(cfg);

    let enabled = false, running = false;
    let stream = null, ctx = null, analyser = null, srcNode = null, timer = null;
    let freq = null;
    let avg = 0;            // 能量滑动均值（EMA，用于起音检测）
    let nod = 0;            // 重拍脉冲（0..1，检测到一拍置 1 后逐帧衰减；用于副歌/重拍时短暂睁眼）
    let lastBeat = 0;

    // —— 序列化点头状态机：保证"一次完整点头播完才播下一次"，杜绝高频抖动 ——
    // 之前头部俯仰用的是自由连续正弦 swing=sin(2π·phase)，频率跟 BPM 走，
    // 快歌时每秒好几次起伏，观感像抽搐，且不存在"播完一次再下一次"的概念。
    // 改为：每拍触发一次，从头到位完整播放（neutral→低头→neutral）后，才允许下一拍；
    // 拍子来太快（仍在点头中）就跳过这次，等播完再接。
    let nodActive = false;  // 当前是否正在播放一次点头
    let nodStart = 0;       // 本次点头起始时间（performance.now，毫秒）
    let nodDurMs = 460;     // 本次点头总时长（毫秒），由拍间隔推算并夹在舒适区间

    // —— A+B 混合律动所需状态 ——
    // A（连续律动）：level 是相对响度(0..1)，直接作为动作幅度；听得见的段落才晃，静音自然收敛。
    // B（BPM 锁定）：phase 是按当前速度连续推进的相位，swing = sin(2π·phase) 得到平滑正弦；
    //                估出可信 BPM 后用该速度推进，并在每拍把相位往"最低点"轻推，实现与鼓点同频。
    let level = 0;          // 平滑后的相对响度 0..1（= 动作幅度系数）
    let peakEnv = 1;        // 自适应峰值包络（慢速衰减），用于把 energy 归一化成 level
    let phase = 0;          // 连续律动相位 0..1
    let bpm = 0;            // 估计出的 BPM（0 = 尚未锁定）
    let bpmStable = false;  // 是否已锁定到可信 BPM
    let intervals = [];     // 最近若干拍的间隔(ms)，用于估 BPM
    let prevTick = 0;       // 上一 tick 时间戳（用于按真实 dt 推进相位，不受 setInterval 抖动影响）
    let lastOnsetAt = 0;    // 最近一次起音时间（用于判定"音乐停了"→ 解除 BPM 锁定）
    // 「是否在放歌」改以**音量**判定（不再用起音）：安静段落检测不到节拍起音，
    // 但音量还在、人还在跟着晃，用起音判定就会显示"未检测到音乐"却仍在晃（显示与实际不符）。
    let lastLoudAt = 0;     // 最近一次"有音量"的时间戳

    // —— 方案③：Python 侧车（WASAPI 逐端点回环）模式 ——
    // audioSource 形如 "wasapi:<输出端点ID>" 时启用：由 audio/audio_server.py 对指定输出设备
    // 开 loopback 采集并算好 level/bpm/playing/peak，这里只负责轮询取回并推进律动相位。
    let extMode = false, extPoll = null, extPlaying = false, extPeak = 0;
    let lastExtOnsets = 0, prevExtT = 0;

    // —— 调试面板（app/music-debug.html）——
    // 存在的意义：把"听得见音乐却几乎不动"这类问题从"猜"变成"看"。面板上同时有
    // 能量/起音阈值/起音时刻、连续相位 swing、一次性点头包络，以及**最终写进模型的参数值**，
    // 一眼就能分辨是"没检测到拍"、"检测到了但幅度被参数压成 0"、还是"模型根本没收到"。——
    let _lastDiagSent = 0;        // 限流时间戳
    let lastDiagPayload = null;   // 最近一份快照（调试窗就绪时补发）
    let debugOpen = false;        // 调试窗是否开着（开着才发，省 IPC）
    let debugHeartbeat = null;    // 未采集时的低频心跳：面板也要能显示"为什么没在动"
    let modelProbe = null;        // 由 app.js 注入：读取 live2d-loader 真正写进模型的参数值
    let onsetCount = 0;           // 起音累计次数（面板据此算"每秒几拍"）
    let lastOnsetGapMs = 0;       // 最近一次起音间隔(ms)
    let lastEnergy = 0;           // 本帧能量（诊断用）
    let lastFlux = 0;             // 本帧频谱通量（诊断用）
    let lastFluxCap = 0;          // 通量缓冲容量（诊断用）
    const DIAG_MIN_MS = 66;       // 限流 ~15fps

    // —— 高精度 BPM：起音强度包络（频谱通量）+ 自相关 ——
    // 旧做法（拍间隔取中位数 + 倍频折叠到 60..180）有两个硬伤：
    //   ① 折叠会把估计推向区间中心（≈104），所以"测什么歌都是 100 出头"；
    //   ② 每来一个新间隔就用 EMA 更新，导致同一首歌中途漂移。
    // 新做法：把"频谱通量"当作起音强度序列，对它做自相关，并配合谐波梳状滤波与
    // 120BPM 附近的偏好先验解决倍频歧义，再用抛物线插值取亚帧精度，最后用投票直方图稳定输出。
    let fluxBuf = [];       // 起音强度（频谱通量）环形缓冲，约 8 秒
    let fluxMax = 512;
    let prevMag = null;     // 上一帧频谱（算通量用）
    let avgDt = 16;         // 实测平均帧间隔(ms)（setInterval 会抖动，不能假定就是 16）
    let lastEstAt = 0;      // 上次做自相关估测的时间戳
    let bpmVotes = [];      // 最近若干次估测结果（投票用），长度上限 24
    let bpmVoteMax = 24;

    const BPM_MIN = 50, BPM_MAX = 200;   // 认可的 BPM 范围（比旧版更宽，减少折叠带来的中心化偏差）
    const EST_EVERY_MS = 500;            // 每 500ms 做一次自相关估测
    const FLUX_WIN_SEC = 8;              // 参与自相关的通量窗口（秒）

    const DEFAULT_TEMPO = 90;   // 未锁定 BPM 时的默认律动速度（BPM）；保证没测准也有自然摆动
    const SILENCE_E = 8;        // 低于该能量视为静音：level 归零，动作自然停下
    // 取哪块屏的源：音频回环抓的是整块声卡混音，任意屏源都行；用配置里的屏幕索引保持一致
    let screenIndex = (window.__companionConfig && window.__companionConfig.screenTrack &&
      window.__companionConfig.screenTrack.screenIndex != null)
      ? Number(window.__companionConfig.screenTrack.screenIndex) : 0;

    const MIN_GAP = 250;    // 两次拍子最小间隔(ms)（≈上限 240 BPM，避免一拍触发多次）
    const DECAY = 0.90;    // 每帧衰减：分析帧率已提到 ~16ms/帧 → 约 10 帧(≈160ms)回到 0（保持与提速前相同的实际时长）

    function stopStream() {
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); stream = null; }
      if (srcNode) { try { srcNode.disconnect(); } catch (e) {} srcNode = null; }
      if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
      // 方案③：退出逐端点回环模式时通知侧车停止，并停掉轮询
      if (extMode) {
        try { if (window.desktopPet && window.desktopPet.audioStop) window.desktopPet.audioStop(); } catch (e) {}
        extMode = false; extPlaying = false; extPeak = 0; lastExtOnsets = 0; prevExtT = 0;
      }
      if (extPoll) { clearInterval(extPoll); extPoll = null; }
      analyser = null; freq = null; avg = 0; nod = 0;
      // 重置 A+B 的律动状态，避免下次开启时残留旧相位/旧 BPM 造成突兀跳动
      level = 0; peakEnv = 1; phase = 0; bpm = 0; bpmStable = false;
      intervals.length = 0; prevTick = 0; lastOnsetAt = 0;
      fluxBuf.length = 0; bpmVotes.length = 0; prevMag = null; lastEstAt = 0; lastLoudAt = 0;
    }

    // 方案③ 轮询：从 Python 侧车取回分析结果，并按当前速度推进律动相位。
    // 分析（频谱通量/自相关/BPM）全部在侧车里做，这里只做"取数 + 相位"，逻辑与浏览器采集模式一致。
    function extTick() {
      const api = window.desktopPet;
      if (!api || !api.getAudioState) return;
      Promise.resolve(api.getAudioState()).then((s) => {
        if (!s) return;
        const now = performance.now();
        extPlaying = !!s.playing;
        level = (typeof s.level === 'number') ? Math.max(0, Math.min(1, s.level)) : 0;
        const b = (typeof s.bpm === 'number') ? s.bpm : 0;
        bpmStable = !!s.bpmStable;
        bpm = bpmStable ? b : 0;
        extPeak = (typeof s.peak === 'number') ? s.peak : 0;
        nod = extPeak;                                    // 重拍脉冲（副歌短暂睁眼用）
        // 起音计数增加 = 新的一拍 → 把相位往最低点轻推（与浏览器采集模式同款相位锁定）
        if (typeof s.onsets === 'number' && s.onsets > lastExtOnsets) {
          lastExtOnsets = s.onsets;
          phase += shortestTo(0.25 - phase) * 0.35;
        }
        if (level > 0.08) lastLoudAt = now;
        // 相位按当前速度连续推进（未锁定 BPM 时用默认速度兜底）
        const dtMs = prevExtT ? Math.min(200, now - prevExtT) : 33;
        prevExtT = now;
        const tempo = (bpmStable && bpm > 0) ? bpm : DEFAULT_TEMPO;
        phase += (dtMs / 1000) * (tempo / 60);
        phase -= Math.floor(phase);
        emitDiag('');   // 侧车模式同样上报（内部限流）
      }).catch(() => {});
    }

    async function startCapture() {
      // —— 路线 0（方案③）：指定输出端点，经 Python 侧车做 WASAPI 逐端点回环 ——
      // 这是唯一能"任意选择输出设备"的路径：Electron 自身只能跟默认输出设备。
      if (typeof audioSource === 'string' && audioSource.indexOf('wasapi:') === 0) {
        const devId = audioSource.slice('wasapi:'.length);
        const api = window.desktopPet;
        if (!api || !api.audioStart) { log('缺少 audioStart 接口，无法使用逐端点回环'); return false; }
        let r = null;
        try { r = await api.audioStart({ id: devId, maxTempo: maxTempo }); }
        catch (e) { log('逐端点回环启动异常：' + (e && e.message || e)); return false; }
        if (!r || r.ok === false) { log('逐端点回环启动失败：' + ((r && r.error) || '侧车不可用（需 audio/venv 内的 soundcard）')); return false; }
        extMode = true; lastExtOnsets = 0; prevExtT = 0;
        extPoll = setInterval(extTick, 33);
        log('已启动逐端点回环采集（输出端点 ' + devId.slice(0, 28) + '…）');
        return true;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        log('navigator.mediaDevices.getUserMedia 不可用，无法采集音频'); return false;
      }
      let media = null;

      // —— 路线 1：指定了音频输入设备（如"立体声混音"、虚拟声卡）——
      // 标准 deviceId 采集：不需要屏幕捕获权限，也不存在 desktop 回环那个 video:false 崩溃问题。
      if (audioSource && audioSource !== 'loopback') {
        try {
          media = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: audioSource } }, video: false
          });
          log('已按指定设备采集音频：' + audioSource);
        } catch (e) {
          log('按指定设备采集失败：' + (e && e.message || e) + '（设备可能已拔出/被占用），回退到系统回环');
          media = null;
        }
      }

      // —— 路线 2：系统回环（整块声卡混音，跟随 Windows 默认输出设备）——
      if (!media) {
        if (!window.desktopPet || typeof window.desktopPet.getScreenSources !== 'function') {
          log('缺少 getScreenSources 接口，无法采集系统音频'); return false;
        }
        let sources;
        try { sources = await window.desktopPet.getScreenSources(); }
        catch (e) { log('枚举屏幕源失败：' + (e && e.message || e)); return false; }
        if (!sources || sources.error || !sources.length) { log('未找到屏幕源'); return false; }
        let idx = (isFinite(screenIndex) && screenIndex >= 0) ? Math.round(screenIndex) : 0;
        if (idx >= sources.length) idx = 0;
        const sourceId = sources[idx].id;
        try {
          // 重要（踩坑）：Windows 上若只请求 audio 而 video:false，getUserMedia 会直接崩溃渲染进程
          // （透明窗口随之"凭空消失"、主进程仍在，极难定位）。与屏幕运动追踪保持一致，必须同时请求
          // video；拿到流后立刻停掉视频轨（我们只用音频做节拍分析），既避开崩溃又不会常驻"正在共享屏幕"。
          media = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
          });
        } catch (e) {
          log('getUserMedia(desktop audio) 失败：' + (e && e.message || e) + '（请确认已授予屏幕/音频捕获权限）');
          return false;
        }
        // 视频轨对我们无用，且保留会常驻系统"屏幕捕获"占用；拿到流立即停掉（音频轨不受影响）。
        try {
          if (media.getVideoTracks) media.getVideoTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
        } catch (e) {}
      }

      if (!media.getAudioTracks || !media.getAudioTracks().length) {
        log('getUserMedia 返回的流不含音频轨，无法做节拍检测（当前来源没有音频输出）');
        stopStream(); return false;
      }
      stream = media;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { log('AudioContext 不可用'); stopStream(); return false; }
      ctx = new AC();
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
      srcNode = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      srcNode.connect(analyser);
      freq = new Uint8Array(analyser.frequencyBinCount);
      // 分析帧率提到 ~60Hz（原 33ms≈30Hz）：自相关的 lag 分辨率直接决定 BPM 精度，
      // 配合抛物线插值才能得到亚帧精度。开销很小（1024 点 FFT + 一次通量累加）。
      timer = setInterval(tick, 16);
      log('已启动音频采集（来源=' + (audioSource === 'loopback' ? '系统回环(整块混音)' : '设备 ' + audioSource) +
        '），开始检测节拍（eyeClose=' + eyeClose + ' nodStrength=' + nodStrength +
        ' swayStrength=' + swayStrength + ' sensitivity=' + sensitivity + '）');
      return true;
    }

    // 相位差取最短路径（-0.5..0.5），避免相位跨 0/1 边界时往反方向修正
    function shortestTo(d) { return d - Math.round(d); }

    // 高精度 BPM 估测：对"起音强度序列（频谱通量）"做自相关。
    // 步骤：① 归一化自相关找节拍周期 → ② 谐波梳状滤波（lag/2lag/3lag 加权）压掉半速倍速误判
    //      → ③ 120BPM 对数高斯先验解决倍频歧义 → ④ 抛物线插值取亚帧精度
    //      → ⑤ 投票直方图取"最密集一簇"的均值作为输出（这是"同一首歌不漂移"的关键）。
    function estimateTempo() {
      const n = fluxBuf.length;
      const fps = 1000 / Math.max(1, avgDt);
      if (n < Math.floor(fps * 4)) return;                       // 至少 4 秒样本
      const lagMin = Math.max(2, Math.floor(fps * 60 / BPM_MAX));
      const lagMax = Math.min(n - 8, Math.ceil(fps * 60 / BPM_MIN));
      if (lagMax <= lagMin + 2) return;

      // 去均值：否则直流分量会把长 lag 的自相关整体抬高，导致偏向慢速
      let mean = 0;
      for (let i = 0; i < n; i++) mean += fluxBuf[i];
      mean /= n;
      const x = new Float32Array(n);
      let e0 = 0;
      for (let i = 0; i < n; i++) { x[i] = fluxBuf[i] - mean; e0 += x[i] * x[i]; }
      e0 /= n;
      if (e0 <= 1e-7) return;                                    // 静音，没什么可测

      const maxLag = Math.min(n - 4, lagMax * 3 + 4);             // 谐波要用到 3*lag
      const acf = new Float32Array(maxLag + 1);
      for (let lag = 1; lag <= maxLag; lag++) {
        const cnt = n - lag;
        if (cnt <= 0) { acf[lag] = 0; continue; }
        let s = 0;
        for (let i = 0; i < cnt; i++) s += x[i] * x[i + lag];
        acf[lag] = (s / cnt) / e0;                                // 归一化成相关系数
      }

      let bestScore = -Infinity, bestLag = 0;
      for (let lag = lagMin; lag <= lagMax; lag++) {
        const b = 60 * fps / lag;
        if (b < BPM_MIN || b > BPM_MAX) continue;
        let score = acf[lag];
        if (lag * 2 <= maxLag) score += 0.50 * acf[lag * 2];      // 谐波梳状：真实速度的倍频处也是峰
        if (lag * 3 <= maxLag) score += 0.25 * acf[lag * 3];
        // 偏好先验：以 120BPM 为中心的对数高斯（σ≈0.45 个八度），解决半速/倍速歧义。
        // 参数经离线仿真标定（tools/_test_bpm.js）：合成 70/90/100/110/120/128/140/150 BPM
        // 的起音序列（含噪声+12%漏拍），本组取值可把全部还原到误差 ≤0.6 BPM；
        // 先验太弱（σ=0.7）时 100BPM 会被误判成 50（半速）。
        const prior = Math.exp(-0.5 * Math.pow(Math.log2(b / 120) / 0.45, 2));
        score *= (0.35 + 0.65 * prior);
        if (score > bestScore) { bestScore = score; bestLag = lag; }
      }
      if (!bestLag || !(bestScore > 0)) return;

      // 抛物线插值：峰落在离散帧上，插值才能取到亚帧精度（否则只能给到整数帧，精度不够）
      const y0 = (bestLag > 1 ? acf[bestLag - 1] : 0), y1 = acf[bestLag] || 0, y2 = acf[bestLag + 1] || 0;
      const denom = y0 - 2 * y1 + y2;
      let lagR = bestLag;
      if (denom !== 0) {
        const d = 0.5 * (y0 - y2) / denom;
        if (isFinite(d) && Math.abs(d) <= 1) lagR = bestLag + d;
      }
      // 超速折半：估测超过 maxTempo 就不断除以 2（120→60、128→64、174→87），
      // 避免快歌把角色晃得过快。折半作用在"投票之前"，保证显示值与实际律动速度一致。
      let est = clamp(60 * fps / lagR, BPM_MIN, BPM_MAX);
      while (est > maxTempo && est / 2 >= BPM_MIN) est /= 2;

      // 换歌检测：最近 4 票都远离当前共识 → 清空重投（否则旧歌的票会把新歌拖住）
      if (bpm > 0 && bpmVotes.length >= 4) {
        let far = 0;
        for (let i = bpmVotes.length - 4; i < bpmVotes.length; i++) {
          if (Math.abs(bpmVotes[i] - bpm) > bpm * 0.08) far++;
        }
        if (far === 4) { bpmVotes.length = 0; bpmStable = false; }
      }

      bpmVotes.push(est);
      if (bpmVotes.length > bpmVoteMax) bpmVotes.shift();

      // 取"最密集一簇"的均值：比中位数更抗单票跳变
      const sorted = bpmVotes.slice().sort((a, b) => a - b);
      let bestCnt = 0, bestSum = 0, bestI = 0;
      for (let i = 0; i < sorted.length; i++) {
        let cnt = 0, sum = 0;
        for (let j = 0; j < sorted.length; j++) {
          if (Math.abs(sorted[j] - sorted[i]) <= sorted[i] * 0.03) { cnt++; sum += sorted[j]; }
        }
        if (cnt > bestCnt) { bestCnt = cnt; bestSum = sum; bestI = i; }
      }
      if (!bestCnt) return;
      const center = bestSum / bestCnt;
      const needVotes = Math.max(3, Math.ceil(Math.min(bpmVoteMax, 8) * 0.6));
      if (bestCnt >= needVotes) { bpm = center; bpmStable = true; }
      else if (bestCnt >= 3) { bpm = center; bpmStable = false; }  // 有值但不算锁定
      else { bpmStable = false; }
    }

    function tick() {
      if (!analyser || !freq) return;
      try {
        analyser.getByteFrequencyData(freq);
        // 能量：取中低频（多数音乐节拍落在 < ~ (0.35*sampleRate/2) 的频段）的均方能量
        const n = freq.length;
        const upto = Math.max(4, Math.floor(n * 0.35));
        let sum = 0;
        for (let i = 1; i < upto; i++) { const v = freq[i]; sum += v * v; }
        const energy = sum / (upto - 1);
        lastEnergy = energy;
        const now = performance.now();

        // ---- 高精度 BPM：频谱通量（spectral flux）做起音强度序列 ----
        // 只累加"变亮"的频段（相邻帧差为正的部分），对鼓点这类瞬态起音远比单纯能量敏感，
        // 是节拍检测里最常用的 onset detection function。
        if (!prevMag || prevMag.length !== freq.length) prevMag = new Float32Array(freq.length);
        let flux = 0;
        for (let i = 1; i < upto; i++) {
          const d = freq[i] - prevMag[i];
          if (d > 0) flux += d;
          prevMag[i] = freq[i];
        }
        flux /= (upto - 1);
        lastFlux = flux;
        fluxBuf.push(flux);
        const cap = Math.max(64, Math.floor((1000 / Math.max(1, avgDt)) * FLUX_WIN_SEC));
        lastFluxCap = cap;
        while (fluxBuf.length > cap) fluxBuf.shift();
        // 实测帧间隔：setInterval 会抖动，不能假定就是 16ms，否则自相关的 lag→BPM 换算会偏
        if (prevTick) {
          const d = now - prevTick;
          if (d > 0 && d < 500) avgDt = avgDt * 0.9 + d * 0.1;
        }

        // ---- A：相对响度（连续律动的幅度）----
        // 自适应峰值包络：跟随近期最大能量、缓慢衰减，把 energy 归一化成 0..1 的相对响度。
        // 这样"歌响→晃得明显、歌轻→轻轻晃、静音→停下"，且不依赖绝对音量（换歌/音量不同也能适配）。
        peakEnv = Math.max(energy, peakEnv * 0.995);
        const target = energy < SILENCE_E ? 0 : clamp(energy / Math.max(1, peakEnv), 0, 1);
        level += (target - level) * (target > level ? 0.35 : 0.08);   // 快起慢落，避免抖动
        // 有音量就刷新时间戳：这才是"是否在放歌"的可靠依据（起音只反映节拍，安静段落会漏）
        if (level > 0.08) lastLoudAt = now;

        // ---- 起音检测（既用于估 BPM，也用于重拍短暂睁眼）----
        avg = avg ? avg * 0.94 + energy * 0.06 : energy;
        if (energy > avg * sensitivity && energy > SILENCE_E && (now - lastBeat) > MIN_GAP) {
          const dtBeat = lastBeat ? now - lastBeat : 0;
          lastBeat = now; lastOnsetAt = now;
          onsetCount++;                              // 诊断：起音累计（面板据此算"每秒几拍"）
          if (dtBeat > 0) lastOnsetGapMs = dtBeat;
          nod = 1;                                   // 重拍脉冲（用于短暂睁眼）
          if (dtBeat > 0) {
            // 仅记录原始起音间隔，供观测/调试；**不要**在这里估 BPM。
            // BPM 统一交给 estimateTempo()（频谱通量自相关 + 120BPM 对数高斯先验 +
            // 抛物线插值 + 投票直方图，参数经 tools/_test_bpm.js 离线标定）。
            // 这里曾调用已不存在的 estimateBpm()，每次起音都抛 ReferenceError，
            // 被下方 catch 吞掉后 tick() 尾部（相位推进 / 起音相位微调 / 衰减 /
            // estimateTempo() 调用）全部被跳过 —— 浏览器采集模式下 BPM 永不更新。
            intervals.push(dtBeat);
            if (intervals.length > 12) intervals.shift();
          }
          // 序列化点头：当前点头没播完就跳过这次（完整播完再下一次），避免抽搐。
          // 时长取拍间隔的 ~85%，并夹在 [220,760]ms：既是"一次完整点头"，
          // 又不会因快歌变成高频抖动；慢歌则播完回到 neutral 等待下一拍。
          if (!nodActive) {
            nodActive = true;
            nodStart = now;
            nodDurMs = clamp((dtBeat || 500) * 0.85, 220, 760);
          }
          // B：每拍把相位往"最低点(0.25)"轻推 —— 让连续正弦与真实鼓点同频同相，
          // 但保留正弦的平滑（不是每拍抽一下），这正是"合拍却不机械"的关键。
          phase += shortestTo(0.25 - phase) * 0.35;
        }
        nod *= DECAY;
        if (nod < 0.001) nod = 0;

        // ---- A/B 模式选择 + 按当前速度连续推进相位 ----
        // B 方案（启用且 BPM 已锁定）：用测得的歌曲速度；
        // A 方案（启用）：用 aSpeed 作基础速度（可调，替代固定 90）；
        // 两者都关：不推进相位（配合下方 level 衰减 → 完全静止）。
        const bActive = enableB && bpmStable && bpm > 0;
        const aActive = enableA;
        const dtMs = prevTick ? Math.min(200, now - prevTick) : 33;
        prevTick = now;
        let tempo = 0;
        if (bActive) tempo = bpm;
        else if (aActive) tempo = aSpeed;
        if (tempo > 0) {
          phase += (dtMs / 1000) * (tempo / 60);        // 每秒推进 tempo/60 个周期
          phase -= Math.floor(phase);                   // 归一到 0..1
        }
        // 两个方案都关 → 无律动：把幅度平滑收敛到 0（角色静止，不点头不摆）
        if (!bActive && !aActive) {
          level *= 0.85;
          if (level < 0.001) level = 0;
        }

        // 长时间没有起音 → 音乐可能停了：解除锁定并清空样本，避免用过期速度空摆
        if (now - lastOnsetAt > 3000) { bpmStable = false; bpm = 0; intervals.length = 0; bpmVotes.length = 0; }

        // 每 500ms 做一次自相关估测（不必每帧做，省算力）
        if (!lastEstAt || now - lastEstAt >= EST_EVERY_MS) { lastEstAt = now; estimateTempo(); }

        emitDiag('');   // 内部按 DIAG_MIN_MS 限流；调试窗没开时是空操作
      } catch (e) {
        log('节拍检测异常：' + (e && e.message || e));
      }
    }

    function setEnabled(on) {
      on = !!on;
      if (on === enabled && running === on) return;
      enabled = on;
      if (on) {
        emitDiag('', true);            // 让调试面板立刻反映"已开启、正在启动采集"
        if (!running) {
          startCapture().then((ok) => {
            running = ok;
            if (!ok) { enabled = false; }
            emitDiag(ok ? '' : '音频采集未能启动（请确认已授予捕获权限 / 声卡有回环音频）', true);
          });
        }
      } else {
        stopStream();
        running = false;
        nod = 0;
        nodActive = false;
        log('已停止系统音频采集');
        emitDiag('', true);            // 立即上报"已关闭"，面板不必等心跳
      }
    }

    function setParams(p) {
      const prevSrc = audioSource;
      applyCfg(p);
      log('参数已更新：eyeClose=' + eyeClose + ' nodStrength=' + nodStrength +
        ' swayStrength=' + swayStrength + ' sensitivity=' + sensitivity + ' audioSource=' + audioSource);
      // 设置窗改了监听设备：正在采集的话要按新来源重启，否则换设备不生效
      if (audioSource !== prevSrc) {
        log('监听设备变更（' + prevSrc + ' → ' + audioSource + '），重启音频采集');
        restartCapture();
      }
    }

    // 若当前正在采集，先停再按当前 audioSource 重启（换设备/换来源时用）。
    function restartCapture() {
      if (!enabled && !running) return;
      stopStream();
      running = false;
      startCapture().then((ok) => {
        running = ok;
        if (!ok) enabled = false;
        emitDiag(ok ? '' : '音频采集未能启动（换来源后启动失败）', true);
      });
    }

    // 切换音频来源（'loopback' 或某个输入设备 deviceId）。若正在采集会立即用新来源重启。
    function setAudioSource(id) {
      const next = (id && typeof id === 'string' && id) ? id : 'loopback';
      if (next === audioSource) return;
      audioSource = next;
      log('音频来源切换为：' + audioSource);
      restartCapture();
    }

    // —— A+B 混合律动的对外取值（供 live2d-loader 的 _musicTick 每帧读取）——
    function getNod() { return nod; }                    // 重拍脉冲 0..1（兼容旧名；= 下面的 getPeak）
    function getPeak() { return nod; }                   // 重拍脉冲 0..1（副歌/重拍时短暂睁眼用）
    function getLevel() { return level; }                // 相对响度 0..1 = 律动幅度系数（A）
    function getSwing() { return Math.sin(2 * Math.PI * phase); } // 连续律动 -1..1（B：与 BPM 同频的正弦；已不再驱动可见点头）
    // 序列化点头包络（头部用）：neutral→低头→neutral 的单峰正弦（0→1→0）。
    // 在取值时按墙钟现算，渲染帧(60fps)采样也平滑；一次没播完时返回当前进度，播完自动归零。
    function getNodEnv() {
      if (!nodActive) return 0;
      const u = (performance.now() - nodStart) / nodDurMs;
      if (u >= 1) { nodActive = false; return 0; }
      return Math.sin(Math.PI * u);
    }
    // 序列化点头包络（身体用）：0→1→0→-1→0，一次点头内身体左右摆一个来回，与头部同步。
    function getNodSway() {
      if (!nodActive) return 0;
      const u = (performance.now() - nodStart) / nodDurMs;
      if (u >= 1) return 0;
      return Math.sin(2 * Math.PI * u);
    }
    function getBpm() { return bpmStable ? Math.round(bpm * 10) / 10 : 0; } // 已锁定的 BPM（1 位小数）；0 = 未锁定
    function isBpmStable() { return bpmStable; }
    function getEyeClose() { return eyeClose; }
    function getNodStrength() { return nodStrength; }    // 头部起伏幅度
    function getSwayStrength() { return swayStrength; }  // 身体摆动幅度
    // 当前实际跑哪个方案（供设置窗观测面板）：B=已锁定 BPM 的正弦；A=连续律动（aSpeed）；
    // '-'=没在放歌或 A/B 都关。既反映 enableA/enableB 开关，也反映 BPM 是否测稳。
    function getMode() {
      if (!isPlaying()) return '-';
      if (enableB && bpmStable && bpm > 0) return 'B';
      if (enableA) return 'A';
      return '-';
    }
    // 是否正在播放音乐：以"最近 1.5s 内是否有音量"判定（不再用起音）。
    // 起音只反映节拍，安静段落没有起音但明明在放歌 → 会显示"未检测到音乐"却仍在晃。
    // 暂停播放后音量归零，1.5s 后判定停止，与"暂停时模型停下"的实际表现一致。
    // 用途：决定要不要闭眼陶醉 —— 开着音律识别却没放歌时，不该闭着眼发呆。
    function isPlaying() { return extMode ? extPlaying : ((performance.now() - lastLoudAt) < 1500); }

    // ------------------------------------------------------------------
    // 调试面板数据源
    // ------------------------------------------------------------------
    // 只读地取当前点头包络：不推进状态机（不把 nodActive 置 false）。
    // 若这里也走 getNodEnv()，调试面板的读取会跟渲染帧抢着结束一次点头。
    function peekNod() {
      if (!nodActive) return { active: false, u: 0, env: 0, sway: 0, durMs: nodDurMs };
      const u = (performance.now() - nodStart) / nodDurMs;
      if (u >= 1) return { active: false, u: 1, env: 0, sway: 0, durMs: nodDurMs };
      return { active: true, u: u, env: Math.sin(Math.PI * u), sway: Math.sin(2 * Math.PI * u), durMs: nodDurMs };
    }

    function emitDiag(error, force) {
      // 面板没开就不用发（心跳/补发走 force 忽略 debugOpen，见 setDebugOpen）
      if (!debugOpen && !force) return;
      const now = Date.now();
      if (!force && now - _lastDiagSent < DIAG_MIN_MS) return;
      _lastDiagSent = now;
      const api = window.desktopPet;
      if (!api || !api.send) return;
      const nd = peekNod();
      const swing = Math.sin(2 * Math.PI * phase);
      const pnow = performance.now();
      let model = null;
      try { model = modelProbe ? modelProbe() : null; } catch (e) { model = null; }
      const payload = {
        t: now,
        state: {
          enabled: !!enabled,
          running: !!running,
          extMode: !!extMode,
          playing: isPlaying(),
          mode: getMode(),
          error: error || ''
        },
        cfg: {
          eyeClose: eyeClose, nodStrength: nodStrength, swayStrength: swayStrength,
          sensitivity: sensitivity, maxTempo: maxTempo, enableA: !!enableA, enableB: !!enableB,
          aSpeed: aSpeed, audioSource: String(audioSource == null ? '' : audioSource)
        },
        raw: {
          energy: lastEnergy, avg: avg, flux: lastFlux, level: level, peakEnv: peakEnv,
          silenceE: SILENCE_E,
          onsetThreshold: avg * sensitivity,          // 起音判定门槛（能量 > 它才算一拍）
          amp: Math.max(0, Math.min(1, level))
        },
        beat: {
          count: onsetCount,
          lastAgoMs: lastOnsetAt ? (pnow - lastOnsetAt) : -1,
          lastGapMs: lastOnsetGapMs,
          minGap: MIN_GAP,
          intervals: intervals.slice(-8)
        },
        bpm: {
          value: bpm, stable: !!bpmStable,
          votes: bpmVotes.slice(-10), voteCount: bpmVotes.length, voteMax: bpmVoteMax,
          fps: 1000 / Math.max(1, avgDt), avgDt: avgDt,
          fluxLen: fluxBuf.length, fluxCap: lastFluxCap,
          estEveryMs: EST_EVERY_MS, winSec: FLUX_WIN_SEC
        },
        phase: { phase: phase, swing: swing },
        nod: nd,
        ext: { playing: !!extPlaying, peak: extPeak, onsets: lastExtOnsets },
        model: model
      };
      lastDiagPayload = payload;
      try { api.send('pet:musicDebug', payload); } catch (e) {}
    }

    // 调试窗开/关：开着才定期上报；没采集时靠心跳让面板显示"当前为什么不动"
    function setDebugOpen(on) {
      debugOpen = !!on;
      if (debugOpen) {
        // 心跳走**非强制**的 emitDiag：追踪器正在跑时它会被 66ms 限流吃掉（等于空转），
        // 只有停着不跑时才会真正每 250ms 发一次 —— 面板这时才能显示"为什么没在动"。
        if (!debugHeartbeat) debugHeartbeat = setInterval(() => emitDiag(''), 250);
        emitDiag('', true);   // 开窗第一份立刻给，不等限流/心跳
      } else if (debugHeartbeat) {
        clearInterval(debugHeartbeat);
        debugHeartbeat = null;
      }
    }
    // 立即补发最近一份快照（绕过限流）：调试窗就绪时用，免得空等一个限流周期
    function forceEmit() {
      if (lastDiagPayload) { try { window.desktopPet.send('pet:musicDebug', lastDiagPayload); } catch (e) {} }
      else emitDiag('', true);
    }
    function setModelProbe(fn) { modelProbe = (typeof fn === 'function') ? fn : null; }

    return {
      start: () => setEnabled(true),
      stop: () => setEnabled(false),
      setEnabled: setEnabled,
      setParams: setParams,
      setAudioSource: setAudioSource,
      getNod: getNod,
      getPeak: getPeak,
      getLevel: getLevel,
      getSwing: getSwing,
      getNodEnv: getNodEnv,
      getNodSway: getNodSway,
      getBpm: getBpm,
      isBpmStable: isBpmStable,
      getEyeClose: getEyeClose,
      getNodStrength: getNodStrength,
      getSwayStrength: getSwayStrength,
      getMode: getMode,
      isPlaying: isPlaying,
      isEnabled: () => enabled,
      isActive: () => running,
      // —— 调试面板（见文件内"调试面板数据源"一节）——
      setDebugOpen: setDebugOpen,     // 面板开/关：控制上报与心跳
      requestDiag: forceEmit,         // 面板就绪时补发最近一份快照
      setModelProbe: setModelProbe    // 注入"读取实际写入模型的参数值"的回调
    };
  }

  window.MusicTracker = { init: create, create: create };
})();
