// sim-queue.js —— 台词抽取"无重复"回归验证（不依赖浏览器）
// 验证 live2d-loader.js 的洗牌队列：一个完整周期内每条台词只出现一次，
// 抽空才重建；点击池连续 30 次不重复、且无相邻重复。
'use strict';
const path = require('path');
const fs = require('fs');

global.window = {};
require(path.join(__dirname, '..', 'app', 'js', 'live2d-loader.js'));
const Ctl = global.window.Live2DController;
if (typeof Ctl !== 'function') { console.error('FAIL: Live2DController 未导出'); process.exit(1); }

const idle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'data', 'idle-lines.json'), 'utf8'));
const click = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'data', 'click-lines.json'), 'utf8'));

let fail = 0;
function chk(name, cond, extra) {
  console.log((cond ? '  ok  ' : '  FAIL ') + name + (extra !== undefined && !cond ? ('  -> ' + JSON.stringify(extra)) : ''));
  if (!cond) fail++;
}

// 待机池：按当前时段过滤后，一个完整周期内不应重复
const c = new Ctl();
c._idlePool = idle;
const h = new Date().getHours();
const isNight = (h >= 22 || h < 5);
const eligible = idle.filter((x) => x.time === 'any' || x.time === (isNight ? 'night' : 'day')).length;
const seen = new Set();
for (let i = 0; i < eligible; i++) seen.add(c._pickIdleLine().text);
chk('待机：一个周期内 ' + eligible + ' 条不重复', seen.size === eligible, seen.size);

// 点击池：连续 30 次不重复、无相邻重复
const c2 = new Ctl();
c2._clickPool = click;
const out = [];
c2.playIdleLine = function (t) { out.push(t); };
for (let i = 0; i < 30; i++) c2.sayClick();
let imm = 0;
for (let i = 1; i < out.length; i++) if (out[i] === out[i - 1]) imm++;
chk('点击：30 次抽到 30 条不同', new Set(out).size === 30, new Set(out).size);
chk('点击：无相邻重复', imm === 0, imm);

// 第二轮循环：重新洗牌后仍不重复
const second = [];
c2.playIdleLine = function (t) { second.push(t); };
for (let i = 0; i < 30; i++) c2.sayClick();
chk('点击：第二轮 30 条不重复', new Set(second).size === 30, new Set(second).size);

console.log('');
console.log(fail === 0 ? 'QUEUE_OK' : ('QUEUE_FAILED (fail=' + fail + ')'));
process.exit(fail === 0 ? 0 : 1);
