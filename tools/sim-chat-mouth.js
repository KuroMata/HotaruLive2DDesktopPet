'use strict';
// sim-chat-mouth.js —— 聊天回复「口型同步」回归验证（不依赖浏览器，require 真实 live2d-loader.js）
//
// 复现并锁定用户报的 bug：
//   * 延迟冒泡后，聊天回复此前走 mode='chat'（文本口型），永远进不了 _mouth 的音频分支，
//     于是「TTS 语音播放时嘴反而不动」；而思考期 _chatText 为空却回落到正弦 → 嘴在空转。
// 本次改动：思考期闭嘴；TTS 就绪由渲染端调 startAudioChat() 走音频驱动分支。
//
// 与 sim-audiomouth.js 的区别：那个测的是 _mouth 本身的音频/文本分支；
// 这个测「聊天路径能否正确进入该分支」（startAudioChat / speakTextChat / 空文本闭嘴）。
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
  c._driveOpenY = true;
  return c;
}
// 聊天进行中（未开语音延迟前的状态）：mode='chat'、active、文本尚未喂入
function chatTalk() {
  return { active: true, mode: 'chat', text: '', i: 0, t: 0, charDur: 140, peak: 0.8,
           vowels: null, emo: null, emoList: null };
}
const drive = (c, n, dt) => { for (let i = 0; i < n; i++) c._mouth(dt || 16); };

console.log('[1] 思考期（chat 模式、无文本、未播放）：嘴唇应闭合，不空转');
{
  const c = mk();
  c._talk = chatTalk();
  c._chatText = '';
  global.window.__ttsPlaying = false;
  global.window.__ttsProgress = 0;
  global.window.__ttsRms = 0;
  let maxOpen = 0;
  for (let i = 0; i < 120; i++) { c._mouth(16); maxOpen = Math.max(maxOpen, c._store['ParamMouthOpenY'] || 0); }
  ok('120 帧内 OpenY 全程 < 0.05（不再正弦空转）', maxOpen < 0.05, maxOpen);
}

console.log('[2] startAudioChat：把聊天台词切到音频驱动分支（mode=idle）');
{
  const c = mk();
  c._talk = chatTalk();                 // 模拟思考态遗留的 chat talk
  c._chatText = '';
  c.startAudioChat('ABCDEFGHIJ', 'neutral');
  ok('mode 切为 idle', c._talk.mode === 'idle', c._talk.mode);
  ok('talk 保持 active', c._talk.active === true, c._talk.active);
  ok('text 为整句', c._talk.text === 'ABCDEFGHIJ', c._talk.text);
  ok('指针复位 0', c._talk.i === 0, c._talk.i);
}

console.log('[3] 音频播放中：开合随 __ttsRms、指针随 __ttsProgress');
{
  const c = mk();
  c.startAudioChat('ABCDEFGHIJ', 'neutral');   // 10 字
  global.window.__ttsPlaying = true;
  global.window.__ttsProgress = 0.5;
  global.window.__ttsRms = 0.25;
  drive(c, 60);
  ok('响度 0.25 -> OpenY > 0.2（嘴张开）', (c._store['ParamMouthOpenY'] || 0) > 0.2, c._store['ParamMouthOpenY']);
  ok('进度 0.5 -> 字指针 = 5', c._talk.i === 5, c._talk.i);
  global.window.__ttsRms = 0;
  drive(c, 200);
  ok('响度归零 -> 闭口 < 0.05', (c._store['ParamMouthOpenY'] || 0) < 0.05, c._store['ParamMouthOpenY']);
}

console.log('[4] 元音驱动：静音/标点处元音一热归零');
{
  const c = mk();
  c._visemeMode = true;
  c._vowelParam = { a: 'ParamA', i: 'ParamI', u: 'ParamU', e: 'ParamE', o: 'ParamO' };
  c.startAudioChat('ABCDEFGHIJ', 'neutral');
  c._talk.vowels = ['a', 'i', 'u', 'e', 'o', 'a', 'i', 'u', 'e', 'o'];
  global.window.__ttsPlaying = true;
  global.window.__ttsProgress = 0;
  global.window.__ttsRms = 0.3;
  drive(c, 60);
  ok('当前元音 a 非零', (c._store['ParamA'] || 0) > 0.1, c._store['ParamA']);
  ok('其余元音同帧为 0（一热）',
    (c._store['ParamI'] || 0) === 0 && (c._store['ParamU'] || 0) === 0,
    [c._store['ParamI'], c._store['ParamU']]);
}

console.log('[5] 未开语音 speakTextChat：mode=idle，文本驱动逐字开合（不依赖音频）');
{
  const c = mk();
  c._talk = chatTalk();
  c.speakTextChat('ABCDEFGHIJ', 'neutral');
  ok('mode 切为 idle', c._talk.mode === 'idle', c._talk.mode);
  ok('talk active', c._talk.active === true, c._talk.active);
  global.window.__ttsPlaying = false;
  global.window.__ttsProgress = 0.9;          // 若误用进度，指针会跳到 9
  drive(c, 5, 16);
  ok('文本驱动下指针仍为 0（未误用进度）', c._talk.i === 0, c._talk.i);
  let maxOpen = 0;
  for (let i = 0; i < 40; i++) { c._mouth(16); maxOpen = Math.max(maxOpen, c._store['ParamMouthOpenY'] || 0); }
  ok('文本驱动确实张开过（OpenY>0.05）', maxOpen > 0.05, maxOpen);
}

console.log('[6] onAudioEnded：音频播完闭口并结束台词');
{
  const c = mk();
  c._idleEnabled = false;
  c.startAudioChat('ABCDE', 'neutral');
  global.window.__ttsPlaying = true;
  global.window.__ttsProgress = 0.3;
  global.window.__ttsRms = 0.3;
  drive(c, 60);
  ok('播放中已张嘴', (c._store['ParamMouthOpenY'] || 0) > 0.1, c._store['ParamMouthOpenY']);
  global.window.__ttsPlaying = false;
  c.onAudioEnded();
  ok('台词已结束', c._talk.active === false, c._talk.active);
  ok('已闭口', Math.abs(c._store['ParamMouthOpenY'] || 0) < 0.001, c._store['ParamMouthOpenY']);
  ok('音频开合状态复位', c._audioOpen === 0, c._audioOpen);
}

console.log('');
console.log(fail === 0 ? ('CHAT_MOUTH_OK  (pass=' + pass + ')') : ('FAILED  (pass=' + pass + ' fail=' + fail + ')'));
process.exit(fail === 0 ? 0 : 1);
