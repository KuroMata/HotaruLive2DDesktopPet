// screen-tracker.js —— 屏幕运动追踪（路线 D）
//
// 思路：主进程用 desktopCapturer 枚举屏幕源、把 source id 经 IPC 给到渲染进程；渲染进程用
// navigator.mediaDevices.getUserMedia({ chromeMediaSource:'desktop', chromeMediaSourceId }) 拉到
// 整屏视频流，每帧降采样到 320x180，做帧差求"发生显著变化的像素"的质心 —— 即画面里正在
// 移动的物体（比如视频中快速平移的角色）。把质心映射成归一化方向 (x 右正、y 下正，-1..1，
// 与鼠标追踪完全同一约定)，喂给 Live2DController.setScreenTarget，于是模型的视线/头部会像
// 追鼠标一样追着那个运动物体转。画面静止一段时间后自动解除追踪，视线平滑退回光标。
//
// 默认关闭，由托盘菜单「屏幕运动追踪」或快捷键 Ctrl+Shift+M 开启。
// 性能：降采样 + 单通道帧差，320x180@15fps 的逐帧运算量极小，不卡。
// 权限：macOS 首次会弹"屏幕录制"授权，拒绝则启动失败并回退关闭（已在日志说明）。
// 多屏：当前取第一个屏幕源（主屏）；其余显示器上的运动暂不追踪，详见下方 sourceId 选择处。
(function () {
  'use strict';

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function log(msg) { if (window.desktopPet && window.desktopPet.log) window.desktopPet.log('[screen-track] ' + msg); }

  // 运动网格（16:9）：把画面切成 GX×GY 个单元格，用于连通域分析。
  // 关键修复：帧差里"鼠标光标"是最醒目、运动最剧烈的小块，若直接取全局质心，
  // 一动鼠标质心就被光标抢走，屏追看起来像在"追鼠标"。改为只取【最大的运动连通块】
  // 质心（内容运动通常铺满多格，光标只占 1~2 格），再用绝对像素下限过滤掉光标/噪点。
  const GX = 16, GY = 9;
  const MIN_MOTION_PX = 120; // 最大运动块的像素数下限：小于它的基本是光标/单点噪点，忽略

  // 全局运动（相机平移 / 视频整体平移）抑制：用行/列投影法估计整屏的主平移量并做补偿，
  // 让"镜头在动、但画面里的人/物相对静止"时不计入运动——只盯相对场景在动的前景。
  // 这样看 FPS 视频时，整段画面平移不会被当成追踪目标（问题②）。
  const GLOBAL_MOTION_R = 16;   // 主平移搜索半径（降采样图像素）
  const COVERAGE_MAX = 0.40;    // 补偿后局部运动像素占比上限：超过则视为仍有大规模场景运动（旋转/缩放/转场/闪光），本帧不锁定目标

  // 创建一个追踪器实例，绑定到给定的 Live2DController。
  function create(controller) {
    // 可调参数（config.json 的 screenTrack 段；缺省用下列保守默认值）。设为可变，
    // 以便设置窗经 pet:setScreenTrackParams 实时调整灵敏度而无需重启追踪。
    const cfg = (window.__companionConfig && window.__companionConfig.screenTrack) || {};
    let CW = 320, CH = 180, FPS = 15;
    let THRESH = 22, MOTION_MIN = 0.012, SPREAD = 0.85, RELEASE_FRAMES = 10;
    function applyParams(p) {
      if (!p || typeof p !== 'object') return;
      if (p.width != null) CW = Math.max(80, Math.min(1280, Math.round(p.width)));
      if (p.height != null) CH = Math.max(45, Math.min(720, Math.round(p.height)));
      if (p.fps != null) FPS = Math.max(1, Math.min(60, Math.round(p.fps)));
      if (p.threshold != null) THRESH = Math.max(1, Math.min(255, Math.round(p.threshold)));
      if (p.motionMin != null) MOTION_MIN = Math.max(0, Math.min(1, Number(p.motionMin)));
      if (p.spread != null) SPREAD = Math.max(0.1, Math.min(5, Number(p.spread)));
      if (p.releaseFrames != null) RELEASE_FRAMES = Math.max(1, Math.min(120, Math.round(p.releaseFrames)));
    }
    applyParams(cfg);

    let enabled = false, active = false, running = false;
    let video = null, canvas = null, ctx = null, stream = null, timer = null;
    let prev = null;            // 上一帧灰度数组（Uint8ClampedArray，长度 CW*CH）
    // 选择捕捉哪块显示器：0 基，与 pet:getDisplays / pet:getScreenSources 的索引顺序一致。
    // 默认 0（第一块屏 = 主屏）。负/越界自动回落到 0。
    let screenIndex = (cfg && cfg.screenIndex != null) ? Number(cfg.screenIndex) : 0;

    // —— 人眼焦点模型（路线 D 改进）——
    // focusX/focusY：当前视线落点（归一化 -1..1），每帧向"显著刺激点"缓动（模拟人眼扫视 saccade）。
    // 画面静止时视线在最后落点短暂停留（fixation），超过 DWELL_FRAMES 才解除、平滑退回（回到朝前/光标），
    // 而不是一静止就立刻把视线拽回中心——更接近"看完一样东西再转回头看你"。
    // hasLocked：是否曾经锁定过运动；未锁定过时静止帧走"回退光标"分支（不强行朝前）。
    let focusX = 0, focusY = 0, dwell = 0, hasLocked = false;
    const DWELL_FRAMES = 45;   // 约 3 秒（@15fps）：静止后视线还停在原落点这么久才松手
    const FOCUS_EASE = 0.5;    // 视线向刺激点缓动系数（越大越像瞬间扫视，越小越柔）
    // 桌宠自身窗口遮罩：透明窗里的模型在动，帧差会把"自己"也算成运动物体，
    // 故按主进程给的窗口屏幕坐标，把该区域从监测中剔除（见 refreshMask）。
    let mask = null;           // {x0,y0,x1,y1}（降采样图坐标，含内边距）；null = 不遮罩
    let maskTimer = null;
    let eye = { nx: 0.5, ny: 0.5 };  // 桌宠"眼睛/头部"在显示器上的归一化位置，作为视线方向原点（问题③：朝宠物自身头部看，而非屏幕中心）
    // —— 采集可靠性（问题①：开启后收不到画面，必须手动关掉再开一次才好的根因）——
    // 根因有两个，缺一不可：
    //   ⓐ 视频元素被"移出可视区"（或早期版本的 display:none）→ Chromium 把不可见媒体当成可暂停对象，
    //      于是解码停摆、video.readyState 恒 < 2，tick() 每帧 early-return，既不报画面也不报错。
    //   ⓑ 首次/偶发的桌面源是"坏的"，且旧的看门狗只重试 1 次就放弃；手动关开一次恰好重建了流。
    // 这里改成"常驻采集健康守护"：只要开关是开的就持续检查——
    //   · 还没跑起来 → 自动尝试启动（失败也隔一会儿重试，不再一次就放弃）；
    //   · 跑起来了但 3s 没有新帧 → 自动重新采集（等价于替用户做"关掉再开一次"）。
    // 于是无论首次失败还是中途卡死，都会在数秒内自愈，不必再手动开关。
    let firstFrameSeen = false;   // 是否已成功取到第一帧（日志/调试用）
    let lastFrameAt = 0;          // 最近一次成功取到帧的时间戳（健康守护据此判断卡死）
    let lastAttemptAt = -1e9;     // 最近一次尝试启动采集的时间戳（启动节流；用极小值保证"首次必定尝试"）
    let startAttempts = 0;        // 启动尝试计数（仅用于日志节流，不做放弃）
    let lastWaitAt = -1e9;        // 最近一次回报"采集中但尚无画面"的时间戳（面板提示节流）
    let supervisorTimer = null;   // 采集健康守护定时器（常驻；仅开关关闭时停）
    let starting = false;         // 是否正在启动/重启采集（防并发重入）
    const FRAME_STALL_MS = 3000;  // 超过这么久没有新帧即视为卡死，自动重采
    let lastDiagPayload = null;   // 最近一次 emit 的完整诊断包（forceEmit 复用，绕过限流立即补发）

    // 只停"这一条采集流"相关的东西（取帧定时器 / 视频元素 / 轨道 / 遮罩），
    // 不动开关与常驻健康守护——守护负责按需把它们重新拉起来。
    function stopStream() {
      if (timer) { clearInterval(timer); timer = null; }
      if (maskTimer) { clearInterval(maskTimer); maskTimer = null; }
      mask = null;
      if (stream) { stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); stream = null; }
      if (video && video.parentNode) { try { video.parentNode.removeChild(video); } catch (e) {} }
      video = null; canvas = null; ctx = null; prev = null;
    }

    async function startCapture() {
      if (!window.desktopPet || typeof window.desktopPet.getScreenSources !== 'function') {
        log('缺少 getScreenSources 接口（preload 未暴露），无法采集屏幕'); return false;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        log('navigator.mediaDevices.getUserMedia 不可用（非安全上下文？），无法采集屏幕'); return false;
      }
      let sources;
      try { sources = await window.desktopPet.getScreenSources(); }
      catch (e) { log('枚举屏幕源失败：' + (e && e.message || e)); return false; }
      if (!sources || sources.error) { log('枚举屏幕源错误：' + (sources && sources.error || '未知')); return false; }
      if (!sources.length) { log('未找到任何屏幕源'); return false; }
      // 多屏：sources 按屏幕顺序列出（与 pet:getDisplays 的 index 对应）。
      // 按当前选中的 screenIndex 取对应源；越界则回落主屏（index 0）。
      let idx = (isFinite(screenIndex) && screenIndex >= 0) ? Math.round(screenIndex) : 0;
      if (idx >= sources.length) idx = 0;
      const sourceId = sources[idx].id;

      let media;
      try {
        media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId
            }
          }
        });
      } catch (e) {
        log('getUserMedia(desktop) 失败：' + (e && e.message || e) + '（请确认已授予屏幕录制/捕获权限）');
        return false;
      }
      stream = media;
      // 桌面源可能被系统回收（分辨率切换 / 显示器热插拔 / 权限被撤销）→ 轨道结束就交给健康守护重采。
      try {
        const vt = stream.getVideoTracks && stream.getVideoTracks()[0];
        if (vt) vt.onended = () => { log('采集轨道已结束，准备自动重新采集'); running = false; };
      } catch (e) {}
      video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.autoplay = true;
      video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
      // 【关键】不要把视频元素 display:none，也不要把它移到可视区之外——Chromium 会把"不可见"的媒体
      // 当成可暂停对象而停掉解码，于是 drawImage 永远拿不到帧（正是"开启后收不到画面"的元凶之一）。
      // 改为"留在视口内、极小、几乎全透明"：既能正常解码，又不影响透明桌宠的外观与点击。
      video.style.position = 'fixed';
      video.style.left = '0px';
      video.style.top = '0px';
      video.style.width = '2px';
      video.style.height = '2px';
      video.style.opacity = '0.01';
      video.style.pointerEvents = 'none';
      video.style.zIndex = '-1';
      document.body.appendChild(video);
      video.srcObject = stream;
      await new Promise((res) => {
        let done = false;
        const fin = () => {
          if (done) return; done = true;
          try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
          res();
        };
        video.onloadedmetadata = fin;
        video.onloadeddata = fin;
        video.onplaying = fin;
        setTimeout(fin, 1200);   // 某些环境下事件不触发，兜底继续（取帧由 tick + 健康守护负责）
      });
      canvas = document.createElement('canvas');
      canvas.width = CW; canvas.height = CH;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      prev = null;
      firstFrameSeen = false;
      lastFrameAt = Date.now();   // 从本次尝试重新计时；守护据此判断"启动后多久还没出帧"
      if (timer) { clearInterval(timer); timer = null; }
      timer = setInterval(tick, Math.max(33, Math.round(1000 / FPS)));
      // 桌宠自身遮罩：拉到窗口屏幕坐标并定周期刷新（窗口可被拖动/缩放）
      refreshMask();
      if (maskTimer) { clearInterval(maskTimer); maskTimer = null; }
      maskTimer = setInterval(() => { refreshMask(); }, 1000);
      log('已启动屏幕采集（' + CW + 'x' + CH + ' @' + FPS + 'fps），追踪屏幕 index=' + idx + '（显示器 ' + (idx + 1) + '）');
      return true;
    }

    // —— 采集健康守护：开关打开时常驻，负责"启动 + 自愈"，等价于自动替用户做"关掉再开一次" ——
    function supervisor() {
      if (!enabled) return;
      if (starting) return;                       // 正在启动/重启，勿重入
      const now = Date.now();
      if (!running) {
        if (now - lastAttemptAt < 1500) return;   // 启动节流：失败时不猛试
        lastAttemptAt = now;
        starting = true;
        startAttempts++;
        startCapture().then((ok) => {
          starting = false;
          running = !!ok;
          if (ok) { startAttempts = 0; return; }
          // 不放弃：保持开关打开，交给下一轮继续尝试（日志节流，避免刷屏）
          if (startAttempts <= 2 || startAttempts % 5 === 0) {
            log('采集启动失败（第 ' + startAttempts + ' 次），将在后台持续自动重试；若长时间不成功请检查屏幕录制/捕获权限');
          }
          emitStopped('采集尚未成功（正在后台自动重试；若持续失败请检查屏幕录制/捕获权限）');
        }).catch(() => { starting = false; });
        return;
      }
      // 已在运行：检查是否卡死（长时间没有新帧）→ 自动重新采集，下一轮守护会把它拉起来
      if (lastFrameAt > 0 && (now - lastFrameAt) > FRAME_STALL_MS) {
        log('已 ' + Math.round((now - lastFrameAt) / 1000) + 's 没有取到新帧，自动重新采集');
        stopStream();
        running = false;
        firstFrameSeen = false;
        return;
      }
      // 采集中但一直没出帧：给调试面板一个明确提示，别让它一片空白（问题①的可观测性）
      if (!firstFrameSeen && (now - lastWaitAt) > 2500) {
        lastWaitAt = now;
        emitWaiting('正在采集，但尚未取到画面（守护会自动重试/重采；若持续如此请检查屏幕录制权限）');
      }
    }
    function startSupervisor() {
      stopSupervisor();
      lastAttemptAt = -1e9;   // 立即试第一次（不等首个守护周期）
      lastWaitAt = -1e9;
      supervisor();
      supervisorTimer = setInterval(supervisor, 1500);
    }
    function stopSupervisor() {
      if (supervisorTimer) { clearInterval(supervisorTimer); supervisorTimer = null; }
      starting = false;
    }

    // 桌宠自身窗口遮罩：取主进程给的窗口屏幕坐标 + 当前追踪显示器的 bounds，
    // 算出降采样图里的遮罩矩形（含内边距），让帧差忽略这块区域（否则模型把自己当运动物体）。
    async function refreshMask() {
      let pet = null, disp = null;
      try {
        if (window.desktopPet && typeof window.desktopPet.getPetWindowRect === 'function') {
          pet = await window.desktopPet.getPetWindowRect();
        }
      } catch (e) {}
      try {
        if (window.desktopPet && typeof window.desktopPet.getDisplays === 'function') {
          const ds = await window.desktopPet.getDisplays();
          if (ds && !ds.error) {
            let idx = (isFinite(screenIndex) && screenIndex >= 0) ? Math.round(screenIndex) : 0;
            if (idx >= ds.length) idx = 0;
            disp = ds[idx];
          }
        }
      } catch (e) {}
      if (!pet || !disp || !disp.w || !disp.h) { mask = null; return; }
      const pad = 14;   // 内边距：吃掉窗口阴影/圆角，避免边缘漏检
      const px0 = pet.x - pad, py0 = pet.y - pad;
      const px1 = pet.x + pet.width + pad, py1 = pet.y + pet.height + pad;
      const ox0 = Math.max(px0, disp.x), oy0 = Math.max(py0, disp.y);
      const ox1 = Math.min(px1, disp.x + disp.w), oy1 = Math.min(py1, disp.y + disp.h);
      if (ox1 <= ox0 || oy1 <= oy0) { mask = null; return; }   // 桌宠不在这块屏上
      const sxe = CW / disp.w, sye = CH / disp.h;
      mask = {
        x0: Math.max(0, Math.round((ox0 - disp.x) * sxe)),
        y0: Math.max(0, Math.round((oy0 - disp.y) * sye)),
        x1: Math.min(CW, Math.round((ox1 - disp.x) * sxe)),
        y1: Math.min(CH, Math.round((oy1 - disp.y) * sye))
      };
      // 桌宠眼睛/头部归一化位置（用于问题③：以宠物自身头部为视线原点，而非屏幕中心）。
      // 取窗口中心点（模型脸部大致位于窗口中部）；若宠物不在这块屏上则回落屏幕中心。
      if (pet && disp && disp.w && disp.h) {
        const ex = pet.x + pet.width * 0.5;
        const ey = pet.y + pet.height * 0.5;
        eye = { nx: (ex - disp.x) / disp.w, ny: (ey - disp.y) / disp.h };
      } else {
        eye = { nx: 0.5, ny: 0.5 };
      }
    }

    function tick() {
      if (!video || !ctx || video.readyState < 2) return;
      try {
        ctx.drawImage(video, 0, 0, CW, CH);
        // 取到一帧即视为采集正常：刷新时间戳，健康守护据此判断"是否卡死"
        firstFrameSeen = true;
        lastFrameAt = Date.now();
        const data = ctx.getImageData(0, 0, CW, CH).data;
        const n = CW * CH;
        const cur = new Uint8ClampedArray(n);
        const cellW = CW / GX, cellH = CH / GY;
        // 每格累计运动像素的 x/y 和与数量（像素坐标，非归一化）
        const cellSx = new Float64Array(GX * GY);
        const cellSy = new Float64Array(GX * GY);
        const cellCnt = new Int32Array(GX * GY);
        const havePrev = !!prev;

        // —— 第一遍：算本帧灰度 cur，并顺带累加本帧 / 上一帧的行·列投影（用于全局运动估计） ——
        const rowCur = new Int32Array(CH), rowPrev = new Int32Array(CH);
        const colCur = new Int32Array(CW), colPrev = new Int32Array(CW);
        for (let y = 0; y < CH; y++) {
          let rs = 0;
          const base = y * CW;
          for (let x = 0; x < CW; x++) {
            const i = base + x;
            const gc = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
            cur[i] = gc;
            rs += gc; colCur[x] += gc;                       // 本帧行/列投影
            if (havePrev) { const gp = prev[i]; colPrev[x] += gp; }  // 上一帧列投影
          }
          rowCur[y] = rs;
          if (havePrev) { let rp = 0; for (let x = 0; x < CW; x++) rp += prev[base + x]; rowPrev[y] = rp; }
          else rowPrev[y] = 0;
        }

        // —— 第二遍：用行/列投影 SAD 估计整屏主平移 (dx,dy)，把"镜头 / 视频整体平移"抵消掉 ——
        // 这样看 FPS 视频时，整段画面平移不会被当成运动，只保留相对场景在动的前景（人 / 物）。
        let dx = 0, dy = 0;
        if (havePrev) {
          let bestDySAD = Infinity;
          for (let o = -GLOBAL_MOTION_R; o <= GLOBAL_MOTION_R; o++) {
            let sad = 0;
            for (let y = 0; y < CH; y++) {
              let yy = y + o; if (yy < 0) yy = 0; else if (yy >= CH) yy = CH - 1;
              sad += Math.abs(rowCur[y] - rowPrev[yy]);
            }
            if (sad < bestDySAD) { bestDySAD = sad; dy = o; }
          }
          let bestDxSAD = Infinity;
          for (let o = -GLOBAL_MOTION_R; o <= GLOBAL_MOTION_R; o++) {
            let sad = 0;
            for (let x = 0; x < CW; x++) {
              let xx = x + o; if (xx < 0) xx = 0; else if (xx >= CW) xx = CW - 1;
              sad += Math.abs(colCur[x] - colPrev[xx]);
            }
            if (sad < bestDxSAD) { bestDxSAD = sad; dx = o; }
          }
        }

        // —— 第三遍：做"补偿后的帧差"——参考像素取 prev 中平移 (dx,dy) 后的位置 ——
        // 命中阈值的像素才计入单元格；桌宠自身窗口区域（mask）内的运动直接跳过。
        for (let y = 0; y < CH; y++) {
          const base = y * CW;
          for (let x = 0; x < CW; x++) {
            const i = base + x;
            const g = cur[i];
            let ref = g;
            if (havePrev) {
              const py = y + dy, px = x + dx;
              if (py >= 0 && py < CH && px >= 0 && px < CW) ref = prev[py * CW + px];
            }
            const d = g - ref;
            if (d > THRESH || d < -THRESH) {
              // 像素坐标即 x/y（已在 0..CW-1 / 0..CH-1 内），这里用 x/y 直接索引单元格
              if (mask && x >= mask.x0 && x < mask.x1 && y >= mask.y0 && y < mask.y1) continue;
              let gx = (x / cellW) | 0; if (gx >= GX) gx = GX - 1;
              let gy = (y / cellH) | 0; if (gy >= GY) gy = GY - 1;
              const idx = gy * GX + gx;
              cellSx[idx] += x; cellSy[idx] += y; cellCnt[idx]++;
            }
          }
        }

        prev = cur;
        // 补偿后局部运动像素占比：过大说明仍有大规模场景运动（旋转 / 缩放 / 转场 / 闪光），
        // 本帧不应锁定目标，避免整屏被误判（见下方 target 决策）。
        let localPixels = 0;
        for (let s = 0; s < GX * GY; s++) localPixels += cellCnt[s];
        const coverage = localPixels / n;

        // 连通域：对"热单元格"(cellCnt>0)做 4 邻接 BFS，每个连通块 = 一个"被识别到的物体"（已剔除桌宠自身）。
        // 同时记录每个块的包围盒（格坐标），方便调试面板把物体框出来、逐个列出状态。
        const visited = new Uint8Array(GX * GY);
        const comps = [];
        for (let s = 0; s < GX * GY; s++) {
          if (visited[s] || cellCnt[s] === 0) continue;
          const stack = [s]; visited[s] = 1;
          let compCnt = 0, compSx = 0, compSy = 0;
          let gx0 = GX, gy0 = GY, gx1 = 0, gy1 = 0;
          while (stack.length) {
            const c = stack.pop();
            compCnt += cellCnt[c]; compSx += cellSx[c]; compSy += cellSy[c];
            const cgx = c % GX, cgy = (c / GX) | 0;
            if (cgx < gx0) gx0 = cgx; if (cgx > gx1) gx1 = cgx;
            if (cgy < gy0) gy0 = cgy; if (cgy > gy1) gy1 = cgy;
            if (cgx > 0 && !visited[c - 1] && cellCnt[c - 1] > 0) { visited[c - 1] = 1; stack.push(c - 1); }
            if (cgx < GX - 1 && !visited[c + 1] && cellCnt[c + 1] > 0) { visited[c + 1] = 1; stack.push(c + 1); }
            if (cgy > 0 && !visited[c - GX] && cellCnt[c - GX] > 0) { visited[c - GX] = 1; stack.push(c - GX); }
            if (cgy < GY - 1 && !visited[c + GX] && cellCnt[c + GX] > 0) { visited[c + GX] = 1; stack.push(c + GX); }
          }
          comps.push({ cnt: compCnt, cx: compSx / compCnt, cy: compSy / compCnt,
            x0: Math.round(gx0 * cellW), y0: Math.round(gy0 * cellH),
            x1: Math.round((gx1 + 1) * cellW), y1: Math.round((gy1 + 1) * cellH) });
        }

        // —— 人眼焦点模型：从所有"够大"的运动块里算一个加权显著点（较大者权重大、离当前视线越近额外加权），
        // 视线焦点每帧向该点缓动（模拟扫视），而非死盯最大块；画面静止时视线在最后落点停留，超时再松手。
        // 方向以"宠物眼睛"为原点（eye.nx/eye.ny），使宠物朝"相对自己头部"的方向看（问题③）。
        let sw = 0, sx = 0, sy = 0, bestComp = -1, bestDist = 1e9;
        for (let i = 0; i < comps.length; i++) {
          const c = comps[i];
          if (c.cnt < MIN_MOTION_PX) continue;                 // 太小的基本是光标/噪点
          const nx = clamp((c.cx / CW - eye.nx) * 2 / SPREAD, -1, 1);
          const ny = clamp((c.cy / CH - eye.ny) * 2 / SPREAD, -1, 1);
          const df = Math.hypot(nx - focusX, ny - focusY);     // 与当前视线落点的距离
          const prox = 1 / (1 + df * 1.5);                      // 注意力延续：离视线越近越优先（温和）
          const w = c.cnt * (0.6 + 0.4 * prox);
          sw += w; sx += w * c.cx; sy += w * c.cy;
          if (df < bestDist) { bestDist = df; bestComp = i; }  // 调试高亮：离焦点最近的"够大"块
        }

        let target = { nx: focusX, ny: focusY, active: active };
        // 仅当确有局部运动、且补偿后运动占比不过高（非整屏平移/旋转/转场）时才锁定目标
        if (sw > 0 && coverage <= COVERAGE_MAX) {
          const tnx = clamp((sx / sw / CW - eye.nx) * 2 / SPREAD, -1, 1);
          const tny = clamp((sy / sw / CH - eye.ny) * 2 / SPREAD, -1, 1);
          focusX += (tnx - focusX) * FOCUS_EASE;
          focusY += (tny - focusY) * FOCUS_EASE;
          active = true; dwell = 0; hasLocked = true;
          target = { nx: focusX, ny: focusY, active: true };
          controller.setScreenTarget(focusX, focusY, true);
        } else if (hasLocked) {
          // 画面静止但曾经锁定过：视线保持在最后落点（注视 fixation），不急着回正
          dwell++;
          if (dwell <= DWELL_FRAMES) {
            active = true;
            target = { nx: focusX, ny: focusY, active: true };
            controller.setScreenTarget(focusX, focusY, true);
          } else {
            active = false; hasLocked = false;
            controller.setScreenTarget(focusX, focusY, false);
            log('画面静止，解除运动追踪');
          }
        } else {
          // 从未锁定过（刚开启且一直静止）：视线松手，退回光标/朝前
          if (active) { active = false; controller.setScreenTarget(focusX, focusY, false); }
          target = { nx: focusX, ny: focusY, active: false };
        }

        // 把本帧检测实况回传给调试面板（限流，详见 emitDiag）
        emitDiag(cur, cellCnt, comps, bestComp, target,
          { enabled: true, running: true, active: active, focus: { x: focusX, y: focusY },
            dwell: dwell, dwellFrames: DWELL_FRAMES, mask: mask, coverage: coverage, eye: eye, error: '' });
      } catch (e) {
        log('帧分析异常：' + (e && e.message || e));
      }
    }

    // 把当前启停状态回传给主进程（同步托盘菜单勾选态）；不回发 pet:setScreenTrack，避免环
    function report(v) {
      if (window.desktopPet && window.desktopPet.send) window.desktopPet.send('pet:screenTrackState', !!v);
    }

    // 调试面板数据源：把每帧检测实况打成一份快照发到主进程，由其转发给"屏幕追踪调试"窗口。
    // 限流到 ~12fps，避免高频 IPC 占带宽；gray 为降采样灰度帧（CW*CH），components 为每个运动连通块。
    // 停止/失败时也会发一次（先把 _lastDiag 清零以绕过限流），让面板立刻显示"未运行"。
    let _lastDiag = 0;
    function emitDiag(gray, cells, comps, bestIdx, target, st) {
      const now = Date.now();
      if (now - _lastDiag < 80) return;          // 限流
      _lastDiag = now;
      if (!window.desktopPet || !window.desktopPet.send) return;
      // gray / cells 转成普通 Array 再走 IPC：TypedArray 跨渲染进程（主窗→调试窗）序列化偶发丢值，
      // 普通 Array 最稳，避免"调试窗收不到画面"的首帧问题（问题①）。
      const cellArr = Array.from(cells);
      const compArr = (comps || []).map((c, i) => ({
        cnt: c.cnt,
        cx: Math.round(c.cx), cy: Math.round(c.cy),
        x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
        tracked: (i === bestIdx)
      }));
      const diag = {
        cw: CW, ch: CH, gx: GX, gy: GY,
        gray: gray ? Array.from(gray) : null,
        cells: cellArr,
        coverage: (st && st.coverage != null) ? st.coverage : 0,
        eye: (st && st.eye) ? { nx: st.eye.nx, ny: st.eye.ny } : { nx: 0.5, ny: 0.5 },
        components: compArr,
        best: (bestIdx >= 0 && comps[bestIdx])
          ? { cnt: comps[bestIdx].cnt, cx: Math.round(comps[bestIdx].cx), cy: Math.round(comps[bestIdx].cy) } : null,
        target: target || { nx: 0, ny: 0, active: false },
        focus: (st && st.focus) ? { x: st.focus.x, y: st.focus.y } : { x: 0, y: 0 },
        mask: (st && st.mask) ? { x0: st.mask.x0, y0: st.mask.y0, x1: st.mask.x1, y1: st.mask.y1 } : null,
        state: {
          enabled: !!st.enabled,
          running: !!st.running,
          active: !!st.active,
          dwell: st.dwell | 0,
          dwellFrames: st.dwellFrames | 0,
          coverage: (st && st.coverage != null) ? st.coverage : 0,
          screenIndex: screenIndex,
          error: (st && st.error) || ''
        },
        params: { CW: CW, CH: CH, FPS: FPS, THRESH: THRESH, MOTION_MIN: MOTION_MIN,
          SPREAD: SPREAD, MIN_MOTION_PX: MIN_MOTION_PX }
      };
      try { window.desktopPet.send('pet:screenTrackDebug', diag); } catch (e) {}
      lastDiagPayload = diag;   // 缓存完整包，供 forceEmit 绕过限流立即补发
    }
    // 立即把最近一帧诊断补发给主进程（绕过 80ms 限流）：调试窗就绪 / 切屏时用于即刻拿到画面，
    // 不必等下一次限流窗口。无可用帧（追踪未跑）时为空操作。
    function forceEmit() {
      if (lastDiagPayload && window.desktopPet && window.desktopPet.send) {
        try { window.desktopPet.send('pet:screenTrackDebug', lastDiagPayload); } catch (e) {}
      }
    }
    function emitStopped(error) {
      _lastDiag = 0;   // 绕过限流，立即上报"未运行"
      emitDiag(null, new Int32Array(GX * GY), [], -1, { nx: 0, ny: 0, active: false },
        { enabled: false, running: false, active: false, dwell: 0,
          dwellFrames: DWELL_FRAMES, error: error || '' });
    }
    // 采集中但尚无画面时的状态回报：让调试面板显示"正在采集/正在重试"，而不是一片空白。
    // 仅当调试窗打开时才值得发（emitDiag 内部不做判断，这里靠 lastWaitAt 节流，代价很低：gray=null）。
    function emitWaiting(msg) {
      _lastDiag = 0;
      emitDiag(null, new Int32Array(GX * GY), [], -1, { nx: 0, ny: 0, active: false },
        { enabled: !!enabled, running: !!running, active: false, dwell: 0,
          dwellFrames: DWELL_FRAMES, error: msg || '' });
    }

    function setEnabled(on) {
      on = !!on;
      if (on === enabled && running === on) return;
      enabled = on;
      if (controller && typeof controller.setScreenTrackEnabled === 'function') {
        controller.setScreenTrackEnabled(on);   // 关键：打开 live2d-loader 的屏幕追踪开关，否则视线不跟
      }
      if (on) {
        focusX = 0; focusY = 0; dwell = 0; hasLocked = false; startAttempts = 0;   // 重置焦点状态与重试计数，从朝前开始
        report(true);        // 乐观更新托盘勾选（失败/未成功都会由守护继续尝试）
        startSupervisor();   // 常驻守护：负责启动 + 卡死自愈，不再"失败即放弃、需手动重开"
      } else {
        stopSupervisor();
        stopStream();
        running = false; active = false; startAttempts = 0;
        controller.setScreenTarget(0, 0, false);
        log('已停止屏幕运动追踪');
        report(false);
        emitStopped('');
      }
    }

    // 设置窗实时调参：更新数值后若正在运行则重启检测定时器与画布尺寸（下一帧即用新参数）；
    // 同时把"屏幕追踪专用额外牵动参数"实时下发给 Live2DController（问题②：让身体等参数随屏幕运动转）。
    function setParams(p) {
      applyParams(p);
      if (p && controller && typeof controller.setScreenExtra === 'function' && p.extra !== undefined) {
        controller.setScreenExtra(p.extra);
      }
      if (canvas) { canvas.width = CW; canvas.height = CH; }
      if (timer) { clearInterval(timer); timer = null; }
      if (running && stream) timer = setInterval(tick, Math.max(33, Math.round(1000 / FPS)));
      log('参数已更新：' + CW + 'x' + CH + ' @' + FPS + 'fps, thr=' + THRESH + ', motionMin=' + MOTION_MIN + ', spread=' + SPREAD + ', release=' + RELEASE_FRAMES);
    }

    // 切换要追踪的显示器（0 基索引）。若已开启则强制重建采集流以应用新源（守护会在下一轮立刻重启）。
    function setScreen(idx) {
      let v = (idx == null) ? 0 : Number(idx);
      if (!isFinite(v) || v < 0) v = 0;
      screenIndex = v;
      log('目标屏幕设为 index=' + v);
      if (enabled) {
        stopStream(); running = false; firstFrameSeen = false; lastFrameAt = 0;
        lastAttemptAt = 0;
        supervisor();   // 立即重启（换屏）
      }
    }

    return {
      start: () => setEnabled(true),
      stop: () => setEnabled(false),
      setEnabled: setEnabled,
      setParams: setParams,
      setScreen: setScreen,
      getScreen: () => screenIndex,
      toggle: () => setEnabled(!enabled),
      isEnabled: () => enabled,
      isActive: () => active,
      requestDiag: forceEmit
    };
  }

  window.ScreenTracker = { init: create, create: create };
})();
