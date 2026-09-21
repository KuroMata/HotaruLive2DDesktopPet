// check-user-audio.js —— 端到端验证「自录音频：引用原路径」（需求第 8 条）
// 做法：起主程序 → 打 /api/user-audio → 断言白名单机制真的生效 → 收尾清掉临时台词档。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJ = path.resolve(__dirname, '..', '..');
const EXE = path.join(PROJ, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 18765;
const PROFILES = path.join(PROJ, 'app', 'data', 'lines', 'profiles');
const TMP_PROFILE = path.join(PROFILES, '_probe_abs.json');
const REAL_WAV = path.join(PROJ, 'app', 'data', 'lines', 'click_cn_00.wav');
const LOG = path.join(__dirname, 'check-user-audio.log');
const out = [];
const L = (s) => out.push(s);
const flush = () => { try { fs.writeFileSync(LOG, out.join('\n'), 'utf8'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = () => { const e = Object.assign({}, process.env); delete e.ELECTRON_RUN_AS_NODE; return e; };

function req(url) {
  return new Promise((resolve) => {
    const r = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        len: Buffer.concat(chunks).length,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 90)
      }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.setTimeout(6000, () => { r.destroy(); resolve({ status: 0, err: 'timeout' }); });
  });
}

const U = (p) => 'http://127.0.0.1:' + PORT + '/api/user-audio?path=' + encodeURIComponent(p);

(async () => {
  let child = null;
  try {
    child = spawn(EXE, ['.'], { cwd: PROJ, env: env(), windowsHide: true });
    child.on('exit', (c) => L('app exited ' + c));
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const r = await req('http://127.0.0.1:' + PORT + '/app/settings.html');
      if (r.status === 200) { up = true; L('static up after ' + (i + 1) + 's'); break; }
      if (child.exitCode !== null) break;
    }
    if (!up) { L('FATAL no static server'); flush(); process.exit(2); }

    const sz = fs.statSync(REAL_WAV).size;
    L('real wav = ' + REAL_WAV + '  (' + sz + ' bytes)');
    L('profiles dir has ' + fs.readdirSync(PROFILES).length + ' file(s)');

    // ---- 1) 未被任何台词档引用 → 必须 403 ----
    const r1 = await req(U(REAL_WAV));
    L('');
    L('[1] not referenced      -> ' + r1.status + '  body="' + r1.body + '"');
    L('    expect 403 / not-referenced : ' + (r1.status === 403 ? 'PASS' : 'FAIL'));

    // ---- 2) 非音频扩展名 → 必须 403 ----
    const r2 = await req(U(path.join(PROJ, 'app', 'config.json')));
    L('[2] non-audio ext       -> ' + r2.status + '  body="' + r2.body + '"');
    L('    expect 403 unsupported      : ' + (r2.status === 403 ? 'PASS' : 'FAIL'));

    // ---- 3) 缺 path 参数 → 必须 400 ----
    const r3 = await req('http://127.0.0.1:' + PORT + '/api/user-audio');
    L('[3] missing path        -> ' + r3.status);
    L('    expect 400                  : ' + (r3.status === 400 ? 'PASS' : 'FAIL'));

    // ---- 4) 写一个临时台词档，把该 wav 以 src:'abs' 引用 → 必须 200 ----
    const prof = {
      name: 'PROBE-ABS',
      click: [{ text: 'probe', emo: 'neutral', voice: { cn: { src: 'abs', file: REAL_WAV } } }],
      idle: []
    };
    fs.writeFileSync(TMP_PROFILE, JSON.stringify(prof, null, 2), 'utf8');
    L('');
    L('[4] wrote temp profile _probe_abs.json (abs ref -> click_cn_00.wav)');
    await sleep(300);
    const r4 = await req(U(REAL_WAV));
    L('    referenced (abs src)     -> ' + r4.status + '  type=' + r4.type + '  len=' + r4.len);
    L('    expect 200 + audio/wav + ' + sz + ' bytes : ' +
      ((r4.status === 200 && r4.type.indexOf('audio') === 0 && r4.len === sz) ? 'PASS' : 'FAIL'));

    // ---- 5) 大小写不敏感（Windows 路径应能命中同一白名单项）----
    const r5 = await req(U(REAL_WAV.toUpperCase()));
    L('[5] upper-cased path     -> ' + r5.status + '  len=' + r5.len);
    L('    expect 200 (case-insens)    : ' + (r5.status === 200 ? 'PASS' : 'FAIL'));

    // ---- 6) 不在白名单里的另一个音频 → 仍必须 403 ----
    const other = path.join(PROJ, 'app', 'data', 'lines', 'click_cn_01.wav');
    const r6 = await req(U(other));
    L('[6] other wav not in list-> ' + r6.status);
    L('    expect 403                  : ' + (r6.status === 403 ? 'PASS' : 'FAIL'));

  } catch (e) {
    L('FATAL ' + (e && e.stack || e));
  } finally {
    try { if (fs.existsSync(TMP_PROFILE)) { fs.unlinkSync(TMP_PROFILE); L(''); L('cleaned temp profile'); } } catch (e) { L('cleanup err ' + e.message); }
    await sleep(500);
    try { if (child) child.kill(); } catch (e) {}
    flush();
    process.exit(0);
  }
})();
