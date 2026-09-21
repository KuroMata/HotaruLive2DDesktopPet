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
    let noMotion = 0;
    // 选择捕捉哪块显示器：0 基，与 pet:getDisplays / pet:getScreenSources 的索引顺序一致。
    // 默认 0（第一块屏 = 主屏）。负/越界自动回落到 0。
    let screenIndex = (cfg && cfg.screenIndex != null) ? Number(cfg.screenIndex) : 0;

    function stopStream() {
      if (timer) { clearInterval(timer); timer = null; }
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
      video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.style.display = 'none';
      document.body.appendChild(video);
      video.srcObject = stream;
      await new Promise((res) => {
        const done = () => { try { video.play(); } catch (e) {} res(); };
        video.onloadedmetadata = done;
        setTimeout(res, 1000);   // 某些环境下 onloadedmetadata 不触发，兜底等待
      });
      canvas = document.createElement('canvas');
      canvas.width = CW; canvas.height = CH;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      prev = null; noMotion = 0;
      timer = setInterval(tick, Math.max(33, Math.round(1000 / FPS)));
      log('已启动屏幕采集（' + CW + 'x' + CH + ' @' + FPS + 'fps），追踪屏幕 index=' + idx + '（显示器 ' + (idx + 1) + '）');
      return true;
    }

    function tick() {
      if (!video || !ctx || video.readyState < 2) return;
      try {
        ctx.drawImage(video, 0, 0, CW, CH);
        const data = ctx.getImageData(0, 0, CW, CH).data;
        const n = CW * CH;
        const cur = new Uint8ClampedArray(n);
        const cellW = CW / GX, cellH = CH / GY;
        // 每格累计运动像素的 x/y 和与数量（像素坐标，非归一化）
        const cellSx = new Float64Array(GX * GY);
        const cellSy = new Float64Array(GX * GY);
        const cellCnt = new Int32Array(GX * GY);
        const havePrev = !!prev;
        // 单遍：算本帧灰度（存 cur）与帧差（用 prev），命中阈值的像素累加进所在单元格
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          const g = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
          cur[i] = g;
          if (havePrev) {
            const d = g - prev[i];
            if (d > THRESH || d < -THRESH) {
              const cx = i % CW, cy = (i / CW) | 0;
              let gx = (cx / cellW) | 0; if (gx >= GX) gx = GX - 1;
              let gy = (cy / cellH) | 0; if (gy >= GY) gy = GY - 1;
              const idx = gy * GX + gx;
              cellSx[idx] += cx; cellSy[idx] += cy; cellCnt[idx]++;
            }
          }
        }
        prev = cur;

        // 连通域：对"热单元格"(cellCnt>0)做 4 邻接 BFS，取运动像素最多的一块 = 真正的运动物体
        const visited = new Uint8Array(GX * GY);
        let bestCnt = 0, bestX = 0, bestY = 0;
        for (let s = 0; s < GX * GY; s++) {
          if (visited[s] || cellCnt[s] === 0) continue;
          const stack = [s]; visited[s] = 1;
          let compCnt = 0, compSx = 0, compSy = 0;
          while (stack.length) {
            const c = stack.pop();
            compCnt += cellCnt[c]; compSx += cellSx[c]; compSy += cellSy[c];
            const cgx = c % GX, cgy = (c / GX) | 0;
            if (cgx > 0 && !visited[c - 1] && cellCnt[c - 1] > 0) { visited[c - 1] = 1; stack.push(c - 1); }
            if (cgx < GX - 1 && !visited[c + 1] && cellCnt[c + 1] > 0) { visited[c + 1] = 1; stack.push(c + 1); }
            if (cgy > 0 && !visited[c - GX] && cellCnt[c - GX] > 0) { visited[c - GX] = 1; stack.push(c - GX); }
            if (cgy < GY - 1 && !visited[c + GX] && cellCnt[c + GX] > 0) { visited[c + GX] = 1; stack.push(c + GX); }
          }
          if (compCnt > bestCnt) { bestCnt = compCnt; bestX = compSx / compCnt; bestY = compSy / compCnt; }
        }

        // 触发门槛：绝对像素下限（过滤光标/噪点）+ 与 motionMin 挂钩的灵敏度（抬灵敏→更易触发）
        const need = Math.max(MIN_MOTION_PX, (MOTION_MIN * n) * 0.4);
        if (bestCnt >= need) {
          const cxn = bestX / CW, cyn = bestY / CH;   // 0..1
          const nx = clamp((cxn - 0.5) * 2 / SPREAD, -1, 1);
          const ny = clamp((cyn - 0.5) * 2 / SPREAD, -1, 1);
          controller.setScreenTarget(nx, ny, true);
          active = true; noMotion = 0;
        } else {
          noMotion++;
          if (noMotion >= RELEASE_FRAMES && active) {
            active = false;
            controller.setScreenTarget(controller._screenTrack.x, controller._screenTrack.y, false);
            log('画面静止，解除运动追踪');
          }
        }
      } catch (e) {
        log('帧分析异常：' + (e && e.message || e));
      }
    }

    // 把当前启停状态回传给主进程（同步托盘菜单勾选态）；不回发 pet:setScreenTrack，避免环
    function report(v) {
      if (window.desktopPet && window.desktopPet.send) window.desktopPet.send('pet:screenTrackState', !!v);
    }

    function setEnabled(on) {
      on = !!on;
      if (on === enabled && running === on) return;
      enabled = on;
      if (on) {
        report(true);     // 乐观更新托盘勾选（失败会再回传 false）
        if (!running) {
          startCapture().then((ok) => {
            running = ok;
            if (!ok) { enabled = false; report(false); }
          });
        }
      } else {
        stopStream();
        running = false; active = false;
        controller.setScreenTarget(0, 0, false);
        log('已停止屏幕运动追踪');
        report(false);
      }
    }

    // 设置窗实时调参：更新数值后若正在运行则重启检测定时器与画布尺寸（下一帧即用新参数）
    function setParams(p) {
      applyParams(p);
      if (canvas) { canvas.width = CW; canvas.height = CH; }
      if (timer) { clearInterval(timer); timer = null; }
      if (running && stream) timer = setInterval(tick, Math.max(33, Math.round(1000 / FPS)));
      log('参数已更新：' + CW + 'x' + CH + ' @' + FPS + 'fps, thr=' + THRESH + ', motionMin=' + MOTION_MIN + ', spread=' + SPREAD + ', release=' + RELEASE_FRAMES);
    }

    // 切换要追踪的显示器（0 基索引）。若正在运行则重启采集以应用新源；不运行则仅记录待下次启动生效。
    function setScreen(idx) {
      let v = (idx == null) ? 0 : Number(idx);
      if (!isFinite(v) || v < 0) v = 0;
      screenIndex = v;
      log('目标屏幕设为 index=' + v);
      if (enabled && running) {
        stopStream(); running = false;
        startCapture().then((ok) => { running = ok; if (!ok) { enabled = false; report(false); } });
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
      isActive: () => active
    };
  }

  window.ScreenTracker = { init: create, create: create };
})();
