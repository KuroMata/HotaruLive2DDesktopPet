// final-verify.js —— 收尾静态校验（JS 语法 / JSON 可解析 / 关键事实断言）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const PROJ = 'D:\\live2d-companion';
const ok = [], bad = [];

function checkJs(rel) {
  const p = path.join(PROJ, rel);
  try {
    execFileSync(NODE, ['--check', p], { stdio: 'pipe' });
    ok.push('JS  ok   ' + rel);
  } catch (e) {
    bad.push('JS  FAIL ' + rel + ' :: ' + String(e.stderr || e.message).slice(0, 300));
  }
}
function checkJson(rel) {
  const p = path.join(PROJ, rel);
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    ok.push('JSON ok  ' + rel);
  } catch (e) {
    bad.push('JSON FAIL ' + rel + ' :: ' + e.message);
  }
}

[
  'main.js', 'preload.js',
  'app\\settings.js', 'app\\js\\app.js', 'app\\js\\live2d-loader.js', 'app\\js\\music-tracker.js',
  'tools\\selfcheck\\probe-settings.js', 'tools\\selfcheck\\run-settings-check.js',
  'tools\\selfcheck\\check-user-audio.js', 'tools\\selfcheck\\probe-model-sync.js'
].forEach(checkJs);

[
  'app\\config.json',
  'app\\data\\lines\\profiles\\hotaru.json',
  'app\\data\\lines\\profiles\\default.json'
].forEach(checkJson);

// 关键事实断言（防止后续改动悄悄回退）
const mt = fs.readFileSync(path.join(PROJ, 'app\\js\\music-tracker.js'), 'utf8');
// 断言前先剥掉整行注释：修复说明里会引用 `estimateBpm()` 这个名字，
// 不剥注释会把"注释提到过"误判成"还在调用"（本机实测踩过一次假失败）。
const mtCode = mt.replace(/^\s*\/\/.*$/gm, '');
if (/estimateBpm\s*\(/.test(mtCode)) bad.push('FACT FAIL music-tracker.js 仍存在 estimateBpm() 调用');
else ok.push('FACT ok  音乐跟踪器无悬空 estimateBpm() 调用（已剥注释）');
if (!/function estimateTempo\s*\(/.test(mt)) bad.push('FACT FAIL 找不到 estimateTempo() 定义');
else ok.push('FACT ok  estimateTempo() 定义存在');

const eng = fs.readFileSync(path.join(PROJ, 'tts\\engines.py'), 'utf8');
const m = eng.match(/VOICE_LIST\s*=\s*\[([\s\S]*?)\]/);
if (!m) bad.push('FACT FAIL engines.py 找不到 VOICE_LIST');
else {
  const names = (m[1].match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1));
  const hasJa = names.some((n) => n.startsWith('ja-JP'));
  const hasEn = names.some((n) => n.startsWith('en-US')) && names.some((n) => n.startsWith('en-GB'));
  const dup = names.length !== new Set(names).size;
  ok.push('FACT ..  Edge VOICE_LIST 共 ' + names.length + ' 项；ja=' + hasJa + ' en=' + hasEn + ' 重复=' + dup);
  if (!hasJa || !hasEn) bad.push('FACT FAIL Edge 音色表缺 ja 或 en');
  if (dup) bad.push('FACT FAIL Edge 音色表有重复项');
}

const cfg = JSON.parse(fs.readFileSync(path.join(PROJ, 'app\\config.json'), 'utf8'));
const asrt = [
  ['modelAssets 注入 idle', JSON.stringify(cfg.modelAssets || {}).indexOf('"idle"') >= 0],
  ['modelAssets 注入 sleep', JSON.stringify(cfg.modelAssets || {}).indexOf('"sleep"') >= 0],
  ['assets.hotkeyScope 存在', !!cfg.assets && !!cfg.assets.hotkeyScope],
  ['assets.bindings 非空', !!cfg.assets && Array.isArray(cfg.assets.bindings) && cfg.assets.bindings.length > 0],
  ['lineProfile 绑定 hotaru', !!cfg.lineProfile && Object.values(cfg.lineProfile).indexOf('hotaru') >= 0],
  ['ttsLang 有 en', !!cfg.ttsLang && !!cfg.ttsLang.en],
  ['绑定用 onClick/onIdle/onLine（非 triggers）',
    !cfg.assets.bindings.some((b) => 'triggers' in b) && cfg.assets.bindings.every((b) => 'onClick' in b && 'onLine' in b)]
];
asrt.forEach(([n, pass]) => { (pass ? ok : bad).push((pass ? 'FACT ok  ' : 'FACT FAIL ') + n); });

// 切模型时「台词」/「表情与动作」两页的自动同步（本轮新增）。
// 机制：settings.js 里的 modelCtx 广播 + 四个分页订阅，主进程再把主窗上报的素材清单转发进设置窗。
const sj = fs.readFileSync(path.join(PROJ, 'app\\settings.js'), 'utf8');
const mj = fs.readFileSync(path.join(PROJ, 'main.js'), 'utf8');
const syncAsrt = [
  ['settings.js 有 modelCtx 广播机制',
    /const modelCtx\s*=/.test(sj) && /function setModelUrl\s*\(/.test(sj) && /function emitModelCtx\s*\(/.test(sj)],
  ['onModelChange 为 1 处定义 + 4 处分页订阅',
    (sj.match(/onModelChange\s*\(/g) || []).length === 5],
  ['模型页「载入模型」成功后调 setModelUrl 广播（不再只手改状态栏文字）',
    /bLoad\.addEventListener\('click',[\s\S]{0,800}?setModelUrl\(/.test(sj)],
  ['台词档选择器有 syncToModel 且订阅了模型变化',
    /function syncToModel\s*\(/.test(sj) && /onModelChange\(syncToModel\)/.test(sj)],
  ['素材关联页换模型时丢弃旧扫描结果并重扫',
    /onModelChange\(\(\) => \{\s*assetState\.scan = null;/.test(sj)],
  ['触发绑定页也订阅 lineState（换档后「哪些台词」跟着换）',
    /lineState\.listeners\.push\(render\);/.test(sj.slice(sj.indexOf('function makeAssetBinder')))],
  ['设置窗订阅 pet:modelAssetsUpdated',
    /api\.on\('pet:modelAssetsUpdated'/.test(sj)],
  ['主进程把素材上报转发给设置窗',
    /pet:reportModelAssets'[\s\S]{0,800}?settingsWin\.webContents\.send\('pet:modelAssetsUpdated'/.test(mj)]
];
syncAsrt.forEach(([n, pass]) => { (pass ? ok : bad).push((pass ? 'FACT ok  ' : 'FACT FAIL ') + n); });

const lines = ['=== PASS (' + ok.length + ') ==='].concat(ok)
  .concat(['', '=== FAIL (' + bad.length + ') ===']).concat(bad)
  .concat(['', bad.length ? 'RESULT: FAIL' : 'RESULT: ALL OK']);
fs.writeFileSync(path.join(PROJ, 'tools', 'selfcheck', 'final-verify.log'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
