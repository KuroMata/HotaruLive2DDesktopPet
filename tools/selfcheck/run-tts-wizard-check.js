// 无头验证「语音引擎向导」整条链：preload 桥 → IPC → Python 检测脚本 → 向导页面渲染。
// 用真实主程序 + CDP（见技能 electron-headless-verify 0.6.5）。
// 全程在一个前台进程里跑完，避免沙箱回收掉派生进程。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROJ = 'D:/live2d-companion';
const EXE = path.join(PROJ, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 19277;
const OUT = path.join(PROJ, 'tools', 'selfcheck', 'tts-wizard-check-result.json');
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('error', () => resolve({ code: 0, body: '' }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ code: 0, body: '' }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await httpGet('http://127.0.0.1:' + PORT + '/json/list');
  if (r.code !== 200) return [];
  try { return JSON.parse(r.body); } catch (e) { return []; }
}

function evalIn(wsUrl, expr, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(v); } };
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return finish({ err: 'ws init: ' + e.message }); }
    const t = setTimeout(() => finish({ err: 'timeout' }), timeoutMs || 60000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true }
    }));
    ws.onmessage = (ev) => {
      clearTimeout(t);
      try {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          if (m.result && m.result.exceptionDetails) {
            return finish({ err: String(m.result.exceptionDetails.text || 'exception') });
          }
          finish({ val: m.result && m.result.result ? m.result.result.value : undefined });
        }
      } catch (e) { finish({ err: 'parse: ' + e.message }); }
    };
    ws.onerror = (e) => { clearTimeout(t); finish({ err: 'ws error' }); };
  });
}

async function main() {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, ['.', '--remote-debugging-port=' + PORT], { cwd: PROJ, env, windowsHide: true });
  const appLog = fs.createWriteStream(path.join(PROJ, 'tools', 'selfcheck', 'tts-wizard-app.log'));
  app.stdout.pipe(appLog, { end: false });
  app.stderr.pipe(appLog, { end: false });

  const killAll = () => {
    try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
  };

  try {
    // 1) 等 CDP 起来（最多 60s；单实例锁会让第二实例立刻退出）
    let list = [];
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      list = await targets();
      if (list.length) break;
      if (app.exitCode !== null) { say('APP_EXITED_EARLY code=' + app.exitCode + '（多半是已有实例在跑，单实例锁）'); break; }
    }
    if (!list.length) { say('FAIL: 拿不到 CDP target'); return 2; }

    const petPage = list.filter((t) => t.url && t.url.indexOf('127.0.0.1:18765') >= 0 && t.type === 'page')[0];
    if (!petPage) { say('FAIL: 找不到桌宠页面。targets=' + list.map((t) => t.url).join(' | ')); return 2; }
    say('OK 找到桌宠页面：' + petPage.url);

    // 2) preload 桥是否存在 tts 向导方法
    const bridge = await evalIn(petPage.webSocketDebuggerUrl,
      "JSON.stringify({d:typeof window.desktopPet,detect:typeof (window.desktopPet||{}).ttsEngineDetect," +
      "install:typeof (window.desktopPet||{}).ttsEngineInstall,open:typeof (window.desktopPet||{}).openTtsSetup," +
      "setCfg:typeof (window.desktopPet||{}).setConfig})", 20000);
    say('桥接：' + (bridge.val || JSON.stringify(bridge)));

    // 3) 直接经 IPC 调检测脚本
    const det = await evalIn(petPage.webSocketDebuggerUrl,
      "window.desktopPet.ttsEngineDetect().then(r=>JSON.stringify({ok:r.ok,ready:r.status&&r.status.ready,missing:r.status&&r.status.missing,checks:(r.status&&r.status.checks||[]).length,python:r.status&&r.status.python3_11_found,sb:r.status&&r.status.sidecarRunning}))", 90000);
    say('检测结果：' + (det.val || JSON.stringify(det)));

    // 4) 打开向导窗口并断言页面渲染
    await evalIn(petPage.webSocketDebuggerUrl, "window.desktopPet.openTtsSetup(); 'opened'", 15000);
    let wz = null;
    for (let i = 0; i < 25; i++) {
      await sleep(800);
      const l2 = await targets();
      wz = l2.filter((t) => t.url && t.url.indexOf('tts-setup.html') >= 0)[0];
      if (wz) break;
    }
    if (!wz) { say('FAIL: 向导窗口没出现'); return 2; }
    say('OK 向导窗口已打开：' + wz.url);

    // 等页面自己的 detect() 跑完（rows 有内容）
    let dom = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const r = await evalIn(wz.webSocketDebuggerUrl,
        "JSON.stringify({title:document.title,rows:document.querySelectorAll('#rows .r').length," +
        "hint:document.getElementById('detectHint')?document.getElementById('detectHint').textContent:''," +
        "head:document.body.innerText.slice(0,60)})", 20000);
      if (r.val) { dom = JSON.parse(r.val); if (dom.rows > 0) break; }
    }
    say('向导页面：' + JSON.stringify(dom));

    const okChain = bridge.val && JSON.parse(bridge.val).detect === 'function'
      && det.val && JSON.parse(det.val).ok && JSON.parse(det.val).ready
      && dom && dom.rows >= 7;
    say(okChain ? 'TTS_WIZARD_OK' : 'TTS_WIZARD_FAIL');
    return okChain ? 0 : 3;
  } finally {
    fs.writeFileSync(OUT, JSON.stringify({ lines: lines }, null, 2), 'utf8');
    killAll();
  }
}

main().then((c) => { setTimeout(() => process.exit(c), 500); }).catch((e) => {
  say('EXC ' + (e && e.stack || e));
  try { fs.writeFileSync(OUT, JSON.stringify({ lines: lines }, null, 2), 'utf8'); } catch (e2) {}
  process.exit(9);
});
