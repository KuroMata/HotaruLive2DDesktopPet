// 临时仿真：验证「整句元音分布小结」_emitVisemeSummary 真的会发射，
// 且 distinct（出现的元音种类）与 maxNonzeroPerFrame（one-hot 证据）正确。
// 不依赖 Electron / 真实模型，用只提供 set/get 的 stub core 复现真实运行时。
const fs = require('fs');
const OUT = 'D:/live2d-companion/tools/_sims.txt';
const lines = [];
const out = (s) => lines.push(s);
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
try {
  const { pinyin } = require('pinyin-pro');
  const LOGS = [];
  global.window = {
    addEventListener: () => {},
    // 与真实 main.js 一致：nonZh:'spaced' 返回逐字 1:1 数组
    desktopPet: {
      pinyin: (t) => pinyin(t || '', { toneType: 'none', type: 'array', nonZh: 'spaced' }),
      log: (m) => LOGS.push(m)
    }
  };
  global.document = { addEventListener: () => {} };
  let simNow = 0;
  global.performance = { now: () => simNow };

  eval(fs.readFileSync('D:/live2d-companion/app/js/live2d-loader.js', 'utf8'));
  const c = new window.Live2DController();

  const store = {};
  c._setParam = (id, v) => { store[id] = v; };
  c._getParam = (id) => (store[id] || 0);

  function makeCore(existingIds) {
    const has = new Set(existingIds);
    const map = {};
    return {
      setParameterValueById: (id, v) => { if (has.has(id)) map[id] = v; },
      getParameterValueById: (id) => (has.has(id) ? (map[id] || 0) : 0)
    };
  }
  const VIS = ['ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO'];
  c._core = () => makeCore([
    'ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO', 'Silence',
    'ParamMouthOpenY', 'ParamMouthForm', 'ParamEyeLOpen', 'ParamEyeROpen'
  ]);
  c._initVisemeMode();
  if (!c._visemeMode) throw new Error('应进入元音对照模式');

  // 驱动整条待机台词直到播完（tk.active 变 false 即小结已发射）
  c.idle = false;
  c.playIdleLine('麻尼木美波。');
  await flush();  // 让异步拼音就绪
  if (!c._talk.vowels) throw new Error('异步拼音未就绪');
  out('vowels=' + JSON.stringify(c._talk.vowels) + ' (应为 [a,i,u,e,o,null])');

  const dt = 20;
  let frames = 0;
  while (c._talk.active && frames < 600) {
    simNow += dt; c._mouth(dt); frames++;
  }
  out('驱动帧数=' + frames + ' 台词已播完(active=' + c._talk.active + ')');
  out('播完后 _visemeStats=' + (c._visemeStats === null ? 'null(已重置)' : '未重置!'));

  const summaries = LOGS.filter((m) => m.indexOf('[viseme-summary]') === 0);
  if (!summaries.length) throw new Error('未发射 [viseme-summary] 行！');
  out('捕获到 summary 行数=' + summaries.length);
  out('SUMMARY=' + summaries[0]);

  // 解析 distinct 与 maxNonzeroPerFrame
  const sm = summaries[0];
  const d = sm.match(/distinct=(\d+)\/5/);
  const m = sm.match(/maxNonzeroPerFrame=(\d+)/);
  const distinct = d ? +d[1] : -1;
  const maxNz = m ? +m[1] : -1;
  out('解析 distinct=' + distinct + ' maxNonzeroPerFrame=' + maxNz);
  if (distinct !== 5) throw new Error('distinct 应为 5（a/i/u/e/o 都出现），实为 ' + distinct);
  if (maxNz !== 1) throw new Error('maxNonzeroPerFrame 应为 1（严格 one-hot），实为 ' + maxNz);
  out('OK_SUMMARY_PASS');
} catch (e) {
  out('FAIL: ' + (e && e.stack ? e.stack : e));
}
fs.writeFileSync(OUT, lines.join('\n'), 'utf-8');
})();
