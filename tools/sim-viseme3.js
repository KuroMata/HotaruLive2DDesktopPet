const fs = require('fs');
const OUT = 'D:/live2d-companion/tools/_simv3.txt';
const lines = [];
function w(s) { lines.push(s); }
try {
  const { pinyin } = require('pinyin-pro');
  global.window = {
    addEventListener: () => {},
    desktopPet: {
      log: (m) => w('[log] ' + m),
      pinyin: (t) => pinyin(t || '', { toneType: 'none', type: 'array', nonZh: 'consecutive' })
    }
  };
  global.performance = { now: () => Date.now() };
  eval(fs.readFileSync('D:/live2d-companion/app/js/live2d-loader.js', 'utf-8'));

  // 稳定 core：每次 _core() 返回同一实例（模拟真实的 internalModel.coreModel），
  // 这样 setParameterValueById 与 getParameterValueById 共享同一 store，可验证真实写入。
  function stableCore(ids) {
    const store = {};
    const writes = {};
    const core = {
      getParameterCount: () => ids.length,
      getParameterId: (i) => ids[i],
      setParameterValueById: (id, v) => { store[id] = v; writes[id] = (writes[id] || []).concat(v); },
      getParameterValueById: (id) => (id in store ? store[id] : 0),
      _writes: writes, _store: store
    };
    return core;
  }

  function scenario(name, ids, text) {
    const c = new window.Live2DController();
    const core = stableCore(ids);
    c._core = () => core;
    c._initVisemeMode();
    c.playIdleLine(text);
    const dt = 16;
    // 只跑足够覆盖整句台词的帧，确保采样落在"说话中"
    for (let i = 0; i < 200; i++) { c._mouth(dt); if (!c._talk.active) break; }
    w(name + ': visemeMode=' + c._visemeMode + ' silenceParam=' + (c._silenceParam || '(none)'));
    w(name + ': Silence 写入记录=' + JSON.stringify(core._writes['Silence'] || []));
    if (c._visemeMode) w(name + ': ParamA 写入过的最大幅值=' + (core._writes['ParamA'] ? Math.max.apply(null, core._writes['ParamA']).toFixed(2) : 'n/a'));
    else w(name + ': OpenY 写入过的最大幅值=' + (core._writes['ParamMouthOpenY'] ? Math.max.apply(null, core._writes['ParamMouthOpenY']).toFixed(2) : 'n/a'));
  }

  scenario('A(元音对照)', ['ParamA','ParamI','ParamU','ParamE','ParamO','Silence','ParamMouthOpenY'], '你好啊');
  scenario('B(回退模式)', ['ParamMouthOpenY','ParamMouthForm','Silence','ParamEyeBallX'], '你好啊');
  scenario('C(无Silence)', ['ParamA','ParamI','ParamU','ParamE','ParamO','ParamMouthOpenY'], '你好啊');

  w('SIM_OK');
} catch (e) {
  w('SIM_ERROR: ' + (e && e.stack ? e.stack : e));
}
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf-8');
