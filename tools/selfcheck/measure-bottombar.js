// measure-bottombar.js —— 用 headless Electron 实测底部栏的宽度占用与容量
// 自起一个静态服务托管 app/ 资源，加载一个"只有底栏 + 音量条"的最小页面
// （不加载 Live2D，避免模型干扰），在 384 / 500 两种窗口宽度下量出
// 各元素真实宽度、剩余空间，以及还能再加几个按钮。
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 18901;
const OUT = path.join(__dirname, 'bottombar-measure.json');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
};

// 与 app/index.html 保持一致的底栏结构（品牌字已移除，6 个按钮）
const PAGE = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8">
<link rel="stylesheet" href="/app/styles.css"></head><body>
<div id="window-frame">
  <div id="volume-bar">
    <span id="vol-label" class="vol-label">音量</span>
    <input id="vol" type="range" min="0" max="100" value="10" />
    <span id="vol-num">10</span>
  </div>
  <div id="bottom-bar">
    <button id="btn-chat">聊天</button><button id="btn-idle">待机</button><button id="btn-glass">透明</button>
    <button id="btn-lock">锁定</button><button id="btn-reset">重置</button><button id="btn-settings">设置</button>
  </div>
</div></body></html>`;

function serve(req, res) {
  const u = (req.url || '/').split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return res.end(PAGE);
  }
  const fp = path.join(ROOT, decodeURIComponent(u).replace(/^\/+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const MEASURE = (extra) => `(() => {
  const bar = document.getElementById('bottom-bar');
  ${extra || ''}
  const cs = getComputedStyle(bar);
  const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
  const gap = parseFloat(cs.gap) || 0;
  const items = [...bar.children].map((el) => ({
    tag: el.tagName, text: (el.textContent || '').trim(),
    w: +el.getBoundingClientRect().width.toFixed(1)
  }));
  const sum = items.reduce((s, i) => s + i.w, 0);
  const need = sum + gap * Math.max(0, items.length - 1) + pl + pr;
  return {
    windowW: window.innerWidth,
    frameW: +(document.getElementById('window-frame').getBoundingClientRect().width).toFixed(1),
    barW: +bar.getBoundingClientRect().width.toFixed(1),
    contentW: +(bar.clientWidth - pl - pr).toFixed(1),
    gap: gap,
    nButtons: items.filter((i) => i.tag === 'BUTTON').length,
    items: items,
    itemsSum: +sum.toFixed(1),
    neededW: +need.toFixed(1),
    freeW: +(bar.getBoundingClientRect().width - need).toFixed(1),
    overflow: bar.scrollWidth > bar.clientWidth + 0.5
  };
})()`;

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

const server = http.createServer(serve);

setTimeout(() => {
  try { fs.writeFileSync(OUT, JSON.stringify({ error: 'timeout' }, null, 2), 'utf8'); } catch (e) {}
  try { app.quit(); } catch (e) {}
}, 60000);

app.whenReady().then(() => server.listen(PORT, '127.0.0.1', async () => {
  const result = { note: '品牌字已移除；宽度单位 px；scale18 = config 当前 uiFontSize=18' };
  const win = new BrowserWindow({
    width: 384, height: 564, show: false, frame: false,
    webPreferences: { offscreen: false, sandbox: false }
  });
  try {
    await win.loadURL('http://127.0.0.1:' + PORT + '/');
    await win.webContents.executeJavaScript(`document.documentElement.style.setProperty('--ui-scale', String(18/14)); true`);
    for (const width of [384, 500]) {
      win.setContentSize(width, 564);
      await new Promise((r) => setTimeout(r, 150));
      const key = 'w' + width;
      const addButton = (t) => `{ const b = document.createElement('button'); b.textContent = '${t}'; bar.appendChild(b); }`;
      const removeExtra = `(() => { const bs = [...document.querySelectorAll('#bottom-bar button')]; bs.slice(6).forEach((b) => b.remove()); })()`;
      result[key] = {
        base6: await win.webContents.executeJavaScript(MEASURE('')),
        plus1: await win.webContents.executeJavaScript(MEASURE(addButton('设置'))),
        plus2: await win.webContents.executeJavaScript(MEASURE(addButton('字体'))),
        plus3: await win.webContents.executeJavaScript(MEASURE(addButton('角色')))
      };
      await win.webContents.executeJavaScript(removeExtra);
    }
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    console.log('MEASURE_OK');
  } catch (e) {
    fs.writeFileSync(OUT, JSON.stringify({ error: String((e && e.message) || e) }, null, 2), 'utf8');
    console.log('MEASURE_FAIL');
  }
  try { win.destroy(); } catch (e) {}
  server.close();
  app.quit();
  })
);
