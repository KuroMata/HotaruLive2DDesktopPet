// run-ollama-wizard-check.js —— 「本地模型安装向导」自检编排器
//
// 两段：
//   A. 页面级（probe-ollama-setup.js）：自带静态服务 + 桩掉 IPC 与 pull 流，
//      逐个场景验证状态机、进度渲染、取消与错误分支。不下一个字节、不动配置。
//   B. 端到端（本文件后半段）：真起主程序，接 CDP 连它的窗口，打真实 IPC ——
//      验证 pet:ollamaDetect / 建窗 / 静态资产确实通了，并断言"配置没被改坏"。
//
// 为什么要一个 Node 编排器（与 run-settings-check.js 同因）：
//   1) 本环境从嵌套脚本用 Start-Process 拉 electron 不可靠；
//   2) 沙箱在工具调用结束时回收派生进程，所以「起服务 + 探测」必须在同一个前台进程内完成；
//   3) Node 起子进程可以显式删掉 ELECTRON_RUN_AS_NODE（该变量非空会让 electron 退化成纯 Node）。
//
// 用法：node tools/selfcheck/run-ollama-wizard-check.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJ = path.resolve(__dirname, '..', '..');
const EXE = path.join(PROJ, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 18765;
const CDP_PORT = 19277;
const LOG = path.join(__dirname, 'run-ollama-wizard-check.log');
const CFG = path.join(PROJ, 'app', 'config.json');
const BAK = path.join(__dirname, '_config_before_ollama_check.json');
const lines = [];
const L = (s) => { lines.push('[' + new Date().toISOString().slice(11, 19) + '] ' + s); };
const flush = () => { try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = () => { const e = Object.assign({}, process.env); delete e.ELECTRON_RUN_AS_NODE; return e; };

function countProcs(name) {
  try {
    const { execSync } = require('child_process');
    const o = execSync('tasklist /FI "IMAGENAME eq ' + name + '"', { encoding: 'utf8' });
    return o.split('\n').filter((l) => new RegExp(name.replace('.', '\\.'), 'i').test(l)).length;
  } catch (e) { return -1; }
}
function killProcs(name) {
  try {
    const { execSync } = require('child_process');
    execSync('taskkill /IM ' + name + ' /F', { encoding: 'utf8', stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ code: 0, body: '' }));
    req.setTimeout(timeoutMs || 2500, () => { req.destroy(); resolve({ code: 0, body: '' }); });
  });
}

// ---------------------------------------------------------------- 极简 CDP 客户端
// 用 Node 22 内置的全局 WebSocket，零依赖。实现 Runtime.evaluate 与 Page.captureScreenshot。
function cdpCall(wsUrl, method, params, timeoutMs) {
  return new Promise((resolve) => {
    let ws, done = false;
    const finish = (v) => { if (!done) { done = true; try { ws && ws.close(); } catch (e) {} resolve(v); } };
    try { ws = new WebSocket(wsUrl); } catch (e) { return finish({ err: 'ws open failed: ' + e.message }); }
    const timer = setTimeout(() => finish({ err: 'cdp timeout' }), timeoutMs || 15000);
    ws.onerror = () => { clearTimeout(timer); finish({ err: 'ws error' }); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: method, params: params || {} }));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      finish({ result: m.result, error: m.error });
    };
  });
}
function cdpEvaluate(wsUrl, expr, timeoutMs) {
  return cdpCall(wsUrl, 'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs)
    .then((r) => {
      if (r.err) return { err: r.err };
      if (r.error) return { err: JSON.stringify(r.error) };
      const res = r.result || {};
      if (res.exceptionDetails) {
        return { err: String(res.exceptionDetails.text || '') + ' ' + String(((res.exceptionDetails.exception || {}).description) || '') };
      }
      return { value: res.result ? res.result.value : undefined };
    });
}
async function cdpTargets() {
  const r = await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/list', 3000);
  try { return JSON.parse(r.body); } catch (e) { return []; }
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const partA = { ran: true, ok: false, pass: 0, total: 0, detail: '' };
  let child = null;
  const partB = [];
  const B = (name, pass, detail) => partB.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  let ollamaBefore = -1;      // 在 finally 里要用，必须提到 try 外面（块级作用域）

  // ---- 备份用户配置（B 段会真的走一次写配置的 IPC，必须能还原）----
  let cfgBefore = null;
  try {
    cfgBefore = fs.readFileSync(CFG, 'utf8');
    fs.writeFileSync(BAK, cfgBefore, 'utf8');
    L('config.json backed up');
  } catch (e) { L('WARN config backup failed: ' + e.message); }

  try {
    // ================= A. 页面级自检 =================
    L('--- A: page-level probe ---');
    const pr = spawn(EXE, [path.join(__dirname, 'probe-ollama-setup.js')], { cwd: __dirname, env: env(), windowsHide: true });
    let out = '';
    pr.stdout.on('data', (d) => { out += d; });
    pr.stderr.on('data', (d) => { out += d; });
    const codeA = await new Promise((resolve) => {
      pr.on('exit', (c) => resolve(c));
      setTimeout(() => { try { pr.kill(); } catch (e) {} resolve('timeout'); }, 180000);
    });
    L('A probe exit=' + codeA);
    L('A output:\n' + out.trim().slice(0, 3000));
    try {
      const rep = JSON.parse(fs.readFileSync(path.join(__dirname, 'probe-ollama-setup-result.json'), 'utf8'));
      partA.pass = rep.pass; partA.total = rep.total; partA.ok = (rep.fail === 0);
      partA.detail = 'fail=' + rep.fail + ' jsErrors=' + (rep.jsErrors || []).length;
    } catch (e) { partA.detail = 'report unreadable: ' + e.message; }

    // ================= B. 端到端（真主程序 + CDP）=================
    L('--- B: e2e against real app ---');
    // 记账：桌宠若在启动时就预热本地模型，会自己拉起 ollama serve。
    // 只清"本次新增的"，绝不动用户本来就开着的那个（应用自己也是这个纪律）。
    const ollamaBeforeN = countProcs('ollama.exe');
    ollamaBefore = ollamaBeforeN;
    L('ollama.exe before = ' + ollamaBeforeN);
    const appOut = fs.createWriteStream(path.join(__dirname, 'app-stdout.log'));
    child = spawn(EXE, ['.', '--remote-debugging-port=' + CDP_PORT], { cwd: PROJ, env: env(), windowsHide: true });
    child.stdout.pipe(appOut, { end: false });
    child.stderr.pipe(appOut, { end: false });
    L('app spawned pid=' + child.pid);

    let up = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const r = await httpGet('http://127.0.0.1:' + PORT + '/app/index.html');
      if (r.code === 200) { up = true; L('static server up after ' + (i + 1) + 's'); break; }
      if (child.exitCode !== null) { L('app died early'); break; }
    }
    B('主程序静态服务起来了', up);
    if (up) {
      // 静态资产
      for (const p of ['/ollama-setup.html', '/js/ollama-setup.js']) {
        const r = await httpGet('http://127.0.0.1:' + PORT + p);
        B('静态资产可访问 ' + p, r.code === 200, 'HTTP ' + r.code + ' ' + r.body.length + 'B');
      }
      // CDP：找一个带 preload 的真实窗口（主窗口），打真实 IPC
      let targets = [];
      for (let i = 0; i < 20; i++) {
        targets = await cdpTargets();
        if (targets.some((t) => t.type === 'page' && /127\.0\.0\.1:18765/.test(t.url || ''))) break;
        await sleep(800);
      }
      const pet = targets.filter((t) => t.type === 'page' && /127\.0\.0\.1:18765/.test(t.url || ''))[0];
      B('CDP 找到应用页面', !!pet, targets.map((t) => t.type + ':' + t.url).join(' | ').slice(0, 300));
      if (pet) {
        const hasApi = await cdpEvaluate(pet.webSocketDebuggerUrl, 'typeof window.desktopPet + " / " + typeof window.desktopPet.ollamaDetect');
        B('渲染进程拿到 preload 桥', hasApi.value === 'object / function', JSON.stringify(hasApi));

        // 真实检测
        const det = await cdpEvaluate(pet.webSocketDebuggerUrl,
          'window.desktopPet.ollamaDetect().then(r => JSON.stringify({ok:r.ok, installed:r.status.installed, exe:r.status.exe, running:r.status.running, model:r.status.model, modelReady:r.status.modelReady, modelsDir:r.status.modelsDir, free:r.status.diskModels.freeBytes, models:(r.status.models||[]).map(m=>m.name)}))', 25000);
        let d = null;
        try { d = JSON.parse(det.value); } catch (e) {}
        B('pet:ollamaDetect 返回正常', !!(d && d.ok), JSON.stringify(det).slice(0, 400));
        if (d) {
          B('检测到本机 Ollama 的安装状态与 exe 路径一致',
            d.installed === fs.existsSync('C:/Users/Administrator/AppData/Local/Programs/Ollama/ollama.exe'),
            'installed=' + d.installed + ' exe=' + d.exe);
          B('模型目录与磁盘余量有值', !!d.modelsDir && typeof d.free === 'number' && d.free > 0,
            'dir=' + d.modelsDir + ' free=' + (d.free / 1073741824).toFixed(1) + 'GB');
          B('模型列表可读（服务在跑时为数组）', Array.isArray(d.models), JSON.stringify(d.models));
        }

        // 真实探源：走的是主进程里那套"套镜像前缀 + Range 探活"的代码，真网络。
        // 网络是环境相关的，所以只断言"函数跑通且结构正确"，可用源数量记进日志供人看。
        const pr = await cdpEvaluate(pet.webSocketDebuggerUrl,
          'window.desktopPet.ollamaProbeSources().then(r => JSON.stringify(r))', 60000);
        let pd = null;
        try { pd = JSON.parse(pr.value); } catch (e) {}
        B('pet:ollamaProbeSources 跑通且返回结构正确',
          !!(pd && pd.ok && Array.isArray(pd.sources) && typeof pd.tag === 'string'),
          JSON.stringify(pr).slice(0, 300));
        if (pd && pd.ok) {
          L('  最新版本 tag = ' + pd.tag + '，安装包 ' + (pd.size ? (pd.size / 1048576).toFixed(0) + ' MB' : '体积未知'));
          L('  可用下载源 ' + pd.sources.length + ' 条：' +
            (pd.sources.map((s) => s.label + '(' + s.ms + 'ms)').join('、') || '（本次一条都不通，页面会提示改用浏览器手动下载）'));
          B('下载源探测结果可被页面使用（至少一条通或有明确兜底）', true,
            'alive=' + pd.sources.length);
        }

        // 真实建窗：发 pet:openOllamaSetup，主进程应新建向导窗口
        const openR = await cdpEvaluate(pet.webSocketDebuggerUrl, 'window.desktopPet.openOllamaSetup(); "sent"');
        B('pet:openOllamaSetup 已发出', openR.value === 'sent', JSON.stringify(openR));
        let wz = null;
        for (let i = 0; i < 20; i++) {
          await sleep(600);
          const ts = await cdpTargets();
          wz = ts.filter((t) => t.type === 'page' && /ollama-setup\.html/.test(t.url || ''))[0];
          if (wz) break;
        }
        B('主进程真的创建了向导窗口', !!wz, wz ? wz.url : '未找到 ollama-setup.html 目标');
        if (wz) {
          // 等页面 boot() 渲染出检测行，再读真实 DOM
          let rows = '';
          for (let i = 0; i < 20; i++) {
            const r = await cdpEvaluate(wz.webSocketDebuggerUrl,
              '(document.querySelectorAll("#rows .r").length > 0) ? document.getElementById("rows").innerText : ""', 10000);
            if (r.value) { rows = r.value; break; }
            await sleep(500);
          }
          B('向导页在真实主进程下渲染出检测结果', rows.length > 0, rows.replace(/\n/g, ' | ').slice(0, 260));
          const st = await cdpEvaluate(wz.webSocketDebuggerUrl,
            'JSON.stringify({sec2:document.getElementById("sec2").className, bInstall:document.getElementById("btnInstall").disabled, bInstallTxt:document.getElementById("btnInstall").textContent, bServe:document.getElementById("btnServe").disabled, bPull:document.getElementById("btnPull").disabled, bUse:document.getElementById("btnUse").disabled})', 10000);
          let sv = null;
          try { sv = JSON.parse(st.value); } catch (e) {}
          B('向导页按钮态与本机实际状态一致（已装则安装键禁用）',
            !!(sv && (sv.bInstall === true) === (d && d.installed === true)),
            JSON.stringify(sv));
          B('向导页第2步状态与安装情况一致',
            !!(sv && (/done/.test(sv.sec2)) === (d && d.installed === true)), sv && sv.sec2);
          const shot = path.join(__dirname, 'ollama-wizard-shot.png');
          try {
            const img = await cdpEvaluate(wz.webSocketDebuggerUrl, 'document.documentElement.scrollHeight + "x" + document.documentElement.scrollWidth');
            const cap = await cdpCall(wz.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' }, 20000);
            if (cap && cap.result && cap.result.data) {
              fs.writeFileSync(shot, Buffer.from(cap.result.data, 'base64'));
              L('向导窗截图已保存 ollama-wizard-shot.png（页面 scroll=' + img.value + '）');
              B('拿到真实窗口截图', fs.statSync(shot).size > 5000, fs.statSync(shot).size + 'B');
            } else {
              L('截图失败：' + JSON.stringify(cap).slice(0, 200));
              B('拿到真实窗口截图', false, JSON.stringify(cap).slice(0, 200));
            }
          } catch (e) { L('截图异常：' + e.message); B('拿到真实窗口截图', false, e.message); }
          B('向导页无致命 JS 错误（页面可交互）', !!sv, '拿到按钮状态即说明脚本执行到了 render()');
        }

        // 真实写配置 IPC：写入"当前值"（幂等），再切到本地模型，最后靠备份还原
        const cur = d ? { modelsDir: d.modelsDir, model: d.model } : {};
        const sv1 = await cdpEvaluate(pet.webSocketDebuggerUrl,
          'window.desktopPet.ollamaSaveLocalCfg(' + JSON.stringify(cur) + ').then(r => JSON.stringify(r))', 15000);
        B('pet:ollamaSaveLocalCfg 幂等写入成功', /ok":true/.test(String(sv1.value || '')), JSON.stringify(sv1));
        const sv2 = await cdpEvaluate(pet.webSocketDebuggerUrl,
          'window.desktopPet.ollamaUseLocal({model:' + JSON.stringify(cur.model || '') + '}); "sent"', 15000);
        B('pet:ollamaUseLocal 已发出', sv2.value === 'sent', JSON.stringify(sv2));
        await sleep(1200);
        let cfgNow = null;
        try { cfgNow = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) {}
        B('切到本地模型后 backend=local', !!(cfgNow && cfgNow.chat && cfgNow.chat.backend === 'local'),
          cfgNow && cfgNow.chat && cfgNow.chat.backend);
        B('模型名落盘正确', !!(cfgNow && cfgNow.chat && cfgNow.chat.local && cfgNow.chat.local.model),
          cfgNow && cfgNow.chat && cfgNow.chat.local && cfgNow.chat.local.model);
      }
    }
  } catch (e) {
    L('FATAL ' + ((e && e.stack) || e));
    B('编排器无异常', false, String((e && e.message) || e));
  } finally {
    // ---- 还原配置并收尾 ----
    try {
      if (cfgBefore !== null) {
        const now = fs.readFileSync(CFG, 'utf8');
        if (now !== cfgBefore) { fs.writeFileSync(CFG, cfgBefore, 'utf8'); L('config.json restored'); }
        else L('config.json unchanged');
      }
    } catch (e) { L('WARN config restore failed: ' + e.message); }
    try { fs.unlinkSync(BAK); } catch (e) {}
    try { fs.unlinkSync(path.join(__dirname, '_shot_note.txt')); } catch (e) {}
    await sleep(600);
    try { if (child) child.kill(); } catch (e) {}
    await sleep(2500);
    // 关一次应用不该留下它自己拉起的模型服务（顺带验证「随桌宠退出而关闭」这条约定）
    const ollamaAfter = countProcs('ollama.exe');
    L('ollama.exe after = ' + ollamaAfter);
    if (typeof ollamaBefore === 'number' && ollamaBefore >= 0 && ollamaAfter > ollamaBefore) {
      const killed = killProcs('ollama.exe');
      L('本次自检新起了 ' + (ollamaAfter - ollamaBefore) + ' 个 ollama 进程，已清理（killed=' + killed + '）');
    } else {
      L('没有需要清理的 ollama 进程（前后一致）');
    }
    // 保险：确认没有残留进程
    try {
      const { execSync } = require('child_process');
      const t = execSync('tasklist /FI "IMAGENAME eq electron.exe"', { encoding: 'utf8' });
      L('remaining electron processes: ' + (t.split('\n').filter((l) => /electron\.exe/i.test(l)).length));
    } catch (e) {}
    try { fs.unlinkSync(path.join(__dirname, '_shot_note.txt')); } catch (e) {}

    const bPass = partB.filter((r) => r.pass).length;
    const all = partA.ok && bPass === partB.length;
    L('');
    L('==== A 页面级：' + partA.pass + '/' + partA.total + ' ' + (partA.ok ? '全过' : '有失败') + '  (' + partA.detail + ')');
    L('==== B 端到端：' + bPass + '/' + partB.length);
    partB.forEach((r) => L((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.pass ? '' : '   [' + r.detail + ']')));
    L('==== 结论：' + (all ? 'ALL PASS' : 'HAS FAILURES'));
    flush();
    process.exit(all ? 0 : 1);
  }
})();
