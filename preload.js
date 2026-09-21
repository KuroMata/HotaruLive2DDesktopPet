// preload.js —— 以 contextBridge 暴露受限的窗口控制接口给渲染进程
const { contextBridge, ipcRenderer } = require('electron');
// 注意：pinyin-pro 的汉字转拼音改为由主进程经 ipcMain.handle('pet:pinyin') 提供，
// 渲染进程只需 ipcRenderer.invoke 异步取结果。这样 preload 不再直接 require pinyin-pro，
// 避免该依赖在 Electron 渲染子进程里加载失败、导致整段 contextBridge 不挂载
//（那样 window.desktopPet 会是 undefined，口型同步与诊断日志会全部静默失效）。
contextBridge.exposeInMainWorld('desktopPet', {
  minimize: () => ipcRenderer.send('pet:minimize'),
  close: () => ipcRenderer.send('pet:close'),
  toggleAlwaysOnTop: () => ipcRenderer.send('pet:toggle-top'),
  // 锁定/解锁模型位置与缩放（单一入口：写入主进程状态并下发）
  lockModel: (v) => ipcRenderer.send('pet:lock', !!v),
  // 请求重置模型位置与缩放
  resetTransform: () => ipcRenderer.send('pet:reset'),
  // 切换窗口显隐
  toggleVisible: () => ipcRenderer.send('pet:toggleVisible'),
  // 打开设置窗口（主窗「设置」按钮用；与托盘菜单同一入口）
  openSettings: () => ipcRenderer.send('pet:openSettings'),
  // 主进程 -> 渲染进程：应用锁定状态
  onApplyLock: (cb) => ipcRenderer.on('pet:applyLock', (_e, v) => cb(!!v)),
  // 主进程 -> 渲染进程：执行重置
  onApplyReset: (cb) => ipcRenderer.on('pet:applyReset', () => cb()),
  // 主进程 -> 渲染进程：通用事件订阅（托盘菜单的口型调试指令经此下发）
  on: (channel, cb) => { try { ipcRenderer.on(channel, (_e, ...args) => cb(...args)); } catch (e) {} },
  // 汉字转拼音（异步，经主进程，避免渲染进程直接依赖 pinyin-pro）：返回拼音字符串数组
  pinyin: (text) => {
    try { return ipcRenderer.invoke('pet:pinyin', text || ''); }
    catch (e) { return Promise.resolve([]); }
  },
  // 渲染进程 -> 主进程：枚举屏幕采集源（供"屏幕运动追踪"经 getUserMedia 取得 source id）。
  // 返回 [{id,name,display_id}] 或 {error}。渲染进程 contextIsolation 下不能 require electron，
  // 故由主进程用 desktopCapturer 取源，只把 id 字符串传回，渲染进程再走 getUserMedia 拿视频流。
  getScreenSources: () => {
    try { return ipcRenderer.invoke('pet:getScreenSources'); }
    catch (e) { return Promise.resolve({ error: String(e && e.message || e) }); }
  },
  // 设置窗：枚举物理显示器（供"追踪屏幕"下拉与"标识屏幕"按钮）
  getDisplays: () => {
    try { return ipcRenderer.invoke('pet:getDisplays'); }
    catch (e) { return Promise.resolve({ error: String(e && e.message || e) }); }
  },
  // 设置窗：在每个显示器上短暂弹出编号（类似 Windows 显示设置的"标识"），selected 高亮
  identifyDisplays: (selected) => {
    try { return ipcRenderer.invoke('pet:identifyDisplays', selected); }
    catch (e) { return Promise.resolve({ error: String(e && e.message || e) }); }
  },
  // 设置窗：读取当前配置快照（主进程从 app/config.json 加载后持有的对象）
  getConfig: () => {
    try { return ipcRenderer.invoke('pet:getConfig'); }
    catch (e) { return Promise.resolve({}); }
  },
  // 渲染进程 -> 主进程：上报已加载模型的全部参数 ID（设置窗“额外追踪参数”下拉枚举用）
  reportModelParams: (ids) => { try { ipcRenderer.send('pet:reportModelParams', ids); } catch (e) {} },
  // 设置窗 -> 主进程：读取缓存的模型参数 ID 列表（空时主进程会请主窗口补报一次）
  getModelParams: () => {
    try { return ipcRenderer.invoke('pet:getModelParams'); }
    catch (e) { return Promise.resolve([]); }
  },
  // 渲染进程 -> 主进程：上报本机的音频输入设备列表（设置窗"监听设备"下拉用）
  reportAudioDevices: (list) => { try { ipcRenderer.send('pet:reportAudioDevices', list); } catch (e) {} },
  // 设置窗 -> 主进程：读取缓存的音频输入设备列表（空时主进程会请主窗口补报一次）
  getAudioDevices: () => {
    try { return ipcRenderer.invoke('pet:getAudioDevices'); }
    catch (e) { return Promise.resolve([]); }
  },
  // 音频侧车（方案③ 逐端点回环）：
  getOutputDevices: () => {                       // 枚举本机输出设备（音箱/耳机），可选具体端点
    try { return ipcRenderer.invoke('pet:getOutputDevices'); }
    catch (e) { return Promise.resolve([]); }
  },
  audioStart: (p) => {                            // 对指定输出端点开始回环采集
    try { return ipcRenderer.invoke('pet:audioStart', p); }
    catch (e) { return Promise.resolve({ ok: false }); }
  },
  audioStop: () => {                              // 停止回环采集
    try { return ipcRenderer.invoke('pet:audioStop'); }
    catch (e) { return Promise.resolve({ ok: false }); }
  },
  getAudioState: () => {                          // 轮询：{level,bpm,bpmStable,playing,peak,onsets}
    try { return ipcRenderer.invoke('pet:getAudioState'); }
    catch (e) { return Promise.resolve(null); }
  },
  // 渲染进程 -> 主进程：上报音律识别状态（设置窗"音律识别"观测面板用，每 500ms 一次）
  reportMusicState: (s) => { try { ipcRenderer.send('pet:reportMusicState', s); } catch (e) {} },
  // 设置窗 -> 主进程：读取缓存的音乐检测状态（是否检测到音乐 / 当前跑 A 还是 B / BPM 多少）
  getMusicState: () => {
    try { return ipcRenderer.invoke('pet:getMusicState'); }
    catch (e) { return Promise.resolve(null); }
  },
  // 设置窗：写入配置。payload 为 {key,value}（单键）或平铺对象（多键）。返回 {ok,error?}
  setConfig: (payload) => {
    try { return ipcRenderer.invoke('pet:setConfig', payload); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e && e.message || e) }); }
  },
  // 渲染进程 -> 主进程：写入 app.log（把模型真实口型参数名等诊断信息落到日志，便于确认）
  log: (msg) => { try { ipcRenderer.send('pet:log', String(msg)); } catch (e) {} },
  // 渲染进程 -> 主进程：通用事件发送（参数调试面板经此把全参数快照发给主进程，再转发到调试窗口）
  send: (channel, ...args) => { try { ipcRenderer.send(channel, ...args); } catch (e) {} },

  // ==================== R1 · 模型库与切换 ====================
  // 系统目录选择对话框。返回 {ok, path} 或 {ok:false}
  chooseDirectory: (opts) => {
    try { return ipcRenderer.invoke('pet:chooseDirectory', opts || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
  // 系统文件选择对话框（默认音频过滤器）。返回 {ok, path} 或 {ok:false}
  chooseFile: (opts) => {
    try { return ipcRenderer.invoke('pet:chooseFile', opts || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
  // 扫描模型库，列出其中全部 *.model3.json：{ok, base, models:[{name,rel,dir,size}]}
  scanModels: (dir) => {
    try { return ipcRenderer.invoke('pet:scanModels', dir || ''); }
    catch (e) { return Promise.resolve({ ok: false, models: [] }); }
  },
  // 扫描指定模型目录下的动作/表情素材：{ok, dir, motions:[{file,rel,name}], expressions:[...]}
  scanModelAssets: (modelUrl) => {
    try { return ipcRenderer.invoke('pet:scanModelAssets', modelUrl || ''); }
    catch (e) { return Promise.resolve({ ok: false, motions: [], expressions: [] }); }
  },
  // 切换模型（热重载，不重启程序）：主进程写 config.modelUrl 并让桌宠重载模型
  switchModel: (url) => {
    try { return ipcRenderer.invoke('pet:switchModel', url); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },

  // ==================== R2 · 台词档与音色 ====================
  listLineProfiles: () => {
    try { return ipcRenderer.invoke('pet:listLineProfiles'); }
    catch (e) { return Promise.resolve([]); }
  },
  getLineProfile: (id) => {
    try { return ipcRenderer.invoke('pet:getLineProfile', id); }
    catch (e) { return Promise.resolve({ ok: false }); }
  },
  // 保存整份台词档：{id, profile:{name, click:[], idle:[]}}
  setLineProfile: (payload) => {
    try { return ipcRenderer.invoke('pet:setLineProfile', payload || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
  deleteLineProfile: (id) => {
    try { return ipcRenderer.invoke('pet:deleteLineProfile', id); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
  // 列出某 TTS 引擎的预设音色：{engine, voices:[...]}
  listVoices: (engine) => {
    try { return ipcRenderer.invoke('pet:listVoices', engine || ''); }
    catch (e) { return Promise.resolve({ engine: '', voices: [] }); }
  },
  // 试听：直接用侧车合成一段文本，返回 {ok, dataUrl} 供 <audio> 播放
  previewTTS: (payload) => {
    try { return ipcRenderer.invoke('pet:previewTTS', payload || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },

  // ==================== R3 · 素材与触发绑定 ====================
  // 渲染进程 -> 主进程：上报本模型实际可用的表情/动作清单
  reportModelAssets: (o) => { try { ipcRenderer.send('pet:reportModelAssets', o || {}); } catch (e) {} },
  // 设置窗 -> 主进程：读取缓存的素材清单（空时主进程会请主窗口补报一次）
  getModelAssets: () => {
    try { return ipcRenderer.invoke('pet:getModelAssets'); }
    catch (e) { return Promise.resolve({ expressions: [], motions: [] }); }
  },
  // 保存触发绑定与快捷键范围：{bindings:[], hotkeyScope:'window'|'global'}
  setBindings: (payload) => {
    try { return ipcRenderer.invoke('pet:setBindings', payload || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
  // 设置页「试播」：让桌宠立即播放指定绑定
  triggerAsset: (id) => {
    try { return ipcRenderer.invoke('pet:triggerAsset', id); }
    catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  }
});
