// sim-music-debug.js —— 音律识别调试链路自检
//
// 两件事：
//  A) 把 app/js/music-tracker.js **真跑起来**（虚拟时钟 + 桩化 AudioContext/analyser/desktopPet），
//     喂一段"每 600ms 一次鼓点"的合成频谱，验证：只开调试窗才上报、快照字段齐全、
//     起音计数随鼓点增长、限流生效、关窗后停报。
//  B) 复刻 live2d-loader._musicTick 的**旧公式 / 新公式**，用不同密度的起音序列跑一遍，
//     量化"偶尔抽动"与"连贯晃动"的差别（本次修复的核心主张，用数字说话）。
//
// 注意（踩坑）：startCapture 是 async，真正的采集循环注册发生在 await 之后。
// 因此虚拟时钟每推进一步都必须让微任务排空（await setImmediate），
// 否则整个测试体跑在"第一个 await 之前"，定时器根本没注册、一帧都不会跑。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, got, want, tol) {
  const ok = (tol == null) ? (got === want) : (Math.abs(got - want) <= tol);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  ->  ' + got + (ok ? '' : '   期望 ' + want));
}
function ok(name, cond, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra == null ? '' : '  ->  ' + extra));
}

// ===========================================================================
// A) 真跑 music-tracker（虚拟时钟）
// ===========================================================================
let vnow = 0;
const EPOCH = 1760000000000;
const RealDate = Date;
function VDate(...a) { return a.length ? new RealDate(...a) : new RealDate(vnow + EPOCH); }
VDate.now = () => vnow + EPOCH;
VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC; VDate.prototype = RealDate.prototype;

const timers = [];
function vSetInterval(fn, ms) { const t = { fn, ms, next: vnow + ms }; timers.push(t); return t; }
function vSetTimeout(fn, ms) { const t = { fn, ms, next: vnow + ms, once: true }; timers.push(t); return t; }
function vClear(t) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }

async function advanceTo(target) {
  while (vnow < target) {
    vnow = Math.min(target, vnow + 10);
    for (let i = timers.length - 1; i >= 0; i--) {
      const t = timers[i];
      if (t.next > vnow) continue;
      if (t.once) timers.splice(i, 1); else t.next += t.ms;
      try { t.fn(); } catch (e) { console.log('  定时器回调抛错：' + e.message); }
    }
    await new Promise((r) => setImmediate(r));   // 排空微任务：让 startCapture 的后续步骤真正执行
  }
}

const sent = [];
const analyserStub = {
  fftSize: 1024,
  smoothingTimeConstant: 0.6,
  frequencyBinCount: 512,
  // 合成频谱：低频段有"鼓点"包络（每 600ms 一次、持续 80ms 的脉冲），其余频段有稳定底噪
  getByteFrequencyData(arr) {
    const hit = (vnow % 600) < 80 ? 1 : 0;
    for (let i = 0; i < arr.length; i++) {
      const base = 40 + (i % 7) * 3;
      arr[i] = i < 179 ? Math.min(255, base + hit * 90) : base;
    }
  }
};
const fakeStream = {
  getTracks: () => [{ stop() {} }],
  getVideoTracks: () => [{ stop() {} }],
  getAudioTracks: () => [{ stop() {} }]
};
function FakeAudioContext() {
  this.state = 'running';
  this.resume = async () => {};
  this.close = async () => {};
  this.createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
  this.createAnalyser = () => analyserStub;
}

const win = {
  __companionConfig: { music: { enabled: true, audioSource: 'loopback', eyeClose: 0.8, nodStrength: 1, swayStrength: 1, sensitivity: 1.3, enableA: true, enableB: false, aSpeed: 50 } },
  desktopPet: {
    send: (ch, d) => { sent.push({ ch, d, at: vnow }); },
    log: () => {},
    getScreenSources: async () => [{ id: 'screen:0:0', name: '显示器 1' }]
  },
  AudioContext: FakeAudioContext
};
const ctx = {
  window: win,
  performance: { now: () => vnow },
  Date: VDate,
  setInterval: vSetInterval, clearInterval: vClear,
  setTimeout: vSetTimeout, clearTimeout: vClear,
  navigator: { mediaDevices: { getUserMedia: async () => fakeStream } },
  console, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error, isFinite,
  Uint8Array, Float32Array, Int32Array
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'app/js/music-tracker.js'), 'utf8'), ctx, { filename: 'music-tracker.js' });

// ===========================================================================
// B) 旧公式 vs 新公式（纯数学，与源码逐字对应）
// ===========================================================================
const DECAY = 0.90, AMP = 0.8;   // amp = level，取"歌正响"的典型值
// 复刻 _musicTick 里身体侧摆的两套写法：
//   旧： nodSway × sway × 4.0 × amp              （只有每拍一次性，拍与拍之间为 0）
//   新： swing × sway × 4.0 × amp + nodSway × sway × 1.5 × amp
// 起音序列用"每 onsetPeriod 一次"，nodDurMs = clamp(period×0.85, 220, 760) 与源码同式。
function run(elapsedMs, onsetPeriod, isNew, sway) {
  const rows = [];
  let phase = 0, nodActive = false, nodStart = -1e9, prev = 0;
  const nodDur = Math.max(220, Math.min(760, onsetPeriod * 0.85));
  for (let t = 0; t <= elapsedMs; t += 16) {
    if (t > 0 && t % onsetPeriod === 0 && !nodActive) {
      nodActive = true; nodStart = t;
      const d = 0.25 - phase; phase += (d - Math.round(d)) * 0.35;   // shortestTo(0.25-phase)×0.35
    }
    if (prev) phase += ((t - prev) / 1000) * (50 / 60);              // A 方案 aSpeed=50
    phase -= Math.floor(phase);
    prev = t;
    let nsway = 0;
    if (nodActive) {
      const u = (t - nodStart) / nodDur;
      if (u >= 1) nodActive = false; else nsway = Math.sin(2 * Math.PI * u);
    }
    const swing = Math.sin(2 * Math.PI * phase);
    const body = isNew
      ? (swing * sway * 4.0 * AMP) + (nsway * sway * 1.5 * AMP)
      : (nsway * sway * 4.0 * AMP);
    rows.push(body);
  }
  return rows;
}
function stats(rows) {
  let mx = 0, sum = 0, still = 0;
  for (const b of rows) { mx = Math.max(mx, Math.abs(b)); sum += b * b; if (Math.abs(b) < 0.15) still++; }
  return { peak: mx, rms: Math.sqrt(sum / rows.length), stillRatio: still / rows.length };
}

// ===========================================================================
async function main() {
  const T = win.MusicTracker.init();
  console.log('--- A. music-tracker 真跑（虚拟时钟）---');
  ok('初始未开启', T.isEnabled() === false && T.isActive() === false);

  await advanceTo(vnow + 500);
  check('未开调试窗时不上报', sent.filter((s) => s.ch === 'pet:musicDebug').length, 0);

  T.setModelProbe(() => ({ angleY: -1.23, bodyZ: 2.34, bob: -1.23, sway: 2.34, eyeBlend: 0.9, eyeVal: 0.2, eyeWritten: true }));
  T.setDebugOpen(true);
  await advanceTo(vnow + 100);
  const afterOpen = sent.filter((s) => s.ch === 'pet:musicDebug');
  ok('开窗后立即拿到一份快照', afterOpen.length >= 1, 'n=' + afterOpen.length);
  const d0 = afterOpen[afterOpen.length - 1].d;
  ok('快照含 model 探针值（实际写入模型的参数）', !!d0.model && d0.model.bodyZ === 2.34);
  ok('快照结构齐全', ['t', 'state', 'cfg', 'raw', 'beat', 'bpm', 'phase', 'nod', 'ext', 'model'].every((k) => k in d0),
    Object.keys(d0).join(','));
  check('cfg.swayStrength 透传', d0.cfg.swayStrength, 1);
  check('cfg.audioSource 透传', d0.cfg.audioSource, 'loopback');

  T.setEnabled(true);
  await advanceTo(vnow + 600);
  ok('采集已启动', T.isActive() === true);
  ok('running 状态已上报', sent.some((s) => s.ch === 'pet:musicDebug' && s.d.state.running === true));

  const t0 = vnow;
  await advanceTo(vnow + 4000);
  const diags = sent.filter((s) => s.ch === 'pet:musicDebug').map((s) => s.d);
  const last = diags[diags.length - 1];
  const elapsed = vnow - t0;
  console.log('  ' + (elapsed / 1000).toFixed(1) + 's 内共上报 ' + diags.length + ' 份快照');
  ok('上报被限流（≈15fps；心跳在追踪器运行时不额外叠加）', diags.length <= Math.ceil(elapsed / 66) + 2,
    'n=' + diags.length + '，上限≈' + (Math.ceil(elapsed / 66) + 2));
  ok('起音计数随鼓点增长（≈每 600ms 一拍 → 4s 内 ≥ 4 次）', last.beat.count >= 4, 'count=' + last.beat.count);
  ok('通量缓冲在累积（BPM 自相关的样本）', last.bpm.fluxLen > 20, 'fluxLen=' + last.bpm.fluxLen);
  ok('实测帧率合理', last.bpm.fps > 20 && last.bpm.fps < 200, 'fps=' + last.bpm.fps.toFixed(1));
  ok('相位在推进（连续律动的来源）', last.phase.phase >= 0 && last.phase.phase <= 1, 'phase=' + last.phase.phase.toFixed(3));
  ok('能量与起音阈值都有值', last.raw.energy > 0 && last.raw.onsetThreshold > 0,
    'energy=' + last.raw.energy.toFixed(1) + ' thr=' + last.raw.onsetThreshold.toFixed(1));
  ok('amp 落在 0..1', last.raw.amp >= 0 && last.raw.amp <= 1, 'amp=' + last.raw.amp.toFixed(3));
  ok('起音间隔被记录', last.beat.lastGapMs > 0, 'gap=' + Math.round(last.beat.lastGapMs) + 'ms');
  ok('相位至少在 4s 内变化过（不是死值）',
    new Set(diags.map((d) => d.phase.phase.toFixed(2))).size > 3,
    '不同相位取值 ' + new Set(diags.map((d) => d.phase.phase.toFixed(2))).size + ' 种');

  // 面板开着但不再采集：心跳应继续供数，让面板能显示"未采集"而不是一片空白
  T.setEnabled(false);
  const beforeIdle = sent.length;
  await advanceTo(vnow + 1000);
  const idleDiags = sent.slice(beforeIdle).filter((s) => s.ch === 'pet:musicDebug').map((s) => s.d);
  ok('停止采集后面板仍有心跳数据（不至于空白）', idleDiags.length >= 3, 'n=' + idleDiags.length);
  ok('心跳数据正确标记为未运行/未开启', idleDiags.every((d) => d.state.running === false),
    '最后一份 running=' + (idleDiags.length ? idleDiags[idleDiags.length - 1].state.running : 'n/a'));

  T.setDebugOpen(false);
  const beforeClose = sent.length;
  await advanceTo(vnow + 1200);
  check('关闭调试窗后停止上报', sent.length - beforeClose, 0);

  console.log('\n--- B. 不同起音密度下，身体侧摆（swayStrength=1.0, amp=0.8）---');
  console.log('  起音间隔   旧公式(只有每拍重音)                     新公式(连续+重音)');
  const densities = [600, 1200, 2500, 4000];
  const oldStill = {}, newStill = {};
  for (const p of densities) {
    const o = stats(run(12000, p, false, 1.0));
    const n = stats(run(12000, p, true, 1.0));
    oldStill[p] = o.stillRatio; newStill[p] = n.stillRatio;
    const colOld = '静帧 ' + (o.stillRatio * 100).toFixed(0) + '%   RMS ' + o.rms.toFixed(2);
    const colNew = '静帧 ' + (n.stillRatio * 100).toFixed(0) + '%   RMS ' + n.rms.toFixed(2);
    console.log('  ' + String(p + 'ms').padEnd(10) + colOld.padEnd(30) + colNew);
  }
  ok('旧公式：起音越稀疏，静止帧越多（6s 间隔时 >85% 时间完全不动）', oldStill[4000] > 0.85,
    (oldStill[4000] * 100).toFixed(0) + '%');
  ok('旧公式：即使 1.2s 一拍，也有显著比例的"完全不动"帧', oldStill[1200] > 0.3,
    (oldStill[1200] * 100).toFixed(0) + '%');
  ok('新公式：任何起音密度下都几乎一直在动（静帧 <5%）',
    densities.every((p) => newStill[p] < 0.05),
    densities.map((p) => p + 'ms:' + (newStill[p] * 100).toFixed(0) + '%').join(' '));
  ok('新公式在稀疏起音下的 RMS 明显高于旧公式（4s 间隔：≥2 倍）',
    stats(run(12000, 4000, true, 1.0)).rms > stats(run(12000, 4000, false, 1.0)).rms * 2,
    'new=' + stats(run(12000, 4000, true, 1.0)).rms.toFixed(2) + ' old=' + stats(run(12000, 4000, false, 1.0)).rms.toFixed(2));
  ok('幅度不会失控（峰值 ≤ 摆幅×(4+1.5)×amp = 4.4）',
    stats(run(12000, 1200, true, 1.0)).peak <= 5.5 * AMP + 1e-6,
    'peak=' + stats(run(12000, 1200, true, 1.0)).peak.toFixed(2));

  console.log('\n--- B2. 身体摆幅系数的影响（新公式，1.2s 一拍）---');
  for (const sw of [0.1, 0.5, 1.0, 2.0]) {
    const s = stats(run(12000, 1200, true, sw));
    console.log('  swayStrength=' + String(sw).padEnd(5) + ' 峰值 ±' + s.peak.toFixed(2) +
      (s.peak < 1 ? '   ← 模型 ParamBodyAngleZ 量级 ±10，肉眼看不见' : ''));
  }
  ok('摆幅 0.1 时峰值 <1（用户当前配置：身体几乎不动）', stats(run(12000, 1200, true, 0.1)).peak < 1,
    'peak=' + stats(run(12000, 1200, true, 0.1)).peak.toFixed(2));
  ok('摆幅调回 1.0 时峰值 ≥2.5（肉眼可见）', stats(run(12000, 1200, true, 1.0)).peak >= 2.5,
    'peak=' + stats(run(12000, 1200, true, 1.0)).peak.toFixed(2));

  console.log('\n--- B3. 快歌不失控（相位顶速 200BPM）---');
  const fast = [];
  { let phase = 0; for (let t = 0; t <= 4000; t += 16) { phase += (16 / 1000) * (200 / 60); phase -= Math.floor(phase); fast.push(Math.sin(2 * Math.PI * phase) * 4.0 * AMP); } }
  const fs2 = stats(fast);
  ok('200BPM 时连续项峰值仍是 4×amp（不会累积放大）', Math.abs(fs2.peak - 4.0 * AMP) < 0.05, 'peak=' + fs2.peak.toFixed(2));
  ok('200BPM 时不会出现静帧（连续项本质是正弦）', fs2.stillRatio < 0.05, (fs2.stillRatio * 100).toFixed(0) + '%');

  console.log('\n合计：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('测试自身异常：' + (e && e.stack || e)); process.exit(2); });
