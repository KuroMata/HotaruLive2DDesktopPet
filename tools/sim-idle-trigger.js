'use strict';
// sim-idle-trigger.js —— 待机台词的「手动触发」与「总开关」回归验证
//   forceIdleLine(): 立即播一条待机台词；说话中不打断
//   setIdleEnabled(): 关闭后停自动随机，但手动触发仍可用
const path = require('path');
const fs = require('fs');

global.window = {};
require(path.join(__dirname, '..', 'app', 'js', 'live2d-loader.js'));
const Ctl = global.window.Live2DController;
if (typeof Ctl !== 'function') { console.error('FAIL: Live2DController 未导出'); process.exit(1); }

const idle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'data', 'idle-lines.json'), 'utf8'));
const texts = new Set(idle.map((x) => x.text));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ('  -> ' + JSON.stringify(extra)) : '')); }
}

function mk() {
  const c = new Ctl();
  c._store = {};
  c._setParam = function (id, v) { this._store[id] = v; };
  c._getParam = function (id) { return this._store[id] || 0; };
  c._paramSet = new Set([]);
  c._vowelParam = { a: '', i: '', u: '', e: '', o: '' };
  c._visemeMode = false;
  c._silenceParam = '';
  c._idlePool = idle;
  return c;
}

console.log('[1] forceIdleLine 立即触发一条待机台词');
{
  const c = mk();
  const r = c.forceIdleLine();
  ok('返回 true', r === true, r);
  ok('进入说话态', c._talk.active === true, c._talk.active);
  ok('文本来自待机池', texts.has(c._talk.text), c._talk.text);
}

console.log('[2] 说话中不打断');
{
  const c = mk();
  c.forceIdleLine();
  const first = c._talk.text;
  const r2 = c.forceIdleLine();
  ok('第二次返回 false', r2 === false, r2);
  ok('文本未被替换', c._talk.text === first);
  c.speaking = true;
  c._talk.active = false;
  ok('chat 说话中也不打断', c.forceIdleLine() === false);
}

console.log('[3] setIdleEnabled 关闭后停自动、但手动仍可用');
{
  const c = mk();
  c._idleEnabled = true;
  c._scheduleIdleLine();
  ok('自动排程已建立', !!c._idleTimer);
  c.setIdleEnabled(false);
  ok('关闭后 _idleEnabled=false', c._idleEnabled === false);
  ok('关闭后清掉了自动计时', !c._idleTimer, c._idleTimer);
  const r = c.forceIdleLine();
  ok('关闭后手动触发仍有效', r === true && c._talk.active === true, r);
  ok('手动触发不会重排自动计时', !c._idleTimer, c._idleTimer);
}

console.log('[4] setIdleEnabled 打开后重新排程');
{
  const c = mk();
  c._idleEnabled = false;
  c.setIdleEnabled(true);
  ok('打开后 _idleEnabled=true', c._idleEnabled === true);
  ok('打开后重新排程', !!c._idleTimer);
}

console.log('');
console.log(fail === 0 ? ('IDLE_TRIGGER_OK  (pass=' + pass + ')') : ('FAILED  (pass=' + pass + ' fail=' + fail + ')'));
process.exit(fail === 0 ? 0 : 1);
