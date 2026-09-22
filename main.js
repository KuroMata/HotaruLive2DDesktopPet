// live2d-companion — Electron 主进程
// 职责：
//   1) 启动一个本地静态服务器，托管 app/ 与 node_modules/，并把 /models/* 映射到本机模型目录（解决 file:// 跨域）
//   2) 创建透明、置顶、无边框、可拖拽/缩放的桌宠窗口
const http = require('http');
const https = require('https');   // 云端聊天接口可能走 https，代理转发需要
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const electron = require('electron');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen,
        dialog, globalShortcut, shell } = electron;

// 汉字转拼音（元音口型对照用）：在主进程加载，经 ipcMain.handle('pet:pinyin') 暴露给渲染进程。
// 之前的做法是让 preload.js 直接 require('pinyin-pro')，但它在 Electron 渲染子进程里会抛错、
// 导致整段 contextBridge 不挂载（window.desktopPet 变 undefined）——口型同步与诊断日志全部静默失效。
// 放到主进程加载更可靠（已用同款 Node 验证可 require），且 preload 不再依赖该包。
let pinyinFn = null;
try {
  const pinyinPro = require('pinyin-pro');
  if (pinyinPro && typeof pinyinPro.pinyin === 'function') pinyinFn = pinyinPro.pinyin;
} catch (e) {
  log('pinyin-pro load failed in main process; vowel sync disabled: ' + (e && e.message));
}
if (pinyinFn) log('pinyin-pro loaded (main process) for vowel detection');
else log('pinyin-pro NOT available; vowel sync will be disabled');

// 日文假名 -> 罗马字（元音口型对照用）。渲染进程 _vowelFromSyllable 只认拉丁 a/o/e/i/u，
// 故这里把每个假名转成罗马字 token（数组严格对齐输入字符数），日语台词即可驱动口型。
// 仅含主进程、零第三方依赖，与 pinyin-pro 各管一摊（中文走 pinyin-pro，日文走本表）。
const ROMA = {
  // 清音
  'あ':'a','い':'i','う':'u','え':'e','お':'o',
  'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
  'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
  'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
  'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
  'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
  'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
  'や':'ya','ゆ':'yu','よ':'yo',
  'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro',
  'わ':'wa','を':'wo','ん':'n',
  // 浊音 / 半浊音
  'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
  'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
  'だ':'da','ぢ':'di','づ':'du','で':'de','ど':'do',
  'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
  'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
  // 拗音（小写法在下方合并；这里单列常见双字符，纯中文/英文场景用不到）
  'きゃ':'kya','きゅ':'kyu','きょ':'kyo','しゃ':'sha','しゅ':'shu','しょ':'sho',
  'ちゃ':'cha','ちゅ':'chu','ちょ':'cho','にゃ':'nya','にゅ':'nyu','にょ':'nyo',
  'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo','みゃ':'mya','みゅ':'myu','みょ':'myo',
  'りゃ':'rya','りゅ':'ryu','りょ':'ryo','ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
  'じゃ':'ja','じゅ':'ju','じょ':'jo','びゃ':'bya','びゅ':'byu','びょ':'byo',
  'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo',
  // 片假名
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o',
  'カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
  'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so',
  'タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no',
  'ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
  'マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
  'ヤ':'ya','ユ':'yu','ヨ':'yo',
  'ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro',
  'ワ':'wa','ヲ':'wo','ン':'n',
  'ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go',
  'ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo',
  'ダ':'da','ヂ':'di','ヅ':'du','デ':'de','ド':'do',
  'バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
  'パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po',
  'キャ':'kya','キュ':'kyu','キョ':'kyo','シャ':'sha','シュ':'shu','ショ':'sho',
  'チャ':'cha','チュ':'chu','チョ':'cho','ニャ':'nya','ニュ':'nyu','ニョ':'nyo',
  'ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo',
  'ジャ':'ja','ジュ':'ju','ジョ':'jo','ビャ':'bya','ビュ':'byu','ビョ':'byo',
  'ピャ':'pya','ピュ':'pyu','ピョ':'pyo',
  // 长音 / 促音 / 小字（合并进前一音节，自身不占独立元音）
  'ー':'','っ':'','ッ':'','ゃ':'','ゅ':'','ょ':'','ャ':'','ュ':'','ョ':'',
  'ゎ':'wa','ゐ':'wi','ゑ':'we','ゕ':'ka','ゖ':'ke',
  '・':'','、':'','。':'',' ':'' ,'!':'','?':'','♪':''
};
const SMALL_Y = { 'ゃ':'a','ゅ':'u','ょ':'o','ャ':'a','ュ':'u','ョ':'o' };

function hasJapanese(text) {
  return /[ぁ-んァ-ヶ]/.test(text || '');
}

// 返回与输入字符一一对应的罗马字 token 数组（非假名：拉丁字母原样小写，其余留空）。
// 小 ゃ/ゅ/ょ 合并进前一 token 的辅音（ki + ya -> kya），自身位置补空，长度不变。
function kanaRomajiTokens(text) {
  const chars = Array.from(text || '');
  const out = [];
  let prevCons = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const r = ROMA[c];
    if (r === undefined) {
      if (/[a-zA-Z]/.test(c)) { out.push(c.toLowerCase()); prevCons = c.toLowerCase(); }
      else { out.push(''); }
      continue;
    }
    if (SMALL_Y[c] && prevCons && out.length) {
      const cons = prevCons.replace(/[aiueo]$/, '');
      const comb = cons + (SMALL_Y[c] === 'a' ? 'ya' : SMALL_Y[c] === 'u' ? 'yu' : 'yo');
      out[out.length - 1] = comb;
      prevCons = comb;
      out.push('');   // 小字本身不贡献独立元音（元音随合并后的 kya 落在前一字符）
      continue;
    }
    out.push(r);
    prevCons = r;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 防呆 + 自愈：若 ELECTRON_RUN_AS_NODE 被继承（值非空），electron.exe 会退化成
// 纯 Node，require('electron') 只返回二进制路径字符串，app 为 undefined，随后报
// "TypeError: Cannot read properties of undefined (reading 'whenReady')"。
//
// 这里不再直接退出：此时 process.execPath 仍然指向 electron.exe，只要去掉该
// 环境变量重新拉起自己即可恢复正常。这样无论从哪个上下文启动（Explorer 双击、
// 终端、被其它程序派生的进程），程序都能自己救回来。
// ---------------------------------------------------------------------------
if (!app || typeof app.whenReady !== 'function') {
  let healed = false;
  try {
    const { spawn } = require('child_process');
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const child = spawn(process.execPath, [__dirname], {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true
    });
    child.unref();
    healed = true;
    console.log('[live2d-companion] ELECTRON_RUN_AS_NODE was inherited; relaunched ' +
      'as a real Electron process (pid=' + child.pid + ').');
  } catch (e) {
    healed = false;
  }

  if (healed) process.exit(0);

  // 自愈失败才报错。说明：以下提示刻意使用 ASCII，避免在 GBK 控制台下中文乱码。
  console.error('[live2d-companion] FATAL: not running as an Electron main process.');
  console.error('  ELECTRON_RUN_AS_NODE = ' + JSON.stringify(process.env.ELECTRON_RUN_AS_NODE));
  console.error('  When that variable is non-empty, electron.exe degrades to plain Node');
  console.error('  and require("electron") returns only a path string, so "app" is undefined.');
  console.error('  Clear it first, or simply double-click start.cmd (it clears it for you):');
  console.error('    PowerShell :  $env:ELECTRON_RUN_AS_NODE = ""');
  console.error('    CMD        :  set ELECTRON_RUN_AS_NODE=');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 启动日志：每次启动的关键步骤都追加写入 app.log，便于"双击没反应"时定位问题。
// 注意 __dirname 即项目根目录（main.js 位于此处），无需依赖后面的 PROJECT_DIR。
// ---------------------------------------------------------------------------
const LOG_PATH = path.join(__dirname, 'app.log');
const WIN_BOUNDS_PATH = path.join(__dirname, 'window-bounds.json');
function log(...args) {
  const ts = new Date().toISOString();
  const line = '[' + ts + '] ' + args.map(a =>
    (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8'); } catch (e) { /* 忽略 */ }
  try { console.log(line); } catch (e) { /* 忽略 */ }
}

log('boot', {
  electron: process.versions.electron,
  ELECTRON_RUN_AS_NODE: JSON.stringify(process.env.ELECTRON_RUN_AS_NODE),
  appDefined: !!app
});

const PROJECT_DIR = __dirname;
const APP_DIR = path.join(PROJECT_DIR, 'app');
const NM_DIR = path.join(PROJECT_DIR, 'node_modules');

// 读取 app/config.json（不存在则用内置默认值）
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf-8'));
} catch (e) {
  CONFIG = {};
}

// ---------------------------------------------------------------------------
// 聊天大脑配置：本地 / 云端 / WorkBuddy 三选一
// ---------------------------------------------------------------------------
// backend         当前选用的大脑。首次安装默认 'cloud'（本地模型没装时也能直接用）。
// askEveryStart   是否每次启动都弹选择窗。用户勾了"下次不再询问"就置 false。
//                 无论 true/false，选过的大脑都会记下来，下次作为默认选中项。
const CHAT_DEFAULTS = {
  backend: 'cloud',
  askEveryStart: true,
  local: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b-instruct-q4_K_M',
    temperature: 0.8,
    numCtx: 8192,
    // keepAlive 拉长到 30m：Ollama 默认 5 分钟不用就卸载模型，
    // 桌宠这种"半天说一句"的用法会反复触发冷加载，体验很差。
    keepAlive: '30m'
  },
  cloud: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.8,
    maxTokens: 512
  },
  workbuddy: { cwd: '' }
};
function normalizeChatConfig() {
  const c = Object.assign({}, CHAT_DEFAULTS, CONFIG.chat || {});
  c.local = Object.assign({}, CHAT_DEFAULTS.local, (CONFIG.chat && CONFIG.chat.local) || {});
  c.cloud = Object.assign({}, CHAT_DEFAULTS.cloud, (CONFIG.chat && CONFIG.chat.cloud) || {});
  c.workbuddy = Object.assign({}, CHAT_DEFAULTS.workbuddy, (CONFIG.chat && CONFIG.chat.workbuddy) || {});
  if (!c.workbuddy.cwd) c.workbuddy.cwd = CONFIG.acpCwd || '.';
  if (['local', 'cloud', 'workbuddy'].indexOf(c.backend) < 0) c.backend = 'cloud';
  CONFIG.chat = c;
  return c;
}
normalizeChatConfig();

// 人设文件：app/data/persona.json。不存在时回落到内置默认（男性助理）。
const PERSONA_PATH = path.join(APP_DIR, 'data', 'persona.json');
const PERSONA_DEFAULT = {
  version: 2,
  charName: '黑叶萤',
  charGender: 'male',
  species: '狼族少年',
  appearance: '狼族少年，头顶一对狼耳，身后一条狼尾；耳朵和尾巴会随情绪动（高兴时立起、放松时耷下）。',
  relation: '助理',
  userTitle: '博士',
  selfTitle: '萤',
  personality: ['沉稳克制，话不多，但不冷淡', '做事靠谱，答应下来的事一定办到'],
  tone: '干练、平实，像一位长期共事的男性助理：不谄媚，不撒娇，称呼对方用「您」。',
  speech: { length: '短句为主，一次不超过三句', punctuation: '正常书面标点，不用颜文字，也不用括号写动作或神态', languages: '默认简体中文' },
  boundaries: ['不主动宣称自己是人工智能', '不替对方做重大决定',
    '耳朵和尾巴的反应只能用叙述性的话带出来，绝不能写成方括号或括号里的动作标注'],
  extra: ''
};
function readPersona() {
  try {
    const j = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf-8'));
    if (j && typeof j === 'object') return j;
  } catch (e) { /* 文件不存在或坏了：用默认 */ }
  return JSON.parse(JSON.stringify(PERSONA_DEFAULT));
}
function writePersona(p) {
  fs.writeFileSync(PERSONA_PATH, JSON.stringify(p, null, 2), 'utf-8');
}
// 模型库根目录：**每次请求都读** CONFIG，而不是启动时求值成常量。
// 这样在设置里换了「模型库目录」不必重启程序 —— /models/* 立刻改用新根目录。
// （曾经写成启动常量，换库只能重启；安全防护由 safeJoin 的目录穿越检查保持不变。）
function modelServeBase() {
  return CONFIG.modelServeBase || path.join(__dirname, 'app', 'models');
}
const PORT = CONFIG.serverPort || 18765;

// ---------------------------------------------------------------------------
// TTS 语音侧车（本地离线 Python 服务，可选）
// ---------------------------------------------------------------------------
// 由主进程 spawn 拉起 tts/tts_server.py，监听 127.0.0.1:TTS_PORT。
// 前端经同源路由 /api/tts 访问（页面来自 18765，直连 18766 属跨域，故由主进程代理）。
// 侧车不可用时整条语音链路静默降级（/api/tts 返回 503），不影响桌宠其余功能。
const TTS_PORT = CONFIG.ttsPort || 18766;
const TTS_ENGINE_IDS = [
  { id: 'auto', label: '自动（克隆优先 → 在线音色 → 内置）' },
  { id: 'cosyvoice', label: 'CosyVoice 3（流式·实时）' },
  { id: 'indextts', label: 'IndexTTS-2（离线·克隆你的音色）' },
  { id: 'edge', label: 'Edge TTS（在线·微软专业音色）' },
  { id: 'sapi', label: 'Windows 内置语音（占位）' },
  { id: 'tone', label: '提示音（仅链路自检）' }
];
const ttsState = {
  enabled: CONFIG.ttsEnabled !== false,
  want: CONFIG.ttsEngine || 'auto',
  active: '',
  engines: [],
  ok: false
};
let ttsChild = null;

function ttsSpawn() {
  if (!ttsState.enabled) { log('tts: disabled by config'); return; }
  if (ttsChild) return;
  const { spawn } = require('child_process');
  const script = path.join(__dirname, 'tts', 'tts_server.py');
  if (!fs.existsSync(script)) { log('tts: sidecar missing: ' + script); return; }
  const cands = [];
  if (ttsState.want === 'cosyvoice') {
    if (CONFIG.cosyvoicePython) cands.push(CONFIG.cosyvoicePython);
  } else if (CONFIG.ttsPython) {
    cands.push(CONFIG.ttsPython);
  }
  cands.push('python', 'python3', 'py');
  const tryAt = (i) => {
    if (i >= cands.length) { log('tts: no python launcher available (set config.ttsPython)'); return; }
    const exe = cands[i];
    // 把 IndexTTS-2 的配置作为环境变量传给侧车 —— 这样用户只要填 config.json，
    // 不必去设系统环境变量（双击 start.cmd 启动时是拿不到用户手设的临时变量的）。
    const ttsEnv = Object.assign({}, process.env);
    if (CONFIG.indexttsDir) ttsEnv.INDEXTTS_DIR = String(CONFIG.indexttsDir);
    if (CONFIG.indexttsModelDir) ttsEnv.INDEXTTS_MODEL_DIR = String(CONFIG.indexttsModelDir);
    if (CONFIG.indexttsRef) ttsEnv.INDEXTTS_REF = String(CONFIG.indexttsRef);
    if (CONFIG.indexttsSemitones !== undefined && CONFIG.indexttsSemitones !== null) {
      ttsEnv.INDEXTTS_SEMITONES = String(CONFIG.indexttsSemitones);
    }
    if (CONFIG.indexttsBoyify !== undefined && CONFIG.indexttsBoyify !== null) {
      ttsEnv.INDEXTTS_BOYIFY = CONFIG.indexttsBoyify ? '1' : '0';
    }
    if (CONFIG.indexttsEmoAlpha !== undefined && CONFIG.indexttsEmoAlpha !== null) {
      ttsEnv.INDEXTTS_EMO_ALPHA = String(CONFIG.indexttsEmoAlpha);
    }
    if (CONFIG.indexttsPolish !== undefined && CONFIG.indexttsPolish !== null) {
      ttsEnv.INDEXTTS_POLISH = CONFIG.indexttsPolish ? '1' : '0';
    }
    if (CONFIG.indexttsFormant !== undefined && CONFIG.indexttsFormant !== null) {
      ttsEnv.INDEXTTS_FORMANT = CONFIG.indexttsFormant ? '1' : '0';
    }
    // CosyVoice 配置作为环境变量传给侧车（用户只需填 config.json，不必手设系统变量）。
    if (CONFIG.cosyvoiceDir) ttsEnv.COSYVOICE_DIR = String(CONFIG.cosyvoiceDir);
    if (CONFIG.cosyvoiceRef) ttsEnv.COSYVOICE_REF = String(CONFIG.cosyvoiceRef);
    if (CONFIG.cosyvoiceFp16 !== undefined && CONFIG.cosyvoiceFp16 !== null) {
      ttsEnv.COSYVOICE_FP16 = CONFIG.cosyvoiceFp16 ? '1' : '0';
    }
    let child;
    try {
      child = spawn(exe, [script, '--port', String(TTS_PORT), '--engine', ttsState.want],
        { cwd: path.join(__dirname, 'tts'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: ttsEnv });
    } catch (e) { return tryAt(i + 1); }
    child.on('error', (err) => {
      log('tts: launcher "' + exe + '" failed: ' + err.message);
      if (ttsChild === child) ttsChild = null;
      tryAt(i + 1);
    });
    child.on('exit', (code) => {
      if (ttsChild === child) ttsChild = null;
      log('tts: sidecar exited (code=' + code + ')');
    });
    if (child.stdout) child.stdout.on('data', (d) => log('tts ' + String(d).trim()));
    if (child.stderr) child.stderr.on('data', (d) => log('tts ' + String(d).trim()));
    ttsChild = child;
    log('tts: sidecar spawned (launcher=' + exe + ', port=' + TTS_PORT + ')');
    setTimeout(ttsProbe, 1400);
  };
  tryAt(0);
}

function ttsKill() {
  if (!ttsChild) return;
  try { ttsChild.kill(); } catch (e) {}
  ttsChild = null;
}

function ttsRestart() { ttsKill(); setTimeout(ttsSpawn, 300); }

// ---------------------------------------------------------------------------
// 音频侧车（方案③）：原生 WASAPI 逐端点回环采集。
// Electron 的桌面回环只能抓「Windows 默认输出设备」的混音，做不到按端点选择；
// 故用 Python soundcard 对任意指定输出端点开 loopback，实现"想听哪个输出设备就听哪个"。
// 侧车缺失或 soundcard 未安装时全部优雅降级（返回空/未激活），不影响主程序。
// ---------------------------------------------------------------------------
const AUDIO_PORT = (CONFIG.serverPort || 18765) + 3;   // 主服务 +3，避开占用
let audioChild = null;
let audioReady = false;
function audioExe() {
  // 优先项目内 venv（audio/venv，已装 soundcard），避免污染用户系统 Python
  const winPy = path.join(__dirname, 'audio', 'venv', 'Scripts', 'python.exe');
  const posixPy = path.join(__dirname, 'audio', 'venv', 'bin', 'python');
  if (fs.existsSync(winPy)) return winPy;
  if (fs.existsSync(posixPy)) return posixPy;
  return 'python';                                     // 回退系统 python（可能没装 soundcard）
}
function audioSpawn() {
  if (audioChild) return;
  const script = path.join(__dirname, 'audio', 'audio_server.py');
  if (!fs.existsSync(script)) { log('audio: sidecar missing: ' + script); return; }
  const { spawn } = require('child_process');
  const exe = audioExe();
  try {
    audioChild = spawn(exe, [script, String(AUDIO_PORT)], { cwd: __dirname, windowsHide: true });
    audioReady = true;
    log('audio: sidecar spawned (' + exe + ') port=' + AUDIO_PORT);
    audioChild.on('error', (e) => { log('audio: spawn error: ' + e.message); audioChild = null; audioReady = false; });
    audioChild.on('exit', (c) => { log('audio: sidecar exited code=' + c); audioChild = null; audioReady = false; });
  } catch (e) { log('audio: spawn failed: ' + e.message); }
}
function audioKill() {
  if (!audioChild) return;
  try { audioChild.kill(); } catch (e) {}
  audioChild = null; audioReady = false;
}

// ---------------------------------------------------------------------------
// Ollama 侧车（本地聊天模型的宿主：选中时才拉起，随桌宠退出而关闭）
// ---------------------------------------------------------------------------
// 三条纪律，都是会踩的坑：
// 1) 只在用户选中「本地模型」时才拉起 —— 它常驻会占着显存，不该开机就起。
// 2) **只关我们自己拉起的那个**。若用户本来就开着 Ollama（命令行起的、或其它
//    软件在用），我们只是借用，退出时绝不能杀 —— 否则关一次桌宠就把别人的服务
//    搞没了。用 ollamaState.owned 区分「我起的」和「本来就在的」。
// 3) **必须显式传 OLLAMA_MODELS**。模型当初刻意装到 D:\ollama-models（省 C 盘），
//    不传这个变量，服务会去读系统默认目录（~/.ollama/models，本机是空的），
//    然后报「找不到模型」——看起来像没下载，其实是读错了地方。
// ---------------------------------------------------------------------------
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT_DEFAULT = 11434;
const ollamaState = { owned: false, running: false, pid: 0, exe: '', modelsDir: '' };
let ollamaChild = null;

function ollamaPort() {
  const lc = (CONFIG.chat && CONFIG.chat.local) || {};
  return Number(lc.port) || OLLAMA_PORT_DEFAULT;
}

// 模型目录优先级：config.chat.local.modelsDir > 环境变量 OLLAMA_MODELS >
// 已存在的 D:\ollama-models > 不传（交给 Ollama 自己决定）
function ollamaModelsDir() {
  const lc = (CONFIG.chat && CONFIG.chat.local) || {};
  if (lc.modelsDir) return String(lc.modelsDir);
  if (process.env.OLLAMA_MODELS) return String(process.env.OLLAMA_MODELS);
  try {
    const d = 'D:\\ollama-models';
    if (fs.existsSync(d) && fs.existsSync(path.join(d, 'manifests'))) return d;
  } catch (e) {}
  return '';
}

// 按常见安装位置找 ollama.exe，找不到就退回 PATH（指望 `ollama` 命令可用）
function ollamaExe() {
  const cands = [];
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
  if (process.env.USERPROFILE) cands.push(path.join(process.env.USERPROFILE, '.ollama', 'bin', 'ollama.exe'));
  for (let i = 0; i < cands.length; i++) {
    try { if (cands[i] && fs.existsSync(cands[i])) return cands[i]; } catch (e) {}
  }
  return 'ollama';
}

// 探活：拿得到 /api/version 就算活着
function ollamaPing(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      host: OLLAMA_HOST, port: ollamaPort(), path: '/api/version', method: 'GET',
      timeout: timeoutMs || 1200
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => finish(res.statusCode === 200));
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
    try { req.end(); } catch (e) { finish(false); }
  });
}

// 拉起服务并等到端口就绪。返回 {ok, owned, already, elapsedMs, message}
//   already=true 表示「本来就有一个在跑」，我们只是借用（退出时不会关它）
async function ollamaStart(maxWaitMs) {
  const t0 = Date.now();
  const limit = maxWaitMs || 60000;
  if (await ollamaPing(1200)) {
    ollamaState.running = true;
    return { ok: true, owned: ollamaState.owned, already: !ollamaState.owned, elapsedMs: 0 };
  }
  const exe = ollamaExe();
  const env = Object.assign({}, process.env);
  const md = ollamaModelsDir();
  if (md) env.OLLAMA_MODELS = md;
  let child;
  try {
    const { spawn } = require('child_process');
    child = spawn(exe, ['serve'],
      { cwd: path.dirname(exe), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, message: '启动 Ollama 失败：' + (e && e.message) + '（请确认已安装 Ollama）' };
  }
  ollamaChild = child;
  ollamaState.owned = true;
  ollamaState.pid = child.pid;
  ollamaState.exe = exe;
  ollamaState.modelsDir = md;
  child.on('error', (e) => {
    log('ollama: spawn error: ' + e.message);
    if (ollamaChild === child) { ollamaChild = null; ollamaState.owned = false; ollamaState.running = false; }
  });
  child.on('exit', (c) => {
    log('ollama: exited code=' + c);
    if (ollamaChild === child) {
      ollamaChild = null; ollamaState.owned = false; ollamaState.running = false; ollamaState.pid = 0;
    }
  });
  if (child.stdout) child.stdout.on('data', (d) => log('ollama ' + String(d).trim()));
  if (child.stderr) child.stderr.on('data', (d) => log('ollama ' + String(d).trim()));
  log('ollama: spawned (' + exe + ') modelsDir=' + (md || '(default)'));
  while (Date.now() - t0 < limit) {
    if (await ollamaPing(1000)) {
      ollamaState.running = true;
      return { ok: true, owned: true, already: false, elapsedMs: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, message: 'Ollama 启动超时（' + Math.round(limit / 1000) + ' 秒）' };
}

// 只关我们自己拉起的那个。顺便按进程树杀：Ollama 会再派生 runner 子进程
// （真正占显存的是它），只 kill 主进程会留下孤儿继续吃显存。
function ollamaStop() {
  if (!ollamaChild || !ollamaState.owned) {
    if (ollamaState.running) log('ollama: not spawned by us, leaving it running');
    return;
  }
  const pid = ollamaChild.pid;
  try {
    if (process.platform === 'win32') {
      require('child_process').execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => {});
    } else {
      ollamaChild.kill('SIGTERM');
    }
  } catch (e) {}
  log('ollama: stopped (pid=' + pid + ')');
  ollamaChild = null;
  ollamaState.owned = false;
  ollamaState.running = false;
  ollamaState.pid = 0;
}

// ---------------------------------------------------------------------------
// 本地模型安装向导（"一键装 Ollama"的后端）
// ---------------------------------------------------------------------------
// 为什么需要：安装包刻意不带 Ollama（安装包本身 1.5 GB，模型还要另拉 4.7 GB），
// 于是新用户第一次选「本地模型」时只会看到一句"请先安装 Ollama"，门槛全落在他身上。
// 这里把整条链路做成一键：探活下载源 → 下载安装包 → 静默安装 → 起服务 → 拉模型。
//
// 四条实测纪律（都踩过，别改）：
// 1) **GitHub release 直连在国内经常不通**，winget 也栽在同一处（报
//    InternetOpenUrl() failed. 0x80072efd）。所以下载源必须带镜像，且真的逐个探活、
//    失败自动换下一个，不能让用户对着"下载失败"自己想办法。
// 2) **静默安装必须带 /CURRENTUSER**：Ollama 的安装器是 Inno Setup，带这个参数才是
//    每用户安装，不需要管理员、不弹 UAC；不带它会去写 Program Files，要么要提权要么直接失败。
// 3) **必须先 serve 再 pull**。没有服务时 pull 会自己起一个然后超时卡死（进程活着、
//    日志一动不动，看着像网络问题）。向导的步骤顺序就是照这个排的，不要调换。
// 4) **服务与 pull 必须看到同一个 OLLAMA_MODELS**。向导先把模型目录写进配置，再拉起
//    服务（ollamaStart 会读这个配置带上环境变量），顺序反了就会出现"拉完了却找不到模型"。
// ---------------------------------------------------------------------------
const OLLAMA_SETUP_FALLBACK_TAG = 'v0.34.2';   // GitHub API 拿不到时用的兜底版本
const OLLAMA_SETUP_FILE = 'OllamaSetup.exe';
// 顺序不重要（会并发探活按延迟排序），但必须包含直连：境外网络下直连往往最快。
const OLLAMA_SETUP_MIRRORS = [
  { id: 'ghproxy', label: 'gh-proxy 镜像', prefix: 'https://gh-proxy.com/' },
  { id: 'ghfast', label: 'ghfast 镜像', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy2', label: 'ghproxy 备用镜像', prefix: 'https://mirror.ghproxy.com/' },
  { id: 'direct', label: 'GitHub 直连', prefix: '' }
];
let ollamaSetupTag = '';        // 解析到的 release tag（缓存，避免每次重探）
let ollamaSetupAsset = null;    // { tag, url, size, sha256 }
let ollamaSetupJob = null;      // 进行中的安装任务：{ cancelled, abort, child }
let ollamaSetupWin = null;      // 向导窗口

function setupDir() {
  return path.join(require('os').tmpdir(), 'ollama-setup');
}

// 统一的 GET：自动跟随重定向（GitHub release 会跳到 objects.githubusercontent.com，
// 镜像站也多是一跳 302）。回调拿到的是最终的 res 流，调用方自己决定读法。
function followGet(url, opts, onRes, onErr, hops) {
  hops = hops || 0;
  if (hops > 6) return onErr(new Error('重定向次数过多'));
  let u;
  try { u = new URL(url); } catch (e) { return onErr(new Error('地址不合法：' + url)); }
  const mod = u.protocol === 'http:' ? http : https;
  const req = mod.get({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    headers: Object.assign({ 'User-Agent': 'HotaruDesktopPet-OllamaWizard' }, (opts && opts.headers) || {}),
    timeout: (opts && opts.timeout) || 20000
  }, (res) => {
    const code = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].indexOf(code) >= 0 && res.headers.location) {
      res.resume();
      return followGet(new URL(res.headers.location, url).toString(), opts, onRes, onErr, hops + 1);
    }
    onRes(res, req);
  });
  req.on('error', onErr);
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} onErr(new Error('连接超时')); });
  req.end();
  return req;
}

// 解析最新 release：拿 tag、体积、官方 sha256（用于下载后校验，防止半截包被当成装完）
function resolveOllamaAsset() {
  if (ollamaSetupAsset) return Promise.resolve(ollamaSetupAsset);
  return new Promise((resolve) => {
    const fallback = () => {
      const tag = OLLAMA_SETUP_FALLBACK_TAG;
      ollamaSetupTag = tag;
      ollamaSetupAsset = {
        tag: tag,
        url: 'https://github.com/ollama/ollama/releases/download/' + tag + '/' + OLLAMA_SETUP_FILE,
        size: 0,
        sha256: '',
        source: 'fallback'
      };
      resolve(ollamaSetupAsset);
    };
    githubJson('https://api.github.com/repos/ollama/ollama/releases/latest', (err, j) => {
      if (err || !j || !j.tag_name) { log('ollama wizard: release API 不可用（' + (err && err.message) + '），用兜底版本 ' + OLLAMA_SETUP_FALLBACK_TAG); return fallback(); }
      const a = (j.assets || []).filter((x) => x.name === OLLAMA_SETUP_FILE)[0];
      if (!a) return fallback();
      ollamaSetupTag = j.tag_name;
      ollamaSetupAsset = {
        tag: j.tag_name,
        url: a.browser_download_url,
        size: a.size || 0,
        sha256: String(a.digest || '').replace(/^sha256:/, ''),
        source: 'api'
      };
      log('ollama wizard: 最新版 ' + j.tag_name + '  安装包 ' + (a.size / 1048576).toFixed(0) + ' MB');
      resolve(ollamaSetupAsset);
    });
  });
}

function githubJson(url, cb) {
  followGet(url, { headers: { 'Accept': 'application/vnd.github+json' }, timeout: 15000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode)); }
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { b += c; if (b.length > 4e6) { try { res.destroy(); } catch (e) {} } });
    res.on('end', () => { try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
  }, cb);
}

// 把官方地址套上各镜像前缀
function setupCandidates(asset) {
  return OLLAMA_SETUP_MIRRORS.map((m) => ({
    id: m.id, label: m.label, url: m.prefix + asset.url
  }));
}

// 逐个探活：只要前 1KB 能拿到就说明这条源通。返回按延迟升序的可用源。
function probeSetupSources(cands) {
  return Promise.all(cands.map((c) => new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      followGet(c.url, { headers: { Range: 'bytes=0-1023' }, timeout: 12000 }, (res) => {
        const code = res.statusCode || 0;
        const ok = code === 200 || code === 206;
        res.resume();
        if (!ok) return done(null);
        done({ id: c.id, label: c.label, url: c.url, ms: Date.now() - t0 });
      }, () => done(null));
    } catch (e) { done(null); }
    // 兜底：12s 内没有任何回调就当这条源不通
    setTimeout(() => done(null), 13000);
  }))).then((list) => list.filter(Boolean).sort((a, b) => a.ms - b.ms));
}

// 把向导进度推给向导窗口（窗口没开就静默丢弃，不报错）
function setupEmit(obj) {
  try {
    if (ollamaSetupWin && !ollamaSetupWin.isDestroyed()) {
      ollamaSetupWin.webContents.send('pet:ollamaSetupProgress', obj);
    }
  } catch (e) {}
}

function setupLog(msg) {
  log('[ollama-wizard] ' + msg);
  setupEmit({ phase: 'log', message: String(msg) });
}

// 下载安装包（支持断点续传 + 换源重试）。dest = 目标 .exe 路径。
function downloadSetupFile(src, dest, job) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part';
    const meta = dest + '.part.meta';
    let startAt = 0;
    try {
      // 续传只在"同一个源下到一半"时才有意义；换了源就从零开始，避免拼接出坏包
      if (fs.existsSync(part) && fs.existsSync(meta) && fs.readFileSync(meta, 'utf8').trim() === src.url) {
        startAt = fs.statSync(part).size;
      } else {
        try { fs.unlinkSync(part); } catch (e) {}
      }
    } catch (e) { startAt = 0; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.writeFileSync(meta, src.url, 'utf8'); } catch (e) {}

    const headers = { 'User-Agent': 'HotaruDesktopPet-OllamaWizard' };
    if (startAt > 0) headers.Range = 'bytes=' + startAt + '-';
    const out = fs.createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' });
    let got = startAt;
    let total = startAt;
    let lastTick = 0;
    let done = false;

    const fail = (msg) => {
      if (done) return;
      done = true;
      try { out.destroy(); } catch (e) {}
      reject(new Error(msg));
    };

    const req = followGet(src.url, { headers: headers, timeout: 30000 }, (res) => {
      if (res.statusCode === 416) {  // Range 越界：本地那份其实已经下完了
        res.resume();
        if (done) return;
        done = true;
        try { out.destroy(); } catch (e) {}
        return resolve({ resumed: startAt > 0, bytes: startAt });
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return fail('HTTP ' + res.statusCode);
      }
      if (res.statusCode === 200 && startAt > 0) {
        // 服务端不认 Range：从头写，别把两段拼在一起
        got = 0; total = 0;
        try { fs.truncateSync(part, 0); } catch (e) {}
      }
      const cl = Number(res.headers['content-length'] || 0);
      if (cl > 0) total = cl + (res.statusCode === 206 ? startAt : 0);
      res.on('data', (chunk) => {
        got += chunk.length;
        const now = Date.now();
        if (now - lastTick > 350) {
          lastTick = now;
          if (job) job.bytes = got;
          setupEmit({
            phase: 'download', percent: total ? Math.min(100, (got / total) * 100) : 0,
            message: '正在下载安装包…', bytes: got, total: total, source: src.label
          });
        }
      });
      res.on('error', (e) => fail(e.message || '下载中断'));
      res.pipe(out);
      out.on('error', (e) => fail(e.message || '写入失败'));
      out.on('finish', () => {
        if (done) return;
        done = true;
        resolve({ resumed: startAt > 0, bytes: got });
      });
    }, (e) => fail(e.message || '连接失败'));

    if (job) {
      job.abort = () => { try { req.destroy(); } catch (e) {} fail('已取消'); };
    }
  });
}

function sha256File(p) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('error', () => resolve(''));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// 静默安装。/CURRENTUSER = 每用户安装，免管理员免 UAC（见文件头纪律 2）
function installOllamaSilently(exePath) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let child;
    try {
      child = spawn(exePath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/NOICONS'],
        { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      return resolve({ ok: false, message: '无法启动安装程序：' + (e && e.message) });
    }
    if (ollamaSetupJob) ollamaSetupJob.child = child;
    child.on('error', (e) => resolve({ ok: false, message: '安装程序启动失败：' + (e && e.message) }));
    child.on('exit', (code) => resolve({ ok: true, code: code }));
  });
}

// 等 ollama.exe 落盘（安装器退出到文件就位之间有几十毫秒差）
async function waitForOllamaExe(maxWaitMs) {
  const t0 = Date.now();
  const limit = maxWaitMs || 45000;
  while (Date.now() - t0 < limit) {
    const exe = ollamaExe();
    try { if (exe !== 'ollama' && fs.existsSync(exe)) return exe; } catch (e) {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return '';
}

// 检测当前环境：装没装 / 跑没跑 / 有哪些模型 / 目标目录与磁盘余量
function ollamaDetectSync() {
  const exe = ollamaExe();
  let installed = false, exePath = '';
  try {
    if (exe !== 'ollama' && fs.existsSync(exe)) { installed = true; exePath = exe; }
  } catch (e) {}
  const lc = (CONFIG.chat && CONFIG.chat.local) || {};
  const model = lc.model || 'qwen2.5:7b-instruct-q4_K_M';
  let dir = lc.modelsDir || ollamaModelsDir() || '';
  if (!dir) {
    try { dir = path.join(require('os').homedir(), '.ollama', 'models'); } catch (e) { dir = ''; }
  }
  // 磁盘余量：装包落在 temp、模型落在 dir，两个都要看
  const disk = (p) => {
    try {
      const s = fs.statfsSync(p);
      return { path: p, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch (e) { return { path: p, freeBytes: -1, totalBytes: -1 }; }
  };
  return {
    installed: installed,
    exe: exePath || (exe === 'ollama' ? '(PATH 里的 ollama)' : ''),
    running: !!ollamaState.running,
    port: ollamaPort(),
    model: model,
    models: [],
    modelsDir: dir,
    modelsDirConfigured: !!lc.modelsDir,
    freeSpaceOk: true,
    diskModels: disk(dir || 'C:\\'),
    diskTemp: disk(setupDir().slice(0, 3)),
    tag: ollamaSetupTag || OLLAMA_SETUP_FALLBACK_TAG
  };
}

// 探服务的实时状态 + 已装模型（带体积，用于"下没下好"）
function ollamaQueryModels() {
  return new Promise((resolve) => {
    const req = http.get({
      host: OLLAMA_HOST, port: ollamaPort(), path: '/api/tags', method: 'GET', timeout: 2500
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve({
            running: true,
            models: (j.models || []).map((m) => ({ name: m.name || '', size: m.size || 0, modified: m.modified_at || '' }))
          });
        } catch (e) { resolve({ running: false, models: [] }); }
      });
    });
    req.on('error', () => resolve({ running: false, models: [] }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ running: false, models: [] }); });
  });
}

// 完整的一键安装流程。任何一步失败都返回可读原因，不抛。
async function ollamaWizardInstall() {
  if (ollamaSetupJob && !ollamaSetupJob.cancelled && ollamaSetupJob.phase && ollamaSetupJob.phase !== 'done') {
    return { ok: false, message: '已有一个安装任务在进行中' };
  }
  const job = { cancelled: false, phase: 'probe', abort: null, child: null, bytes: 0 };
  ollamaSetupJob = job;
  const t0 = Date.now();
  try {
    setupEmit({ phase: 'probe', percent: 0, message: '正在解析最新版本…' });
    const asset = await resolveOllamaAsset();
    if (job.cancelled) throw new Error('已取消');

    setupEmit({ phase: 'probe', percent: 0, message: '正在探测下载源（' + OLLAMA_SETUP_MIRRORS.length + ' 个）…', tag: asset.tag, size: asset.size });
    const alive = await probeSetupSources(setupCandidates(asset));
    if (job.cancelled) throw new Error('已取消');
    if (!alive.length) throw new Error('所有下载源都连不上。请点「打开官网手动下载」用浏览器下载后手动安装');
    setupEmit({ phase: 'probe', percent: 100, sources: alive, message: '可用下载源：' + alive.map((a) => a.label + ' ' + a.ms + 'ms').join('、') });

    // 下载：按探活顺序逐个试，前一个失败就换下一个（1.5 GB，单源失败很常见）
    let dest = path.join(setupDir(), OLLAMA_SETUP_FILE);
    let lastErr = '';
    let okDownload = false;
    for (let i = 0; i < alive.length && !job.cancelled; i++) {
      const src = alive[i];
      try {
        setupEmit({ phase: 'download', percent: 0, source: src.label, message: '正在从 ' + src.label + ' 下载安装包…' });
        setupLog('下载源 #' + (i + 1) + '：' + src.label + '  (' + src.url + ')');
        await downloadSetupFile(src, dest, job);
        okDownload = true;
        break;
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        setupLog('该源失败：' + lastErr + '，换下一个');
      }
    }
    if (job.cancelled) throw new Error('已取消');
    if (!okDownload) throw new Error('下载安装包失败：' + lastErr);

    // 校验：官方给了 sha256 就比对，避免半截包被当成装完（装到一半失败很难排查）
    if (asset.sha256) {
      setupEmit({ phase: 'verify', percent: 100, message: '正在校验安装包完整性…' });
      const h = await sha256File(dest);
      if (h && h.toLowerCase() !== asset.sha256.toLowerCase()) {
        try { fs.unlinkSync(dest); } catch (e) {}
        throw new Error('安装包校验失败（下载不完整），请重试');
      }
      setupLog('sha256 校验通过');
    }
    const part = dest + '.part';
    try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch (e) {}
    try { fs.unlinkSync(dest + '.part.meta'); } catch (e) {}

    const sizeOk = fs.statSync(dest).size;
    setupEmit({ phase: 'install', percent: 0, message: '正在静默安装（约 1~3 分钟，请勿关闭）…', bytes: sizeOk, total: sizeOk });
    job.phase = 'install';
    const r = await installOllamaSilently(dest);
    if (job.cancelled) throw new Error('已取消');
    if (!r.ok) throw new Error(r.message || '安装失败');
    setupLog('安装程序已退出（code=' + r.code + '），等待 ollama.exe 就位…');
    const exe = await waitForOllamaExe(45000);
    if (!exe) throw new Error('安装程序已结束，但没有找到 ollama.exe。请到 Ollama 官网确认安装是否完成');
    setupLog('已就位：' + exe);
    try { fs.unlinkSync(dest); } catch (e) {}

    job.phase = 'done';
    setupEmit({ phase: 'done', percent: 100, message: 'Ollama 安装完成', exe: exe, elapsedMs: Date.now() - t0 });
    return { ok: true, exe: exe, elapsedMs: Date.now() - t0 };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const cancelled = job.cancelled || /已取消/.test(msg);
    job.phase = 'done';
    setupEmit({ phase: cancelled ? 'cancelled' : 'error', percent: 0, message: cancelled ? '已取消' : msg });
    return { ok: false, cancelled: cancelled, message: msg };
  } finally {
    if (ollamaSetupJob === job) { ollamaSetupJob.phase = 'done'; }
  }
}

function audioReq(method, pathname, body) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1', port: AUDIO_PORT, path: pathname, method: method, timeout: 4000,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

function ttsProbe() {
  const req = http.request({ host: '127.0.0.1', port: TTS_PORT, path: '/health', method: 'GET', timeout: 4000 },
    (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          ttsState.ok = !!j.ok;
          ttsState.active = j.engine || '';
          ttsState.engines = j.engines || [];
          log('tts: health ok, active=' + ttsState.active + ' engines=' +
            ttsState.engines.map((e) => e.name + (e.available ? '' : '(x)')).join(','));
        } catch (e) { log('tts: health parse error: ' + e.message); }
      });
    });
  req.on('error', (e) => { ttsState.ok = false; log('tts: health error: ' + e.message); });
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
  req.end();
}

function ttsProxy(res, query) {
  const upstream = http.request(
    { host: '127.0.0.1', port: TTS_PORT, path: '/tts' + (query || ''), method: 'GET', timeout: 180000 },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      up.pipe(res);
    });
  upstream.on('error', (e) => {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: 'TTS 侧车不可用：' + e.message }));
  });
  upstream.on('timeout', () => { try { upstream.destroy(); } catch (e) {} });
  upstream.end();
}


// ---------------------------------------------------------------------------
// 聊天后端代理：/api/ollama/*（本机 Ollama）与 /api/cloud/*（云端 OpenAI 兼容接口）
// ---------------------------------------------------------------------------
// 和 /api/v1/acp 同一套路：渲染进程只打同源地址，由主进程转发。
// 两个理由：
//   1) 跨域 —— 页面来自 http://127.0.0.1:18765，直连 11434 或 https 接口都会被
//      Chromium 拦掉，失败时只剩一句没信息量的 "Failed to fetch"。
//   2) 可读错误 —— 代理能把"连不上 / 401 / 模型没下载"翻成人话再回给前端。
//
// 流式必须逐块透传（up.pipe(res)），绝不能缓冲完再返回；否则打字机效果
// 会退化成"等半天一次性吐完"，本地模型尤其明显。
function pipeProxy(req, res, opts) {
  let u;
  try { u = new URL(opts.base); } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: '接口地址不合法：' + opts.base }));
  }
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const port = u.port || (isHttps ? 443 : 80);

  const h = Object.assign({}, req.headers);
  // 这两个是渲染进程传给主进程的"目标指示"，不能泄露给上游
  delete h['x-target-base'];
  delete h['x-target-key'];
  delete h['host'];
  delete h['origin'];
  delete h['referer'];
  Object.assign(h, opts.headers || {});

  const up = mod.request({
    hostname: u.hostname, port: port, path: opts.path, method: req.method,
    headers: h, timeout: opts.timeout || 120000
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, {
      'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    upRes.pipe(res);
  });
  up.on('timeout', () => {
    try { up.destroy(); } catch (e) {}
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '上游超时（本地模型首次加载可能较慢，请稍候再试）' }));
    }
  });
  up.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: (opts.failPrefix || '无法连接上游') + '：' + e.message }));
    }
  });
  req.on('error', () => { try { up.destroy(); } catch (e) {} });
  req.pipe(up);
}

// /api/ollama/* -> http://127.0.0.1:11434/*
function ollamaProxy(req, res, urlPath) {
  const base = (CONFIG.chat && CONFIG.chat.local && CONFIG.chat.local.baseUrl) || 'http://127.0.0.1:11434';
  pipeProxy(req, res, {
    base: base,
    path: urlPath.slice('/api/ollama'.length),
    // 本地模型冷启动要加载几 GB 权重，超时给足（10 分钟）
    timeout: 600000,
    failPrefix: '无法连接 Ollama（请确认已安装并启动，默认端口 11434）'
  });
}

// /api/cloud/* -> 用户配置的云端接口
// 目标地址优先取请求头 x-target-base（前端填写后即时生效，未保存也能试），
// 其次取 config.json 里已保存的值。密钥同理，且只在主进程里拼进 Authorization。
function cloudProxy(req, res, urlPath) {
  const cc = (CONFIG.chat && CONFIG.chat.cloud) || {};
  const base = String(req.headers['x-target-base'] || cc.baseUrl || '');
  const key = String(req.headers['x-target-key'] || cc.apiKey || '');
  if (!base) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: '还没填云端接口地址' }));
  }
  if (!/^https?:\/\//i.test(base)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: '接口地址必须以 http:// 或 https:// 开头' }));
  }
  const headers = {};
  if (key) headers['Authorization'] = 'Bearer ' + key;
  pipeProxy(req, res, {
    base: base,
    path: urlPath.slice('/api/cloud'.length),
    headers: headers,
    timeout: 120000,
    failPrefix: '无法连接云端接口'
  });
}

// ---------------------------------------------------------------------------
// WorkBuddy ACP 反向代理 + 端口自动发现
// ---------------------------------------------------------------------------
// 两个曾经的坑：
//
// 坑 1（跨域）：页面来自 http://127.0.0.1:18765，直连 ACP 端口属跨域。上游不带
//   Access-Control-Allow-Origin 时 Chromium 在网络层直接拒绝，fetch 只抛一句含糊的
//   "TypeError: Failed to fetch"——既拿不到状态码，也分不清端口没开还是被拒。
//   → 由主进程做同源代理：页面请求 /api/v1/acp*（同源，无跨域），主进程再转发。
//
// 坑 2（端口写死）：9418 是当初记错的端口。实测本机 WorkBuddy 的 ACP 服务在
//   127.0.0.1:10925，而同一进程组还监听 7484 / 7499 / 7580 / 18488 等其它服务，
//   端口看起来是每次启动动态分配的。写死任何一个都会在下次启动时失效。
//   → 自动发现：列出 WorkBuddy 进程监听的本地端口，逐个 POST /api/v1/acp/connect，
//     能拿到 connectionId + sessionToken 的那个就是 ACP 端口；结果写入
//     acp-port.cache.json，下次启动先试缓存，命中即秒连。
//
// 注意：/api/v1/acp 的响应体是 SSE 流，转发必须逐块透传，绝不能缓冲后再返回，
// 否则助手回复会一直"卡着不出来"。
// ---------------------------------------------------------------------------
const ACP_BASE_HINT = (CONFIG.acpBaseUrl || '').replace(/\/+$/, '');
const ACP_CACHE_PATH = path.join(__dirname, 'acp-port.cache.json');

let acpPort = 0;              // 已确认可用的 ACP 端口（0 = 尚未发现）
let lastCandidates = [];      // 最近一次扫描过的候选端口，用于错误提示
let discovering = null;       // 进行中的发现 Promise（去重）

function runCmd(file, args) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(String((stdout || ''), 'utf-8')));
  });
}

function portFromUrl(u) {
  try {
    const p = new URL(u);
    return Number(p.port || (p.protocol === 'https:' ? 443 : 80));
  } catch (e) { return 0; }
}

function readPortCache() {
  try {
    const j = JSON.parse(fs.readFileSync(ACP_CACHE_PATH, 'utf-8'));
    return typeof j.port === 'number' ? j.port : 0;
  } catch (e) { return 0; }
}
function writePortCache(port) {
  try {
    fs.writeFileSync(ACP_CACHE_PATH, JSON.stringify({ port: port, at: new Date().toISOString() }, null, 2), 'utf-8');
  } catch (e) { /* 忽略 */ }
}
function dropPortCache() {
  try { fs.unlinkSync(ACP_CACHE_PATH); } catch (e) { /* 忽略 */ }
}

// 列出 WorkBuddy 进程监听的本地端口（跨平台）：
//  - Windows : netstat 拿 端口↔PID，tasklist 拿 PID↔进程名
//  - macOS   : lsof  拿 端口↔PID，ps 拿 PID↔进程名
//  - 其它    : 暂不探测（返回空）
async function workBuddyPorts() {
  let ns = '', tl = '';
  if (process.platform === 'win32') {
    [ns, tl] = await Promise.all([
      runCmd('netstat.exe', ['-ano', '-p', 'TCP']),
      runCmd('tasklist.exe', ['/FO', 'CSV', '/NH'])
    ]);
  } else if (process.platform === 'darwin') {
    [ns, tl] = await Promise.all([
      runCmd('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P', '-F', 'pn']),
      runCmd('ps', ['-eo', 'pid,command'])
    ]);
  } else {
    return [];
  }
  const byPid = new Map();
  const wbPids = new Set();
  if (process.platform === 'win32') {
    for (const line of ns.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!m) continue;
      const host = m[1];
      if (host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '[::]' && host !== '[::1]' && host !== '::') continue;
      const port = Number(m[2]);
      const pid = m[3];
      if (!byPid.has(pid)) byPid.set(pid, new Set());
      byPid.get(pid).add(port);
    }
    for (const line of tl.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && /^workbuddy/i.test(m[1])) wbPids.add(m[2]);
    }
  } else { // darwin
    let curPid = null;
    for (const line of ns.split(/\n/)) {
      if (line.startsWith('p')) { curPid = line.slice(1).trim(); continue; }
      if (!line.startsWith('n') || !curPid) continue;
      const addr = line.slice(1);
      const mm = addr.match(/(\d+)$/);
      if (!mm) continue;
      const port = Number(mm[1]);
      const hostPart = addr.replace(/:\d+$/, '').replace(/[\[\]]/g, '');
      if (hostPart && hostPart !== '*' && hostPart !== '127.0.0.1' && hostPart !== '0.0.0.0' && hostPart !== '::' && hostPart !== '[::1]' && !hostPart.startsWith('127.')) continue;
      if (!byPid.has(curPid)) byPid.set(curPid, new Set());
      byPid.get(curPid).add(port);
    }
    for (const line of tl.split(/\n/)) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m && /workbuddy|codebuddy/i.test(m[2])) wbPids.add(String(m[1]));
    }
  }
  const ports = [];
  for (const pid of wbPids) for (const p of (byPid.get(pid) || [])) ports.push(p);
  return ports;
}

// 极简 HTTP 客户端（仅用于探针，不进代理链路）
function acpHttp(port, method, urlPath, headers, body) {
  return new Promise((resolve) => {
    const h = Object.assign({ 'x-codebuddy-request': '1' }, headers || {});
    const payload = body ? Buffer.from(body, 'utf-8') : null;
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: urlPath, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(); });
      res.on('end', () => done({ status: res.statusCode || 0, text: data }));
    });
    req.setTimeout(2500, () => { req.destroy(); done({ status: 0, text: '' }); });
    req.on('error', () => done({ status: 0, text: '' }));
    if (payload) req.write(payload);
    req.end();
  });
}

// 判定某个端口是不是 ACP：能 connect 出 connectionId + sessionToken 即命中。
// 探针用完立刻把这条连接还回去（DELETE），免得在 WorkBuddy 侧留下闲置连接。
async function probeAcpPort(port) {
  if (!port) return false;
  const r = await acpHttp(port, 'POST', '/api/v1/acp/connect', null, '{}');
  if (r.status !== 200) return false;
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { return false; }
  if (!j || !j.connectionId || !j.sessionToken) return false;
  acpHttp(port, 'DELETE', '/api/v1/acp',
    { 'acp-connection-id': j.connectionId, 'acp-session-token': j.sessionToken });
  return true;
}

async function discoverAcpPort() {
  if (discovering) return discovering;
  discovering = (async () => {
    const tried = [];
    const push = (arr, p) => {
      const n = Number(p);
      if (n > 0 && n < 65536 && arr.indexOf(n) === -1) arr.push(n);
    };
    const quick = [];
    push(quick, readPortCache());                 // 上次成功的端口（正常路径全靠它）
    push(quick, portFromUrl(ACP_BASE_HINT));      // config 里手动指定的
    (CONFIG.acpPortHints || []).forEach((p) => push(quick, p));  // config 里的候选

    // 阶段一：先试"已知端口"。命中就是毫秒级，不必去扫进程表。
    for (const p of quick) {
      tried.push(p);
      if (await probeAcpPort(p)) {
        acpPort = p;
        writePortCache(p);
        lastCandidates = tried.slice();
        log('ACP port (cached/hint): ' + p);
        return p;
      }
    }

    // 阶段二：扫 WorkBuddy 进程监听的端口。
    // 本机实测这一步经常要 10 秒以上——每次 spawn netstat/tasklist 都会被安全软件
    // 逐个扫描，而模型加载又在抢 CPU。所以只在阶段一全落空（端口变了/首次运行）时才做，
    // 且结果会写进缓存，下次直接走阶段一。
    if (CONFIG.acpAutoDiscover !== false) {
      const scanned = [];
      try { (await workBuddyPorts()).forEach((p) => push(scanned, p)); } catch (e) { /* 忽略 */ }
      for (const p of scanned) {
        tried.push(p);
        if (await probeAcpPort(p)) {
          acpPort = p;
          writePortCache(p);
          lastCandidates = tried.slice();
          log('ACP port discovered by scan: ' + p + ' (tried: ' + tried.join(',') + ')');
          return p;
        }
      }
    }

    acpPort = 0;
    lastCandidates = tried.slice();
    log('ACP port NOT found. tried: ' + (tried.join(',') || '(none)'));
    return 0;
  })();
  try { return await discovering; } finally { discovering = null; }
}

function acpHint() {
  const tried = lastCandidates.length ? lastCandidates.join('、') : '（未扫描到候选端口）';
  return '未找到 WorkBuddy 的 ACP 服务。已扫描 WorkBuddy 进程监听的端口：' + tried +
    '。请确认 WorkBuddy 桌面端正在运行。';
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// 探活：确认端口是否真的可用；必要时重新扫描。
// 注意这里会真的 connect 一次（随即释放），因为其它端口在 TCP 层也是通的，
// 只看"端口有没有监听"无法区分哪个是 ACP。
async function acpHealth(res) {
  let port = acpPort;
  let ok = port ? await probeAcpPort(port) : false;
  if (!ok) {
    dropPortCache();
    port = await discoverAcpPort();
    ok = !!port;
  }
  sendJson(res, 200, {
    ok: ok,
    port: port || 0,
    target: ok ? 'http://127.0.0.1:' + port : '',
    code: ok ? '' : 'NO_ACP',
    message: ok ? ('WorkBuddy ACP 在线（端口 ' + port + '，自动发现）') : acpHint(),
    candidates: lastCandidates
  });
}

async function acpProxy(req, res, urlPath, query) {
  let port = acpPort;
  if (!port) port = await discoverAcpPort();
  if (!port) {
    sendJson(res, 502, { error: acpHint(), code: 'NO_ACP', candidates: lastCandidates });
    return;
  }

  const headers = Object.assign({}, req.headers);
  // 这几个头是给本机服务器用的，转发出去反而会让上游按错误来源处理请求
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  delete headers.connection;

  const up = http.request({
    host: '127.0.0.1', port: port, method: req.method, path: urlPath + query, headers: headers
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    if (typeof res.flushHeaders === 'function') res.flushHeaders(); // SSE 需要立刻把响应头送出去
    upRes.pipe(res);
  });

  up.setNoDelay(true); // 关掉 Nagle，否则 SSE 事件会被攒着一起发
  up.on('error', (err) => {
    const code = (err && err.code) || '';
    // 连不上说明这个端口已经作废（WorkBuddy 重启后端口会变）：丢掉缓存，下次重新扫描
    acpPort = 0;
    dropPortCache();
    if (res.headersSent) { try { res.end(); } catch (e) { /* 忽略 */ } return; }
    sendJson(res, 502, {
      error: '连接 WorkBuddy ACP（端口 ' + port + '）失败：' + (code || '未知错误') +
        '。端口可能已变化，已在后台重新扫描。',
      code: code, candidates: lastCandidates
    });
  });
  req.on('error', () => { try { up.destroy(); } catch (e) { /* 忽略 */ } });
  req.pipe(up);
}

function clampCursor(v, m) { return Math.max(-m, Math.min(m, v)); }
// 全局光标方向：主进程用 screen.getCursorScreenPoint()（跨多显示器，主屏左上为原点）
// 与窗口 getBounds() 相减，得到从窗口中心指向光标的归一化向量（dx/dy 可能 >1，已截断）。
function cursorHandler(res) {
  if (!winAlive()) { sendJson(res, 200, { dx: 0, dy: 0, inside: false }); return; }
  const b = mainWin.getBounds();
  const p = screen.getCursorScreenPoint();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const dx = (p.x - cx) / (b.width / 2);
  const dy = (p.y - cy) / (b.height / 2);
  const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  sendJson(res, 200, {
    dx: clampCursor(dx, 1.5),
    dy: clampCursor(dy, 1.5),
    inside: !!inside
  });
}

// ---------------------------------------------------------------------------
// Chromium 子进程沙箱
// ---------------------------------------------------------------------------
// 症状：窗口永远不出现，终端反复打印
//   ERROR:gpu_process_host.cc GPU process exited unexpectedly: exit_code=1
//   FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.
// 实测（本机 Electron 30.5.1 / Chromium 124）：这类环境下渲染进程连 about:blank
// 都加载不了（ERR_FAILED -2），webgl / gpu_compositing 全为 disabled_off，
// Live2D 必然画不出来；而加上 --no-sandbox 后 GPU 合成、WebGL1/2 立刻恢复
// （ANGLE + Direct3D11 走真实显卡）。
// 原因不在显卡，而是 chromium 的渲染进程沙箱在该进程上下文里无法初始化。
// 本程序所有内容都来自本机（自建的 127.0.0.1 静态服务 + 本机模型目录），
// 不加载任何远程页面，故默认关闭沙箱以保证可用性。
// 若你的环境沙箱正常、希望恢复，把 config.json 的 "chromiumSandbox" 改为 true。
// 注意：该开关必须在 app ready 之前声明，否则对子进程不生效。
if (CONFIG.chromiumSandbox !== true) {
  app.commandLine.appendSwitch('no-sandbox');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.moc3': 'application/octet-stream',
  '.moc': 'application/octet-stream',
  '.model3.json': 'application/json; charset=utf-8',
  '.physics3.json': 'application/json; charset=utf-8',
  '.cdi3.json': 'application/json; charset=utf-8',
  '.motion3.json': 'application/json; charset=utf-8',
  '.exp3.json': 'application/json; charset=utf-8',
  '.pose3.json': 'application/json; charset=utf-8',
  '.userdata3.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function safeJoin(base, target) {
  if (!base) return null;
  // 注意：config.json 里路径可能写成正斜杠（如 D:/Steam.../Live2DModels），
  // 而 path.join/path.resolve 会统一成反斜杠。若直接拿未归一化的 base 去
  // startsWith，正常请求也会被判为越界而返回 403（曾踩此坑）。
  // Windows 路径大小写不敏感，比较时统一转小写。
  const baseNorm = path.resolve(base);
  const p = path.resolve(baseNorm, target);
  const a = p.toLowerCase();
  const b = baseNorm.toLowerCase();
  if (a !== b && !a.startsWith(b + path.sep)) return null; // 目录穿越防护
  return p;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + filePath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    // 必须禁缓存：Electron 的磁盘缓存在多次启动之间是保留的，而 127.0.0.1 的响应
    // 不带缓存头时会走启发式缓存。改完 CSS/JS 重启却看到旧样式，就是这么来的。
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// 模型素材注入（Motions / Expressions）
// ---------------------------------------------------------------------------
// 背景：不少从 VTube Studio 导出的模型，其 .motion3.json / .exp3.json 就躺在模型
// 目录里，却没被写进 model3.json 的 FileReferences —— 于是 pixi-live2d-display 根本
// 不会加载它们，用户在设置页里"选了动作也播不出来"。
//
// 解决办法：不改磁盘上的模型文件，而是在服务层返回 *.model3.json 时，按
// config.modelAssets 的配置**动态补写** FileReferences。明文与 .enc 两条路径都走这里。
//
// config.modelAssets 结构（键 = model3.json 相对模型库的路径，正斜杠）：
//   {
//     "Hotaru2024/hotaru2024.model3.json": {
//       "motions":     [ { "group":"idle", "file":"idle.motion3.json", "loop":true,
//                          "fadeIn":0.5, "fadeOut":0.5 } ],
//       "expressions": [ { "name":"custom", "file":"exp3/custom.exp3.json" } ]
//     }
//   }
function injectModelAssets(text, relPath) {
  const key = String(relPath || '').replace(/\\/g, '/');
  const cfg = CONFIG.modelAssets && CONFIG.modelAssets[key];
  if (!cfg) return null;
  let j;
  try { j = JSON.parse(text); } catch (e) { return null; }
  const fr = j.FileReferences || (j.FileReferences = {});
  let changed = false;

  if (Array.isArray(cfg.motions) && cfg.motions.length) {
    const mo = fr.Motions || (fr.Motions = {});
    for (const m of cfg.motions) {
      if (!m || !m.group || !m.file) continue;
      const g = String(m.group);
      if (!Array.isArray(mo[g])) mo[g] = [];
      const dup = mo[g].some((x) => x && String(x.File).toLowerCase() === String(m.file).toLowerCase());
      if (dup) continue;
      const ent = { File: String(m.file) };
      ent.FadeIn = (m.fadeIn != null) ? Number(m.fadeIn) : 0.5;
      ent.FadeOut = (m.fadeOut != null) ? Number(m.fadeOut) : 0.5;
      if (m.loop) ent.Loop = true;
      mo[g].push(ent);
      changed = true;
    }
  }

  if (Array.isArray(cfg.expressions) && cfg.expressions.length) {
    const ex = fr.Expressions || (fr.Expressions = []);
    for (const e of cfg.expressions) {
      if (!e || !e.file) continue;
      const name = String(e.name || path.basename(String(e.file)).replace(/\.exp3\.json$/i, ''));
      if (ex.some((x) => x && String(x.Name) === name)) continue;
      ex.push({ Name: name, File: String(e.file) });
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(j), 'utf-8') : null;
}

// 通用二进制响应（与 sendFile 同款缓存/跨域头）
function sendBuffer(res, buf, filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': ct,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(buf);
}

// 模型资源发送：明文优先；若磁盘上是同名 .enc，则 AES-256-CBC 解密后返回。
// 磁盘不落明文 moc3/纹理，别人解包拿到的是打不开的 .enc（混淆级防盗，非 DRM）。
// KEY 派生参数与 tools/encrypt-models.js 完全一致。
// relPath 用于查 config.modelAssets（model3.json 的动态注入按相对路径做键）。
const MODEL_ENC_KEY = crypto.scryptSync('HotaruDesktopPet-Live2D-2024', 'static-salt-v1', 32);
function sendModelFile(res, filePath, relPath) {
  const isModel3 = /\.model3\.json$/i.test(String(relPath || filePath));
  const finish = (buf) => {
    if (isModel3) {
      const injected = injectModelAssets(buf.toString('utf-8'), relPath);
      if (injected) {
        // 注入后长度会变，用 JSON 的 Content-Type 单独走一次响应（sendBuffer 会按扩展名给 json）
        return sendBuffer(res, injected, filePath);
      }
    }
    return sendBuffer(res, buf, filePath);
  };
  if (fs.existsSync(filePath)) {
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found: ' + filePath); return; }
      finish(data);
    });
    return;
  }
  const enc = filePath + '.enc';
  if (!fs.existsSync(enc)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + filePath);
    return;
  }
  let plain;
  try {
    const data = fs.readFileSync(enc);
    const iv = data.slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', MODEL_ENC_KEY, iv);
    plain = Buffer.concat([decipher.update(data.slice(16)), decipher.final()]);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('model decrypt failed: ' + e.message);
    return;
  }
  finish(plain);
}

// ---------------------------------------------------------------------------
// 用户自录音频（R2）
// ---------------------------------------------------------------------------
// 台词档目录：app/data/lines/profiles/<id>.json
const LINE_PROFILES_DIR = path.join(APP_DIR, 'data', 'lines', 'profiles');

// 收集全部台词档里被引用过的"用户自录音频"绝对路径 —— 作为 /api/user-audio 的白名单。
// 只放行这些路径，避免该接口退化成任意文件读取。
function collectUserAudioPaths() {
  const set = new Set();
  try {
    if (!fs.existsSync(LINE_PROFILES_DIR)) return set;
    for (const f of fs.readdirSync(LINE_PROFILES_DIR)) {
      if (!/\.json$/i.test(f)) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(LINE_PROFILES_DIR, f), 'utf-8')); } catch (e) { continue; }
      for (const pool of ['click', 'idle']) {
        const arr = (j && j[pool]) || [];
        for (const ent of arr) {
          const v = ent && ent.voice;
          if (!v || typeof v !== 'object') continue;
          for (const lang of Object.keys(v)) {
            const src = v[lang];
            if (src && src.src === 'abs' && src.file) {
              try { set.add(path.resolve(String(src.file)).toLowerCase()); } catch (e) { /* 忽略 */ }
            }
          }
        }
      }
    }
  } catch (e) { /* 忽略 */ }
  return set;
}

function userAudioHandler(req, res, query) {
  let p = '';
  try { p = new URLSearchParams(String(query || '').replace(/^\?/, '')).get('path') || ''; } catch (e) { p = ''; }
  if (!p) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('missing path'); return; }
  if (!/^\.(wav|mp3|m4a|aac|ogg|opus|flac|weba)$/i.test(path.extname(p))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('unsupported audio type'); return;
  }
  let abs;
  try { abs = path.resolve(p); } catch (e) { abs = ''; }
  if (!abs) { res.writeHead(400); res.end('bad path'); return; }
  const allow = collectUserAudioPaths();
  if (!allow.has(abs.toLowerCase())) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not referenced by any line profile');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found: ' + abs); return; }
    sendBuffer(res, data, abs);
  });
}

// 递归查找 *.model3.json（含加密的 .model3.json.enc），返回模型清单。
// 用于设置页「模型」分页：把模型库里的模型列出来供选择。
function readModelName(file) {
  try {
    let buf;
    if (/\.enc$/i.test(file)) buf = decryptModelFile(file);
    else buf = fs.readFileSync(file);
    if (!buf) return '';
    const j = JSON.parse(buf.toString('utf-8'));
    if (j && typeof j.Name === 'string' && j.Name.trim()) return j.Name.trim();
  } catch (e) { /* 忽略 */ }
  return '';
}

function decryptModelFile(file) {
  try {
    const data = fs.readFileSync(file);
    const iv = data.slice(0, 16);
    const d = crypto.createDecipheriv('aes-256-cbc', MODEL_ENC_KEY, iv);
    return Buffer.concat([d.update(data.slice(16)), d.final()]);
  } catch (e) { return null; }
}

function scanModels(dir, maxDepth) {
  const out = [];
  const depth = (maxDepth == null) ? 4 : maxDepth;
  const walk = (d, lv) => {
    if (lv > depth) return;
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, lv + 1); continue; }
      if (!/\.model3\.json(\.enc)?$/i.test(e.name)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e2) { /* 忽略 */ }
      const name = readModelName(p) || path.basename(path.dirname(d)) || path.basename(d);
      out.push({
        name: name,
        rel: path.relative(dir, p).replace(/\\/g, '/'),
        dir: path.relative(dir, path.dirname(p)).replace(/\\/g, '/') || '.',
        size: size
      });
    }
  };
  walk(dir, 0);
  out.sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
  return out;
}

// 列出某个模型目录下的动作/表情素材（*.motion3.json / *.exp3.json，含 .enc）。
// 返回相对 model3.json 所在目录的路径（可直接写进 FileReferences）。
function scanModelAssets(modelUrl) {
  const base = modelServeBase();
  const rel = String(modelUrl || '').replace(/^\/models\//, '');
  const fp = base ? safeJoin(base, rel) : null;
  if (!fp) return { error: '模型路径非法' };
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) return { error: '模型目录不存在：' + dir, dir: dir };
  const motions = [], expressions = [];
  const walk = (d, lv) => {
    if (lv > 2) return;
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, lv + 1); continue; }
      const r = path.relative(dir, p).replace(/\\/g, '/');
      const clean = r.replace(/\.enc$/i, '');
      if (/\.motion3\.json$/i.test(clean)) motions.push({ file: clean, rel: r, name: path.basename(clean, '.motion3.json') });
      else if (/\.exp3\.json$/i.test(clean)) expressions.push({ file: clean, rel: r, name: path.basename(clean, '.exp3.json') });
    }
  };
  walk(dir, 0);
  motions.sort((a, b) => a.file.localeCompare(b.file));
  expressions.sort((a, b) => a.file.localeCompare(b.file));
  return { dir: path.relative(base, dir).replace(/\\/g, '/'), motions: motions, expressions: expressions };
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const query = qIdx >= 0 ? rawUrl.slice(qIdx) : '';
  let urlPath = decodeURIComponent(qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl);
  if (urlPath === '/') urlPath = '/index.html';

  // /api/cursor -> 全局光标相对窗口的方向（跨所有显示器）；驱动视线跟随
  if (urlPath === '/api/cursor') return cursorHandler(res);

  // /api/tts -> 本地 TTS 语音侧车（同源代理）；/api/tts/health -> 引擎状态
  if (urlPath === '/api/tts') return ttsProxy(res, query);
  if (urlPath === '/api/tts/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      ok: ttsState.ok, enabled: ttsState.enabled, engine: ttsState.active,
      want: ttsState.want, engines: ttsState.engines
    }));
  }

  // /api/ollama/* -> 本机 Ollama（本地聊天模型）
  if (urlPath.startsWith('/api/ollama/')) return ollamaProxy(req, res, urlPath);

  // /api/cloud/* -> 云端 OpenAI 兼容接口（地址与密钥由渲染进程经请求头给出）
  if (urlPath.startsWith('/api/cloud/')) return cloudProxy(req, res, urlPath);

  // /api/v1/acp* -> WorkBuddy 本地 ACP 服务（同源代理，绕开跨域并给出可读错误）
  // 注意 /api/v1/acp/health 必须排在前面：它也以 /api/v1/acp 开头。
  if (urlPath === '/api/v1/acp/health') return acpHealth(res);
  if (urlPath === '/api/v1/acp' || urlPath.startsWith('/api/v1/acp/')) {
    return acpProxy(req, res, urlPath, query);
  }

  // /user-audio -> 用户自录音频（R2：台词语音可用自己录的文件，引用原路径）
  // 页面来自 http://127.0.0.1，直接 file:///D:/x.wav 会被 Chromium 拦截，故走同源代理。
  // 只放行音频扩展名、且必须是被 config 里某条台词的 voice 引用过的路径（白名单），
  // 避免变成"任意文件读取"入口。
  if (urlPath === '/api/user-audio') return userAudioHandler(req, res, query);

  // /models/* -> 本机模型目录（支持 .enc 加密资源：主进程内存解密后返回）
  // 库根目录每次请求读 CONFIG（见 modelServeBase），所以设置里换库无需重启。
  if (urlPath.startsWith('/models/')) {
    const base = modelServeBase();
    const rel = urlPath.slice('/models/'.length);
    const fp = base ? safeJoin(base, rel) : null;
    if (fp) return sendModelFile(res, fp, rel);
    res.writeHead(403); res.end('forbidden'); return;
  }

  // /node_modules/* -> 项目依赖
  // 注意：前缀必须整段切掉。曾写成 urlPath.slice(1)，只去掉了开头的斜杠，
  // "node_modules/" 被保留下来与 NM_DIR 拼成 node_modules\node_modules\...，
  // 于是所有依赖请求全部 404，页面上 pixi / cubism core / display 都加载不到。
  if (urlPath.startsWith('/node_modules/')) {
    const fp = safeJoin(NM_DIR, urlPath.slice('/node_modules/'.length));
    if (fp) return sendFile(res, fp);
    res.writeHead(404); res.end('not found'); return;
  }

  // /app/* -> app 目录（app/index.html 内部引用的是 /app/ 前缀）
  // 曾漏掉这条规则：/app/styles.css 会被拼成 app\app\styles.css 而 404。
  if (urlPath.startsWith('/app/')) {
    const fp = safeJoin(APP_DIR, urlPath.slice('/app/'.length));
    if (fp) return sendFile(res, fp);
    res.writeHead(404); res.end('not found'); return;
  }

  // 其余 -> app/（兼容根相对写法，如 /config.json、/js/app.js）
  const rel = urlPath.replace(/^\/+/, '');
  const fp = safeJoin(APP_DIR, rel);
  if (fp) return sendFile(res, fp);
  res.writeHead(404); res.end('not found');
});

// 窗口位置/大小记忆：把 BrowserWindow 的 bounds(x,y,width,height) 落盘，
// 下次启动时恢复，避免每次打开都要重新拉伸/移动窗口。
function loadWindowBounds() {
  try {
    const o = JSON.parse(fs.readFileSync(WIN_BOUNDS_PATH, 'utf-8'));
    if (o && typeof o.x === 'number' && typeof o.y === 'number' &&
        typeof o.width === 'number' && typeof o.height === 'number' &&
        o.width >= 240 && o.height >= 200) {
      return { x: Math.round(o.x), y: Math.round(o.y), width: Math.round(o.width), height: Math.round(o.height), locked: !!o.locked };
    }
  } catch (e) {}
  return null;
}
function saveWindowBounds() {
  if (!winAlive()) return;
  try {
    const b = mainWin.getBounds();
    fs.writeFileSync(WIN_BOUNDS_PATH,
      JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, locked: !!appState.locked }), 'utf-8');
    log('window bounds saved: x=' + b.x + ' y=' + b.y + ' w=' + b.width + ' h=' + b.height + ' locked=' + !!appState.locked);
  } catch (e) {}
}

// 窗口锁：锁定后禁止用户移动窗口（拖拽区失效）与缩放窗口（缩放边缘失效），
// 并落盘到 window-bounds.json 的 locked 字段，保证重启后仍保持锁定。
function applyWindowLock(v) {
  appState.locked = !!v;
  if (winAlive()) {
    try { mainWin.setMovable(!appState.locked); } catch (e) {}
    try { mainWin.setResizable(!appState.locked); } catch (e) {}
  }
  saveWindowBounds();
}

function createWindow() {
  const w = (CONFIG.window && CONFIG.window.width) || 360;
  const h = (CONFIG.window && CONFIG.window.height) || 540;
  // 恢复上次记忆的窗口位置/大小（若存在且合法）；否则用 config.json 默认值
  const saved = loadWindowBounds();
  const win = new BrowserWindow({
    width: (saved && saved.width) || w,
    height: (saved && saved.height) || h,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // 记忆恢复：若保存的位置落在已断开的显示器上，窗口会消失在屏幕外——
  // 此时放弃恢复、回到默认尺寸并居中，避免"窗口不见了"。
  if (saved) {
    try {
      const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height }).workArea;
      const onScreen = saved.x < area.x + area.width && saved.y < area.y + area.height &&
                       saved.x + saved.width > area.x && saved.y + saved.height > area.y;
      if (!onScreen) { win.center(); log('saved window bounds off-screen; recentered'); }
    } catch (e) {}
  }
  if (saved && saved.locked) {
    // 上次锁定过：启动即禁止移动/缩放窗口（拖拽区与缩放边缘均失效）
    appState.locked = true;
    try { win.setMovable(false); } catch (e) {}
    try { win.setResizable(false); } catch (e) {}
  }
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.once('ready-to-show', () => win.show());
  mainWin = win;
  // 页面加载完成后下发初始 UI 字体（字号/字体族）与表情情绪开关，让渲染进程按 config.json 当前值应用
  win.webContents.once('did-finish-load', () => {
    try { sendUI(); } catch (e) {}
    try { sendViseme('pet:setEmotionEnabled', emoState.enabled); } catch (e) {}
    try { sendViseme('pet:setIdleEnabled', idleState.enabled); } catch (e) {}
  });
  // 渲染进程崩溃诊断：透明窗口崩溃后肉眼看不出（画布变全透明=凭空消失），主进程却在。
  // 这里把崩溃原因写进 app.log，避免下次再出现"窗口没了但进程还在"却无任何线索。
  win.webContents.on('render-process-gone', (event, details) => {
    log('渲染进程崩溃（窗口不可见）：reason=' + (details && details.reason) +
      ' exitCode=' + (details && details.exitCode) + '（透明窗崩溃后看似消失，主进程仍存活）');
  });
  // 拖动/缩放窗口时防抖落盘（每 400ms 最多写一次），保证关闭时位置/大小已保存
  let boundsTimer = null;
  const scheduleSave = () => {
    if (boundsTimer) return;
    boundsTimer = setTimeout(() => { boundsTimer = null; saveWindowBounds(); }, 400);
  };
  win.on('resized', scheduleSave);
  win.on('moved', scheduleSave);
  win.on('close', saveWindowBounds);
  log('browser window created (w=' + win.getBounds().width + ' h=' + win.getBounds().height +
    (saved ? ', restored from saved bounds' : ', default size') + ', skipTaskbar=true)');
  return win;
}

// ---------------------------------------------------------------------------
// 单实例锁：避免多次双击产生多个进程抢端口 18765（曾是"双击没反应"的诱因之一）。
// 第二个实例会把已有窗口提到前台并自行退出。
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log('another instance already holds the single-instance lock; quit this one');
  app.quit();
}
app.on('second-instance', () => {
  // 用户第二次双击图标时的正确反馈：把"已经存在的那个窗口"提到前台。
  // 旧实现只处理主窗口：若此刻桌面上只有"选择聊天大脑"窗（启动流程卡在选大脑这一步），
  // mainWin 仍是 null → 什么都不做 → 双击毫无反应，看起来就像"桌宠打不开了"。
  const target = firstAliveWindow();
  if (target) {
    log('second-instance：把已有窗口提到前台（' + describeWindow(target) + '）');
    showAndFocus(target, '已有窗口');
    return;
  }
  log('second-instance：当前没有任何窗口，直接启动桌宠');
  if (server.listening) bootPet();
  else log('second-instance：本地服务尚未就绪，跳过（本实例稍后会自行建窗）');
});

// 端口被占用时给出明确日志（而非静默崩溃）
server.on('error', (err) => {
  log('static server error:', err && err.message);
  if (winAlive()) {
    try { mainWin.webContents.send('pet:fatal', '本地服务启动失败：' + (err && err.message)); } catch (e) {}
  }
});

app.whenReady().then(() => {
  // 本实例已判定为"第二个实例"并决定退出：不要再起静态服务，否则会额外报一条
  // EADDRINUSE 噪音日志，把真正的退出原因盖住。
  if (!gotSingleInstanceLock) return;
  server.listen(PORT, '127.0.0.1', () => {
    log('static server on http://127.0.0.1:' + PORT + '/');
    // 预热：后台先把 ACP 端口扫出来，页面 ~1 秒后的 /api/v1/acp/health 就能直接命中
    // （两个调用共用同一个 discovering Promise，不会重复扫描）
    discoverAcpPort();
    // 拉起本地 TTS 语音侧车（失败不影响其余功能）
    ttsSpawn();
    // 拉起音频侧车（方案③：逐端点回环；失败不影响其余功能，设置窗会显示不可用）
    audioSpawn();
    // 恢复上次配置的全局快捷键（范围 = 全局时才注册）
    try { refreshHotkeys(); } catch (e) {}

    // 启动先问一句"用哪个大脑"。askEveryStart 为 true（默认）时每次都问；
    // 用户在窗里勾了"下次不再询问"就置 false，之后直接沿用记住的那个。
    if (CONFIG.chat.askEveryStart !== false) {
      openBrainChooser(() => bootPet());
      // 两道兜底，避免"选择窗没显示出来 / 用户没回应"时，程序静默地一个窗口都没有
      // （旧版就是这样把自己卡死的：进程在跑、桌面空白、双击图标还没反应，只能强杀）。
      // 1) 4s 内选择窗仍未可见 → 直接启动桌宠；选择窗继续留着，用户仍可随时改。
      setTimeout(() => {
        if (winAlive()) return;
        if (!brainWin || brainWin.isDestroyed() || !brainWin.isVisible()) {
          log('选择窗 4s 内未显示，直接启动桌宠（避免"无窗口"死锁态）');
          bootPet();
        }
      }, 4000);
      // 2) 60s 内始终没做出选择 → 用已保存的大脑启动，不留一个空白桌面。
      brainChooserWatchdog = setTimeout(() => {
        brainChooserWatchdog = null;
        if (winAlive()) return;
        log('选择窗 60s 内未完成选择，改用已保存的大脑（' + CONFIG.chat.backend + '）启动桌宠');
        bootPet();
      }, 60000);
    } else {
      bootPet();
    }
  });
});

// 桌宠主窗口 + 托盘。之所以抽出来：选择窗关掉之后才建主窗口，
// 这样"选大脑"这一步不会被桌宠窗口抢焦点。
// 注意：本函数会被多个入口调用（选择窗回调、启动兜底定时器、second-instance），
// 因此必须幂等（winAlive 早返回）且绝不能抛出去——它常处在事件回调里，抛错会变成"莫名没有窗口"。
function bootPet() {
  if (brainChooserWatchdog) { clearTimeout(brainChooserWatchdog); brainChooserWatchdog = null; }
  // 退出流程中绝不建窗：关掉选择窗会触发 closed → 回调 → bootPet，
  // 若此刻正在退出，新建的桌宠窗口会让进程退不干净（残留实例还会一直占着单实例锁，
  // 导致下次双击图标"毫无反应"）。这是"关掉后再打开打不开"的成因之一。
  if (app.isQuiting) { log('bootPet：正在退出，跳过建窗'); return; }
  if (winAlive()) return;
  try {
    createWindow();
    createTray();
  } catch (e) {
    log('bootPet 失败（创建桌宠窗口/托盘时抛错）：' + ((e && e.stack) || e));
    return;
  }
  // 主窗口加载完会把当前大脑下发一次（见 createWindow 的 did-finish-load）
}

// ---------------------------------------------------------------------------
// 应用级状态（托盘菜单的单一可信源）。渲染进程里的 UI 锁按钮与托盘锁菜单都经由
// ipcMain('pet:lock') 写入这里，再由主进程统一下发 'pet:applyLock' 给渲染进程，
// 保证两个入口的"锁定"状态始终一致。
// ---------------------------------------------------------------------------
const appState = { locked: false };
// 口型调试面板的可视状态（与 config.json 默认值保持一致；用户经托盘菜单实时改写）
const visemeDbg = { family: 'auto', driveOpenY: true, silenceSpeaking: 0 };
const VOWEL_FAMILIES = [
  { id: 'auto', label: '自动探测' },
  { id: 'Param', label: 'Param (A/I/U/E/O)' },
  { id: 'ParamMouth', label: 'ParamMouth' },
  { id: 'Mouth', label: 'Mouth' },
  { id: 'Vowel', label: 'Vowel' },
  { id: 'ParamVowel', label: 'ParamVowel' }
];
// 界面字体（字号/字体族）的可视状态：与 config.json 默认值一致，用户经托盘菜单实时改写并落盘。
// fontSize 单位 px（设计基准 14px，渲染进程换算成 --ui-scale 倍率）；fontFamily 空串表示"系统默认"。
const uiState = {
  fontSize: (typeof CONFIG.uiFontSize === 'number' && CONFIG.uiFontSize >= 8 && CONFIG.uiFontSize <= 64) ? CONFIG.uiFontSize : 14,
  fontFamily: (typeof CONFIG.uiFontFamily === 'string') ? CONFIG.uiFontFamily : ''
};
const UI_FONT_SIZES = [12, 14, 16, 18, 20, 22, 24, 28];
const UI_FONT_FAMILIES = [
  { id: '', label: '系统默认' },
  { id: 'Microsoft YaHei', label: '微软雅黑' },
  { id: 'Sarasa Mono SC', label: '等距更纱黑体 Sarasa Mono SC' },
  { id: 'Sarasa SC', label: '更纱黑体 Sarasa SC' },
  { id: 'SimHei', label: '黑体' },
  { id: 'DengXian', label: '等线' }
];
// 情绪/表情层开关（随台词自动做五官表情）。与 config.json 默认一致，托盘可实时改写并落盘。
const emoState = { enabled: CONFIG.emotionEnabled !== false };
// 待机台词（自动随机播放）开关。关闭后只是不再自动出现台词；底栏「待机」按钮仍可手动触发一次。
const idleState = { enabled: CONFIG.idleLinesEnabled !== false };
// 把当前 uiState 下发到渲染进程应用，并写回 config.json 持久化。
function applyUI(size, family) {
  if (typeof size === 'number' && size >= 8 && size <= 64) uiState.fontSize = Math.round(size);
  if (typeof family === 'string') uiState.fontFamily = family;
  if (winAlive()) mainWin.webContents.send('pet:setUIFont', { fontSize: uiState.fontSize, fontFamily: uiState.fontFamily });
  saveConfig();
}
function sendUI() {
  if (winAlive()) mainWin.webContents.send('pet:setUIFont', { fontSize: uiState.fontSize, fontFamily: uiState.fontFamily });
}
// 把当前配置写回 app/config.json。CONFIG 是配置的单一真相来源（含模型路径/端口/屏幕追踪等），
// 这里先把运行时状态镜像（字体/表情/待机/TTS/追踪开关）同步进 CONFIG，再整体落盘，
// 保证托盘菜单的实时改动与设置窗的写回互不丢字段。
function saveConfig() {
  try {
    CONFIG.uiFontSize = uiState.fontSize;
    CONFIG.uiFontFamily = uiState.fontFamily;
    CONFIG.emotionEnabled = emoState.enabled;
    CONFIG.ttsEnabled = ttsState.enabled;
    CONFIG.ttsEngine = ttsState.want;
    CONFIG.idleLinesEnabled = idleState.enabled;
    CONFIG.screenTrack = CONFIG.screenTrack || {};
    CONFIG.screenTrack.enabled = screenTrackState.enabled;
    CONFIG.mouseFollow = mouseFollowState.enabled;
    fs.writeFileSync(path.join(APP_DIR, 'config.json'), JSON.stringify(CONFIG, null, 2), 'utf-8');
    log('config saved (keys=' + Object.keys(CONFIG).length + ')');
  } catch (e) { log('save config failed: ' + e.message); }
}
// 轻量输入窗：托盘菜单无输入框，用一个小 BrowserWindow 收集"自定义字号/字体名"。
let promptWin = null;
let promptCb = null;
function promptInput(title, placeholder, defaultValue, onOk) {
  if (promptWin && !promptWin.isDestroyed()) { try { promptWin.close(); } catch (e) {} }
  promptCb = onOk;
  const w = new BrowserWindow({
    width: 340, height: 172,
    minWidth: 280, minHeight: 150,
    title: title,
    resizable: false,
    frame: true,
    show: true,
    backgroundColor: '#11151c',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;padding:14px;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#e8eef6;background:#11151c;box-sizing:border-box}' +
    '.t{font-size:13px;margin-bottom:8px}.hint{font-size:11px;color:#93a0b5;margin-top:8px}' +
    'input{width:100%;box-sizing:border-box;padding:7px 9px;font-size:14px;border-radius:8px;border:1px solid rgba(0,229,255,.4);background:rgba(4,8,14,.6);color:#e8eef6;outline:none}' +
    '.row{text-align:right;margin-top:12px}button{padding:6px 16px;font-size:13px;border:none;border-radius:8px;background:linear-gradient(135deg,#00e5ff,#1b9fd6);color:#04141a;cursor:pointer;font-weight:600}' +
    '</style></head><body>' +
    '<div class="t">' + esc(title) + '</div>' +
    '<input id="v" value="' + esc(defaultValue) + '" placeholder="' + esc(placeholder) + '">' +
    '<div class="hint">回车确认 / Esc 取消</div>' +
    '<div class="row"><button id="ok">确定</button></div>' +
    '<script>' +
    'var ipc=window.desktopPet;' +
    'function done(){try{ipc.send("pet:promptResult",document.getElementById("v").value);}catch(e){}window.close();}' +
    'document.getElementById("ok").onclick=done;' +
    'var i=document.getElementById("v");i.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();done();}else if(e.key==="Escape"){window.close();}});' +
    'setTimeout(function(){try{i.focus();i.select();}catch(e){}},60);' +
    '</script></body></html>';
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  w.once('ready-to-show', () => { try { w.show(); } catch (e) {} });
  w.on('closed', () => { promptWin = null; });
  promptWin = w;
}
function sendViseme(channel, val) {
  if (winAlive()) mainWin.webContents.send(channel, val);
}
let mainWin = null;
let tray = null;
let debugWin = null;
let settingsWin = null;
let screenDebugWin = null;   // 屏幕追踪调试面板窗口（独立窗口，实时可视化识别到的物体）
let lastScreenDiag = null;    // 最近一帧屏幕追踪检测实况（调试窗就绪后补发给它，避免首帧收不到画面）
let musicDebugWin = null;    // 音律识别调试面板窗口（实时可视化能量/起音/律动波形/实际写入的模型参数）
let lastMusicDiag = null;    // 最近一份音律识别诊断快照（调试窗就绪后补发，避免首帧空白）
let brainChooserWatchdog = null;  // 启动时"选大脑"未回应/未显示的兜底定时器（确保桌宠最终一定会被拉起来）
// 屏幕运动追踪开关（托盘菜单勾选态的唯一来源；渲染进程的追踪器实启停后回传 pet:screenTrackState 同步）
let screenTrackState = { enabled: !!(CONFIG.screenTrack && CONFIG.screenTrack.enabled) };
// 鼠标追踪总开关（默认开；关闭后视线不跟光标，只跟屏幕运动或回正）
let mouseFollowState = { enabled: CONFIG.mouseFollow !== false };
// 音律识别（BPM/节拍驱动闭眼跟拍）开关。默认关；开启后由渲染进程拉起系统音频采集。
let musicState = { enabled: !!(CONFIG.music && CONFIG.music.enabled) };

// 窗口是否仍可安全操作：托盘菜单/事件回调在窗口已销毁（如退出流程中）后仍可能触发，
// 此时 mainWin 非空但内部已失效，直接调用 isVisible()/webContents.send 会抛异常
// （表现为系统错误音 + 托盘菜单不再弹出 + 托盘/进程残留）。统一用此判定兜底。
function winAlive() { return !!mainWin && !mainWin.isDestroyed(); }

// ---------------------------------------------------------------------------
// 窗口显示/前置的统一收口。
// 教训：只调 win.focus() 是不够的——若目标窗口还处于"隐藏/最小化"状态，focus 不会让它
// 出现，用户看到的就是"点了设置却没反应"。这里保证"先恢复、再显示、再置顶、最后聚焦"。
// ---------------------------------------------------------------------------
function showAndFocus(win, tag) {
  if (!win || win.isDestroyed()) return false;
  const wasVisible = (() => { try { return win.isVisible(); } catch (e) { return false; } })();
  try { if (win.isMinimized()) win.restore(); } catch (e) {}
  try { if (!win.isVisible()) win.show(); } catch (e) {}
  try { win.moveTop(); } catch (e) {}
  try { win.focus(); } catch (e) {}
  try {
    const nowVisible = win.isVisible();
    if (!wasVisible || !nowVisible) log(tag + '：显示窗口 visible=' + nowVisible + '（此前 ' + wasVisible + '）');
  } catch (e) {}
  return true;
}
// 当前还活着的窗口里最"该被提到前台"的一个（主窗口优先，其次设置/选择/调试窗）
function firstAliveWindow() {
  const cands = [mainWin, settingsWin, brainWin, ollamaSetupWin, debugWin, screenDebugWin, musicDebugWin];
  for (let i = 0; i < cands.length; i++) {
    const w = cands[i];
    try { if (w && !w.isDestroyed()) return w; } catch (e) {}
  }
  return null;
}
function describeWindow(win) {
  try {
    if (!win || win.isDestroyed()) return '(已销毁)';
    return 'url=' + win.webContents.getURL() + ' visible=' + win.isVisible();
  } catch (e) { return '(未知)'; }
}
// 托盘菜单里"需要新建窗口"的动作统一延后一帧执行：菜单仍处于展开（模态消息循环）时同步
// new BrowserWindow，Windows 无法完成前台焦点转移，表现为系统错误音 + 窗口不弹出 + 托盘
// 右键失灵（只能强杀进程）。与「退出」项同理。
function deferMenuAction(fn, tag) {
  setTimeout(() => {
    try { fn(); }
    catch (e) { log('[托盘菜单] ' + tag + ' 执行失败：' + ((e && e.stack) || e)); }
  }, 60);
}

// ---------------------------------------------------------------------------
// 把子窗口（设置/调试/选择）摆到"桌宠旁边"。
// 教训：Electron 默认把新窗口居中到主显示器。本机主屏是 3440×1440 的超宽屏、桌宠停在最右侧
// （x≈2872），而居中的设置窗会出现在 x≈1330 —— 也就是用户视野的左半边。用户盯着桌宠点"设置"，
// 却什么都没看到，这就是"设置窗口弹不出来"的真实观感。改成紧贴桌宠（优先左侧，放不下则右侧，
// 再不行才居中），并把结果夹回工作区，保证一定出现在用户当前看的地方。
// 没有桌宠窗口时（如启动时的"选择聊天大脑"）退回"在光标所在屏居中"。
// ---------------------------------------------------------------------------
function placeNearPet(win, w, h) {
  if (!win || win.isDestroyed()) return false;
  const GAP = 16;
  try {
    let ref = null;
    if (winAlive()) { try { ref = mainWin.getBounds(); } catch (e) { ref = null; } }
    const disp = ref ? screen.getDisplayMatching(ref) : screen.getPrimaryDisplay();
    const wa = disp.workArea;
    let x, y;
    if (ref) {
      x = ref.x - w - GAP;                                  // 1) 贴左侧
      if (x < wa.x) x = ref.x + ref.width + GAP;            // 2) 左侧放不下 → 贴右侧
      if (x + w > wa.x + wa.width) x = Math.round(ref.x + (ref.width - w) / 2);  // 3) 都不行 → 与桌宠同中心
      y = Math.round(ref.y + (ref.height - h) / 2);         // 与桌宠垂直对齐
    } else {
      x = Math.round(wa.x + (wa.width - w) / 2);            // 无桌宠 → 该屏居中
      y = Math.round(wa.y + (wa.height - h) / 2);
    }
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
    return true;
  } catch (e) { return false; }
}

// 参数调试面板：独立的、不透明、常驻窗口，实时列出模型全部参数（名称/当前值/范围/可视化）。
// 主进程只负责"建窗 + 把渲染进程上报的快照转发进来"，真正的参数读取在 live2d-loader 里完成。
function createDebugWindow() {
  if (debugWin && !debugWin.isDestroyed()) { showAndFocus(debugWin, '参数调试面板(已存在)'); return; }
  const dw = new BrowserWindow({
    width: 720, height: 760,
    minWidth: 420, minHeight: 320,
    title: 'Live2D 参数调试面板',
    backgroundColor: '#1e1e1e',
    show: false,   // 与屏幕追踪调试一致：菜单关闭后再显示，避免抢前台触发错误音/卡死
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  dw.loadURL('http://127.0.0.1:' + PORT + '/debug.html');
  placeNearPet(dw, 720, 760);
  // 与设置窗一致的显示三重保险（ready-to-show / did-finish-load / 超时兜底）
  dw.once('ready-to-show', () => showAndFocus(dw, '参数调试面板(ready-to-show)'));
  dw.webContents.once('did-finish-load', () => showAndFocus(dw, '参数调试面板(did-finish-load)'));
  dw.on('did-fail-load', (_e, code, desc) => {
    log('参数调试面板加载失败 code=' + code + ' ' + desc + '（仍强制显示窗口）');
    showAndFocus(dw, '参数调试面板(did-fail-load)');
  });
  setTimeout(() => { if (!dw.isDestroyed()) showAndFocus(dw, '参数调试面板(超时兜底)'); }, 1500);
  dw.on('closed', () => {
    debugWin = null;
    // 窗口被关掉即停止上报，并复位调试模式（托盘再次点击会重新打开并重新启动上报）
    if (winAlive()) mainWin.webContents.send('pet:setDebugMode', false);
  });
  debugWin = dw;
  log('debug window created');
}

function toggleDebugPanel() {
  if (debugWin && !debugWin.isDestroyed()) {
    try { debugWin.close(); } catch (e) {}
    debugWin = null;
    if (winAlive()) mainWin.webContents.send('pet:setDebugMode', false);
  } else {
    // 延后到托盘菜单关闭后创建（与屏幕追踪调试、退出项一致），避免菜单模态循环里同步建窗抢前台
    setTimeout(() => {
      try { createDebugWindow(); if (winAlive()) mainWin.webContents.send('pet:setDebugMode', true); }
      catch (e) { console.error('[debug] 创建窗口失败：', e && e.stack || e); }
    }, 60);
  }
}

// 屏幕追踪调试面板：独立窗口，实时可视化"屏幕运动追踪"识别到的物体与各自状态。
// 渲染进程的追踪器每帧把检测实况经 pet:screenTrackDebug 发来，这里转发进窗口。
function createScreenDebugWindow() {
  if (screenDebugWin && !screenDebugWin.isDestroyed()) { showAndFocus(screenDebugWin, '屏幕追踪调试(已存在)'); return; }
  const dw = new BrowserWindow({
    width: 560, height: 720,
    minWidth: 420, minHeight: 420,
    title: '屏幕追踪调试',
    backgroundColor: '#1b1b1d',
    show: false,   // 关键：先不显示；等 ready-to-show 再 show，避免在托盘菜单还展开时抢前台触发系统错误音 + 卡死消息泵
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  dw.loadURL('http://127.0.0.1:' + PORT + '/screen-debug.html');
  placeNearPet(dw, 560, 720);
  // 显示三重保险：ready-to-show / did-finish-load / 1.5s 超时兜底，任一先到即显示，
  // 免得窗口"凭空消失"让用户以为没反应。
  dw.once('ready-to-show', () => showAndFocus(dw, '屏幕追踪调试(ready-to-show)'));
  dw.webContents.once('did-finish-load', () => showAndFocus(dw, '屏幕追踪调试(did-finish-load)'));
  dw.on('did-fail-load', (_e, code, desc) => {
    log('屏幕追踪调试页加载失败 code=' + code + ' ' + desc + '（仍强制显示窗口）');
    showAndFocus(dw, '屏幕追踪调试(did-fail-load)');
  });
  setTimeout(() => { if (!dw.isDestroyed()) showAndFocus(dw, '屏幕追踪调试(超时兜底)'); }, 1500);
  dw.on('closed', () => { screenDebugWin = null; });
  screenDebugWin = dw;
  log('screen debug window created');
}
function toggleScreenDebugPanel() {
  if (screenDebugWin && !screenDebugWin.isDestroyed()) {
    try { screenDebugWin.close(); } catch (e) {}
    screenDebugWin = null;
    return;
  }
  // 关键：把窗口创建延后到托盘菜单关闭之后（约一帧），否则在菜单模态循环里同步 new BrowserWindow
  // 会让 Windows 无法转移前台焦点，表现为：系统错误音 + 窗口不弹出 + 托盘右键失灵 + 需强杀进程。
  // 这与"退出"项的延时写法一致（见退出项注释）。
  try {
    setTimeout(() => {
      try { createScreenDebugWindow(); }
      catch (e) { console.error('[screen-debug] 创建窗口失败：', e && e.stack || e); }
    }, 60);
  } catch (e) {
    console.error('[screen-debug] toggle 失败：', e && e.stack || e);
  }
}

// 音律识别调试面板：独立窗口，实时可视化"音频分析 → 律动 → 写进模型的参数"这条链。
// 渲染进程的追踪器周期性经 pet:musicDebug 发来快照，这里转发进窗口；窗口开/关时通知主窗口，
// 由它转告追踪器（追踪器只在面板开着时才上报 + 跑心跳，没开就不占 IPC）。
function createMusicDebugWindow() {
  if (musicDebugWin && !musicDebugWin.isDestroyed()) { showAndFocus(musicDebugWin, '音律识别调试(已存在)'); return; }
  const dw = new BrowserWindow({
    width: 680, height: 800,
    minWidth: 480, minHeight: 480,
    title: '音律识别调试',
    backgroundColor: '#1b1b1d',
    show: false,   // 先不显示，等 ready-to-show 再 show：避免托盘菜单仍展开时抢前台触发系统错误音
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  dw.loadURL('http://127.0.0.1:' + PORT + '/music-debug.html');
  placeNearPet(dw, 680, 800);
  dw.once('ready-to-show', () => showAndFocus(dw, '音律识别调试(ready-to-show)'));
  dw.webContents.once('did-finish-load', () => showAndFocus(dw, '音律识别调试(did-finish-load)'));
  dw.on('did-fail-load', (_e, code, desc) => {
    log('音律识别调试页加载失败 code=' + code + ' ' + desc + '（仍强制显示窗口）');
    showAndFocus(dw, '音律识别调试(did-fail-load)');
  });
  setTimeout(() => { if (!dw.isDestroyed()) showAndFocus(dw, '音律识别调试(超时兜底)'); }, 1500);
  dw.on('closed', () => {
    musicDebugWin = null;
    if (winAlive()) { try { mainWin.webContents.send('pet:musicDebugOpen', false); } catch (e) {} }
  });
  musicDebugWin = dw;
  // 告知主窗口（→追踪器）：面板已开，开始上报 + 心跳
  if (winAlive()) { try { mainWin.webContents.send('pet:musicDebugOpen', true); } catch (e) {} }
  log('music debug window created');
}
function toggleMusicDebugPanel() {
  if (musicDebugWin && !musicDebugWin.isDestroyed()) {
    try { musicDebugWin.close(); } catch (e) {}
    musicDebugWin = null;
    return;
  }
  // 与屏幕追踪调试完全一致：延后到菜单关闭后再建窗，否则菜单模态循环里同步建窗会抢不到前台焦点。
  try {
    setTimeout(() => {
      try { createMusicDebugWindow(); }
      catch (e) { console.error('[music-debug] 创建窗口失败：', e && e.stack || e); }
    }, 60);
  } catch (e) {
    console.error('[music-debug] toggle 失败：', e && e.stack || e);
  }
}

// 本地模型安装向导窗口：新用户第一次选「本地模型」时的落地页。
// 它自己不碰系统，所有安装动作都在主进程（下载/静默安装要写文件、起进程），
// 页面只负责显示与驱动；进度经 pet:ollamaSetupProgress 推进来。
function createOllamaSetupWindow() {
  if (ollamaSetupWin && !ollamaSetupWin.isDestroyed()) { showAndFocus(ollamaSetupWin, '本地模型向导(已存在)'); return; }
  const w = new BrowserWindow({
    width: 720, height: 800,
    minWidth: 560, minHeight: 560,
    title: '本地模型安装向导',
    backgroundColor: '#11151c',
    autoHideMenuBar: true,
    show: false,   // 同选择窗/调试窗：等 ready-to-show 再显示，避免托盘菜单展开时抢前台触发错误音
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  w.loadURL('http://127.0.0.1:' + PORT + '/ollama-setup.html');
  placeNearPet(w, 720, 800);
  // 三重显示保险（与设置窗/选择窗一致）：任一事件/超时先到即显示
  w.once('ready-to-show', () => showAndFocus(w, '本地模型向导(ready-to-show)'));
  w.webContents.once('did-finish-load', () => showAndFocus(w, '本地模型向导(did-finish-load)'));
  w.on('did-fail-load', (_e, code, desc) => {
    log('本地模型向导页加载失败 code=' + code + ' ' + desc + '（仍强制显示窗口）');
    showAndFocus(w, '本地模型向导(did-fail-load)');
  });
  setTimeout(() => { if (!w.isDestroyed()) showAndFocus(w, '本地模型向导(超时兜底)'); }, 1500);
  w.on('closed', () => {
    ollamaSetupWin = null;
    // 关窗即取消进行中的安装任务：否则下载会在看不见的地方继续跑，
    // 用户以为已经取消、后台却还在吃流量和磁盘。已下好的 .part 会保留，下次能续传。
    if (ollamaSetupJob && ollamaSetupJob.phase && ollamaSetupJob.phase !== 'done') {
      ollamaSetupJob.cancelled = true;
      try { if (ollamaSetupJob.abort) ollamaSetupJob.abort(); } catch (e) {}
    }
  });
  ollamaSetupWin = w;
  log('ollama setup window created');
}

function toggleOllamaSetupPanel() {
  if (ollamaSetupWin && !ollamaSetupWin.isDestroyed()) {
    // 安装任务进行中时不要一关就断线（任务会在看不见的窗口里继续跑，用户以为取消了）
    if (ollamaSetupJob && ollamaSetupJob.phase && ollamaSetupJob.phase !== 'done') {
      showAndFocus(ollamaSetupWin, '本地模型向导(安装中，仅前置)');
      return;
    }
    try { ollamaSetupWin.close(); } catch (e) {}
    ollamaSetupWin = null;
    return;
  }
  // 与其它面板一致：延后到托盘菜单关闭后再建窗，否则菜单模态循环里同步建窗会抢不到前台焦点
  try {
    setTimeout(() => {
      try { createOllamaSetupWindow(); }
      catch (e) { console.error('[ollama-wizard] 创建窗口失败：', e && e.stack || e); }
    }, 60);
  } catch (e) {
    console.error('[ollama-wizard] toggle 失败：', e && e.stack || e);
  }
}

// 设置窗口：独立的不透明窗口，渲染 app/settings.html（由本地静态服务托管）。
// 复用与调试面板相同的 preload（contextBridge 已暴露 getConfig/setConfig）。
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    // 旧实现这里只 focus()：若窗口被最小化或仍卡在隐藏态，focus 不会让它出现，
    // 用户看到的就是"点设置毫无反应"。改为统一走 showAndFocus（恢复+显示+置顶+聚焦）。
    showAndFocus(settingsWin, '设置窗(已存在)');
    return;
  }
  const SW = 780, SH = 620;
  const sw = new BrowserWindow({
    width: SW, height: SH,
    minWidth: 560, minHeight: 440,
    title: '黑叶萤桌宠 · 设置',
    backgroundColor: '#11151c',
    show: false,   // 避免在托盘菜单展开时同步抢前台触发错误音/卡死（与调试面板一致）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // 开在"桌宠旁边"（而不是主显示器正中）：超宽屏/多屏下默认居中会跑到用户视野之外，
  // 看起来就像"点了设置没反应"。详见 placeNearPet 的说明。
  placeNearPet(sw, SW, SH);
  sw.loadURL('http://127.0.0.1:' + PORT + '/settings.html');
  // 三重保险：ready-to-show / did-finish-load / 1.5s 超时兜底——任一先到即显示。
  // 只要其中任一环节在个别环境下不触发，窗口就会永远停在隐藏态（"弹不出来"），
  // 因此这里不再依赖单一事件。
  sw.once('ready-to-show', () => showAndFocus(sw, '设置窗(ready-to-show)'));
  sw.webContents.once('did-finish-load', () => showAndFocus(sw, '设置窗(did-finish-load)'));
  sw.on('did-fail-load', (_e, code, desc) => {
    log('设置窗页面加载失败 code=' + code + ' ' + desc + '（仍强制显示窗口，便于看到错误）');
    showAndFocus(sw, '设置窗(did-fail-load)');
  });
  setTimeout(() => { if (!sw.isDestroyed()) showAndFocus(sw, '设置窗(超时兜底)'); }, 1500);
  sw.on('closed', () => { settingsWin = null; });
  settingsWin = sw;
  log('settings window created');
}

// ---------------------------------------------------------------------------
// 聊天大脑选择窗
// ---------------------------------------------------------------------------
// 启动时弹（除非用户勾过"下次不再询问"）。它只负责收集选择，真正的切换
// 由 pet:brainChoice 落盘后经 pet:setBrain 下发给桌宠窗口。
//
// 关窗不点确定 = 沿用上次的大脑（回调收到 null），不会把程序卡在没选的状态。
let brainWin = null;
let brainCb = null;
function openBrainChooser(onDone) {
  if (brainWin && !brainWin.isDestroyed()) { showAndFocus(brainWin, '选择窗(已存在)'); return; }
  brainCb = onDone || null;
  const w = new BrowserWindow({
    width: 520, height: 720,
    minWidth: 460, minHeight: 480,
    title: '选择聊天大脑',
    backgroundColor: '#11151c',
    autoHideMenuBar: true,
    show: false,   // 避免在托盘菜单展开时同步抢前台触发错误音/卡死（与调试面板一致）
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // 同设置窗：摆在桌宠旁边（无桌宠时该屏居中）
  placeNearPet(w, 520, 720);
  w.loadURL('http://127.0.0.1:' + PORT + '/brain-chooser.html');
  // 与设置窗一致的三重保险：任一事件/超时先到即显示，避免窗口卡在隐藏态导致
  // "桌面空白 + 没有桌宠"这种只能强杀进程的死锁态。
  w.once('ready-to-show', () => showAndFocus(w, '选择窗(ready-to-show)'));
  w.webContents.once('did-finish-load', () => showAndFocus(w, '选择窗(did-finish-load)'));
  w.on('did-fail-load', (_e, code, desc) => {
    log('选择窗页面加载失败 code=' + code + ' ' + desc + '（仍强制显示窗口）');
    showAndFocus(w, '选择窗(did-fail-load)');
  });
  setTimeout(() => { if (!w.isDestroyed()) showAndFocus(w, '选择窗(超时兜底)'); }, 1500);
  w.on('closed', () => {
    brainWin = null;
    if (brainCb) { const cb = brainCb; brainCb = null; cb(null); }
  });
  brainWin = w;
  log('brain chooser window created');
}
function closeBrainChooser(result) {
  const cb = brainCb;
  brainCb = null;
  if (brainWin && !brainWin.isDestroyed()) { try { brainWin.close(); } catch (e) {} }
  if (cb) cb(result);
}
function brainLabel() {
  return ({ local: '本地模型', cloud: '云端接口', workbuddy: 'WorkBuddy' })[CONFIG.chat.backend] || '云端接口';
}
// 把当前大脑下发给桌宠窗口；warm=true 时渲染进程会顺手预热（本地模型要加载权重）
function pushBrain(warm) {
  if (winAlive()) {
    mainWin.webContents.send('pet:setBrain', { backend: CONFIG.chat.backend, warm: !!warm });
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'app', 'assets', 'tray.png');
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath));
  } catch (e) {
    console.error('[live2d-companion] create Tray failed:', e.message);
    return;
  }
  tray.setToolTip('Live2D Companion · WorkBuddy');
  // 左键：切换窗口显隐（任务栏已隐藏，这是最顺手的恢复入口）
  tray.on('click', () => {
    if (winAlive()) { mainWin.isVisible() ? mainWin.hide() : mainWin.show(); }
  });
  // 右键：弹出实用菜单
  tray.on('right-click', () => {
    if (tray) tray.popUpContextMenu(buildTrayMenu());
  });
  log('tray icon ready');
}

function buildTrayMenu() {
  const visible = winAlive() && mainWin.isVisible();
  const items = [
    {
      label: visible ? '隐藏窗口' : '显示窗口',
      click: () => { if (winAlive()) { mainWin.isVisible() ? mainWin.hide() : mainWin.show(); } }
    },
    { type: 'separator' },
    {
      label: '切换聊天大脑…（当前：' + brainLabel() + '）',
      // 延后到菜单关闭后再建窗，避免菜单模态循环里同步建窗抢前台（错误音/窗口不弹/托盘失灵）
      click: () => deferMenuAction(() => openBrainChooser(() => pushBrain(true)), '切换聊天大脑')
    },
    {
      label: '本地模型安装向导…',
      click: () => { toggleOllamaSetupPanel(); }
    },
    { type: 'separator' },
    {
      label: appState.locked ? '解锁窗口与模型位置/缩放' : '锁定窗口与模型位置/缩放',
      click: () => {
        applyWindowLock(!appState.locked);
        if (winAlive()) mainWin.webContents.send('pet:applyLock', appState.locked);
      }
    },
    {
      label: '重置模型位置与缩放',
      click: () => { if (winAlive()) mainWin.webContents.send('pet:applyReset'); }
    },
    { type: 'separator' },
    {
      label: '调试',
      submenu: [
        {
          label: '参数调试面板',
          click: () => { toggleDebugPanel(); }
        },
        {
          label: '屏幕追踪调试',
          click: () => { toggleScreenDebugPanel(); }
        },
        {
          label: '音律识别调试',
          click: () => { toggleMusicDebugPanel(); }
        },
        {
          label: '口型调试',
          submenu: [
            {
              label: '元音参数族',
              submenu: VOWEL_FAMILIES.map((f) => ({
                label: (visemeDbg.family === f.id ? '● ' : '  ') + f.label,
                click: () => { visemeDbg.family = f.id; sendViseme('pet:setVowelFamily', f.id); }
              }))
            },
            {
              label: (visemeDbg.driveOpenY ? '● ' : '  ') + '驱动 OpenY(张合)',
              click: () => { visemeDbg.driveOpenY = !visemeDbg.driveOpenY; sendViseme('pet:setDriveOpenY', visemeDbg.driveOpenY); }
            },
            {
              label: (visemeDbg.silenceSpeaking === 0 ? '● ' : '  ') + '说话时 Silence=0(口型接管)',
              click: () => { visemeDbg.silenceSpeaking = (visemeDbg.silenceSpeaking === 0 ? 1 : 0); sendViseme('pet:setSilenceSpeaking', visemeDbg.silenceSpeaking); }
            }
          ]
        }
      ]
    },
    {
      label: '设置…',
      // 延后到菜单关闭后再建窗（原因同上）。这是用户最常点的入口，
      // 同步建窗会表现为"点了设置窗口弹不出来"，且之后托盘菜单还会失灵。
      click: () => deferMenuAction(() => openSettings(), '设置')
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuiting = true;
        // 延后一帧再 quit：避免在右键菜单仍展开时立即销毁窗口，触发系统错误音；
        // before-quit 会负责销毁托盘图标并关闭本地服务，确保进程彻底退出、不留残留。
        setTimeout(() => { try { app.quit(); } catch (e) {} }, 30);
      }
    }
  ];
  return Menu.buildFromTemplate(items);
}

// 渲染进程 -> 主进程：打开设置窗口（来自主窗「设置」按钮；与托盘菜单同一入口）
ipcMain.on('pet:openSettings', () => { openSettings(); });

// 渲染进程 -> 主进程：锁定状态变更（来自窗口内的"锁定"按钮）
ipcMain.on('pet:lock', (_e, v) => {
  applyWindowLock(!!v);
  if (winAlive()) mainWin.webContents.send('pet:applyLock', appState.locked);
});
// 渲染进程 -> 主进程：请求重置
ipcMain.on('pet:reset', () => {
  if (winAlive()) mainWin.webContents.send('pet:applyReset');
});
// 渲染进程 -> 主进程：切换窗口显隐
ipcMain.on('pet:toggleVisible', () => {
  if (!winAlive()) return;
  if (mainWin.isVisible()) mainWin.hide(); else mainWin.show();
});

ipcMain.on('pet:minimize', () => { if (winAlive()) mainWin.hide(); });
ipcMain.on('pet:close', () => { if (winAlive()) mainWin.hide(); });
ipcMain.on('pet:toggle-top', () => {
  if (!winAlive()) return;
  const onTop = mainWin.isAlwaysOnTop();
  mainWin.setAlwaysOnTop(!onTop, 'screen-saver');
});
// 渲染进程 -> 主进程：把诊断日志（如模型真实口型参数名）写入 app.log
ipcMain.on('pet:log', (_e, m) => { try { log('render:', m); } catch (e) {} });
// 渲染进程 -> 主进程：参数调试面板的全参数快照，转发到调试窗口（仅窗口存在时转发）
ipcMain.on('pet:debugParams', (_e, snapshot) => {
  if (debugWin && !debugWin.isDestroyed()) {
    try { debugWin.webContents.send('debug:params', snapshot); } catch (e) {}
  }
});
// 渲染进程 -> 主进程：枚举屏幕采集源（供"屏幕运动追踪"经 getUserMedia 取得 source id）。
// 渲染进程 contextIsolation 下不能 require electron，故由这里用 desktopCapturer 取源，
// 只回传 id/name/display_id；渲染进程再用 chromeMediaSourceId 拉视频流，帧差检测在渲染进程做。
ipcMain.handle('pet:getScreenSources', async () => {
  try {
    const sources = await electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }   // 只要 id，不生成缩略图，省开销
    });
    const all = screen.getAllDisplays();
    // 关键修复：desktopCapturer 的源顺序与 screen.getAllDisplays() 在 Windows 下并不一致，
    // 若直接按数组下标对应，会导致"设置里选屏幕1、实际却捕捉屏幕2"之类的错位。
    // 这里按 display_id 把 desktopCapturer 源对齐到 screen API 的显示器顺序，
    // 使得 sources[k].id 正对应设置下拉里标注的"显示器 k+1"，追踪器 sources[screenIndex] 即采到正确的屏。
    const byDisplayId = new Map();
    sources.forEach((s) => { if (s.display_id != null && s.display_id !== '') byDisplayId.set(String(s.display_id), s); });
    const ordered = all.map((d, i) => {
      const s = byDisplayId.get(String(d.id));
      const pick = s || sources[i] || null;
      return {
        id: pick ? pick.id : null,
        name: pick ? pick.name : ('显示器 ' + (i + 1)),
        display_id: pick ? pick.display_id : String(d.id),
        index: i
      };
    });
    return ordered;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
// 设置窗用：枚举所有物理显示器（供"追踪屏幕"下拉 + "标识屏幕"按钮）。
// 这里用 screen API 的显示器顺序（与 Windows 显示设置一致，编号即"显示器 N"）。
// pet:getScreenSources 已按 display_id 把 desktopCapturer 源对齐到本顺序，
// 因此下拉选中的 index 与追踪器 sources[index] 指向同一块物理屏。
ipcMain.handle('pet:getDisplays', () => {
  try {
    const all = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    return all.map((d, i) => ({
      index: i,
      label: '显示器 ' + (i + 1) + (d.id === primaryId ? '（主屏）' : ''),
      primary: d.id === primaryId,
      x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height
    }));
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
// 屏幕运动追踪用：返回桌宠自身窗口的屏幕坐标（含尺寸），供渲染进程把"自己"从运动检测里遮罩掉。
ipcMain.handle('pet:getPetWindowRect', () => {
  if (!winAlive()) return null;
  const b = mainWin.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});
// 设置窗"标识屏幕"按钮：在每个物理显示器上短暂弹出一个透明大数字窗口，
// 编号 1..N 与 Windows 显示设置一致；selected 那个高亮标"✓已选"，便于确认当前选中的是哪块屏。
ipcMain.handle('pet:identifyDisplays', (_e, selected) => {
  try {
    const all = screen.getAllDisplays();
    const sel = (typeof selected === 'number') ? selected : -1;
    const wins = [];
    all.forEach((d, i) => {
      const b = d.bounds;
      const w = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        transparent: true, frame: false, skipTaskbar: true, show: false,
        alwaysOnTop: true, resizable: false, movable: false,
        hasShadow: false, enableLargerThanScreen: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false }
      });
      w.setIgnoreMouseEvents(true);
      const accent = (i === sel);
      const html =
        '<!doctype html><html><head><meta charset="utf-8"><style>' +
        'html,body{margin:0;height:100%;background:transparent;' +
        'display:flex;align-items:center;justify-content:center;overflow:hidden;}' +
        '.n{font:700 ' + Math.round(Math.min(b.width, b.height) * 0.16) + 'px/1 "Microsoft YaHei",sans-serif;' +
        'color:' + (accent ? '#9fd0ff' : 'rgba(255,255,255,0.9)') + ';' +
        'background:' + (accent ? 'rgba(20,60,100,0.6)' : 'rgba(0,0,0,0.38)') + ';' +
        'border:4px solid ' + (accent ? '#4ea1ff' : 'rgba(255,255,255,0.65)') + ';' +
        'border-radius:28px;padding:0.16em 0.5em;text-shadow:0 2px 10px rgba(0,0,0,.6);}' +
        '</style></head><body><div class="n">' + (i + 1) + (accent ? ' ✓已选' : '') + '</div></body></html>';
      w.loadURL('data:text/html,' + encodeURIComponent(html));
      w.showInactive();
      wins.push(w);
    });
    setTimeout(() => { wins.forEach((w) => { try { w.close(); } catch (e) {} }); }, 2600);
    return { ok: true, count: all.length };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
// 渲染进程 -> 主进程：汉字转拼音（元音口型对照）。由主进程加载的 pinyin-pro 计算，
// 返回拼音字符串数组（每个汉字一项）。pinyinFn 不可用时返回空数组，不阻断调用方。
ipcMain.handle('pet:pinyin', (_e, text) => {
  if (!text) return [];
  // 日文：逐字转罗马字（口型元音跟随日语）；中文：走 pinyin-pro。
  if (hasJapanese(text)) {
    try { return kanaRomajiTokens(text); } catch (e) { return []; }
  }
  if (!pinyinFn) return [];
  try { return pinyinFn(text, { toneType: 'none', type: 'array', nonZh: 'spaced' }); }
  catch (e) { return []; }
});
// 渲染进程 -> 主进程：自定义输入窗的回传结果（自定义字号/字体名），触发对应回调
ipcMain.on('pet:promptResult', (_e, val) => {
  const cb = promptCb;
  promptCb = null;
  if (typeof cb === 'function') { try { cb(val); } catch (e) {} }
});
// 渲染进程 -> 主进程：屏幕运动追踪实启停后回传状态，用于同步托盘菜单勾选态。
// 注意：这里只更新本地状态、不再 webContents.send 回渲染进程，避免与主进程下发的 pet:setScreenTrack 形成环。
ipcMain.on('pet:screenTrackState', (_e, v) => { screenTrackState.enabled = !!v; });

// 渲染进程 -> 主进程：屏幕运动追踪每帧检测实况（含灰度帧/各运动连通块/状态），转发给"屏幕追踪调试"窗口。
// 仅在调试窗口存在时转发，避免无谓的 IPC 带宽消耗；同时缓存最近一帧，供调试窗就绪后补发（解决首帧收不到画面）。
ipcMain.on('pet:screenTrackDebug', (_e, d) => {
  lastScreenDiag = d;
  if (screenDebugWin && !screenDebugWin.isDestroyed()) {
    try { screenDebugWin.webContents.send('debug:screenTrack', d); } catch (e) {}
  }
});
// 调试窗就绪后，立即把最近一帧检测实况补发给它。首帧常因"监听注册时机 / 限流"被错过，
// 导致"打开调试面板却收不到画面、必须重开关卡才看到"；补发缓存即可立即可见（问题①）。
ipcMain.on('pet:debugReady', () => {
  if (screenDebugWin && !screenDebugWin.isDestroyed()) {
    // 1) 把缓存的最近一帧立刻补发给调试窗（首帧兜底）
    if (lastScreenDiag) {
      try { screenDebugWin.webContents.send('debug:screenTrack', lastScreenDiag); } catch (e) {}
    }
    // 2) 同时请追踪器立即补发一帧（绕过 80ms 限流），确保打开即见画面、不依赖限流窗口
    if (winAlive()) {
      try { mainWin.webContents.send('pet:requestScreenDiag'); } catch (e) {}
    }
  }
});

// 渲染进程 -> 主进程：音律识别周期的诊断快照（能量/起音/相位/点头包络/实际写入的模型参数），
// 转发给"音律识别调试"窗口。仅在窗口存在时转发，并缓存最近一份供窗口就绪后补发。
ipcMain.on('pet:musicDebug', (_e, d) => {
  lastMusicDiag = d;
  if (musicDebugWin && !musicDebugWin.isDestroyed()) {
    try { musicDebugWin.webContents.send('debug:music', d); } catch (e) {}
  }
});
// 音律识别调试窗就绪：先补发缓存，再请追踪器立即补一份（绕过限流）。两者都做，
// 保证"打开面板立刻有数据"，不必等下一个心跳/限流周期。
ipcMain.on('pet:musicDebugReady', () => {
  if (!musicDebugWin || musicDebugWin.isDestroyed()) return;
  if (lastMusicDiag) {
    try { musicDebugWin.webContents.send('debug:music', lastMusicDiag); } catch (e) {}
  }
  if (winAlive()) {
    try { mainWin.webContents.send('pet:requestMusicDiag'); } catch (e) {}
  }
});

// ---------------------------------------------------------------------------
// 设置窗：配置读写（主进程持有落盘职责，渲染进程只发 get/set 请求）
// ---------------------------------------------------------------------------
function getByPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setByPath(obj, p, v) {
  const ks = String(p).split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[ks[ks.length - 1]] = v;
}
// 把单个配置键的改动实时下发到运行中的桌宠（尽量不重启）。返回 'reload' 表示需重启桌宠/程序生效。
function applyConfigKey(key, val) {
  switch (key) {
    case 'emotionEnabled':
      emoState.enabled = !!val; sendViseme('pet:setEmotionEnabled', emoState.enabled); return;
    case 'idleLinesEnabled':
      idleState.enabled = !!val; sendViseme('pet:setIdleEnabled', idleState.enabled); return;
    case 'ttsEnabled':
      ttsState.enabled = !!val;
      if (ttsState.enabled) ttsSpawn(); else ttsKill();
      sendViseme('pet:setTTS', { enabled: ttsState.enabled }); return;
    case 'ttsEngine':
      ttsState.want = String(val); CONFIG.ttsEngine = String(val); ttsRestart(); return;
    case 'idleDisplayLang':
      CONFIG.idleDisplayLang = String(val);
      sendViseme('pet:setLang', { display: String(val), voice: CONFIG.idleVoiceLang || 'cn' }); return;
    case 'idleVoiceLang':
      CONFIG.idleVoiceLang = String(val);
      sendViseme('pet:setLang', { display: CONFIG.idleDisplayLang || 'cn', voice: String(val) }); return;
    case 'vowelParamFamily':
      visemeDbg.family = String(val); sendViseme('pet:setVowelFamily', String(val)); return;
    case 'vowelModeDriveOpenY':
      visemeDbg.driveOpenY = !!val; sendViseme('pet:setDriveOpenY', visemeDbg.driveOpenY); return;
    case 'silenceSpeakingValue':
      visemeDbg.silenceSpeaking = (Number(val) ? 1 : 0); sendViseme('pet:setSilenceSpeaking', visemeDbg.silenceSpeaking); return;
    case 'uiFontSize':
      applyUI(Number(val), uiState.fontFamily); return;
    case 'uiFontFamily':
      applyUI(uiState.fontSize, String(val)); return;
    case 'screenTrack.enabled':
      screenTrackState.enabled = !!val;
      if (winAlive()) mainWin.webContents.send('pet:setScreenTrack', screenTrackState.enabled);
      return;
    case 'screenTrack.screenIndex':
      try { CONFIG.screenTrack = CONFIG.screenTrack || {}; CONFIG.screenTrack.screenIndex = (val == null ? 0 : Number(val)); } catch (e) {}
      if (winAlive()) mainWin.webContents.send('pet:setScreenTrackScreen', CONFIG.screenTrack.screenIndex);
      return;
    case 'mouseFollow':
      mouseFollowState.enabled = !!val;
      sendViseme('pet:setMouseFollow', mouseFollowState.enabled);
      return;
    case 'gaze.smooth':
    case 'gaze.amplitude':
    case 'gaze.headAmplitude':
    case 'gaze.headSmooth':
    case 'gaze.extra':
      // 视线/头部跟随参数：实时推给渲染进程的 Live2DController（若已加载模型则立即生效）
      try { CONFIG.gaze = CONFIG.gaze || {}; } catch (e) {}
      if (winAlive()) mainWin.webContents.send('pet:setGazeCfg', CONFIG.gaze);
      return;
    case 'music.enabled':
      musicState.enabled = !!val;
      if (winAlive()) mainWin.webContents.send('pet:setMusic', musicState.enabled);
      return;
    case 'music.eyeClose':
    case 'music.nodStrength':
    case 'music.swayStrength':
    case 'music.sensitivity':
    case 'music.maxTempo':
    case 'music.audioSource':
    case 'music.enableA':
    case 'music.enableB':
    case 'music.aSpeed':
      // 音律识别参数（含 audioSource）：整块推给追踪器实时生效；
      // 若正在采集且 audioSource 变了，追踪器会用新来源重启采集。
      if (winAlive()) mainWin.webContents.send('pet:setMusicCfg', CONFIG.music);
      return;
    case 'modelUrl':
      // 换模型：热重载模型本身，不整窗 reload（保住聊天记录与链路）
      CONFIG.modelUrl = String(val || '');
      if (winAlive()) mainWin.webContents.send('pet:setModel', CONFIG.modelUrl);
      return;
    case 'modelServeBase':
      // 换模型库根目录：/models 路由每次请求都读 CONFIG，故立刻生效，无需重启
      CONFIG.modelServeBase = String(val || '');
      return;
    case 'modelAssets':
      // 改了动作/表情注入配置：只落盘，不自动重载模型。
      // 设置页「素材关联」改完由用户点「保存并重新载入模型」显式重载（避免每勾一下就重载一次）。
      CONFIG.modelAssets = val || {};
      return;
    case 'lineProfile':
      // 换了"模型 → 台词档"映射：让桌宠重读台词池
      CONFIG.lineProfile = val || {};
      if (winAlive()) mainWin.webContents.send('pet:reloadLines');
      return;
    case 'assets':
    case 'assets.hotkeyScope':
    case 'assets.bindings':
      CONFIG.assets = CONFIG.assets || {};
      refreshHotkeys();
      if (winAlive()) mainWin.webContents.send('pet:setBindings', CONFIG.assets);
      return;
    case 'ttsLang':
      CONFIG.ttsLang = val || {};
      return;
    default:
      if (key.indexOf('screenTrack.') === 0) {
        // 屏幕追踪灵敏度等子参数：实时推给追踪器（若正在运行则立即生效）
        if (winAlive()) mainWin.webContents.send('pet:setScreenTrackParams', CONFIG.screenTrack);
        return;
      }
      // 以下在渲染进程启动时读取，reload 桌宠即可生效
      if (key === 'idleMotion' || key === 'lipSync' || key === 'autoConnectChat' || key === 'startupBackground') return 'reload';
      // 其余（端口/窗口尺寸/模型路径/内核/沙箱/ACP 等）仅落盘，需退出程序重新启动才生效
      return;
  }
}
// 模型参数列表缓存：主窗口在模型加载完成后经 pet:reportModelParams 上报（见 app.js）。
// 设置窗“额外追踪参数”下拉依赖它枚举本模型真实存在的参数；缓存为空时按需请主窗口补报。
let cachedModelParams = [];
ipcMain.on('pet:reportModelParams', (_e, ids) => { if (Array.isArray(ids)) cachedModelParams = ids; });
ipcMain.handle('pet:getModelParams', async () => {
  if (!cachedModelParams.length && winAlive()) mainWin.webContents.send('pet:requestModelParams');
  return cachedModelParams;
});
// 音频输入设备列表缓存：由主窗口（已有媒体权限上下文）枚举后经 pet:reportAudioDevices 上报，
// 设置窗据此渲染"监听设备"下拉。设置窗自己枚举拿不到设备名（未授权时 label 为空）。
let cachedAudioDevices = [];
ipcMain.on('pet:reportAudioDevices', (_e, list) => { if (Array.isArray(list)) cachedAudioDevices = list; });
ipcMain.handle('pet:getAudioDevices', async () => {
  if (!cachedAudioDevices.length && winAlive()) mainWin.webContents.send('pet:requestAudioDevices');
  return cachedAudioDevices;
});
// 音律识别状态缓存：主窗口每 500ms 经 pet:reportMusicState 上报（设置窗"音律识别"观测面板显示用）。
// 设置窗是独立窗口，读不到主窗渲染进程里的追踪器，故走"上报→主进程缓存→查询"这条链路。
let cachedMusicState = { active: false, playing: false, mode: '-', bpm: 0, level: 0 };
ipcMain.on('pet:reportMusicState', (_e, s) => { if (s && typeof s === 'object') cachedMusicState = s; });
ipcMain.handle('pet:getMusicState', async () => cachedMusicState);
// —— 音频侧车（方案③）IPC：逐端点回环采集 / 查询状态 ——
ipcMain.handle('pet:getOutputDevices', async () => {
  if (!audioReady) audioSpawn();
  const r = await audioReq('GET', '/devices');
  if (r && r.error) log('audio: /devices error: ' + r.error);
  return (r && Array.isArray(r.devices)) ? r.devices : [];
});
ipcMain.handle('pet:audioStart', async (_e, p) => {
  if (!audioReady) audioSpawn();
  return await audioReq('POST', '/start', p || {});
});
ipcMain.handle('pet:audioStop', async () => audioReq('POST', '/stop', {}));
ipcMain.handle('pet:getAudioState', async () => await audioReq('GET', '/state'));

// ===========================================================================
// 模型库 / 素材 / 台词档 / 音色 / 绑定与快捷键（设置页 R1·R2·R3）
// ===========================================================================

// ---- 文件与目录选择对话框 ----
function dlgParent() { return (settingsWin && !settingsWin.isDestroyed()) ? settingsWin : (winAlive() ? mainWin : undefined); }

ipcMain.handle('pet:chooseDirectory', async (_e, opts) => {
  const o = (opts && typeof opts === 'object') ? opts : {};
  try {
    const r = await dialog.showOpenDialog(dlgParent(), {
      title: o.title || '选择目录',
      defaultPath: o.defaultPath || undefined,
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pet:chooseFile', async (_e, opts) => {
  const o = (opts && typeof opts === 'object') ? opts : {};
  try {
    const filters = (Array.isArray(o.filters) && o.filters.length)
      ? o.filters
      : [{ name: '音频文件', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'] }];
    const r = await dialog.showOpenDialog(dlgParent(), {
      title: o.title || '选择文件',
      defaultPath: o.defaultPath || undefined,
      filters: filters,
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ---- 模型库扫描 / 素材扫描 ----
ipcMain.handle('pet:scanModels', async (_e, dir) => {
  const base = dir ? String(dir) : modelServeBase();
  try {
    if (!fs.existsSync(base)) return { ok: false, base: base, error: '目录不存在：' + base, models: [] };
    return { ok: true, base: base, models: scanModels(base) };
  } catch (e) { return { ok: false, base: base, error: String((e && e.message) || e), models: [] }; }
});

ipcMain.handle('pet:scanModelAssets', async (_e, modelUrl) => {
  try { return Object.assign({ ok: true }, scanModelAssets(modelUrl)); }
  catch (e) { return { ok: false, error: String((e && e.message) || e), motions: [], expressions: [] }; }
});

// ---- 台词档（profile）读写 ----
function safeProfileId(id) {
  const s = String(id || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
}
function profilePath(id) { return path.join(LINE_PROFILES_DIR, safeProfileId(id) + '.json'); }

ipcMain.handle('pet:listLineProfiles', async () => {
  const out = [];
  try {
    if (fs.existsSync(LINE_PROFILES_DIR)) {
      for (const f of fs.readdirSync(LINE_PROFILES_DIR)) {
        if (!/\.json$/i.test(f)) continue;
        const id = f.replace(/\.json$/i, '');
        let j = null;
        try { j = JSON.parse(fs.readFileSync(path.join(LINE_PROFILES_DIR, f), 'utf-8')); } catch (e) { continue; }
        out.push({
          id: id,
          name: (j && j.name) || id,
          clickCount: (j && Array.isArray(j.click)) ? j.click.length : 0,
          idleCount: (j && Array.isArray(j.idle)) ? j.idle.length : 0
        });
      }
    }
  } catch (e) { /* 忽略 */ }
  out.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id)));
  return out;
});

ipcMain.handle('pet:getLineProfile', async (_e, id) => {
  const p = profilePath(id);
  if (!p) return { ok: false, error: '非法台词档 id' };
  try {
    if (!fs.existsSync(p)) return { ok: true, id: safeProfileId(id), missing: true };
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { ok: true, id: safeProfileId(id), profile: j };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pet:setLineProfile', async (_e, payload) => {
  const id = safeProfileId(payload && payload.id);
  if (!id) return { ok: false, error: '非法台词档 id' };
  try {
    if (!fs.existsSync(LINE_PROFILES_DIR)) fs.mkdirSync(LINE_PROFILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(LINE_PROFILES_DIR, id + '.json'),
      JSON.stringify(payload.profile || {}, null, 2), 'utf-8');
    log('line profile saved: ' + id);
    // 通知桌宠重读台词池（不必重启）
    if (winAlive()) mainWin.webContents.send('pet:reloadLines');
    return { ok: true, id: id };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

ipcMain.handle('pet:deleteLineProfile', async (_e, id) => {
  const sid = safeProfileId(id);
  if (!sid || sid === 'default') return { ok: false, error: '不可删除' };
  try { fs.unlinkSync(profilePath(sid)); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// ---- TTS 音色清单（经本地侧车 /voices） ----
ipcMain.handle('pet:listVoices', async (_e, engine) => {
  const q = engine ? ('?engine=' + encodeURIComponent(String(engine))) : '';
  return await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: TTS_PORT, path: '/voices' + q, method: 'GET', timeout: 20000 },
      (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve({ engine: '', voices: [] }); } });
      });
    req.on('error', () => resolve({ engine: '', voices: [], error: 'TTS 侧车不可用' }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ engine: '', voices: [], error: '超时' }); });
    req.end();
  });
});

// ---- 切换模型（热重载，不重启程序，不影响聊天） ----
ipcMain.handle('pet:switchModel', async (_e, url) => {
  const u = String(url || '').trim();
  if (!u) return { ok: false, error: '模型 URL 为空' };
  CONFIG.modelUrl = u;
  saveConfig();
  if (winAlive()) mainWin.webContents.send('pet:setModel', u);
  log('model switched: ' + u);
  return { ok: true, url: u };
});

// ---- 渲染进程上报 / 查询本模型素材清单 ----
let cachedModelAssets = { expressions: [], motions: [] };
ipcMain.on('pet:reportModelAssets', (_e, o) => {
  if (o && typeof o === 'object') {
    cachedModelAssets = {
      expressions: Array.isArray(o.expressions) ? o.expressions : [],
      motions: Array.isArray(o.motions) ? o.motions : []
    };
    // 主窗每次加载/热重载模型后都会上报素材清单。设置窗若开着，实时转发过去，
    // 否则它只能靠定时轮询猜时机，「表情与动作」页会短暂（或一直）显示上一个模型的素材。
    if (settingsWin && !settingsWin.isDestroyed()) {
      try { settingsWin.webContents.send('pet:modelAssetsUpdated', cachedModelAssets); } catch (e) { /* 忽略 */ }
    }
  }
});
ipcMain.handle('pet:getModelAssets', async () => {
  if (!cachedModelAssets.expressions.length && !cachedModelAssets.motions.length && winAlive()) {
    mainWin.webContents.send('pet:requestModelAssets');
  }
  return cachedModelAssets;
});

// ---- 触发绑定与快捷键范围 ----
// 全局快捷键：范围 = 'global' 时由主进程注册系统级热键；'window' 时由渲染进程在本窗口内监听。
let registeredHotkeys = [];
function unregisterHotkeys() {
  for (const acc of registeredHotkeys) {
    try { globalShortcut.unregister(acc); } catch (e) { /* 忽略 */ }
  }
  registeredHotkeys = [];
}
function refreshHotkeys() {
  unregisterHotkeys();
  const A = CONFIG.assets || {};
  if (A.hotkeyScope !== 'global') return;   // 窗口内模式：渲染进程自己监听，主进程不注册
  const list = Array.isArray(A.bindings) ? A.bindings : [];
  const failed = [];
  for (const b of list) {
    const acc = b && b.hotkey ? normalizeAccelerator(b.hotkey) : '';
    if (!acc) continue;
    try {
      const ok = globalShortcut.register(acc, () => {
        if (winAlive()) mainWin.webContents.send('pet:triggerAsset', b.id);
      });
      if (ok) registeredHotkeys.push(acc);
      else failed.push(acc);
    } catch (e) { failed.push(acc); }
  }
  if (failed.length) log('globalShortcut failed for: ' + failed.join(','));
  else if (registeredHotkeys.length) log('globalShortcut registered: ' + registeredHotkeys.join(','));
}
// 把 "Alt+1" / "ctrl+shift+m" 这类写法统一成 Electron 认的 Accelerator
function normalizeAccelerator(s) {
  const parts = String(s).split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return '';
  const mods = [];
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'cmdorctrl') mods.push('Control');
    else if (l === 'alt') mods.push('Alt');
    else if (l === 'shift') mods.push('Shift');
    else if (l === 'meta' || l === 'super' || l === 'win' || l === 'cmd' || l === 'command') mods.push('Super');
    else key = p.length === 1 ? p.toUpperCase() : (p.charAt(0).toUpperCase() + p.slice(1));
  }
  if (!key) return '';
  return mods.concat([key]).join('+');
}

ipcMain.handle('pet:setBindings', async (_e, payload) => {
  const o = (payload && typeof payload === 'object') ? payload : {};
  CONFIG.assets = CONFIG.assets || {};
  if (Array.isArray(o.bindings)) CONFIG.assets.bindings = o.bindings;
  if (typeof o.hotkeyScope === 'string') CONFIG.assets.hotkeyScope = (o.hotkeyScope === 'global') ? 'global' : 'window';
  saveConfig();
  refreshHotkeys();
  if (winAlive()) mainWin.webContents.send('pet:setBindings', CONFIG.assets);
  return { ok: true, assets: JSON.parse(JSON.stringify(CONFIG.assets)) };
});

// 设置页「试播」：让桌宠立即播放指定绑定
ipcMain.handle('pet:triggerAsset', async (_e, id) => {
  if (!winAlive()) return { ok: false, error: '桌宠窗口未就绪' };
  mainWin.webContents.send('pet:triggerAsset', String(id || ''));
  return { ok: true };
});

// 设置页「试听」：直接用侧车合成一段文本，返回 data URL 供 <audio> 播放
// （设置页是独立窗口，不走主窗的音频链路，避免打扰正在说话的桌宠）
ipcMain.handle('pet:previewTTS', async (_e, payload) => {
  const o = (payload && typeof payload === 'object') ? payload : {};
  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '文本为空' };
  const q = 'text=' + encodeURIComponent(text)
    + (o.engine ? '&engine=' + encodeURIComponent(o.engine) : '')
    + (o.voice ? '&voice=' + encodeURIComponent(o.voice) : '')
    + (o.emo ? '&emo=' + encodeURIComponent(o.emo) : '');
  return await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: TTS_PORT, path: '/tts?' + q, method: 'GET', timeout: 180000 },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if ((res.statusCode || 0) >= 400) {
            let msg = 'TTS ' + res.statusCode;
            try { msg = JSON.parse(buf.toString('utf-8')).error || msg; } catch (e) { /* 忽略 */ }
            resolve({ ok: false, error: msg });
            return;
          }
          const mime = res.headers['content-type'] || 'audio/wav';
          resolve({ ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length });
        });
      });
    req.on('error', (e) => resolve({ ok: false, error: 'TTS 侧车不可用：' + e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, error: '合成超时' }); });
    req.end();
  });
});

// 设置窗读取当前配置快照（深拷贝，避免渲染进程改到主进程对象）
ipcMain.handle('pet:getConfig', async () => {
  try { return JSON.parse(JSON.stringify(CONFIG)); } catch (e) { return {}; }
});

// ---- 聊天大脑 ----
ipcMain.handle('pet:getPersona', async () => readPersona());

ipcMain.handle('pet:setPersona', async (_e, p) => {
  try {
    if (!p || typeof p !== 'object') throw new Error('人设数据不合法');
    writePersona(p);
    // 人设改了要让正在跑的桌宠立刻换提示词（三种大脑共用同一份人设）
    if (winAlive()) mainWin.webContents.send('pet:setPersona', p);
    log('persona saved');
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// 选择窗点「确定」：落盘 -> 下发 -> 关窗
ipcMain.on('pet:brainChoice', (_e, payload) => {
  try {
    const p = payload || {};
    if (p.backend && ['local', 'cloud', 'workbuddy'].indexOf(p.backend) >= 0) CONFIG.chat.backend = p.backend;
    if (typeof p.askEveryStart === 'boolean') CONFIG.chat.askEveryStart = p.askEveryStart;
    saveConfig();
    log('brain chosen: ' + CONFIG.chat.backend + ' askEveryStart=' + CONFIG.chat.askEveryStart);
    // warm=true：本地模型趁这个时候把权重装进显存，用户开口时就是热的
    pushBrain(true);
  } catch (e) { log('brainChoice failed: ' + e.message); }
  closeBrainChooser(payload);
});

// 探测本机 Ollama：在不在 + 装了哪些模型
// 拉起 Ollama 并等到就绪（选中「本地模型」时调用）。maxWaitMs 可省略，默认 60 秒。
ipcMain.handle('pet:ollamaStart', async (_e, maxWaitMs) => {
  try {
    return await ollamaStart(Number(maxWaitMs) || 60000);
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
});

// 查询当前 Ollama 是谁在跑（owned=我们拉起的，退出时会被关掉）
ipcMain.handle('pet:ollamaStatus', async () => ({
  running: !!ollamaState.running,
  owned: !!ollamaState.owned,
  pid: ollamaState.pid || 0,
  modelsDir: ollamaState.modelsDir || ollamaModelsDir() || '(默认)',
  exe: ollamaState.exe || ollamaExe()
}));

// 手动关闭（只关我们自己拉起的那个）
ipcMain.handle('pet:ollamaStop', async () => { ollamaStop(); return { ok: true }; });

// ---------------------------------------------------------------------------
// 本地模型安装向导的 IPC
// ---------------------------------------------------------------------------
// 向导窗口的四个动作：检测 → 装 Ollama → 起服务 → 拉模型。
// 「拉模型」不在主进程做：它的进度是 NDJSON 流，走既有的 /api/ollama 同源代理
// 由页面自己读流算百分比最省事，也不需要新增 IPC。

// 打开向导（选择大脑窗的按钮 / 其它页面都能用）
ipcMain.on('pet:openOllamaSetup', () => { toggleOllamaSetupPanel(); });

// 环境检测：装没装、跑没跑、模型在不在、放哪、磁盘够不够
ipcMain.handle('pet:ollamaDetect', async () => {
  try {
    const st = ollamaDetectSync();
    const q = await ollamaQueryModels();
    st.running = q.running;
    st.models = q.models;
    const base = String(st.model || '').split(':')[0];
    st.modelReady = q.models.some((m) => m.name === st.model || String(m.name).split(':')[0] === base);
    // 空间判断：模型 4.7 GB 是 7B 档的经验值；装包下载在 temp（约 1.5 GB）
    st.needBytes = 4.7 * 1073741824;
    st.diskModelsOk = st.diskModels.freeBytes < 0 ? true : st.diskModels.freeBytes > st.needBytes;
    st.diskTempOk = st.diskTemp.freeBytes < 0 ? true : st.diskTemp.freeBytes > 1.8 * 1073741824;
    st.busy = !!(ollamaSetupJob && ollamaSetupJob.phase && ollamaSetupJob.phase !== 'done');
    st.asset = ollamaSetupAsset ? { tag: ollamaSetupAsset.tag, size: ollamaSetupAsset.size } : null;
    return { ok: true, status: st };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
});

// 单独探下载源（页面想先展示"哪条源能用"时用；一键安装内部也会探一次）
ipcMain.handle('pet:ollamaProbeSources', async () => {
  try {
    const asset = await resolveOllamaAsset();
    const alive = await probeSetupSources(setupCandidates(asset));
    return { ok: true, tag: asset.tag, size: asset.size, sources: alive };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
});

// 一键安装（下载 + 静默安装）。进度全程经 pet:ollamaSetupProgress 推送。
ipcMain.handle('pet:ollamaInstall', async () => {
  try {
    return await ollamaWizardInstall();
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
});

ipcMain.handle('pet:ollamaInstallCancel', async () => {
  if (ollamaSetupJob && ollamaSetupJob.phase && ollamaSetupJob.phase !== 'done') {
    ollamaSetupJob.cancelled = true;
    try { if (ollamaSetupJob.abort) ollamaSetupJob.abort(); } catch (e) {}
    try { if (ollamaSetupJob.child) ollamaSetupJob.child.kill(); } catch (e) {}
  }
  return { ok: true };
});

// 兜底：所有源都不通时，让用户用浏览器自己下（浏览器有系统代理，往往比我们通）
ipcMain.handle('pet:ollamaOpenDownloadPage', async () => {
  try { await shell.openExternal('https://ollama.com/download/windows'); return { ok: true }; }
  catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
});

// 向导把模型目录/模型名落盘（再起服务时 ollamaStart 就会带上正确的 OLLAMA_MODELS）
ipcMain.handle('pet:ollamaSaveLocalCfg', async (_e, patch) => {
  try {
    const p = patch || {};
    CONFIG.chat = CONFIG.chat || {};
    CONFIG.chat.local = CONFIG.chat.local || {};
    if (typeof p.modelsDir === 'string' && p.modelsDir.trim()) CONFIG.chat.local.modelsDir = p.modelsDir.trim();
    if (typeof p.model === 'string' && p.model.trim()) CONFIG.chat.local.model = p.model.trim();
    saveConfig();
    log('ollama wizard: 配置已更新 modelsDir=' + (CONFIG.chat.local.modelsDir || '(默认)') + ' model=' + (CONFIG.chat.local.model || ''));
    return { ok: true };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
});

// 向导收尾：切到本地模型并立即下发（等价于选择窗点确定，只是不关选择窗）
ipcMain.on('pet:ollamaUseLocal', (_e, payload) => {
  try {
    const p = payload || {};
    if (p.model) { CONFIG.chat = CONFIG.chat || {}; CONFIG.chat.local = CONFIG.chat.local || {}; CONFIG.chat.local.model = String(p.model); }
    CONFIG.chat = CONFIG.chat || {};
    CONFIG.chat.backend = 'local';
    if (typeof p.askEveryStart === 'boolean') CONFIG.chat.askEveryStart = p.askEveryStart;
    saveConfig();
    log('ollama wizard: 已切到本地模型 ' + (CONFIG.chat.local.model || ''));
    pushBrain(true);   // warm=true：趁现在把权重装进显存
    // 通知所有窗口刷新（选择大脑窗要重新探测，否则还显示"没安装"）
    [brainWin, settingsWin, ollamaSetupWin].forEach((w) => {
      try { if (w && !w.isDestroyed()) w.webContents.send('pet:ollamaReady', { model: (CONFIG.chat.local && CONFIG.chat.local.model) || '' }); } catch (e) {}
    });
  } catch (e) { log('ollamaUseLocal failed: ' + e.message); }
});

ipcMain.handle('pet:probeLocalModel', async () => {
  const base = (CONFIG.chat && CONFIG.chat.local && CONFIG.chat.local.baseUrl) || 'http://127.0.0.1:11434';
  let u;
  try { u = new URL(base); } catch (e) { return { ok: false, message: '接口地址不合法：' + base }; }
  return await new Promise((resolve) => {
    const req = http.get({ hostname: u.hostname, port: u.port || 11434, path: '/api/tags', timeout: 3000 }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ ok: true, models: (j.models || []).map((m) => m.name || '') });
        } catch (e) { resolve({ ok: false, message: '响应无法解析' }); }
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, message: '连接超时' }); });
    req.on('error', (e) => resolve({ ok: false, message: '无法连接 Ollama：' + e.message }));
  });
});

// 设置窗写入配置：payload 可为 {key,value}（单键）或平铺对象（多键同时写）。
// 设置窗写入配置：payload 可为 {key,value}（单键）或平铺对象（多键同时写）。
// 每个键先写进 CONFIG，再尽量实时下发；需重启的键累计后统一 reload 一次。
ipcMain.handle('pet:setConfig', async (_e, payload) => {
  try {
    const changes = {};
    if (payload && typeof payload === 'object' && typeof payload.key === 'string') changes[payload.key] = payload.value;
    else if (payload && typeof payload === 'object') Object.assign(changes, payload);
    let needReload = false;
    for (const k of Object.keys(changes)) {
      setByPath(CONFIG, k, changes[k]);
      if (applyConfigKey(k, changes[k]) === 'reload') needReload = true;
    }
    saveConfig();
    if (needReload && winAlive()) mainWin.reload();
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

app.on('before-quit', () => {
  // 退出前清理：先记住窗口位置/大小（mainWin 此刻仍存活），再销毁托盘图标
  // （否则它会残留在系统托盘区，直到进程真正死亡；若进程因其它原因未退出就会一直挂着），
  // 并关闭本地静态服务释放端口 18765。
  try { saveWindowBounds(); } catch (e) {}
  try { unregisterHotkeys(); } catch (e) {}
  try { if (tray) { tray.destroy(); tray = null; } } catch (e) {}
  try { ttsKill(); } catch (e) {}
  try { audioKill(); } catch (e) {}
  // Ollama 若是我们自己拉起的，随桌宠一起退出（不关用户本来就开着的那一个）
  try { ollamaStop(); } catch (e) {}
  try { server.close(); } catch (e) {}
  app.isQuiting = true;
});

app.on('window-all-closed', () => {
  // 有托盘常驻时，窗口被隐藏（而非真正关闭）不算退出；只有托盘"退出"才真正 quit。
  if (app.isQuiting) app.quit();
});

// 诊断用：GPU / 渲染进程异常退出时给出可读提示，避免"窗口没出现又没报错"。
// 提示文本用 ASCII，避免 GBK 控制台乱码。
app.on('child-process-gone', (_event, details) => {
  if (details && details.type === 'GPU') {
    console.error('[live2d-companion] GPU process gone: reason=' + details.reason + ' exitCode=' + details.exitCode);
    console.error('  If the window never shows up, set "chromiumSandbox": false in app/config.json.');
  }
});
app.on('render-process-gone', (_event, _wc, details) => {
  console.error('[live2d-companion] renderer process gone: reason=' + details.reason + ' exitCode=' + details.exitCode);
});
