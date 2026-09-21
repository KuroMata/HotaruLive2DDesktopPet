// 仿真：验证「主进程异步拼音 + 按行预取元音」路径，且 Silence 说话时归 0
const fs = require('fs');
const OUT = 'D:/live2d-companion/tools/_simv4.txt';
const lines = [];
const W = (s) => { lines.push(s); };
fs.writeFileSync(OUT, '');
try {
  const pinyinFn = require('pinyin-pro').pinyin;

  global.window = {
    addEventListener: () => {},
    devicePixelRatio: 1,
    PIXI: { live2d: { Live2DModel: {} } },
    Live2DCubismCore: {},
    desktopPet: {
      // 模拟主进程 ipcMain.handle('pet:pinyin')：返回 Promise<array>
      pinyin: (t) => Promise.resolve(pinyinFn(t || '', { toneType: 'none', type: 'array', nonZh: 'consecutive' })),
      log: (m) => { try { fs.appendFileSync('D:/live2d-companion/tools/_vislog.txt', m + '\n', 'utf-8'); } catch (e) {} }
    }
  };
  global.document = { addEventListener: () => {} };
  global.performance = { now: () => Date.now() };

  eval(fs.readFileSync('D:/live2d-companion/app/js/live2d-loader.js', 'utf8'));
  const c = new window.Live2DController();

  // 假模型：带 ParamA..O + Silence + OpenY（你的 Hotaru2024 实际命名）
  const params = {};
  ['ParamA','ParamI','ParamU','ParamE','ParamO','Silence','ParamMouthOpenY','ParamMouthForm'].forEach((k) => params[k] = 0);
  c._core = () => ({
    getParameterCount: () => 7,
    getParameterId: (i) => ['ParamA','ParamI','ParamU','ParamE','ParamO','Silence','ParamMouthOpenY'][i],
    setParameterValueById: (id, v) => { params[id] = v; },
    getParameterValueById: (id) => params[id] || 0
  });
  c._setParam = (id, v) => { params[id] = v; return true; };
  c._getParam = (id) => params[id] || 0;
  c.idle = true;

  // 探测
  c._initVisemeMode();
  W('visemeMode=' + c._visemeMode + ' (期望 true)');
  W('vowelParam=' + JSON.stringify(c._vowelParam));
  W('silenceParam=' + c._silenceParam + ' (期望 Silence)');

  // 播放一条含多元音的台词
  const done = new Promise((res) => {
    c.onIdleLine = () => {};
    c.playIdleLine('啊衣乌鹅喔');  // a i u e o
    // 等元音异步预取完成
    setTimeout(() => {
      let bad = null;
      const dt = 16; let frames = 0;
      const seenVowels = new Set();
      while (frames < 6000) {
        c._mouth(dt);
        // 记录当前被驱动的元音参数
        ['ParamA','ParamI','ParamU','ParamE','ParamO'].forEach((k) => { if (params[k] > 0.05) seenVowels.add(k); });
        if (!isFinite(params.ParamMouthOpenY)) bad = 'OpenY NaN';
        frames++;
        if (c._talk.active === false) break; // 台词播完
      }
      W('frames=' + frames);
      W('driven vowels=' + [...seenVowels].join(',') + ' (期望含 A/I/U/E/O)');
      W('Silence during talk=' + params.Silence + ' (期望 0)');
      W('OpenY peak~=' + (params.ParamMouthOpenY).toFixed(3));
      W(bad ? ('FAIL ' + bad) : 'no-NaN OK');
      res();
    }, 200);
  });

  done.then(() => {
    fs.appendFileSync(OUT, lines.join('\n') + '\n', 'utf-8');
  });
} catch (e) {
  fs.appendFileSync(OUT, lines.join('\n') + '\nEXCEPTION ' + (e && e.stack ? e.stack : String(e)) + '\n', 'utf-8');
}
