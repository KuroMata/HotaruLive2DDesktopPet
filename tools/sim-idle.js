// 临时仿真：验证待机台词引擎（不依赖 Electron / 模型）
global.window = { addEventListener: () => {} };
global.document = { addEventListener: () => {} };
let simNow = 0;
global.performance = { now: () => simNow };
const fs = require('fs');
const OUT = 'D:/live2d-companion/tools/_simresult.txt';
function log(...a) { fs.appendFileSync(OUT, a.join(' ') + '\n'); }
fs.writeFileSync(OUT, '');
try {
  eval(fs.readFileSync('D:/live2d-companion/app/js/live2d-loader.js', 'utf8'));
} catch (e) {
  fs.appendFileSync(OUT, 'EVAL_ERROR: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(2);
}

const c = new window.Live2DController();
let bad = null, maxV = 0, minV = 1;
c._setParam = (id, v) => {
  if (typeof v !== 'number' || !isFinite(v)) bad = id + '=' + v;
  if (id === 'ParamMouthOpenY') { maxV = Math.max(maxV, v); minV = Math.min(minV, v); }
};
c._core = () => null;
c.idle = true;

// 1) 时间过滤
c._idlePool = [{ time: 'day', text: 'A' }, { time: 'night', text: 'B' }, { time: 'any', text: 'C' }];
const realGetHours = Date.prototype.getHours;
Date.prototype.getHours = () => 12;
log('白天候选应只含 A/C ->', c._pickIdleLine());
Date.prototype.getHours = () => 2;
log('夜间候选应只含 B/C ->', c._pickIdleLine());
Date.prototype.getHours = realGetHours;

// 2) 口型引擎：含标点、中英混合
c._talk = { active: true, mode: 'idle', text: '你好呀，今天开心吗？我在哦。Hi~', i: 0, t: 0, charDur: c._randCharDur(), peak: c._randPeak() };
const dt = 16; let frames = 0;
while (c._talk.active && frames < 8000) {
  simNow += dt; c._mouth(dt); frames++;
  if (bad) throw new Error('NaN/Inf ' + bad);
}
log('台词播完 frames=', frames, '（约', (frames * dt / 1000).toFixed(1), 's）');
log('口型开合 max=', maxV.toFixed(3), 'min=', minV.toFixed(3));
if (maxV > 1.001 || minV < -0.001) throw new Error('口型超出 [0,1]');

// 3) chat 口型路径不报错
c.setSpeaking(true);
for (let i = 0; i < 30; i++) { simNow += dt; c._mouth(dt); if (bad) throw new Error('chat NaN ' + bad); }
c.setSpeaking(false);

log('OK', bad || 'noNaN');
