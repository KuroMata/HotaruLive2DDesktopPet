// ---------------------------------------------------------------------------
// Live2D Companion 自检脚本
// ---------------------------------------------------------------------------
// 用途：不改动主程序，用一个独立的 Electron 实例把 app 页面真正加载一遍，
//       检查「资源是否 200 / 依赖是否注册 / 模型是否加载成功 / 待机动作是否在动」。
// 为什么需要它：主窗口是透明置顶的，肉眼很难判断"模型没画出来"到底是没加载、
//       还是加载了但不可见；有了它可以直接拿到结论，而不是靠猜。
//
// 前置：主程序必须已经在运行（自检本身不起静态服务，它连已有的 18765）。
// 用法：先启动 start.cmd，再在 PowerShell 里执行
//   & "D:\live2d-companion\node_modules\electron\dist\electron.exe" "D:\live2d-companion\tools\selfcheck\."
//       或双击 tools\selfcheck\run.cmd
// 产出：同目录下 selfcheck-result.json、selfcheck-shot.png，并在控制台打印结论。
// ---------------------------------------------------------------------------
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 与主程序同款自愈：若 ELECTRON_RUN_AS_NODE 被继承（值非空），electron.exe 会退化
// 成纯 Node，app 为 undefined，本脚本下一行就会报
// "Cannot read properties of undefined (reading 'commandLine')"。
// 此时 process.execPath 仍是 electron.exe，去掉该变量重新拉起自己即可。
if (!app || typeof app.whenReady !== 'function') {
  let healed = false;
  try {
    const { spawn } = require('child_process');
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [__dirname], { detached: true, stdio: 'ignore', env, windowsHide: true });
    child.unref();
    healed = true;
    console.log('[selfcheck] ELECTRON_RUN_AS_NODE was inherited; relaunched as real Electron (pid=' + child.pid + ').');
  } catch (e) { healed = false; }
  if (healed) process.exit(0);
  console.error('[selfcheck] FATAL: not running as an Electron main process. Clear ELECTRON_RUN_AS_NODE and retry.');
  process.exit(1);
}

// 与主程序保持一致：chromium 渲染进程沙箱在受限环境下起不来，会让页面白屏。
app.commandLine.appendSwitch('no-sandbox');

const BASE = 'http://127.0.0.1:18765';
const ACP = 'http://127.0.0.1:9418';
const RESULT = path.join(__dirname, 'selfcheck-result.json');
const SHOT = path.join(__dirname, 'selfcheck-shot.png');

const res = { base: BASE, failed: [], consoleErrors: [], consoleWarnings: [] };
const t0 = Date.now();

function finish(code) {
  res.elapsedMs = Date.now() - t0;
  try { fs.writeFileSync(RESULT, JSON.stringify(res, null, 2), 'utf8'); } catch (e) {}
  // 结论用 ASCII 打印，避免 GBK 控制台乱码
  const out = [];
  out.push('==== live2d-companion selfcheck ====');
  out.push('resource failures (>=400) : ' + (res.failed.length ? JSON.stringify(res.failed) : 'none'));
  out.push('page JS errors            : ' + (res.consoleErrors.length ? JSON.stringify(res.consoleErrors) : 'none'));
  if (res.dom) {
    out.push('model hint visible        : ' + (res.dom.hintDisplay === 'none' ? 'no (loaded OK)' : 'YES -> ' + res.dom.hintText));
    out.push('canvas                    : ' + res.dom.canvas);
  }
  if (res.pixel) {
    out.push('idle animation            : ' + (res.pixel.animated ? 'YES (two frames differ)' : 'NO (static)'));
    out.push('  frame hashes            : ' + res.pixel.hashA + ' / ' + res.pixel.hashB);
  }
  if (res.glass) {
    out.push('background toggle         : ' + (res.glass.changed ? 'OK' : 'BROKEN') +
      ' (' + res.glass.before + ' -> ' + res.glass.after + ')');
    out.push('  glass button label      : ' + res.glass.buttonLabel);
  }
  if (res.dom && res.dom.css) {
    const c = res.dom.css;
    out.push('neon tube bloom           : ' + (c.ringInsetLayers >= 4 ? 'OK' : 'BROKEN') +
      ' (inner layers=' + c.ringInsetLayers + ', ::after content=' + c.frameAfterContent + ')');
    out.push('glass panel inset         : margin-left=' + c.chatMargin +
      '  (0 = 与灯带框内沿对齐，无非灯带的竖直硬边)');
    out.push('glow headroom (--gap)     : ' + c.gap + 'px ' + (c.gap >= 24 ? 'OK' : 'BROKEN (<24, 外发光会被窗口切一刀)'));
  }
  if (res.acp) {
    out.push('workBuddy ACP link        : ' + (res.acp.ok ? 'OK (port ' + res.acp.port + ')' : 'DOWN -> ' + res.acp.code));
    if (res.acp.candidates) out.push('  ports probed            : ' + res.acp.candidates.join(','));
  }
  out.push('details                   : ' + RESULT);
  out.push('screenshot                : ' + SHOT);
  console.log(out.join('\n'));
  app.exit(code);
}

app.whenReady().then(async () => {
  // 窗口尺寸取自 app/config.json，而不是写死 —— 光晕的"刀口"问题与外发光半径
  // 和 --gap（透明内边距）有关，透明边距必须跟着窗口一起量才有意义。
  // （窗口宽高改变不影响该结论：--gap 是绝对像素，不随窗口缩放。）
  let winW = 384, winH = 564;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'config.json'), 'utf-8'));
    if (cfg.window && cfg.window.width) winW = cfg.window.width;
    if (cfg.window && cfg.window.height) winH = cfg.window.height;
  } catch (e) { /* 读不到就用默认值 */ }
  res.windowSize = winW + 'x' + winH;
  // frame:false 才能让"内容区 = 窗口尺寸"，与真实主窗口一致。
  // 否则量到的是"窗口减系统边框/标题栏"（384x564 会变成 368x499），
  // 报告里的尺寸就不是真机尺寸，看着对不上。
  const w = new BrowserWindow({ show: false, frame: false, width: winW, height: winH });
  const ses = w.webContents.session;

  // 拦掉会真的改 WorkBuddy 会话状态的请求，避免自检副作用。
  // 注意要连"同源代理"路径一起拦：页面默认走 18765/api/v1/acp*，由主进程转发到
  // 9418，只拦 9418 是拦不住的。
  // /api/v1/acp/health 特意放行：它只做一次 TCP 探活、无任何副作用，
  // 放行后才能验证"链路未就绪时状态栏显示的是可读原因，而不是 Failed to fetch"。
  ses.webRequest.onBeforeRequest({
    urls: [ACP + '/*', BASE + '/api/v1/acp', BASE + '/api/v1/acp/connect']
  }, (d, cb) => cb({ cancel: true }));
  ses.webRequest.onCompleted({ urls: [BASE + '/*'] }, (d) => {
    if (d.statusCode >= 400) res.failed.push({ url: d.url, status: d.statusCode });
  });
  // 清掉磁盘缓存：Electron 的缓存在多次启动之间保留，否则自检很可能量到旧样式表，
  // 得出与实际不符的尺寸/布局结论（主程序已加 no-store，这里再加一道保险）。
  ses.clearCache(() => {});
  w.webContents.on('console-message', (_e, level, msg) => {
    if (msg.indexOf('Security Warning') !== -1) return; // Electron 开发模式的 CSP 提示，非问题
    if (level >= 2) res.consoleErrors.push(msg);
    else if (level === 1) res.consoleWarnings.push(msg);
  });
  w.webContents.on('did-fail-load', (_e, code, desc, url) => {
    res.failed.push({ url, status: 'did-fail-load ' + code + ' ' + desc });
  });

  try {
    await w.loadURL(BASE + '/');
    // 模型贴图很大（6×4096），留足时间
    await new Promise((r) => setTimeout(r, 14000));

    res.env = await w.webContents.executeJavaScript(`(() => ({
      PIXI: typeof window.PIXI,
      PIXI_version: window.PIXI && window.PIXI.VERSION,
      cubismCore: typeof window.Live2DCubismCore,
      coreVersion: (window.Live2DCubismCore && window.Live2DCubismCore.Version &&
                    window.Live2DCubismCore.Version.csmGetVersion()) || null,
      live2dModel: !!(window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel)
    }))()`);

    res.dom = await w.webContents.executeJavaScript(`(() => {
      const hint = document.getElementById('live2d-hint');
      const c = document.querySelector('#live2d canvas');
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        return Math.round(b.width) + 'x' + Math.round(b.height) + '@' + Math.round(b.left) + ',' + Math.round(b.top); };
      const frame = document.getElementById('window-frame');
      const stage = document.getElementById('stage');
      const g = (el, p) => el ? getComputedStyle(el)[p] : null;
      return {
        hintText: hint ? hint.textContent : null,
        hintDisplay: hint ? getComputedStyle(hint).display : null,
        canvas: c ? (c.width + 'x' + c.height) : null,
        rects: {
          body: r(document.body),
          frame: r(frame),
          stage: r(stage),
          live2d: r(document.getElementById('live2d')),
          chat: r(document.getElementById('chat')),
          bar: r(document.getElementById('bottom-bar'))
        },
        // 这几个值用于确认浏览器拿到的是最新样式表（旧版 stage 是 relative）
        css: {
          bodyPadding: g(document.body, 'paddingTop'),
          stagePosition: g(stage, 'position'),
          stageMask: (g(stage, 'maskImage') || g(stage, 'webkitMaskImage') || '').slice(0, 40),
          // 灯带描边在 ::before 上，必须问伪元素；问元素本身只会得到初始值 add
          ringMaskComposite: frame ? getComputedStyle(frame, '::before').maskComposite : null,
          ringPseudo: (frame ? getComputedStyle(frame, '::before').backgroundImage : '').slice(0, 34),
          // 内晕层数：灯带必须"内外对称"。只做外发光时管子内侧紧邻处 α 仅 24
          //（外侧 95），读起来就是一条硬线——这是"边缘硬边"的根因之一，必须守住。
          ringInsetLayers: frame ? ((g(frame, 'boxShadow') || '').match(/inset/g) || []).length : 0,
          // ::after 曾是"等宽弱环"鞘层，它自身的内外边界就是新的硬边，已移除。
          // 这里断言它保持 'none'，避免以后又被加回来。
          frameAfterContent: frame ? getComputedStyle(frame, '::after').content : null,
          chatMask: (g(document.getElementById('chat'), 'maskImage') || '').slice(0, 40),
          chatMargin: g(document.getElementById('chat'), 'marginLeft'),
          // 透明内边距：外发光必须在到达窗口矩形之前衰减到 0，否则光会"像被切一刀"。
          // 实测 gap=16px 时最边缘仍比桌面亮 3.8，gap>=24px 才归零。断言 >= 24。
          gap: parseFloat(g(document.body, 'paddingTop')) || 0,
          msgSystemFont: g(document.querySelector('.msg.system'), 'fontFamily')
        },
        buttons: Array.prototype.map.call(document.querySelectorAll('#bottom-bar button'),
          (b) => b.id + ':' + b.textContent + (b.classList.contains('active') ? '(active)' : '')),
        msgCount: document.querySelectorAll('.msg').length,
        firstMsg: (document.querySelector('.msg') || {}).textContent || null,
        status: (document.getElementById('status') || {}).textContent,
        glassMode: !!(frame && frame.classList.contains('glass-mode'))
      };
    })()`);

    // 链路探活：从页面侧请求同源代理，拿到主进程自动发现的 ACP 端口
    res.acp = await w.webContents.executeJavaScript(
      `fetch('/api/v1/acp/health').then(r => r.json()).catch(e => ({ ok:false, message:String(e) }))`);

    // 隔 2 秒各截一帧做像素比对：完全一致说明模型是静止的（待机动作没生效）
    const a = (await w.webContents.capturePage()).toPNG();
    await new Promise((r) => setTimeout(r, 2000));
    const b = (await w.webContents.capturePage()).toPNG();
    res.pixel = {
      frameA: a.length,
      frameB: b.length,
      identical: a.equals(b),
      hashA: crypto.createHash('md5').update(a).digest('hex').slice(0, 12),
      hashB: crypto.createHash('md5').update(b).digest('hex').slice(0, 12),
      animated: !a.equals(b)
    };
    fs.writeFileSync(SHOT, b);

    // 背景模式切换：透明底 <-> 毛玻璃底。
    // 注意两点：① 隐藏窗口的 capturePage 受合成时机影响、容易拿到旧帧，所以先用
    // computed style 断言"切换确实改变了渲染参数"，截图只作观感参考；
    // ② #window-frame 上有 transition: background-color .28s，若在切换的同一帧里读
    // 计算值，读到的仍是过渡起点（曾据此误判成"毛玻璃没生效"），必须等过渡跑完再读。
    const readFrameBg = `(() => {
      const f = document.getElementById('window-frame');
      const cs = getComputedStyle(f);
      return { color: cs.backgroundColor, image: (cs.backgroundImage || '').slice(0, 34) };
    })()`;
    // 测量期间先关掉过渡：隐藏窗口里合成器/动画时钟会被节流，transition 可能"冻住"，
    // 读到的值会滞后一拍（曾据此误判成"毛玻璃没生效"）。
    await w.webContents.executeJavaScript(
      `document.getElementById('window-frame').style.transition = 'none'; true`);
    const before = await w.webContents.executeJavaScript(readFrameBg);
    await w.webContents.executeJavaScript(
      `document.getElementById('window-frame').classList.add('glass-mode'); true`);
    await new Promise((r) => setTimeout(r, 300));
    const after = await w.webContents.executeJavaScript(readFrameBg);
    await w.webContents.executeJavaScript(
      `document.getElementById('window-frame').classList.remove('glass-mode'); true`);
    await new Promise((r) => setTimeout(r, 300));
    const back = await w.webContents.executeJavaScript(readFrameBg);
    // 截图时恢复过渡，拍"毛玻璃"状态
    await w.webContents.executeJavaScript(
      `(() => { const f = document.getElementById('window-frame');
                f.style.transition = ''; f.classList.add('glass-mode'); return true; })()`);
    await new Promise((r) => setTimeout(r, 1200));
    fs.writeFileSync(path.join(__dirname, 'selfcheck-glass.png'), (await w.webContents.capturePage()).toPNG());
    res.glass = {
      before: before.color, after: after.color, restored: back.color,
      tintImage: after.image,
      changed: before.color !== after.color && back.color === before.color,
      buttonLabel: await w.webContents.executeJavaScript(
        `(document.getElementById('btn-glass') || {}).textContent || null`)
    };

    const ok = res.failed.length === 0 && res.consoleErrors.length === 0 &&
      res.dom.hintDisplay === 'none' && res.pixel.animated &&
      res.glass.changed === true &&
      res.dom.css.ringInsetLayers >= 4 && res.dom.css.frameAfterContent === 'none' &&
      res.dom.css.gap >= 24;
    finish(ok ? 0 : 1);
  } catch (e) {
    res.error = String(e);
    finish(2);
  }
});
