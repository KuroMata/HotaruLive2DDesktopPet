'use strict';
// sim-audiomouth.js —— 音频驱动口型回归验证（不依赖浏览器）
// 验证 live2d-loader 的 _mouth 在 TTS 播放期间的行为：
//   播放中  -> 字指针跟随 __ttsProgress、开合跟随 __ttsRms（不再走文本节奏）
//   未播放  -> 回到文本驱动（忽略 __ttsProgress）
//   onAudioEnded -> 结束台词并闭口
const path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'app', 'js', 'live2d-loader.js'));
const Ctl = global.window.Live2DController;
if (typeof Ctl !== 'function') { console.error('FAIL: Live2DController 未导出'); process.exit(1); }

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
  return c;
}
function talk(text, charDur) {
  return { active: true, mode: 'idle', text: text, i: 0, t: 0, charDur: charDur || 140,
           peak: 0.8, vowels: null, emo: null, emoList: null };
}

console.log('[1] 播放中：指针随进度、开合随响度');
{
  const c = mk();
  c._talk = talk('ABCDEFGHIJ');           // 10 字
  global.window.__ttsPlaying = true;
  global.window.__ttsProgress = 0.5;
  global.window.__ttsRms = 0.25;
  for (let i = 0; i < 60; i++) c._mouth(16);
  ok('进度 0.5 -> 字指针 = 5', c._talk.i === 5, c._talk.i);
  ok('响度驱动开合 > 0.2', c._store['ParamMouthOpenY'] > 0.2, c._store['ParamMouthOpenY']);
  global.window.__ttsRms = 0;
  for (let i = 0; i < 200; i++) c._mouth(16);
  ok('响度归零 -> 闭口 < 0.05', c._store['ParamMouthOpenY'] < 0.05, c._store['ParamMouthOpenY']);
  global.window.__ttsProgress = 0.95;
  for (let i = 0; i < 20; i++) c._mouth(16);
  ok('进度 0.95 -> 字指针 = 9', c._talk.i === 9, c._talk.i);
}

console.log('[2] 未播放：回到文本驱动（忽略进度）');
{
  const c = mk();
  c._talk = talk('ABCDEFGHIJ', 400);      // 慢节奏，5 帧远不足以推进
  global.window.__ttsPlaying = false;
  global.window.__ttsProgress = 0.9;      // 若误用进度，指针会跳到 9
  for (let i = 0; i < 5; i++) c._mouth(16);
  ok('文本驱动下指针仍为 0（未误用进度）', c._talk.i === 0, c._talk.i);
}

console.log('[3] onAudioEnded 结束台词并闭口');
{
  const c = mk();
  c._talk = talk('ABCDE');
  c._talk.i = 2;
  c._idleEnabled = false;                 // 不排下一条，避免定时器
  global.window.__ttsPlaying = true;
  c._store['ParamMouthOpenY'] = 0.8;
  c.onAudioEnded();
  ok('台词已关闭', c._talk.active === false, c._talk.active);
  ok('已闭口', Math.abs(c._store['ParamMouthOpenY'] || 0) < 0.001, c._store['ParamMouthOpenY']);
  ok('音频开合状态已复位', c._audioOpen === 0, c._audioOpen);
}

console.log('[4] 无 __tts* 全局量时不报错（纯文本路径）');
{
  const c = mk();
  c._talk = talk('ABC', 100);
  delete global.window.__ttsPlaying;
  delete global.window.__ttsProgress;
  delete global.window.__ttsRms;
  let threw = false;
  try { for (let i = 0; i < 10; i++) c._mouth(16); } catch (e) { threw = true; }
  ok('不抛异常', !threw);
}

console.log('[5] 一热归零：无声音时所有元音参数归零');
{
  const c = mk();
  c._visemeMode = true;
  c._vowelParam = { a: 'ParamA', i: 'ParamI', u: 'ParamU', e: 'ParamE', o: 'ParamO' };
  c._talk = talk('ABCDE');
  c._talk.vowels = ['a', 'i', 'u', 'e', 'o'];
  global.window.__ttsPlaying = true;
  global.window.__ttsProgress = 0;
  global.window.__ttsRms = 0.3;
  for (let i = 0; i < 60; i++) c._mouth(16);
  ok('当前元音 a 非零', c._store['ParamA'] > 0.1, c._store['ParamA']);
  ok('其余元音同帧为 0（一热）', (c._store['ParamI'] || 0) === 0 && (c._store['ParamU'] || 0) === 0,
    [c._store['ParamI'], c._store['ParamU']]);
  global.window.__ttsRms = 0;                    // 无声音
  for (let i = 0; i < 300; i++) c._mouth(16);
  const ids = ['ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO'];
  ok('静音 300 帧后所有元音归零', ids.every((id) => (c._store[id] || 0) < 0.02), ids.map((id) => c._store[id]));
  global.window.__ttsRms = 0.3;                  // 有声，但指针落在标点（vowel=null）
  c._talk.vowels = ['a', null, null, null, null];
  global.window.__ttsProgress = 0.3;             // idx=1 -> vowel=null
  for (let i = 0; i < 60; i++) c._mouth(16);
  ok('标点处(元音 null)所有元音归零', ids.every((id) => (c._store[id] || 0) < 0.02), ids.map((id) => c._store[id]));
}

console.log('');
console.log(fail === 0 ? ('AUDIO_MOUTH_OK  (pass=' + pass + ')') : ('FAILED  (pass=' + pass + ' fail=' + fail + ')'));
process.exit(fail === 0 ? 0 : 1);
