// run-probe.js —— 在本环境启动一个 Electron 探针脚本（Node 运行）
// 为什么需要它：Bash 里 `VAR= cmd` 的前缀赋值清不掉从进程树继承的
// ELECTRON_RUN_AS_NODE（会被 shell shim 重新导出），electron 会退化成纯 Node，
// 探针里 `require('electron').app` 变成 undefined。这里显式删掉该变量再起子进程。
//
// 用法：
//   node tools/selfcheck/run-probe.js                      # 默认跑 measure-bottombar.js
//   node tools/selfcheck/run-probe.js my-probe.js          # 跑指定探针
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const exe = path.resolve(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(exe)) {
  console.error('[probe] electron.exe not found: ' + exe);
  process.exit(1);
}

const probe = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(__dirname, 'measure-bottombar.js');
if (!fs.existsSync(probe)) {
  console.error('[probe] script not found: ' + probe);
  process.exit(1);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

console.log('[probe] electron=' + exe);
console.log('[probe] script=' + probe);
const child = spawn(exe, [probe], { env: env, stdio: 'inherit', windowsHide: true });
child.on('error', (e) => { console.error('[probe] spawn error: ' + e.message); process.exit(1); });
child.on('exit', (code) => { console.log('[probe] electron exit=' + code); process.exit(code || 0); });
