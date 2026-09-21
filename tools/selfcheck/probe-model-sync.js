// probe-model-sync.js —— 无头验证：在设置窗里换模型时，
// 「台词」页与「表情与动作」页是否自动跟着切到新模型（无需重开设置窗 / 手动重新载入）。
//
// 自足运行：自己起一个只读静态服务提供 /app/*，IPC 全部用桩。
// 桩的数据取自真实磁盘（真实 config.json、真实模型目录、真实台词档），
// 因此既不会改动用户磁盘上的配置，也不必启动主程序或真正加载几十 MB 的模型。
//
// 断言的是「驱动真实交互后渲染出来的 DOM」，而不是「函数存在过」：
// 订阅没接上、schema 没挂上这类问题，node --check 一律查不出来。
//
// 运行：node tools/selfcheck/probe-model-sync.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT = path.resolve(__dirname, '..', '..');
const PORT = 18799;                                   // 避开主程序的 18765
const OUT = path.join(__dirname, 'probe-model-sync-result.json');
const CONFIG_PATH = path.join(PROJECT, 'app', 'config.json');
const PROFILES_DIR = path.join(PROJECT, 'app', 'data', 'lines', 'profiles');
const APP_DIR = path.join(PROJECT, 'app');
const APP_MODELS = path.join(APP_DIR, 'models');
const VTS_ROOT = 'D:\\SteamLibrary\\steamapps\\common\\VTube Studio\\VTube Studio_Data\\StreamingAssets\\Live2DModels';

// 验证用的两个模型。初始那个必须"已绑台词档 + 已注入动作"，才看得出切换前后的差别：
//   FROM -> 命中 config.lineProfile / config.modelAssets 的键，档=hotaru，动作=idle+sleep
//   TO   -> 未绑档（应回退 default），目录里只有 idle.motion3.json
const FROM = 'Hotaru2024/hotaru2024.model3.json';
const TO = 'nyata/nyata.model3.json';

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

const checks = [];
function ck(name, pass, detail) {
  checks.push({ name: name, pass: !!pass, detail: (detail === undefined || detail === null) ? '' : String(detail) });
}

// ---------------- 静态服务（只提供项目内的文件） ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};
function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
      if (p === '/') p = '/settings.html';
      // 与主程序的静态服务一致：/settings.html 落在 app\ 下，/app/* 落在项目根下。
      // 先按项目根解析，找不到再退到 app\ 目录（这就是上面那次的踩坑点：/settings.html 并不在项目根）。
      const cands = [path.join(PROJECT, p), path.join(APP_DIR, p)];
      let fp = null;
      for (const c of cands) {
        try { if (c.indexOf(PROJECT) === 0 && fs.statSync(c).isFile()) { fp = c; break; } } catch (e) { /* 试下一个 */ }
      }
      if (!fp) { res.writeHead(404); res.end('404'); return; }
      fs.readFile(fp, (e, buf) => {
        if (e) { res.writeHead(404); res.end('404'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------- 与 main.js 等价的扫描实现 ----------------
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}

function scanModelsSync(base) {
  const out = [];
  const walk = (d, lv) => {
    if (lv > 4) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, lv + 1); continue; }
      if (!/\.model3\.json(\.enc)?$/i.test(e.name)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e2) { /* 忽略 */ }
      out.push({
        name: e.name.replace(/\.model3\.json(\.enc)?$/i, ''),
        rel: path.relative(base, p).replace(/\\/g, '/').replace(/\.enc$/i, ''),
        dir: path.relative(base, path.dirname(p)).replace(/\\/g, '/') || '.',
        size: size
      });
    }
  };
  walk(base, 0);
  out.sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
  return out;
}

// 与 main.js 的 scanModelAssets 一致：递归深度 2，不限子目录名，file 为相对 model3.json 目录的路径
function scanAssetsSync(modelDir) {
  const motions = [], expressions = [];
  const walk = (d, lv) => {
    if (lv > 2) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, lv + 1); continue; }
      const r = path.relative(modelDir, p).replace(/\\/g, '/');
      const clean = r.replace(/\.enc$/i, '');
      if (/\.motion3\.json$/i.test(clean)) motions.push({ file: clean, rel: r, name: path.basename(clean, '.motion3.json') });
      else if (/\.exp3\.json$/i.test(clean)) expressions.push({ file: clean, rel: r, name: path.basename(clean, '.exp3.json') });
    }
  };
  walk(modelDir, 0);
  motions.sort((a, b) => a.file.localeCompare(b.file));
  expressions.sort((a, b) => a.file.localeCompare(b.file));
  return { motions: motions, expressions: expressions };
}

// ---------------- IPC 桩 ----------------
// curModelUrl 模拟主进程持有的 CONFIG.modelUrl（切模型时由 pet:switchModel 更新），
// 这样 pet:getModelAssets 之类"读取当前模型"的接口行为与真实主进程一致。
let curModelUrl = '/models/' + FROM;

function registerHandlers() {
  const H = {
    'pet:getConfig': () => Object.assign({}, readConfig(), { modelServeBase: VTS_ROOT, modelUrl: curModelUrl }),
    'pet:switchModel': (u) => { curModelUrl = String(u || ''); return { ok: true, url: curModelUrl }; },
    'pet:setConfig': (p) => ({ ok: true, echo: (p && p.key) || '' }),
    'pet:setBindings': () => ({ ok: true, probe: true }),
    'pet:setLineProfile': () => ({ ok: true, probe: true }),
    'pet:deleteLineProfile': () => ({ ok: true, probe: true }),
    'pet:previewTTS': () => ({ ok: false, error: 'probe' }),
    'pet:triggerAsset': () => ({ ok: true, probe: true }),
    'pet:chooseFile': () => ({ ok: false, error: 'probe' }),
    'pet:chooseDirectory': () => ({ ok: false, error: 'probe' }),
    'pet:getModelParams': () => [],
    'pet:getAudioDevices': () => [],
    'pet:getOutputDevices': () => [],
    'pet:getMusicState': () => null,
    'pet:getScreenSources': () => [],
    'pet:getDisplays': () => [],
    'pet:listVoices': () => ({ engine: '', voices: [] }),

    'pet:scanModels': (dir) => {
      const base = dir || APP_MODELS;
      return { ok: true, base: base, models: scanModelsSync(base) };
    },
    'pet:scanModelAssets': (url) => {
      const rel = String(url || '').replace(/^\/models\//, '');
      const dir = path.dirname(path.join(VTS_ROOT, rel));
      if (!fs.existsSync(dir)) return { ok: false, error: '模型目录不存在：' + dir };
      const a = scanAssetsSync(dir);
      return { ok: true, dir: dir, motions: a.motions, expressions: a.expressions };
    },
    // 真实主进程：motons 来自注入配置，expressions 来自 model3.json 的 FileReferences
    'pet:getModelAssets': () => {
      const cfg = readConfig();
      const key = String(curModelUrl || '').replace(/^\/models\//, '');
      const entry = (cfg.modelAssets || {})[key] || { motions: [], expressions: [] };
      let expressions = [];
      try {
        const j = JSON.parse(fs.readFileSync(path.join(VTS_ROOT, key), 'utf8'));
        expressions = (((j.FileReferences || {}).Expressions) || []).map((e) => ({ name: e.Name, file: e.File }));
      } catch (e) { /* 保留空 */ }
      const motions = (entry.motions || []).map((m) => ({ group: m.group, index: 0, file: m.file }));
      return { expressions: expressions, motions: motions };
    },
    'pet:listLineProfiles': () => {
      let files = [];
      try { files = fs.readdirSync(PROFILES_DIR).filter((f) => /\.json$/i.test(f)); } catch (e) {}
      return files.map((f) => {
        let p = {};
        try { p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')); } catch (e) {}
        return {
          id: f.replace(/\.json$/i, ''),
          name: p.name || f.replace(/\.json$/i, ''),
          clickCount: Array.isArray(p.click) ? p.click.length : 0,
          idleCount: Array.isArray(p.idle) ? p.idle.length : 0
        };
      });
    },
    'pet:getLineProfile': (id) => {
      const f = path.join(PROFILES_DIR, String(id || 'default') + '.json');
      try { return { ok: true, profile: JSON.parse(fs.readFileSync(f, 'utf8')) }; }
      catch (e) { return { ok: false, error: 'not found: ' + id }; }
    }
  };
  Object.keys(H).forEach((ch) => { ipcMain.handle(ch, async (_e, ...a) => H[ch](...a)); });
}

// ---------------- 页面内断言脚本 ----------------
const SNAP = `(() => { try {
  const txt = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
  const lpSel = document.querySelector('.lp-picker select');
  const modelSel = document.querySelector('.model-lib select');
  return {
    ok: true,
    modelSel: modelSel ? modelSel.value : null,
    modelOptions: modelSel ? [...modelSel.options].map((o) => o.value) : [],
    modelStatus: txt('.model-lib .ml-status'),
    lpModel: txt('.lp-model'),
    lpNote: txt('.lp-note'),
    lpCurId: lpSel ? lpSel.value : null,
    lpOptions: lpSel ? [...lpSel.options].map((o) => o.value) : [],
    assetInfo: txt('.asset-link .ml-row .ml-status'),
    assetFiles: [...document.querySelectorAll('.asset-link .al-row .al-file')].map((e) => e.textContent.trim()),
    assetLive: [...document.querySelectorAll('.asset-link .al-live')].map((e) => e.textContent.trim()),
    // 按「动作文件 / 表情文件」两段分组：两类候选混在一个数组里没法直接比较
    assetGroups: (() => {
      const out = {};
      [...document.querySelectorAll('.asset-link .al-sec')].forEach((sec) => {
        const key = sec.textContent.indexOf('动作') >= 0 ? 'motions' : 'expressions';
        const files = [];
        let sib = sec.nextElementSibling;
        while (sib && !(sib.classList && sib.classList.contains('al-sec'))) {
          const f = sib.querySelector ? sib.querySelector('.al-file') : null;
          if (f) files.push(f.textContent.trim());
          sib = sib.nextElementSibling;
        }
        out[key] = files;
      });
      return out;
    })(),
    binderTargets: [...document.querySelectorAll('.asset-binder .ab-card select')].map((s) => [...s.options].map((o) => o.value))
  };
} catch (e) { return { ok: false, err: String((e && e.message) || e) }; } })()`;

// 模拟用户操作：在「模型」页下拉选目标模型，再点「载入模型」
const DO_SWITCH = (rel) => `(() => { try {
  const sel = document.querySelector('.model-lib select');
  if (!sel) return { ok: false, err: '模型下拉未找到' };
  const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(rel)});
  if (!opt) return { ok: false, err: '下拉里没有该模型', options: [...sel.options].map((o) => o.value) };
  sel.value = ${JSON.stringify(rel)};
  sel.dispatchEvent(new Event('change'));
  const btn = [...document.querySelectorAll('.model-lib button')].find((b) => b.textContent.trim() === '载入模型');
  if (!btn) return { ok: false, err: '「载入模型」按钮未找到' };
  btn.click();
  return { ok: true, picked: sel.value };
} catch (e) { return { ok: false, err: String((e && e.message) || e) }; } })()`;

async function waitFor(w, expr, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await w.webContents.executeJavaScript(expr).catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function writeResult(o) {
  try { fs.writeFileSync(OUT, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {}
}

async function main() {
  const result = { step: 'init' };
  let srv = null;
  try {
    srv = await startServer();
    registerHandlers();

    const w = new BrowserWindow({
      width: 820, height: 640, show: true, backgroundColor: '#11151c',
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, webSecurity: true,
        preload: path.join(PROJECT, 'preload.js')
      }
    });
    const errs = [];
    w.webContents.on('console-message', (_e, lvl, msg) => {
      if (lvl >= 2) errs.push('console:' + lvl + ':' + String(msg).slice(0, 240));
    });
    w.webContents.on('preload-error', (_e, f, err) => errs.push('preload:' + f + ':' + err.message));
    w.webContents.on('did-fail-load', (_e, code, desc, url) => errs.push('did-fail-load:' + code + ':' + desc + ':' + url));

    await w.loadURL('http://127.0.0.1:' + PORT + '/settings.html');

    const DIAG = `(() => { try {
      const c = document.getElementById('content');
      return { ok: true, title: document.title,
        hasApi: (typeof window.desktopPet) !== 'undefined',
        apiCount: window.desktopPet ? Object.keys(window.desktopPet).length : -1,
        groupCount: document.querySelectorAll('section.group').length,
        tabCount: document.querySelectorAll('#tabs .tab').length,
        contentChildren: c ? c.children.length : -1,
        scripts: [...document.querySelectorAll('script')].map((s) => s.getAttribute('src')),
        bodyHead: String(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) };
    } catch (e) { return { ok: false, err: String((e && e.message) || e) }; } })()`;

    await new Promise((r) => setTimeout(r, 1000));
    result.diag0 = await w.webContents.executeJavaScript(DIAG).catch((e) => ({ err: String((e && e.message) || e) }));

    // 等 buildUI 渲染完（section.group 出现），再等模型库扫描回来
    const ready = await waitFor(w, 'document.querySelectorAll("section.group").length > 0', 25000);
    ck('页面渲染完成（buildUI 已执行）', !!ready, ready ? 'ok' : '超时');
    if (!ready) result.diagFail = await w.webContents.executeJavaScript(DIAG).catch(() => null);

    const scanned = await waitFor(w, 'document.querySelectorAll(".model-lib select option").length > 1', 20000);
    ck('模型库已扫描出候选', !!scanned, scanned ? 'ok' : '超时 / 候选不足');
    await new Promise((r) => setTimeout(r, 1200));

    // ---------- A. 切换前：应停在 FROM，且台词档=hotaru、动作已注入 ----------
    const A = await w.webContents.executeJavaScript(SNAP);
    result.snapA = A;
    ck('A 模型页下拉 = 初始模型', A.modelSel === FROM, A.modelSel);
    ck('A 台词页显示初始模型', String(A.lpModel || '').indexOf(FROM) >= 0, A.lpModel);
    ck('A 台词档命中模型绑定（hotaru）', A.lpCurId === 'hotaru', A.lpCurId);
    ck('A 已绑档时无「回退 default」提示', !A.lpNote, A.lpNote);
    ck('A 素材页显示初始模型', String(A.assetInfo || '').indexOf(FROM) >= 0, A.assetInfo);
    ck('A 动作候选 = 该模型目录的动作文件',
      JSON.stringify((A.assetGroups || {}).motions) === JSON.stringify(['idle.motion3.json', 'sleep.motion3.json']),
      JSON.stringify((A.assetGroups || {}).motions));
    ck('A 表情候选为空（12 个 exp3 都已被 model3.json 引用，无需重复挂）',
      JSON.stringify((A.assetGroups || {}).expressions) === JSON.stringify([]),
      JSON.stringify((A.assetGroups || {}).expressions));

    // ---------- B. 驱动切换（等价于用户在模型页点「载入模型」） ----------
    const sw = await w.webContents.executeJavaScript(DO_SWITCH(TO));
    result.switchAction = sw;
    ck('B 成功触发「载入模型」', sw && sw.ok, sw && sw.err);

    const moved = await waitFor(w,
      '(() => { const e = document.querySelector(".lp-model"); return e && e.textContent.indexOf(' + JSON.stringify(TO) + ') >= 0; })()',
      12000);
    ck('B 台词页在切换后自动跟到新模型（无需重开设置窗）', !!moved, moved ? 'ok' : '12s 内未跟随');

    const B = await w.webContents.executeJavaScript(SNAP);
    result.snapB = B;
    ck('B 模型页下拉 = 新模型', B.modelSel === TO, B.modelSel);
    ck('B 模型页状态行 = 新模型', String(B.modelStatus || '').indexOf(TO) >= 0, B.modelStatus);
    ck('B 台词页显示新模型', String(B.lpModel || '').indexOf(TO) >= 0, B.lpModel);
    ck('B 新模型未绑档 → 回退 default', B.lpCurId === 'default', B.lpCurId);
    ck('B 页面说明「已回退到通用档」', String(B.lpNote || '').indexOf('default') >= 0, B.lpNote);
    ck('B 素材页显示新模型', String(B.assetInfo || '').indexOf(TO) >= 0, B.assetInfo);
    ck('B 动作候选已换成新模型目录的动作文件',
      JSON.stringify((B.assetGroups || {}).motions) === JSON.stringify(['idle.motion3.json']),
      JSON.stringify((B.assetGroups || {}).motions));
    ck('B 表情候选也换成新模型里未被引用的表情',
      JSON.stringify((B.assetGroups || {}).expressions) === JSON.stringify(['帽子.exp3.json']),
      JSON.stringify((B.assetGroups || {}).expressions));

    // ---------- C. 主窗加载完成后上报素材（主进程会转发给设置窗） ----------
    const live = {
      expressions: [{ name: '帽子', file: '帽子.exp3.json' }],
      motions: [{ group: 'idle', index: 0, file: 'idle.motion3.json' }]
    };
    w.webContents.send('pet:modelAssetsUpdated', live);
    await new Promise((r) => setTimeout(r, 600));
    const C = await w.webContents.executeJavaScript(SNAP);
    result.snapC = C;
    ck('C 收到素材上报后「已加载」计数更新（动作 1 / 表情 1）',
      String(C.assetInfo || '').indexOf('动作 1') >= 0 && String(C.assetInfo || '').indexOf('表情 1') >= 0,
      C.assetInfo);
    // binderTargets[0] 是「表情/动作」类型下拉，[1] 才是目标下拉（第一次取 [0] 导致误判）
    ck('C 触发绑定页的素材候选同步换成新模型的',
      JSON.stringify(C.binderTargets[1] || []) === JSON.stringify(['idle#0']),
      JSON.stringify(C.binderTargets[1] || []));

    // ---------- D. 切回去也应同步（双向） ----------
    const sw2 = await w.webContents.executeJavaScript(DO_SWITCH(FROM));
    result.switchBack = sw2;
    const back = await waitFor(w,
      '(() => { const e = document.querySelector(".lp-model"); return e && e.textContent.indexOf(' + JSON.stringify(FROM) + ') >= 0; })()',
      12000);
    ck('D 切回原模型后台词页同步回来', !!back, back ? 'ok' : '12s 内未跟随');
    const D = await w.webContents.executeJavaScript(SNAP);
    result.snapD = D;
    ck('D 台词档同步回 hotaru', D.lpCurId === 'hotaru', D.lpCurId);
    ck('D 动作候选同步回 idle + sleep',
      JSON.stringify((D.assetGroups || {}).motions) === JSON.stringify(['idle.motion3.json', 'sleep.motion3.json']),
      JSON.stringify((D.assetGroups || {}).motions));

    result.consoleErrors = errs;
    result.checks = checks;
    result.failed = checks.filter((c) => !c.pass).map((c) => c.name + ' :: ' + c.detail);
    result.RESULT = result.failed.length ? 'FAIL' : 'ALL OK';
    result.step = 'done';
    writeResult(result);

    try { w.destroy(); } catch (e) {}
    try { srv.close(); } catch (e) {}
    app.exit(result.failed.length ? 1 : 0);
  } catch (e) {
    result.step = 'fatal';
    result.err = String((e && e.stack) || e);
    result.checks = checks;
    result.failed = checks.filter((c) => !c.pass).map((c) => c.name + ' :: ' + c.detail);
    result.RESULT = 'FAIL';
    writeResult(result);
    try { if (srv) srv.close(); } catch (e2) {}
    app.exit(1);
  }
}

// 必须等 app ready 才能建 BrowserWindow（模块顶层直接建会报
// "Cannot create BrowserWindow before app is ready"）。
app.whenReady()
  .then(main)
  .catch((e) => { writeResult({ step: 'ready-fatal', err: String((e && e.stack) || e) }); app.exit(1); });

setTimeout(() => {
  const r = { step: 'timeout', checks: checks, RESULT: 'FAIL' };
  r.failed = checks.filter((c) => !c.pass).map((c) => c.name + ' :: ' + c.detail);
  writeResult(r);
  app.exit(1);
}, 90000);
