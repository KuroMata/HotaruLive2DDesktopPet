// shot.mjs — 把本地 HTML 渲染成整页 PNG（长图），零第三方依赖。
// 原理：以 --headless=new 启动 Chrome/Edge，通过 DevTools Protocol 量出整页高度，
// 再用 Emulation.setDeviceMetricsOverride 把视口撑到整页高度后 captureScreenshot。
// 不能只靠 `chrome --screenshot`：新无头模式只截视口，且本机装不到 Puppeteer/Playwright。
//
// 用法：
//   node shot.mjs <输入.html> <输出.png> [视口宽度=800] [缩放=2] [等待毫秒=1600]
// 环境变量：
//   SHOT_BROWSER  指定浏览器 exe 路径（默认自动在 Chrome / Edge 里找）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickBrowser() {
  if (process.env.SHOT_BROWSER && fs.existsSync(process.env.SHOT_BROWSER)) return process.env.SHOT_BROWSER;
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome / Edge，请用 SHOT_BROWSER 指定');
}

const [, , htmlArg, outArg, widthArg, scaleArg, waitArg] = process.argv;
if (!htmlArg || !outArg) {
  console.error('用法: node shot.mjs <输入.html> <输出.png> [宽度=800] [缩放=2] [等待ms=1600]');
  process.exit(2);
}
const htmlPath = path.resolve(htmlArg);
const outPath = path.resolve(outArg);
const width = Number(widthArg || 800);
const scale = Number(scaleArg || 2);
const waitMs = Number(waitArg || 1600);
if (!fs.existsSync(htmlPath)) throw new Error('输入不存在: ' + htmlPath);

const browser = pickBrowser();
const port = 19000 + Math.floor(Math.random() * 900);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-udd-'));

let child = null;
let ws = null;
const cleanup = () => {
  try { if (ws && ws.readyState <= 1) ws.close(); } catch {}
  try { if (child) child.kill(); } catch {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
};
const bail = (e) => { console.error('FAILED:', e && e.message ? e.message : e); cleanup(); process.exit(1); };

try {
  child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let tail = '';
  child.stderr.on('data', (d) => { tail += d.toString(); });
  child.stdout.on('data', (d) => { tail += d.toString(); });

  const devtoolsUrl = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 25000;
    const tick = setInterval(() => {
      const m = tail.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearInterval(tick); resolve(m[1]); return; }
      if (Date.now() > deadline) { clearInterval(tick); reject(new Error('等待 DevTools 端口超时\n' + tail.slice(-800))); }
    }, 120);
  });

  // 取初始 about:blank 页的调试端点，直连页面会话（免去 Target 多路复用）
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到 page target');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.method + ' → ' + JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      const fn = events.get(msg.method);
      events.delete(msg.method);
      fn(msg.params);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((res) => events.set(method, res));

  await send('Page.enable');
  await send('Runtime.enable');

  await send('Emulation.setDeviceMetricsOverride', {
    width, height: 1200, deviceScaleFactor: scale, mobile: false,
  });

  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(htmlPath).href });
  await loaded;

  // 等字体 + CSS 入场动画（本页有 animation:rise .7s both，不等会在透明度 0 的状态截到）
  await send('Runtime.evaluate', {
    expression: 'document.fonts.ready.then(()=>1)', awaitPromise: true, returnByValue: true,
  });
  await sleep(waitMs);

  const measure = async (expr) => (await send('Runtime.evaluate', {
    expression: expr, returnByValue: true,
  })).result.value;

  const fullH = await measure('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))');
  if (!fullH || fullH < 50) throw new Error('量到的页面高度异常: ' + fullH);

  await send('Emulation.setDeviceMetricsOverride', {
    width, height: fullH, deviceScaleFactor: scale, mobile: false,
  });
  await sleep(300);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const buf = Buffer.from(shot.data, 'base64');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);

  console.log(JSON.stringify({
    ok: true, browser: path.basename(browser), viewport: `${width}x${fullH}`,
    scale, pixels: `${width * scale}x${fullH * scale}`, bytes: buf.length, out: outPath,
  }, null, 2));
  cleanup();
  process.exit(0);
} catch (e) {
  bail(e);
}
