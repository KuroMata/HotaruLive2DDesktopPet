// settings-extra-probe.js —— 验证「设置窗 → 视线跟随 → 额外追踪参数」真的渲染出来并正确落盘。
//
// 为什么要这个探针：本机看不到窗口、截图不可尽信，而上一轮的改动曾出现
// 「控件函数/CSS/IPC 都在，但 schema 里没挂上那一项」这种静态检查发现不了的漏接。
// 所以这里实际加载 settings.html，做三件事：
//   1) 计算值断言：视线跟随组里是否存在额外的 gaze.extra 行；
//   2) 交互断言：点「+ 添加追踪参数」后是否新增一行，且下拉能枚举模型参数；
//   3) 端到端断言：捕获发往主进程的 setConfig，确认 key='gaze.extra' 且值是数组。
//
// 运行：node tools/selfcheck/run-probe.js tools/settings-extra-probe.js
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const PORT = 18999;
const OUT_JSON = path.join(__dirname, 'settings-extra-result.json');
const OUT_PNG = path.join(__dirname, 'settings-extra-shot.png');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = (u === '/' ? '/settings.html' : u).replace(/^\/+/, '');
  // settings.html 里引用的是 /app/settings.js 这种以「项目根」为基准的路径，
  // 而 settings.html 自身位于 app/ 下。所以先按项目根解析，不存在再退回 app/ 下（与主程序行为一致）。
  let p = path.resolve(ROOT, rel);
  if (!fs.existsSync(p)) p = path.resolve(APP_DIR, rel);
  if (!p.toLowerCase().startsWith(ROOT.toLowerCase())) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404).end('404 ' + rel); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate'
    });
    res.end(data);
  });
});

// —— 主进程桩：捕获设置窗写回来的键值（这是本探针最关键的一条证据） ——
const captured = [];
ipcMain.handle('pet:getConfig', async () => ({
  mouseFollow: true,
  screenTrack: { enabled: true, width: 320, height: 180, fps: 15, threshold: 22, motionMin: 0.012, spread: 0.85, releaseFrames: 10, screenIndex: 0 },
  gaze: { smooth: 120, amplitude: 1, headAmplitude: 1, headSmooth: 220, extra: [{ id: 'ParamBodyX', axis: 'x', amp: 2, flip: false }] }
}));
ipcMain.handle('pet:setConfig', async (_e, payload) => { captured.push(payload); return { ok: true }; });
ipcMain.handle('pet:getDisplays', async () => ([
  { index: 0, label: '显示器 1（主屏）' }, { index: 1, label: '显示器 2' }
]));
ipcMain.handle('pet:identifyDisplays', async () => ({ ok: true }));
ipcMain.handle('pet:getModelParams', async () => ([
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyX', 'ParamBodyY', 'ParamBreath', 'ParamEyeBallX'
]));
ipcMain.on('pet:reportModelParams', () => {});
ipcMain.on('pet:log', () => {});

const result = { phase: 'boot' };
function finish(code) {
  try { fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8'); } catch (e) {}
  try { server.close(); } catch (e) {}
  setTimeout(() => app.exit(code), 200);
}
setTimeout(() => { if (result.phase !== 'done') { result.phase = 'timeout'; finish(2); } }, 55000);

app.whenReady().then(() => {
  server.listen(PORT, '127.0.0.1', async () => {
    const w = new BrowserWindow({
      width: 800, height: 640, x: 40, y: 40,
      show: true,                       // show:true 才能稳定拿到"当前帧"的截图
      backgroundColor: '#11151c',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(ROOT, 'preload.js')
      }
    });
    const logs = [];
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      logs.push(level + ' | ' + message + ' @' + String(sourceId || '').split('/').pop() + ':' + line);
    });
    w.webContents.on('render-process-gone', (_e, d) => { logs.push('GONE ' + JSON.stringify(d)); });
    try {
      await w.loadURL('http://127.0.0.1:' + PORT + '/settings.html');
      await new Promise((r) => setTimeout(r, 900));
      result.console = logs.slice(0, 20);
      result.snapshot = await w.webContents.executeJavaScript(`(() => {
        try {
          return {
            title: document.title,
            tabCount: document.querySelectorAll('.tab').length,
            groupCount: document.querySelectorAll('.group').length,
            rowCount: document.querySelectorAll('.row').length,
            bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)
          };
        } catch (e) { return { err: String(e && e.message || e) }; }
      })()`);

      // 1) 结构断言：切到"视线跟随"标签，数这一组的行与标签
      const dom = await w.webContents.executeJavaScript(`(() => { try {
        const tabs = [...document.querySelectorAll('.tab')];
        const ti = tabs.findIndex((t) => t.textContent.indexOf('视线跟随') >= 0);
        if (ti >= 0) tabs[ti].click();
        const groups = [...document.querySelectorAll('.group')];
        const g = groups[ti];
        const labelOf = (r) => { const l = r.querySelector('.label'); return l ? l.textContent.replace(/\\s+/g, ' ').trim() : ''; };
        const rows = [...g.querySelectorAll(':scope > .row')];
        const box = g.querySelector('.extra-params');
        const firstSel = box ? box.querySelector('.extra-row select') : null;
        const rr = firstSel ? firstSel.getBoundingClientRect() : null;
        return {
          tabs: tabs.map((t) => t.textContent),
          gazeTabIndex: ti,
          groupTitle: (g.querySelector('.gtitle') || {}).textContent,
          rowLabels: rows.map(labelOf),
          helpCount: rows.filter((r) => r.querySelector('.help')).length,
          hasExtraBox: !!box,
          extraRows: box ? box.querySelectorAll('.extra-row').length : 0,
          addBtnText: box ? (box.querySelector('.add-btn') || {}).textContent : null,
          firstSelectOptions: firstSel ? firstSel.options.length : 0,
          firstSelectValue: firstSel ? firstSel.value : null,
          firstSelectRect: rr ? (Math.round(rr.width) + 'x' + Math.round(rr.height)) : null,
          // 布局：这一组是否横向溢出（容器的 clientWidth vs 内容需要宽度）
          groupOverflow: g.scrollWidth - g.clientWidth,
          ctrlRect: box ? (() => { const b = box.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); })() : null
        };
      } catch (e) { return { err: String(e && e.message || e) }; } })()`);
      result.dom = dom;

      // 2) 交互断言：点"+ 添加追踪参数"，确认新增一行且选项来自模型参数
      const after = await w.webContents.executeJavaScript(`(() => { try {
        const box = document.querySelector('.extra-params');
        const before = box.querySelectorAll('.extra-row').length;
        box.querySelector('.add-btn').click();
        const after = box.querySelectorAll('.extra-row').length;
        const sel = box.querySelectorAll('.extra-row select');
        const last = sel[sel.length - 1];
        return {
          rowsBefore: before, rowsAfter: after,
          lastSelectOptions: last ? [...last.options].map((o) => o.value).slice(0, 4) : [],
          overflowsWindow: document.documentElement.scrollWidth > window.innerWidth
        };
      } catch (e) { return { err: String(e && e.message || e) }; } })()`);
      result.afterAdd = after;

      result.capturedKeys = captured.map((p) => ({
        key: p && p.key,
        type: Array.isArray(p && p.value) ? 'array(' + p.value.length + ')' : typeof (p && p.value),
        sample: p && p.key === 'gaze.extra' ? JSON.stringify(p.value) : undefined
      }));

      try {
        const img = await w.webContents.capturePage();
        fs.writeFileSync(OUT_PNG, img.toPNG());
        result.shot = true;
      } catch (e) { result.shot = 'fail: ' + e.message; }

      result.phase = 'done';
      finish(0);
    } catch (e) {
      result.phase = 'error';
      result.error = String((e && e.message) || e);
      finish(1);
    }
  });
});
