// run-settings-check.js —— 一次跑完：起主程序 → 等静态服务 → 跑设置窗探针 → 收尾
// 为什么要一个 Node 编排器：
//   1) 本环境 `Start-Process` 从嵌套脚本里拉起 electron 不可靠（实测有一次完全没启动）；
//   2) 沙箱在工具调用结束时会回收派生进程，所以「起服务 + 探测」必须在同一个前台进程里完成；
//   3) Node 起子进程可以显式删掉 ELECTRON_RUN_AS_NODE（该变量非空会让 electron 退化成纯 Node）。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJ = path.resolve(__dirname, '..', '..');
const EXE = path.join(PROJ, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 18765;
const LOG = path.join(__dirname, 'run-settings-check.log');
const lines = [];
const L = (s) => { lines.push('[' + new Date().toISOString().slice(11, 19) + '] ' + s); };
const flush = () => { try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (e) {} };

function env() { const e = Object.assign({}, process.env); delete e.ELECTRON_RUN_AS_NODE; return e; }

function probePort() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:' + PORT + '/app/settings.html', (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(EXE)) { L('FATAL electron.exe missing: ' + EXE); flush(); process.exit(1); }

  // ---- 1) 起主程序 ----
  const appOut = fs.createWriteStream(path.join(__dirname, 'app-stdout.log'));
  const child = spawn(EXE, ['.'], { cwd: PROJ, env: env(), windowsHide: true });
  child.stdout.pipe(appOut, { end: false });
  child.stderr.pipe(appOut, { end: false });
  L('app spawned pid=' + child.pid);
  child.on('exit', (c, s) => L('app exited code=' + c + ' sig=' + s));

  // ---- 2) 等静态服务 ----
  let up = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (await probePort()) { up = true; L('static server up after ' + (i + 1) + 's'); break; }
    if (child.exitCode !== null) { L('app died early, abort'); break; }
  }
  if (!up) {
    L('FATAL static server never came up');
    try { child.kill(); } catch (e) {}
    flush(); process.exit(2);
  }
  await sleep(4000);

  // ---- 3) 跑探针 ----
  L('launching settings probe');
  const pr = spawn(EXE, [path.join(__dirname, 'probe-settings.js')], { cwd: __dirname, env: env(), windowsHide: true });
  let prOut = '';
  pr.stdout.on('data', (d) => { prOut += d; });
  pr.stderr.on('data', (d) => { prOut += d; });
  const code = await new Promise((resolve) => {
    pr.on('exit', (c) => resolve(c));
    setTimeout(() => { try { pr.kill(); } catch (e) {} resolve('timeout'); }, 90000);
  });
  L('probe exit=' + code);
  if (prOut.trim()) L('probe stdout: ' + prOut.trim().slice(0, 900));

  // ---- 4) 收尾 ----
  await sleep(800);
  try { child.kill(); } catch (e) {}
  await sleep(1200);
  L('done');
  flush();
  process.exit(0);
})();
