// probe-settings.js —— 无头验证「设置窗」是否真的把三大新分页渲染出来
// 用法（主程序需已在运行，静态服务 127.0.0.1:18765）：
//   node tools/selfcheck/run-probe.js tools/selfcheck/probe-settings.js
//
// 断言原则（见 electron-headless-verify 技能 0.7）：
//   控件函数 / CSS / IPC 都写好、但 schema 没挂上 → 界面什么都不显示，node --check 查不出来。
//   所以这里断言的是「渲染出来的 DOM」，而不是「函数存在过」。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT = path.resolve(__dirname, '..', '..');
const PORT = 18765;
const TTS_PORT = 18766;
const OUT = path.join(__dirname, 'probe-settings-result.json');
const SHOT = path.join(__dirname, 'probe-settings.png');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

const called = {};
const t = (ch) => { called[ch] = (called[ch] || 0) + 1; };

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('http timeout')));
  });
}

const CONFIG_PATH = path.join(PROJECT, 'app', 'config.json');
const PROFILES_DIR = path.join(PROJECT, 'app', 'data', 'lines', 'profiles');
const MODELS_DIR = path.join(PROJECT, 'app', 'models');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}

function scanModelsSync(base) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (/\.model3\.json(\.enc)?$/i.test(e.name)) {
        out.push({
          name: e.name.replace(/\.model3\.json(\.enc)?$/i, ''),
          rel: path.relative(base, p).replace(/\\/g, '/').replace(/\.enc$/, ''),
          dir: path.dirname(p), size: e.size || 0
        });
      }
    }
  };
  walk(base, 0);
  return out;
}

function scanAssetsSync(modelDir) {
  const motions = [], expressions = [];
  const strip = (n) => n.replace(/\.enc$/, '');
  let ents = [];
  try { ents = fs.readdirSync(modelDir, { withFileTypes: true }); } catch (e) { return { motions, expressions }; }
  for (const e of ents) {
    if (e.isFile() && /\.motion3\.json(\.enc)?$/i.test(e.name)) {
      motions.push({ file: strip(e.name), rel: strip(e.name), name: strip(e.name).replace(/\.motion3\.json$/, '') });
    }
    if (e.isDirectory() && e.name === 'exp3') {
      let sub = [];
      try { sub = fs.readdirSync(path.join(modelDir, 'exp3'), { withFileTypes: true }); } catch (err) {}
      for (const s of sub) {
        if (s.isFile() && /\.exp3\.json(\.enc)?$/i.test(s.name)) {
          expressions.push({ file: 'exp3/' + strip(s.name), rel: 'exp3/' + strip(s.name), name: strip(s.name).replace(/\.exp3\.json$/, '') });
        }
      }
    }
  }
  return { motions, expressions };
}

function registerHandlers() {
  const H = {
    'pet:getConfig': () => readConfig(),
    'pet:getModelParams': () => [],
    'pet:getAudioDevices': () => [],
    'pet:getOutputDevices': () => [],
    'pet:getMusicState': () => null,
    'pet:getScreenSources': () => [],
    'pet:getDisplays': () => [],
    'pet:chooseFile': () => ({ ok: false, error: 'probe' }),
    'pet:chooseDirectory': () => ({ ok: false, error: 'probe' }),
    'pet:switchModel': () => ({ ok: true, probe: true }),
    'pet:triggerAsset': () => ({ ok: true, probe: true }),
    'pet:setConfig': (p) => ({ ok: true, echo: p && p.key }),
    'pet:setBindings': () => ({ ok: true, probe: true }),
    'pet:setLineProfile': () => ({ ok: true, probe: true }),
    'pet:deleteLineProfile': () => ({ ok: true, probe: true }),
    'pet:previewTTS': () => ({ ok: false, error: 'probe' }),

    'pet:scanModels': (dir) => {
      const base = dir || MODELS_DIR;
      return { ok: true, base: base, models: scanModelsSync(base) };
    },
    'pet:scanModelAssets': (url) => {
      const rel = String(url || '').replace(/^\/models\//, '');
      const dir = path.join(MODELS_DIR, path.dirname(rel));
      const a = scanAssetsSync(dir);
      return { ok: true, dir: dir, motions: a.motions, expressions: a.expressions };
    },
    'pet:getModelAssets': async () => {
      const cfg = readConfig();
      const key = String(cfg.modelUrl || '').replace(/^\/models\//, '');
      const entry = (cfg.modelAssets || {})[key] || { motions: [], expressions: [] };
      let expressions = [];
      try {
        const txt = await httpGet('http://127.0.0.1:' + PORT + '/models/' + key);
        const j = JSON.parse(txt);
        expressions = (j.FileReferences.Expressions || []).map((e) => ({ name: e.Name, file: e.File }));
      } catch (e) { /* 保留空 */ }
      const motions = [];
      (entry.motions || []).forEach((m) => motions.push({ group: m.group, index: 0, file: m.file }));
      return { expressions: expressions, motions: motions, cache: 'probe' };
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
    },
    'pet:listVoices': async (engine) => {
      try {
        const txt = await httpGet('http://127.0.0.1:' + TTS_PORT + '/health');
        const j = JSON.parse(txt);
        const hit = (j.engines || []).find((e) => e.name === (engine || j.engine));
        return { engine: (hit && hit.name) || engine || '', voices: (hit && hit.voices) || [] };
      } catch (e) { return { engine: engine || '', voices: [], error: String(e.message) }; }
    }
  };
  Object.keys(H).forEach((ch) => {
    ipcMain.handle(ch, async (_e, ...args) => { t(ch); return await H[ch](...args); });
  });
}

function writeResult(o) {
  try { fs.writeFileSync(OUT, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {}
}

const INJECT = `(() => { try {
  const rect = (el) => { const b = el.getBoundingClientRect();
    return Math.round(b.width) + 'x' + Math.round(b.height); };
  const wide = [...document.querySelectorAll('.wide-ctrl')].map((e) => {
    const row = e.closest('.row');
    const ctrl = row ? row.querySelector('.ctrl') : null;
    const cs = ctrl ? getComputedStyle(ctrl) : null;
    const rs = row ? getComputedStyle(row) : null;
    return { cls: e.className, size: rect(e),
             ctrlGridColumn: cs ? cs.gridColumnStart + '/' + cs.gridColumnEnd : '',
             ctrlGridRow: cs ? cs.gridRowStart : '',
             rowTemplate: rs ? rs.gridTemplateColumns : '' };
  });
  return {
    ok: true,
    title: document.title,
    tabs: [...document.querySelectorAll('#tabs .tab')].map((x) => x.textContent.trim()),
    groups: [...document.querySelectorAll('section.group')].map((s) => {
      const g = s.querySelector('.gtitle');
      return (g ? g.textContent.trim() : '(no title)') + ' [' + s.querySelectorAll('.row').length + ' rows]';
    }),
    counts: {
      tabs: document.querySelectorAll('#tabs .tab').length,
      groups: document.querySelectorAll('section.group').length,
      rows: document.querySelectorAll('section.group .row').length,
      wideCtrl: document.querySelectorAll('.wide-ctrl').length,
      modelLib: document.querySelectorAll('.model-lib').length,
      lpPicker: document.querySelectorAll('.lp-picker').length,
      lineEditor: document.querySelectorAll('.line-editor').length,
      assetLink: document.querySelectorAll('.asset-link').length,
      assetBinder: document.querySelectorAll('.asset-binder').length,
      leCards: document.querySelectorAll('.line-editor .le-card').length,
      abCards: document.querySelectorAll('.asset-binder .ab-card').length,
      lpOptions: document.querySelectorAll('.lp-picker option').length,
      alRows: document.querySelectorAll('.asset-link .al-row').length,
      alLive: document.querySelectorAll('.asset-link .al-live').length
    },
    wide: wide,
    bodyHead: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 420),
    hasErrParagraph: document.body.innerHTML.indexOf('desktopPet 不存在') >= 0
  };
} catch (e) { return { ok: false, err: String(e && e.message || e) }; } })()`;

const ACTIVATE = `(() => { try {
  const tabs = [...document.querySelectorAll('#tabs .tab')];
  const i = tabs.findIndex((x) => x.textContent.indexOf('表情与动作') >= 0);
  if (i >= 0) { tabs[i].click(); }
  const secs = [...document.querySelectorAll('section.group')];
  const vis = secs.filter((s) => getComputedStyle(s).display !== 'none')
                   .map((s) => { const g = s.querySelector('.gtitle'); return g ? g.textContent.trim() : '?'; });
  return { ok: true, clicked: i, visible: vis,
           visibleRows: document.querySelectorAll('section.group:not([style*="display: none"]) .row').length };
} catch (e) { return { ok: false, err: String(e && e.message || e) }; } })()`;

async function main() {
  try {
    registerHandlers();
    const w = new BrowserWindow({
      width: 780, height: 620,
      show: true,
      backgroundColor: '#11151c',
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, webSecurity: true,
        preload: path.join(PROJECT, 'preload.js')
      }
    });
    const errs = [];
    w.webContents.on('console-message', (_e, lvl, msg) => {
      if (lvl >= 2) errs.push('console:' + lvl + ':' + String(msg).slice(0, 200));
    });
    w.webContents.on('preload-error', (_e, f, err) => errs.push('preload:' + f + ':' + err.message));

    const result = { step: 'load' };
    await w.loadURL('http://127.0.0.1:' + PORT + '/settings.html');

    // 轮询等待 buildUI 把分组渲染出来（别用固定 sleep）
    let ready = false;
    for (let i = 0; i < 60; i++) {
      const n = await w.webContents.executeJavaScript('document.querySelectorAll("section.group").length').catch(() => 0);
      if (n > 0) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    result.buildUIRendered = ready;
    await new Promise((r) => setTimeout(r, 1500));

    result.main = await w.webContents.executeJavaScript(INJECT);
    result.tabSwitch = await w.webContents.executeJavaScript(ACTIVATE);
    await new Promise((r) => setTimeout(r, 600));

    try {
      const img = await w.webContents.capturePage();
      fs.writeFileSync(SHOT, img.toPNG());
      result.shot = SHOT;
    } catch (e) { result.shotErr = String(e.message); }

    result.consoleErrors = errs;
    result.ipcCalled = called;
    result.step = 'done';
    writeResult(result);
    try { w.destroy(); } catch (e) {}
    app.exit(0);
  } catch (e) {
    writeResult({ step: 'fatal', err: String(e && e.stack || e), ipcCalled: called });
    app.exit(1);
  }
}

// 必须等 app ready 才能建 BrowserWindow —— 在模块顶层直接建会报
// "Cannot create BrowserWindow before app is ready"（本机实测踩过）。
app.whenReady()
  .then(main)
  .catch((e) => { writeResult({ step: 'ready-fatal', err: String(e && e.stack || e) }); app.exit(1); });

setTimeout(() => { writeResult({ step: 'timeout', ipcCalled: called }); app.exit(1); }, 60000);
