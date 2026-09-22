// probe-ollama-setup.js —— 无头验证「本地模型安装向导」页面
//
// 为什么要自带静态服务（而不是像 probe-settings.js 那样借用主程序的服务）：
//   本页有一段真实网络行为 —— 点「开始下载」会 POST /api/ollama/api/pull 并读 NDJSON 流。
//   借用主程序的服务就会真的去拉 4.7 GB 模型。所以这里自起一个 18877，把
//   /api/ollama/api/pull 换成一段可控的假流（含 total/completed 与延时），
//   既能验证百分比/速度/剩余时间的渲染，又不会下载一个字节。
//
// 断言原则（electron-headless-verify 0.7）：断言"渲染出来的 DOM"，
// 而不是"函数存在过"——控件写好了但没挂上，node --check 是查不出来的。
//
// 用法：node tools/selfcheck/run-ollama-wizard-check.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(PROJECT, 'app');
const PORT = 18877;
const OUT = path.join(__dirname, 'probe-ollama-setup-result.json');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

const results = [];
const calls = {};                       // 记录页面调了哪些 IPC
const bump = (k) => { calls[k] = (calls[k] || 0) + 1; };
let savedCfg = [];                      // ollamaSaveLocalCfg 收到过什么
let usedLocal = [];                     // ollamaUseLocal 收到过什么
let openSetup = 0;                      // pet:openOllamaSetup 被点过几次

// 分步心跳：本环境看不到窗口，一旦挂住只能靠"卡在哪一步"定位。
// 写到文件（比 stdout 可靠：管道会缓冲到进程结束才吐）。
const HB = path.join(__dirname, '_probe_ollama_hb.log');
try { fs.writeFileSync(HB, '', 'utf8'); } catch (e) {}
const mark = (s) => { try { fs.appendFileSync(HB, new Date().toISOString().slice(11, 19) + '  ' + s + '\n', 'utf8'); } catch (e) {} };

function dump(extra) {
  try {
    const pass = results.filter((r) => r.pass).length;
    fs.writeFileSync(OUT, JSON.stringify(Object.assign({
      at: new Date().toISOString(), total: results.length, pass: pass, fail: results.length - pass,
      calls: calls, results: results
    }, extra || {}), null, 2), 'utf8');
  } catch (e) {}
}

function ok(name, cond, detail) {
  results.push({ name: name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}
function check(name, actual, expected) {
  results.push({ name: name, pass: actual === expected, detail: 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected) });
}

// ---------------------------------------------------------------- 场景数据
const GB = 1073741824;
const baseDisk = { freeBytes: 70 * GB, totalBytes: 500 * GB };
function scen(o) {
  return Object.assign({
    installed: false, exe: '', running: false, port: 11434,
    model: 'qwen2.5:7b-instruct-q4_K_M', models: [], modelsDir: 'C:\\Users\\x\\.ollama\\models',
    modelsDirConfigured: false, modelReady: false, busy: false,
    diskModels: baseDisk, diskTemp: baseDisk, diskModelsOk: true, diskTempOk: true
  }, o || {});
}
const SCEN = {
  fresh: scen({}),
  installedNotRunning: scen({ installed: true, exe: 'C:\\Users\\x\\AppData\\Local\\Programs\\Ollama\\ollama.exe' }),
  runningNoModel: scen({ installed: true, exe: 'C:\\x\\ollama.exe', running: true }),
  ready: scen({
    installed: true, exe: 'C:\\x\\ollama.exe', running: true, modelReady: true,
    models: [{ name: 'qwen2.5:7b-instruct-q4_K_M', size: 4.7 * GB }], modelsDirConfigured: true
  }),
  lowDisk: scen({ installed: true, running: true, diskModelsOk: false, diskModels: { freeBytes: 2 * GB, totalBytes: 100 * GB } })
};
let current = SCEN.fresh;

// ---------------------------------------------------------------- 假 NDJSON 流
// 故意拆成多次 write，模拟真实分片（同时验证页面能跨 chunk 拼行）
function serveCannedPull(req, res, mode) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const total = 1000;
  if (mode === 'fail') {
    res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
    setTimeout(() => { res.write(JSON.stringify({ error: '假错误：磁盘空间不足' }) + '\n'); res.end(); }, 80);
    return;
  }
  res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
  let done = 0;
  let timer = null;
  // 关键：客户端断开（用户点了取消）后必须停表。
  // 不停的话这段假流会继续跑到 success，把 current 改成"就绪"，
  // 悄悄污染后面几个场景的状态——本机就踩过：G 段读到的目录状态是 F 段遗留的。
  let closed = false;
  res.on('close', () => { closed = true; if (timer) clearInterval(timer); });
  timer = setInterval(() => {
    if (closed) return;
    done += 250;
    // 拆两半写，逼页面按 \n 拼行
    const line = JSON.stringify({ status: 'downloading', digest: 'sha256:aaa', total: total, completed: done }) + '\n';
    res.write(line.slice(0, 20));
    res.write(line.slice(20));
    if (done >= total) {
      clearInterval(timer);
      res.write(JSON.stringify({ status: 'verifying sha256 digest' }) + '\n');
      res.write(JSON.stringify({ status: 'writing manifest' }) + '\n');
      res.write(JSON.stringify({ status: 'success' }) + '\n');
      res.end();
      // 下载成功后真实世界的状态就变了（/api/tags 会列出该模型）——
      // 桩必须跟着变，否则页面 pull 完再检测时拿到的还是"没模型"，把测试自己带偏
      const nm = pullingModel || 'qwen2.5:7b-instruct-q4_K_M';
      current = scen({ installed: true, running: true, modelReady: true, models: [{ name: nm, size: 4.7 * GB }] });
    }
  }, 260);
}

// ---------------------------------------------------------------- 静态服务器
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
let pullMode = 'ok';
let pullingModel = '';     // 从 POST body 里读出来，顺便验证页面真的把模型名传对了
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/api/ollama/api/pull') {
    bump('pull');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { pullingModel = (JSON.parse(body) || {}).model || ''; } catch (e) {}
      calls.pullBody = body;
      serveCannedPull(req, res, pullMode);
    });
    return;
  }
  if (u === '/api/ollama/api/tags') {
    bump('tags');
    // 真实 Ollama 的行为：服务在跑就返回 200（哪怕一个模型都没有），
    // 只有连不上才失败。这里必须照这个来，否则会测出"没模型 ⇒ 连不上"的假分支。
    if (current.running) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: current.models || [] }));
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: '假：服务没在跑' }));
  }
  // 静态：按项目根解析（页面里写的是 /js/xxx.js 这种以项目根为基准的路径），
  // 找不到再回退到 app/（与主程序行为一致）
  let rel = u.replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  let fp = path.join(PROJECT, rel);
  if (!fs.existsSync(fp)) fp = path.join(APP_DIR, rel);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found: ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- IPC 桩
function installStubs() {
  ipcMain.handle('pet:ollamaDetect', async () => { bump('detect'); return { ok: true, status: current }; });
  ipcMain.handle('pet:ollamaProbeSources', async () => {
    bump('probeSources');
    return { ok: true, tag: 'v0.34.2', size: 1.5 * GB, sources: [{ id: 'ghproxy', label: 'gh-proxy 镜像', url: 'x', ms: 120 }] };
  });
  ipcMain.handle('pet:ollamaSaveLocalCfg', async (_e, p) => { bump('saveLocalCfg'); savedCfg.push(p); return { ok: true }; });
  ipcMain.handle('pet:ollamaOpenDownloadPage', async () => { bump('openDownloadPage'); return { ok: true }; });
  ipcMain.handle('pet:ollamaStart', async () => { bump('ollamaStart'); current = scen({ installed: true, running: true }); return { ok: true, elapsedMs: 1500, already: false }; });
  ipcMain.handle('pet:ollamaInstallCancel', async () => { bump('installCancel'); return { ok: true }; });

  // 一键安装：按真实事件序列推进度，最后返回成功
  ipcMain.handle('pet:ollamaInstall', async (e) => {
    bump('install');
    const wc = e.sender;
    const send = (o) => { try { wc.send('pet:ollamaSetupProgress', o); } catch (err) {} };
    send({ phase: 'probe', percent: 0, message: '正在探测下载源…' });
    await new Promise((r) => setTimeout(r, 60));
    send({ phase: 'log', message: '探测到可用源：gh-proxy 120ms' });
    for (const p of [12, 45, 88]) {
      send({ phase: 'download', percent: p, bytes: p * 15 * 1048576, total: 1.5 * GB, source: 'gh-proxy 镜像' });
      await new Promise((r) => setTimeout(r, 150));
    }
    send({ phase: 'verify', percent: 100, message: '正在校验安装包完整性…' });
    await new Promise((r) => setTimeout(r, 150));
    send({ phase: 'install', percent: 100, message: '正在静默安装…' });
    await new Promise((r) => setTimeout(r, 250));
    current = scen({ installed: true, exe: 'C:\\Users\\x\\AppData\\Local\\Programs\\Ollama\\ollama.exe' });
    send({ phase: 'done', percent: 100, message: 'Ollama 安装完成', exe: current.exe, elapsedMs: 1234 });
    return { ok: true, exe: current.exe, elapsedMs: 1234 };
  });

  ipcMain.on('pet:openOllamaSetup', () => { openSetup += 1; });
  ipcMain.on('pet:ollamaUseLocal', (_e, p) => { usedLocal.push(p); });
  ipcMain.on('pet:log', () => {});

  // ---- 选择大脑窗用到的桩 ----
  ipcMain.handle('pet:getConfig', async () => ({
    chat: { backend: 'local', askEveryStart: false, local: { model: 'qwen2.5:7b-instruct-q4_K_M' }, cloud: {} }
  }));
  ipcMain.handle('pet:getPersona', async () => ({ charName: '黑叶萤', version: 2 }));
  ipcMain.handle('pet:setConfig', async () => ({ ok: true }));
  ipcMain.handle('pet:setPersona', async () => ({ ok: true }));
  ipcMain.handle('pet:ollamaStatus', async () => ({ running: false, owned: false }));
  ipcMain.handle('pet:ollamaStop', async () => ({ ok: true }));
}

// ---------------------------------------------------------------- 页面工具
function waitFor(wc, expr, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      let v = false;
      try { v = await wc.executeJavaScript('(() => { try { return (' + expr + '); } catch (e) { return false; } })()'); } catch (e) { v = false; }
      if (v) return resolve(true);
      if (Date.now() - t0 > (timeoutMs || 8000)) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}
function ev(wc, code) {
  return wc.executeJavaScript('(() => { try { ' + code + ' } catch (e) { return { __err: String((e && e.message) || e) }; } })()');
}
async function loadPage(win, page) {
  // 注意：这里**不能**先 executeJavaScript 探活。对刚建好、还没加载任何页面的
  // webContents 调 executeJavaScript，会一直等第一帧，永远不 resolve（本机实测卡死 90s）。
  // 必须先 loadURL 让页面进来，再问 readyState。
  await win.loadURL('http://127.0.0.1:' + PORT + '/' + page);
  return waitFor(win.webContents, "document.readyState === 'complete'", 8000);
}

// ---------------------------------------------------------------- 主体
(async () => {
  mark('start');
  // 看门狗：无论卡在哪一步，90 秒必须留下结果并退出，否则调用方只会看到"一直不返回"
  const watchdog = setTimeout(() => {
    mark('WATCHDOG fired: 卡在上一步之后');
    dump({ fatal: 'watchdog timeout', stuckAt: 'see _probe_ollama_hb.log' });
    try { server.close(); } catch (e) {}
    app.exit(7);
  }, 90000);
  const finish = (code) => { clearTimeout(watchdog); try { server.close(); } catch (e) {} app.exit(code); };

  await app.whenReady();
  mark('app ready');
  installStubs();
  mark('ipc stubs installed');
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  mark('static server on ' + PORT);

  const win = new BrowserWindow({
    width: 720, height: 800, show: false, useContentSize: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
      preload: path.join(PROJECT, 'preload.js')
    }
  });
  const wc = win.webContents;
  const jsErrs = [];
  wc.on('console-message', (_e, level, msg) => {
    // Electron 的 CSP 安全提示只在开发模式出现、且与业务无关，别污染报告
    if (level >= 2 && !/Electron Security Warning/.test(msg)) jsErrs.push(msg);
  });
  wc.on('render-process-gone', (_e, d) => jsErrs.push('render gone: ' + JSON.stringify(d)));
  wc.on('did-fail-load', (_e, c, d, url) => mark('did-fail-load ' + c + ' ' + d + ' ' + url));
  mark('window created');

  // ---------------- A. 页面与资产 ----------------
  const loaded = await loadPage(win, 'ollama-setup.html');
  mark('first load, complete=' + loaded);
  ok('向导页可加载', loaded, 'readyState complete');
  const booted = await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  ok('页面 boot() 跑通且渲染出检测行', booted);
  mark('boot check done, rows>0 = ' + booted);
  if (!booted) {
    const t = await ev(wc, "return {title:document.title, text:(document.body&&document.body.innerText||'').slice(0,300), url:location.href};");
    mark('页面诊断：' + JSON.stringify(t));
  }

  // ---------------- B. 五个场景的状态机 ----------------
  const readState = () => ev(wc,
    "return {" +
    " rows: document.getElementById('rows').innerText," +
    " sec2: document.getElementById('sec2').className," +
    " sec3: document.getElementById('sec3').className," +
    " sec4: document.getElementById('sec4').className," +
    " sec5: document.getElementById('sec5').className," +
    " bInstall: document.getElementById('btnInstall').disabled," +
    " bInstallTxt: document.getElementById('btnInstall').textContent," +
    " bServe: document.getElementById('btnServe').disabled," +
    " bPull: document.getElementById('btnPull').disabled," +
    " bUse: document.getElementById('btnUse').disabled," +
    " dirHint: document.getElementById('dirHint').className," +
    " pullHint: document.getElementById('pullHint').textContent," +
    " sizeTag: document.getElementById('modelSizeTag').textContent," +
    " modelDir: document.getElementById('modelsDir').value," +
    " presets: document.getElementById('modelPreset').value" +
    " };");

  mark('scenario fresh');
  // 场景 1：全新机器
  current = SCEN.fresh;
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  let s = await readState();
  ok('①全新：显示未安装', /还没安装/.test(s.rows), s.rows.slice(0, 120));
  check('①全新：安装按钮可用', s.bInstall, false);
  check('①全新：启动服务按钮禁用', s.bServe, true);
  check('①全新：下载模型按钮禁用', s.bPull, true);
  check('①全新：收尾按钮禁用', s.bUse, true);
  ok('①全新：第2步高亮', /active/.test(s.sec2), s.sec2);
  ok('①全新：第5步置灰', /dim/.test(s.sec5), s.sec5);

  mark('scenario installedNotRunning');
  // 场景 2：已装但没跑
  current = SCEN.installedNotRunning;
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  s = await readState();
  ok('②已装未跑：显示已安装', /✓ 已安装/.test(s.rows), s.rows.slice(0, 120));
  check('②已装未跑：安装按钮禁用（已装好）', s.bInstall, true);
  check('②已装未跑：安装按钮文案变化', s.bInstallTxt, '已经装好了');
  check('②已装未跑：可启动服务', s.bServe, false);
  check('②已装未跑：仍不能下载模型', s.bPull, true);

  mark('scenario runningNoModel');
  // 场景 3：服务在跑但没模型
  current = SCEN.runningNoModel;
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  s = await readState();
  ok('③服务在跑：显示没下载', /还没下载/.test(s.rows), s.rows.slice(0, 200));
  check('③服务在跑：可以下载模型', s.bPull, false);
  check('③服务在跑：还不能启用', s.bUse, true);
  ok('③服务在跑：第4步高亮', /active/.test(s.sec4), s.sec4);

  mark('scenario ready');
  // 场景 4：全部就绪
  current = SCEN.ready;
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  s = await readState();
  ok('④就绪：显示模型已就绪', /✓ 已就绪/.test(s.rows), s.rows.slice(0, 200));
  check('④就绪：可启用本地模型', s.bUse, false);
  ok('④就绪：第5步高亮', /active/.test(s.sec5), s.sec5);
  check('④就绪：标签变成已就绪', s.sizeTag, '已就绪');
  check('④就绪：目录回填配置值', s.modelDir, 'C:\\Users\\x\\.ollama\\models');

  mark('scenario lowDisk');
  // 场景 5：磁盘不够
  current = SCEN.lowDisk;
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  s = await readState();
  ok('⑤空间不足：给出行内警告', /空间不足/.test(s.rows), s.rows.slice(0, 220));
  ok('⑤空间不足：目录提示变警示色', /warn/.test(s.dirHint), s.dirHint);

  mark('section C install');
  // ---------------- C. 一键安装的进度渲染 ----------------
  current = SCEN.fresh;
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  await ev(wc, "document.getElementById('btnInstall').click(); return 1;");
  // 中途抓一次：应看到百分比与进度条
  const mid = await waitFor(wc, "/(\\d+\\.\\d)%/.test(document.getElementById('installText').innerText)", 6000)
    .then(() => readState().then(() => ev(wc, "return {t:document.getElementById('installText').innerText, w:document.getElementById('installBar').style.width, cancelHidden:document.getElementById('btnCancelInstall').classList.contains('hidden')};")));
  ok('⑥安装中：显示百分比', /%/.test(mid.t || ''), mid.t);
  ok('⑥安装中：进度条有宽度', /%/.test(mid.w || ''), mid.w);
  check('⑥安装中：取消按钮可见', mid.cancelHidden, false);
  const fin = await waitFor(wc, "/安装完成/.test(document.getElementById('installText').innerText)", 8000)
    .then(() => ev(wc, "return {t:document.getElementById('installText').innerText, cancelHidden:document.getElementById('btnCancelInstall').classList.contains('hidden'), bInstall:document.getElementById('btnInstall').disabled};"));
  ok('⑥安装完成：文案正确', /Ollama 安装完成/.test(fin.t || ''), fin.t);
  check('⑥安装完成：取消按钮收起', fin.cancelHidden, true);
  check('⑥安装完成：安装按钮转为禁用', fin.bInstall, true);
  ok('⑥安装完成：日志区有内容', (await ev(wc, "return document.getElementById('installLog').textContent.length;")) > 0);

  mark('section D pull');
  // ---------------- D. 拉模型的真实流解析 ----------------
  current = SCEN.runningNoModel;
  pullMode = 'ok';
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  await ev(wc, "document.getElementById('btnPull').click(); return 1;");
  const seen = await waitFor(wc, "/50\\.0%/.test(document.getElementById('pullText').innerText)", 8000)
    .then((hit) => ev(wc, "return {hit:" + hit + ", t:document.getElementById('pullText').innerText, w:document.getElementById('pullBar').style.width};"));
  ok('⑦下载中：解析出 50.0% 且跨分片拼行正确', /50\.0%/.test(seen.t || ''), seen.t);
  ok('⑦下载中：进度条同步', parseFloat(seen.w) > 40 && parseFloat(seen.w) < 60, seen.w);
  ok('⑦下载中：显示速度与剩余时间', /\/s/.test(seen.t || '') && /剩/.test(seen.t || ''), seen.t);
  const pfin = await waitFor(wc, "/已就绪/.test(document.getElementById('pullText').innerText)", 12000)
    .then(() => ev(wc, "return {t:document.getElementById('pullText').innerText, bUse:document.getElementById('btnUse').disabled};"));
  ok('⑦下载完成：文案变为已就绪', /模型 .* 已就绪/.test(pfin.t || ''), pfin.t);
  check('⑦下载完成：启用按钮解锁', pfin.bUse, false);
  ok('⑦拉模型前先把模型名/目录落盘', savedCfg.some((c) => c && c.model === 'qwen2.5:7b-instruct-q4_K_M'), JSON.stringify(savedCfg));
  ok('⑦请求体带上 stream:true 与正确的模型名',
    (() => { try { const b = JSON.parse(calls.pullBody || '{}'); return b.stream === true && b.model === 'qwen2.5:7b-instruct-q4_K_M'; } catch (e) { return false; } })(),
    calls.pullBody);

  mark('section E use');
  // ---------------- E. 收尾：切到本地模型 ----------------
  await ev(wc, "document.getElementById('btnUse').click(); return 1;");
  await new Promise((r) => setTimeout(r, 400));
  ok('⑧点启用：发出 ollamaUseLocal 且带模型名',
    usedLocal.length > 0 && usedLocal[usedLocal.length - 1].model === 'qwen2.5:7b-instruct-q4_K_M',
    JSON.stringify(usedLocal));
  const useTxt = await ev(wc, "return document.getElementById('useState').textContent;");
  ok('⑧点启用：界面给出反馈', /已切换/.test(useTxt), useTxt);

  mark('section F fail/cancel');
  // ---------------- F. 下载失败与取消 ----------------
  current = SCEN.runningNoModel;
  pullMode = 'fail';
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  await ev(wc, "document.getElementById('btnPull').click(); return 1;");
  const failTxt = await waitFor(wc, "/下载失败/.test(document.getElementById('pullText').innerText)", 6000)
    .then(() => ev(wc, "return document.getElementById('pullText').innerText;"));
  ok('⑨上游报错：界面显示原因（不静默）', /假错误：磁盘空间不足/.test(failTxt || ''), failTxt);

  pullMode = 'ok';
  await loadPage(win, 'ollama-setup.html');
  await waitFor(wc, "document.querySelectorAll('#rows .r').length > 0", 8000);
  await ev(wc, "document.getElementById('btnPull').click(); return 1;");
  await waitFor(wc, "/%/.test(document.getElementById('pullText').innerText)", 5000);
  await ev(wc, "document.getElementById('btnCancelPull').click(); return 1;");
  const cancelTxt = await waitFor(wc, "/已取消/.test(document.getElementById('pullText').innerText)", 6000)
    .then(() => ev(wc, "return document.getElementById('pullText').innerText;"));
  ok('⑩取消：立即中断并给出说明', /已取消/.test(cancelTxt || ''), cancelTxt);

  mark('section G brain-chooser');
  // ---------------- G. 选择大脑窗的入口按钮 ----------------
  // 让 /api/ollama/api/tags 失败（当前场景 runningNoModel 会返回 502），
  // 选「本地模型」时应出现「一键安装」按钮，点它要触发 pet:openOllamaSetup
  current = scen({ installed: false });
  await loadPage(win, 'brain-chooser.html');
  await waitFor(wc, "document.querySelectorAll('.card').length === 3", 8000);
  await ev(wc, "var i=document.querySelector('.card input[value=local]'); i.checked=true; i.dispatchEvent(new Event('change')); return 1;");
  const fixBtn = await waitFor(wc, "!!document.querySelector('[data-probe=local] .probe-fix')", 6000);
  ok('⑪选择大脑窗：探测失败时出现「一键安装」入口', fixBtn);
  const fixTxt = await ev(wc, "var b=document.querySelector('[data-probe=local] .probe-fix'); return b?b.textContent:'';");
  ok('⑪入口文案指明了是安装 Ollama', /一键安装 Ollama/.test(fixTxt || ''), fixTxt);
  const before = openSetup;
  await ev(wc, "document.querySelector('[data-probe=local] .probe-fix').click(); return 1;");
  await new Promise((r) => setTimeout(r, 250));
  check('⑪点入口：主进程收到 pet:openOllamaSetup', openSetup - before, 1);
  // 服务在跑但没模型 -> 入口应变成「一键下载模型」
  current = scen({ installed: true, running: true, models: [] });
  await loadPage(win, 'brain-chooser.html');
  await waitFor(wc, "document.querySelectorAll('.card').length === 3", 8000);
  await ev(wc, "var i=document.querySelector('.card input[value=local]'); if(i){i.checked=true; i.dispatchEvent(new Event('change'));} return 1;");
  await waitFor(wc, "!!document.querySelector('[data-probe=local] .probe-fix')", 6000);
  const diag = await ev(wc,
    "var p=document.querySelector('[data-probe=local]');" +
    "var b=document.querySelector('[data-probe=local] .probe-fix');" +
    "return {txt:p?p.innerText:'(无探针元素)', cls:p?p.className:'', fix:!!b};");
  ok('⑫入口随状态变化：没模型时提示下载模型', /一键下载模型/.test(diag.txt || ''), JSON.stringify(diag));
  ok('⑫该场景确实向服务发起了探测', (calls.tags || 0) > 0, 'tags 累计 ' + (calls.tags || 0) + ' 次');
  // 已就绪时不该出现按钮
  current = scen({ installed: true, running: true, modelReady: true, models: [{ name: 'qwen2.5:7b-instruct-q4_K_M', size: 1 }] });
  await loadPage(win, 'brain-chooser.html');
  await waitFor(wc, "document.querySelectorAll('.card').length === 3", 8000);
  await ev(wc, "var i=document.querySelector('.card input[value=local]'); i.checked=true; i.dispatchEvent(new Event('change')); return 1;");
  const probeOk = await waitFor(wc, "/模型已就绪/.test(document.querySelector('[data-probe=local]').innerText)", 6000);
  const noFix = await ev(wc, "return !document.querySelector('[data-probe=local] .probe-fix');");
  ok('⑫就绪后不再显示补装按钮', probeOk && noFix === true, 'probeOk=' + probeOk + ' noFix=' + noFix);

  // ---------------- 汇总 ----------------
  const pass = results.filter((r) => r.pass).length;
  const report = {
    at: new Date().toISOString(),
    total: results.length, pass: pass, fail: results.length - pass,
    calls: calls,
    jsErrors: jsErrs.slice(0, 20),
    results: results
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  mark('done ' + pass + '/' + results.length);
  console.log('---- 向导页面自检 ----');
  results.forEach((r) => console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.pass ? '' : '   [' + r.detail + ']')));
  console.log('合计 ' + pass + '/' + results.length + ' 通过');
  if (jsErrs.length) console.log('页面 JS 错误：\n' + jsErrs.join('\n'));
  finish(pass === results.length ? 0 : 1);
})().catch((e) => {
  mark('FATAL ' + ((e && e.message) || e));
  try {
    fs.writeFileSync(OUT, JSON.stringify({ fatal: String((e && e.stack) || e), results: results }, null, 2), 'utf8');
  } catch (e2) {}
  console.log('FATAL ' + ((e && e.stack) || e));
  app.exit(9);
});
