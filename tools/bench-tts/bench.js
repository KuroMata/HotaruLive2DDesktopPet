// bench-tts.js —— M0：本地语音引擎的延迟与稳定性测量
//
// 目的：回答"直播时能不能只用本地引擎、够不够快"。
// 只测**能用你自己音色**的引擎（零样本克隆）：
//   · cosyvoice —— 本地 CosyVoice2，ref = tts/ref/prompt.wav
//   · indextts  —— 本地 IndexTTS-2，ref = tts/ref/prompt.wav + emo_ref/<emo>.wav
// 固定音色的 edge / sapi 不参与（用户要求"只用一个引擎以免变声期"，而它们不能克隆）。sapi 仅作速度参照。
//
// 关键指标（不是"总耗时"）：
//   · RTF = 合成耗时 / 音频时长。**RTF < 1 才可能支撑流水线**（下一句能在当前句播完前合成好）。
//     代码注释里记过一次 RTF 1.5→17 的显存堆积事故，所以这个数字必须实测。
//   · 同一句话合成多次的音色稳定性（交给 analyze.py 用 F0/谱心量）。
//
// 一个引擎一个侧车进程、跑完就杀：避免两个模型同时驻留抢显存（本机空闲显存只有 ~3GB）。
//
// 用法：node tools/bench-tts/bench.js [cosyvoice|indextts|sapi|all] [每句重复次数]
//   引擎很慢时可以传重复次数=1，先只探"能不能出声、RTF 大概多少"；
//   稳定性分析需要 >=2 次，正式测请留默认 3。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJ = path.resolve(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(PROJ, 'app', 'config.json'), 'utf8'));
const OUT_DIR = path.join(__dirname, 'results');
const PORT = 18777;                      // 专用端口，别碰应用自己的 18766
const SENTENCES = [
  { id: 'S1', kind: '短（开场反应）', text: '来了来了，这就回你。' },
  { id: 'S2', kind: '中（一句吐槽）', text: '你这问题问得好，不过我得先看一眼屏幕才知道你在说啥。' },
  { id: 'S3', kind: '长（三句连说）', text: '行，我给你捋一下。第一，本地模型跑起来之后就不用联网了；第二，语音也得留在本地，不然就串味了；第三，弹幕那种必须联网的，我们再单独接。' }
];
const REPEAT = Number(process.argv[3] || 3);   // 每句重复次数（默认 3：取中位数 + 供稳定性分析）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gpu() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used,memory.free,utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

// 本侧车真正会用到的环境变量（与 main.js::ttsSpawn 一致）
function sidecarEnv() {
  const e = Object.assign({}, process.env);
  const m = {
    COSYVOICE_DIR: CFG.cosyvoiceDir, COSYVOICE_REF: CFG.cosyvoiceRef, COSYVOICE_FP16: CFG.cosyvoiceFp16,
    INDEXTTS_DIR: CFG.indexttsDir, INDEXTTS_MODEL_DIR: CFG.indexttsModelDir, INDEXTTS_REF: CFG.indexttsRef,
    INDEXTTS_EMO_ALPHA: CFG.indexttsEmoAlpha, INDEXTTS_BOYIFY: CFG.indexttsBoyify,
    INDEXTTS_SEMITONES: CFG.indexttsSemitones, INDEXTTS_POLISH: CFG.indexttsPolish
  };
  for (const k of Object.keys(m)) if (m[k] !== undefined && m[k] !== null && m[k] !== '') e[k] = String(m[k]);
  return e;
}

function pythonFor(engine) {
  if (engine === 'cosyvoice' && CFG.cosyvoicePython) return CFG.cosyvoicePython;
  if (engine !== 'cosyvoice' && CFG.ttsPython) return CFG.ttsPython;
  return 'python';
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    // ⚠ t0 必须在发请求之前取。第一版写在响应回调里，于是"耗时"量的是
    // "首字节到收完"（恒为 0~2ms），而真正的合成时间全被吞掉了 —— RTF 全 0，
    // 看着像"极快"，实际上是量错了对象。RTF 是本次测量的核心指标，不能再错。
    const t0 = Date.now();
    const req = http.get(url, { timeout: timeoutMs || 600000 }, (res) => {
      let ttfb = 0;
      const chunks = [];
      res.on('data', (c) => { if (!ttfb) ttfb = Date.now() - t0; chunks.push(c); });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, ttfb, total: Date.now() - t0, buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, err: e.message, ttfb: 0, total: Date.now() - t0, buf: Buffer.alloc(0) }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, err: 'timeout', ttfb: 0, total: Date.now() - t0, buf: Buffer.alloc(0) }); });
  });
}

// 从 WAV 头读音频时长（RIFF chunk 遍历，别硬编码偏移）
function wavInfo(buf) {
  if (buf.length < 44 || buf.slice(0, 4).toString() !== 'RIFF') return { sec: 0, sr: 0, bits: 0, ch: 0 };
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString('latin1');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const ch = buf.readUInt16LE(off + 10), sr = buf.readUInt32LE(off + 12), bits = buf.readUInt16LE(off + 22);
      var srV = sr, chV = ch, bitsV = bits;
    }
    if (id === 'data') {
      const bytes = Math.min(size, buf.length - off - 8);
      const sec = bytes / (srV * chV * (bitsV / 8));
      return { sec: sec, sr: srV, bits: bitsV, ch: chV, bytes: bytes };
    }
    off += 8 + size + (size % 2);
  }
  return { sec: 0, sr: 0, bits: 0, ch: 0 };
}

async function benchEngine(engine) {
  const py = pythonFor(engine);
  const logPath = path.join(OUT_DIR, engine + '.sidecar.log');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logFd = fs.openSync(logPath, 'w');
  const gpuBefore = gpu();

  const t0 = Date.now();
  const child = spawn(py, ['tts_server.py', '--port', String(PORT), '--engine', engine],
    { cwd: path.join(PROJ, 'tts'), env: sidecarEnv(), windowsHide: true, stdio: ['ignore', logFd, logFd] });
  console.log('\n================ ' + engine + ' ================');
  console.log('  python   : ' + py);
  console.log('  GPU 起   : ' + gpuBefore);

  const rec = { engine: engine, python: py, gpuBefore: gpuBefore, coldStartMs: -1, health: null, runs: [], errors: [] };

  // 等端口起来（模型还没加载，加载发生在第一次合成）
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const h = await httpGet('http://127.0.0.1:' + PORT + '/health', 2500);
    if (h.ok) {
      up = true;
      try { rec.health = JSON.parse(h.buf.toString('utf8')); } catch (e) {}
      rec.portReadyMs = Date.now() - t0;
      console.log('  端口就绪 : ' + rec.portReadyMs + ' ms  (active=' + (rec.health && rec.health.engine) + ')');
      break;
    }
    if (child.exitCode !== null) break;
  }
  if (!up) {
    rec.errors.push('侧车没能起来（见 ' + path.basename(logPath) + '）');
    try { child.kill(); } catch (e) {}
    return rec;
  }
  // 引擎可用性：/health 里 engines[] 会标 available
  const info = (rec.health && rec.health.engines || []).filter((e) => e.name === engine)[0];
  rec.available = info ? !!info.available : null;
  if (info) console.log('  引擎状态 : ' + (info.available ? '可用' : '不可用') + (info.detail ? '  ' + String(info.detail).slice(0, 120) : ''));

  // 逐句测量
  const shotsDir = path.join(OUT_DIR, engine);
  fs.mkdirSync(shotsDir, { recursive: true });
  for (const s of SENTENCES) {
    for (let n = 1; n <= REPEAT; n++) {
      const q = 'http://127.0.0.1:' + PORT + '/tts?text=' + encodeURIComponent(s.text) + '&engine=' + engine + (n === 1 ? '&emo=neutral' : '');
      const r = await httpGet(q, 900000);
      const info2 = wavInfo(r.buf);
      const row = {
        sentence: s.id, kind: s.kind, chars: s.text.length, run: n,
        ok: r.ok, status: r.status, err: r.err || '',
        ms: r.total, audioSec: Number(info2.sec.toFixed(3)),
        rtf: info2.sec > 0 ? Number((r.total / 1000 / info2.sec).toFixed(3)) : null,
        bytes: r.buf.length
      };
      if (s.id === 'S1' && n === 1) rec.coldStartMs = Date.now() - t0;   // 第一次合成含模型加载
      if (!r.ok && r.buf.length && r.buf.length < 2000) {
        try { row.errBody = r.buf.toString('utf8').slice(0, 300); } catch (e) {}
      }
      if (r.ok && info2.sec > 0) {
        fs.writeFileSync(path.join(shotsDir, s.id + '_run' + n + '.wav'), r.buf);
      }
      rec.runs.push(row);
      console.log('  ' + s.id + ' run' + n + '  ' + (r.ok ? 'ok ' : 'FAIL') +
        '  耗时 ' + String(r.total).padStart(7) + ' ms   音频 ' + String(info2.sec.toFixed(2)).padStart(6) + ' s   RTF ' +
        (row.rtf === null ? '  -  ' : String(row.rtf).padStart(5)) + (row.err ? '   ' + row.err : '') +
        (row.errBody ? '   body=' + row.errBody.slice(0, 120) : ''));
    }
  }
  rec.gpuAfter = gpu();
  // 侧车日志里有引擎自己报的合成耗时（CosyVoice 会打 "yield speech len X, rtf Y"），
  // 拿它当独立交叉核对：条数 = 候选次数，能看出多候选循环跑了几轮。
  try {
    const lg = fs.readFileSync(logPath, 'utf8');
    rec.sidecarRtf = (lg.match(/yield speech len ([0-9.]+), rtf ([0-9.]+)/g) || []).map((m) => {
      const g = /yield speech len ([0-9.]+), rtf ([0-9.]+)/.exec(m);
      return { sec: Number(g[1]), rtf: Number(g[2]) };
    });
    console.log('  引擎自报 : ' + rec.sidecarRtf.length + ' 次候选合成，RTF=' +
      rec.sidecarRtf.map((x) => x.rtf.toFixed(2)).join(', ') + '（音频 ' +
      rec.sidecarRtf.map((x) => x.sec.toFixed(1)).join(', ') + ' s）');
  } catch (e) {}
  console.log('  GPU 末   : ' + rec.gpuAfter);
  try { fs.closeSync(logFd); } catch (e) {}
  try { child.kill(); } catch (e) {}
  await sleep(4000);   // 等它把显存还回去，再测下一个引擎
  return rec;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const arg = (process.argv[2] || 'all').toLowerCase();
  const want = arg === 'all' ? ['cosyvoice', 'indextts', 'sapi'] : [arg];
  const all = [];
  console.log('M0 语音引擎测量开始  ' + new Date().toISOString());
  console.log('GPU（起始）: ' + gpu());
  for (const e of want) {
    try { all.push(await benchEngine(e)); }
    catch (err) { all.push({ engine: e, errors: ['测量异常：' + (err && err.message || err)] }); }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'bench-raw.json'), JSON.stringify(all, null, 2), 'utf8');
  console.log('\n原始结果 → tools/bench-tts/results/bench-raw.json');
  console.log('下一步：python tools/bench-tts/analyze.py   （算音色稳定性）');
})();
