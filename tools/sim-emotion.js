// sim-emotion.js —— 情绪/表情层仿真验证（不依赖浏览器）
// 做法：给 global.window 一个空壳载入 live2d-loader.js（文件末尾会把 Live2DController 挂到 window），
// 然后实例化控制器、替换 _setParam 为内存记录，逐帧调用 _express 验证：
//   分句情绪映射、指针取情绪、缓动收敛、单句内情绪实时切换、脸红可选参数探测、总开关、回中性。
'use strict';
const path = require('path');
const fs = require('fs');

global.window = {};
require(path.join(__dirname, '..', 'app', 'js', 'live2d-loader.js'));
const Ctl = global.window.Live2DController;
if (typeof Ctl !== 'function') { console.error('FAIL: Live2DController 未导出'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ('  -> ' + JSON.stringify(extra)) : '')); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-3 : eps); }

function mk() {
  const c = new Ctl();
  c._store = {};
  c._setParam = function (id, v) { this._store[id] = v; };
  c._paramSet = new Set([]);
  return c;
}
function run(c, frames, dt) {
  for (let i = 0; i < frames; i++) c._express(dt === undefined ? 16 : dt);
}

console.log('[1] 整句情绪（字符串）');
{
  const c = mk();
  const list = c._buildEmoList('你好呀前辈。', 'joy');
  ok('字符串 -> 单段且 end=长度', list && list.length === 1 && list[0].end === 6 && list[0].e === 'joy', list);
  ok('未知情绪名 -> null', c._buildEmoList('x', 'not_exist') === null);
}

console.log('[2] 分句情绪（数组，按标点切分）');
{
  const c = mk();
  const t = '前辈，今天好困，但是我要工作，真的。';
  const list = c._buildEmoList(t, ['sleepy', 'focus', 'serious']);
  // 标点共 4 个（三逗号 + 句号）-> 4 段；数组只给 3 个，末段复用最后一个
  ok('切出 4 段', list && list.length === 4, list);
  ok('逐段情绪 1:1（末段复用）',
    list[0].e === 'sleepy' && list[1].e === 'focus' && list[2].e === 'serious' && list[3].e === 'serious', list);
  ok('末段 end=长度', list[list.length - 1].end === t.length, list);
  const c2 = mk();
  const list2 = c2._buildEmoList('一，二，三，四。', ['a_bad_emo', 'joy']); // 首段情绪名非法被丢弃，其余复用 joy
  ok('非法情绪段被跳过', list2.length === 3 && list2[0].e === 'joy' && list2[0].end === 4, list2);
}

console.log('[3] _emoAt 按字指针取情绪');
{
  const c = mk();
  const tk = { emoList: [{ end: 4, e: 'sleepy' }, { end: 8, e: 'joy' }], emo: null };
  ok('i=0 -> sleepy', c._emoAt(tk, 0) === 'sleepy');
  ok('i=3 -> sleepy', c._emoAt(tk, 3) === 'sleepy');
  ok('i=4 -> joy', c._emoAt(tk, 4) === 'joy');
  ok('i=99 -> 末段 joy', c._emoAt(tk, 99) === 'joy');
  ok('无表回落到 tk.emo', c._emoAt({ emoList: null, emo: 'tease' }, 0) === 'tease');
  ok('都无 -> neutral', c._emoAt({ emoList: null, emo: null }, 0) === 'neutral');
}

console.log('[4] 缓动收敛（joy）');
{
  const c = mk();
  c._talk = { active: true, mode: 'idle', i: 0, emoList: [{ end: 99, e: 'joy' }], emo: null };
  run(c, 200);
  ok('ParamEyeSquintL ≈ 0.85', near(c._store['ParamEyeSquintL'], 0.85, 0.02), c._store['ParamEyeSquintL']);
  ok('ParamBrowLY ≈ 0.55', near(c._store['ParamBrowLY'], 0.55, 0.02), c._store['ParamBrowLY']);
  ok('ParamMouthForm ≈ 0.85', near(c._store['ParamMouthForm'] === undefined ? c._emoCur.mouthForm : c._store['ParamMouthForm'], 0.85, 0.05));
  ok('ParamEyeLOpen ≈ 0.80 (=1×eyeOpen)', near(c._store['ParamEyeLOpen'], 0.80, 0.02), c._store['ParamEyeLOpen']);
}

console.log('[5] 单击内实时换情绪（sleepy -> joy）');
{
  const c = mk();
  c._talk = { active: true, mode: 'idle', i: 0, emoList: [{ end: 4, e: 'sleepy' }, { end: 8, e: 'joy' }], emo: null };
  run(c, 150);
  const eyeSleepy = c._store['ParamEyeLOpen'];
  const squintSleepy = c._store['ParamEyeSquintL'];
  c._talk.i = 6;             // 指针进入第二句
  run(c, 150);
  const eyeJoy = c._store['ParamEyeLOpen'];
  const squintJoy = c._store['ParamEyeSquintL'];
  ok('犯困时眼开合更低 (<0.5)', eyeSleepy < 0.5, eyeSleepy);
  ok('转开心后眼开合回升 (>0.7)', eyeJoy > 0.7, eyeJoy);
  ok('转开心后眯眼变高 (>0.5)', squintJoy > 0.5, squintJoy);
  ok('两句表情确实不同', Math.abs(eyeJoy - eyeSleepy) > 0.3 && Math.abs(squintJoy - squintSleepy) > 0.3);
}

console.log('[6] 脸红可选参数探测');
{
  const c = mk();
  c._paramSet = new Set(['ParamCheek']);
  c._talk = { active: true, mode: 'idle', i: 0, emo: 'shy', emoList: null };
  run(c, 200);
  ok('有 ParamCheek 时写入脸红 >0', c._store['ParamCheek'] > 0.5, c._store['ParamCheek']);
  const c2 = mk();
  c2._paramSet = new Set(['ParamEyeLOpen']);   // 无脸红参数
  c2._talk = { active: true, mode: 'idle', i: 0, emo: 'shy', emoList: null };
  run(c2, 200);
  ok('无脸红参数则跳过（不写 ParamCheek）', c2._store['ParamCheek'] === undefined);
}

console.log('[7] 总开关关闭时不写五官参数');
{
  const c = mk();
  c._emotionEnabled = false;
  c._talk = { active: true, mode: 'idle', i: 0, emo: 'joy', emoList: null };
  run(c, 60);
  ok('关闭时不写 ParamEyeLOpen', c._store['ParamEyeLOpen'] === undefined);
  ok('旋钮仍缓动（内部状态更新）', c._emoCur.eyeSquint > 0.1, c._emoCur.eyeSquint);
}

console.log('[8] 不说话时回到 neutral');
{
  const c = mk();
  c._talk = { active: true, mode: 'idle', i: 0, emo: 'joy', emoList: null };
  run(c, 200);
  c._talk = { active: false, mode: 'idle', i: 0, emoList: null, emo: null };
  c._emoLinger = ''; c._emoLingerUntil = 0;
  run(c, 400);
  ok('眯眼回落到 ~0', c._emoCur.eyeSquint < 0.02, c._emoCur.eyeSquint);
  ok('眉高回落到 ~0', Math.abs(c._emoCur.browY) < 0.02, c._emoCur.browY);
  ok('眼开合回落到 ~1', near(c._store['ParamEyeLOpen'], 1, 0.03), c._store['ParamEyeLOpen']);
}

console.log('[9] 台词数据文件校验');
{
  const idle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'data', 'idle-lines.json'), 'utf8'));
  const click = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'data', 'click-lines.json'), 'utf8'));
  ok('idle 共 30 条', idle.length === 30, idle.length);
  ok('click 共 30 条', click.length === 30, click.length);
  const day = idle.filter((x) => x.time === 'day').length;
  const night = idle.filter((x) => x.time === 'night').length;
  const any = idle.filter((x) => x.time === 'any').length;
  ok('idle 时段：day5/night5/any20', day === 5 && night === 5 && any === 20, { day, night, any });
  const valid = new Set(['neutral','focus','curious','joy','sleepy','affection','shy','tease','serious','surprise','pout','smug']);
  let badEmo = 0, missingEmo = 0, longIdle = 0, longClick = 0;
  // "约三个逗号长"：只数逗号（含顿号/分号/冒号），句号不计
  const longEnough = (t) => (t.match(/[，、；：]/g) || []).length >= 3;
  for (const it of idle) {
    if (!it.emo) missingEmo++;
    for (const e of (Array.isArray(it.emo) ? it.emo : [it.emo])) if (!valid.has(e)) badEmo++;
    if (longEnough(it.text)) longIdle++;
  }
  for (const it of click) {
    if (!it.emo) missingEmo++;
    for (const e of (Array.isArray(it.emo) ? it.emo : [it.emo])) if (!valid.has(e)) badEmo++;
    if (longEnough(it.text)) longClick++;
  }
  ok('全部台词都有情绪标签', missingEmo === 0, missingEmo);
  ok('情绪标签均为预设内合法值', badEmo === 0, badEmo);
  ok('idle 大部分为长台词(≥3 逗号, ≥20 条)', longIdle >= 20, longIdle);
  ok('click 大部分为长台词(≥3 逗号, ≥20 条)', longClick >= 20, longClick);
}

console.log('');
console.log(fail === 0 ? ('ALL_OK  (pass=' + pass + ')') : ('FAILED  (pass=' + pass + ' fail=' + fail + ')'));
process.exit(fail === 0 ? 0 : 1);
