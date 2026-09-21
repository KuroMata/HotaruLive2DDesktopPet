// 临时仿真：用你模型真实的参数集（ParamA/I/U/E/O + Silence + OpenY 等）验证
// 元音对照口型修复、Silence 切换、chat 口型驱动、点击台词触发。结果写入 _simv2.txt。
const fs = require('fs');
const OUT = 'D:/live2d-companion/tools/_simv2.txt';
function w(s) { fs.appendFileSync(OUT, s + '\n'); }
fs.writeFileSync(OUT, '');
try {
  const { pinyin } = require('pinyin-pro');
  global.window = { addEventListener: () => {}, PIXI: {}, desktopPet: { pinyin: (ch) => pinyin(ch, { toneType: 'none', type: 'array' }) } };
  global.performance = { now: () => Date.now() };
  global.document = { addEventListener: () => {} };
  eval(fs.readFileSync('D:/live2d-companion/app/js/live2d-loader.js', 'utf8'));

  const c = new window.Live2DController();
  // 模型 mock：参数集 = 你描述的真实命名
  const PARAMS = ['ParamA','ParamI','ParamU','ParamE','ParamO','Silence','ParamMouthOpenY','ParamMouthForm',
    'ParamBodyAngleX','ParamAngleX','ParamAngleY','ParamAngleZ','ParamBreath','ParamEyeBallX','ParamEyeBallY',
    'ParamEyeLOpen','ParamEyeROpen'];
  const store = {};
  const core = {
    getParameterCount: () => PARAMS.length,
    getParameterId: (i) => PARAMS[i],
    setParameterValueById: (id, v) => { store[id] = v; },
    getParameterValueById: (id) => store[id] || 0
  };
  c.model = { internalModel: { coreModel: core } };
  c._core = () => core;

  // 1) 探测：应为元音对照模式，vowelParams 各命中 ParamX，Silence 命中
  c._initVisemeMode();
  w('visemeMode=' + c._visemeMode + ' (应为 true)');
  w('vowelParams=' + JSON.stringify(c._vowelParam));
  w('silenceParam=' + c._silenceParam + ' (应为 Silence)');

  // 2) idle 元音口型：播 "啊衣乌鹅喔" 逐字，检查每帧只推当前元音 + OpenY + Silence=0
  let bad = null;
  c.onIdleLine = () => {};
  c._idleEnabled = true;
  const seenVowels = new Set();
  let silenceDuringTalk = null, silenceWhenIdle = null;
  c.playIdleLine('啊衣乌鹅喔');
  const dt = 16; let frames = 0;
  while (c._talk.active && frames < 6000) {
    c._mouth(dt);
    if (bad) break;
    // 收集被推到 >0 的元音参数
    for (const v of ['a','i','u','e','o']) { const id = c._vowelParam[v]; if (store[id] > 0.01) seenVowels.add(v); }
    silenceDuringTalk = store['Silence'];
    frames++;
  }
  w('idle 播完 frames=' + frames + ' (~' + (frames*dt/1000).toFixed(1) + 's)');
  w('idle 期间触发到的元音口型: ' + [...seenVowels].sort().join(',') + ' (应含 a,i,u,e,o)');
  w('idle 说话中 Silence=' + silenceDuringTalk + ' (应为 1)');
  // 播完后一帧：Silence 应回到 0（本模型极性相反：空闲=面捕模式=0）
  c._mouth(dt);
  silenceWhenIdle = store['Silence'];
  w('idle 结束后 Silence=' + silenceWhenIdle + ' (应为 0)');

  // 3) chat 元音口型驱动：feedChatText 后逐字推进，无 NaN，Silence=1（本模型极性相反）
  c.setSpeaking(true);
  c.feedChatText('你好呀主人');
  let chatNaN = false; const chatSeen = new Set();
  for (let i = 0; i < 400; i++) {
    c._mouth(dt);
    for (const v of ['a','i','u','e','o']) { const id = c._vowelParam[v]; const val = store[id]; if (typeof val !== 'number' || !isFinite(val)) chatNaN = true; if (val > 0.01) chatSeen.add(v); }
    if (typeof store['Silence'] !== 'number') chatNaN = true;
  }
  w('chat 驱动 NaN=' + chatNaN + ' Silence=' + store['Silence'] + ' (应 1)');
  w('chat 期间触发元音: ' + [...chatSeen].sort().join(','));
  c.setSpeaking(false);
  c._mouth(dt);
  w('chat 结束后 Silence=' + store['Silence'] + ' (应 0)');

  // 4) 点击台词：clickPool 命中 → onIdleLine 被调用
  let clicked = null;
  c.onIdleLine = (t) => { clicked = t; };
  c.setClickLines(['戳我干嘛','被你点到了']);
  c.sayClick();
  w('sayClick 触发台词=' + JSON.stringify(clicked) + ' (应非空)');
  // 聊天进行中不触发点击
  c.setSpeaking(true); clicked = null; c.sayClick(); c.setSpeaking(false);
  w('聊天中 sayClick 应被忽略=' + (clicked === null));

  // 5) 回退路径：模型无五元参数时 visemeMode=false
  const core2 = { getParameterCount: () => 2, getParameterId: (i) => ['ParamMouthOpenY','ParamMouthForm'][i],
    setParameterValueById: (id,v)=>{store[id]=v;}, getParameterValueById: (id)=>store[id]||0 };
  c.model = { internalModel: { coreModel: core2 } }; c._core = () => core2;
  c._initVisemeMode();
  w('回退路径 visemeMode=' + c._visemeMode + ' (应 false) | silenceParam=' + JSON.stringify(c._silenceParam));

  w(bad ? ('FAIL NaN/Inf ' + bad) : 'ALL_OK');
} catch (e) {
  fs.appendFileSync(OUT, 'EXCEPTION ' + (e && e.stack || e) + '\n');
}
