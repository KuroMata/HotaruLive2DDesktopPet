// 临时仿真：验证元音对照口型链路（不依赖 Electron / 真实模型）
// 关键：真实模型的 coreModel 没有 getParameterCount/getParameterId（枚举接口），
// 但有 setParameterValueById/getParameterValueById。新逻辑改用「写-读回环」探测，
// 所以这里用只提供 set/get、不提供枚举的 stub 来复现真实运行时，验证新路径。
//
// 重要：pinyin-pro 经 Promise 异步返回，必须让出微任务队列才能加载元音。整个测试用
// async 结构，在 playIdleLine 之后 await 一次微任务，确保 _talk.vowels 就绪后再跑帧循环，
// 否则同步循环里 vowels 永远是 null、one-hot 校验形同虚设（旧版仿真的盲区）。
const fs = require('fs');
const OUT = 'D:/live2d-companion/tools/_simv.txt';
const lines = [];
const out = (s) => lines.push(s);
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
try {
  const { pinyin } = require('pinyin-pro');
  global.window = {
    addEventListener: () => {},
    desktopPet: { pinyin: (t) => pinyin(t || '', { toneType: 'none', type: 'array', nonZh: 'consecutive' }) }
  };
  global.document = { addEventListener: () => {} };
  let simNow = 0;
  global.performance = { now: () => simNow };

  eval(fs.readFileSync('D:/live2d-companion/app/js/live2d-loader.js', 'utf8'));
  const c = new window.Live2DController();

  // 捕获参数写入（_applyViseme / _clearMouth / _setSilence 走这里）
  const store = {};
  c._setParam = (id, v) => { store[id] = v; };
  c._getParam = (id) => (store[id] || 0);

  // 复现真实运行时：只认 existingIds 里的参数；set 仅当存在才写入，
  // get 对未知 id 返回 0（与 Cubism 对未知 id 静默忽略/返回默认的行为一致）。
  // 注意：不提供 getParameterCount / getParameterId —— 模拟「枚举接口缺失」。
  function makeCore(existingIds) {
    const has = new Set(existingIds);
    const map = {};
    return {
      setParameterValueById: (id, v) => { if (has.has(id)) map[id] = v; },
      getParameterValueById: (id) => (has.has(id) ? (map[id] || 0) : 0)
    };
  }

  // ---- 1) 模型带五元参数（ParamA..O + Silence，你的 Hotaru2024 命名）-> 元音对照模式 ----
  const VIS = ['ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO'];
  c._core = () => makeCore([
    'ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO', 'Silence',
    'ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeLOpen', 'ParamEyeROpen'
  ]);
  c._initVisemeMode();
  out('visemeMode(带五元)=' + c._visemeMode + ' (应为 true)');
  out('vowelParams=' + JSON.stringify(c._vowelParam));
  out('silenceParam=' + (c._silenceParam || '(none)'));
  if (!c._visemeMode) throw new Error('应进入元音对照模式');
  if (c._vowelParam.a !== 'ParamA') throw new Error('a 应识别为 ParamA');

  // 元音分类单测
  const cases = { ma: 'a', ni: 'i', mu: 'u', mei: 'e', bo: 'o', 'lü': 'u', hi: 'i', cat: 'a', z: null };
  for (const [k, exp] of Object.entries(cases)) {
    const got = c._vowelFromSyllable(k);
    if (got !== exp) throw new Error('vowelFromSyllable(' + k + ')=' + got + ' 期望 ' + exp);
  }
  out('vowelFromSyllable 单测通过');

  // ---- 2) 跑 idle 口型：麻(a)尼(i)木(u)美(e)波(o)。 ----
  c.idle = false;
  c.playIdleLine('麻尼木美波。');
  await flush();  // 让出微任务队列，使异步预取的 tk.vowels 就绪
  if (!c._talk.vowels) throw new Error('异步拼音未能在帧循环前就绪（测试盲区）');
  out('vowels 就绪=' + JSON.stringify(c._talk.vowels));
  const dt = 20;
  let bad = null, frames = 0, maxNZ = 0, formViol = 0, silenceActiveViol = 0;
  for (let f = 0; f < 400; f++) {
    simNow += dt; c._mouth(dt); frames++;
    const vowelsReady = !!c._talk.vowels;
    const openY = store.ParamMouthOpenY || 0;
    const vals = VIS.map((k) => store[k] || 0);
    if (vowelsReady && openY > 0.05) {
      const nz = vals.filter((v) => v > 0.05);
      if (nz.length > maxNZ) maxNZ = nz.length;
      // 严格 one-hot：元音激活时最多一个元音参数非零，且 ParamMouthForm 必须归 0
      if (nz.length !== 1) bad = '帧' + f + ' OpenY=' + openY.toFixed(3) + ' 非零元音数=' + nz.length;
      else if (Math.abs(nz[0] - openY) > 0.02) bad = '帧' + f + ' 元音与OpenY不一致';
      if ((store.ParamMouthForm || 0) !== 0) formViol++;
    }
    // 说话中应 Silence=1（本模型极性相反：1=参数驱动模式）；tk.active 为真时检测
    if (c._talk.active && store.Silence !== 1) silenceActiveViol++;
    if (bad) break;
  }
  if (bad) throw new Error(bad);
  if (formViol > 0) throw new Error('元音模式 Form 未归 0 的帧数=' + formViol);
  if (maxNZ > 1) throw new Error('出现两个元音同时非零的帧，maxNZ=' + maxNZ);
  out('idle 元音对照：' + frames + ' 帧无异常（每帧最多 1 个元音参数非零、Form=0、元音=OpenY）');
  out('maxNonzeroVowels=' + maxNZ + ' (应为 1)');
  out('Silence 说话中应=1 的违例帧数=' + silenceActiveViol + ' (应为 0)');

  // 标点帧应闭口：直接验证 _clearMouth
  c._clearMouth();
  if ((store.ParamMouthOpenY || 0) !== 0 || VIS.some((k) => (store[k] || 0) !== 0))
    throw new Error('clearMouth 未归零');
  out('clearMouth 归零通过');

  // ---- 3) 模型无五元参数 -> 回退 OpenY+Form ----
  c._core = () => makeCore(['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY', 'ParamMouthForm']);
  c._initVisemeMode();
  out('visemeMode(无五元)=' + c._visemeMode + ' (应为 false)');
  c.playIdleLine('麻尼木。');
  await flush();
  let bad2 = null;
  for (let f = 0; f < 200; f++) {
    simNow += dt; c._mouth(dt);
    const openY = store.ParamMouthOpenY || 0;
    if (openY > 0.05) {
      if (Math.abs((store.ParamMouthForm || 0) - 0.2) > 0.02) bad2 = '回退模式 Form 非 0.2';
      if (VIS.some((k) => (store[k] || 0) > 0.05)) bad2 = '回退模式却驱动了元音参数';
    }
    if (bad2) break;
  }
  if (bad2) throw new Error(bad2);
  out('回退模式：OpenY+Form 驱动，元音参数保持 0，通过');

  out('OK_ALL_PASS');
} catch (e) {
  out('FAIL: ' + (e && e.stack ? e.stack : e));
}
fs.writeFileSync(OUT, lines.join('\n'), 'utf-8');
})();
