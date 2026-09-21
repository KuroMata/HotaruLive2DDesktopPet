/**
 * 打包用的「发布配置」切换器。
 *
 * === 为什么需要 ===
 *
 * 源码里的 app/config.json 是**本机调好的状态**，含几处只在本机成立的绝对路径：
 *   modelServeBase : D:\SteamLibrary\...\Live2DModels\Hotaru2024   （我的 VTS 模型库）
 *   acpCwd         : D:/live2d-companion/workspace                 （我的 ACP 工作目录）
 *
 * 直接照这份配置打包，别人装完打开是**空白窗**（模型加载不出来）。
 * 程序内自带 app/models/Hotaru2024（加密版，约 172 MB），
 * 所以发布配置把 modelServeBase 留空、modelUrl 指到内置路径即可开箱可用。
 *
 * === 用法 ===
 *
 *   node tools/pack/release-config.js apply     # 备份并写入发布配置
 *   ...打包...
 *   node tools/pack/release-config.js restore   # 从备份恢复（打完必须执行）
 *   node tools/pack/release-config.js show      # 只看当前值
 *
 * 备份放在**项目根**（而不是 app/ 下）：package.json 的 files 白名单只收
 * main.js / preload.js / package.json / app\*\* / tts\*\* / audio/audio_server.py /
 * node_modules\*\*，根目录的其它文件不会被打进包。
 */
const fs = require('fs');
const path = require('path');

const PROJ = path.resolve(__dirname, '..', '..');
const CFG = path.join(PROJ, 'app', 'config.json');
const BAK = path.join(PROJ, '_config_release_backup.json');

const RELEASE = {
  modelServeBase: '',
  modelUrl: '/models/Hotaru2024/hotaru2024.model3.json',
  acpCwd: ''
};

function show(tag) {
  const j = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  console.log(tag + '  modelServeBase = ' + JSON.stringify(j.modelServeBase));
  console.log(tag + '  modelUrl       = ' + j.modelUrl);
  console.log(tag + '  acpCwd         = ' + JSON.stringify(j.acpCwd));
}

const mode = process.argv[2] || 'show';

if (mode === 'apply') {
  if (fs.existsSync(BAK)) {
    console.log('WARN backup already exists, keeping it (not overwritten)');
  } else {
    fs.copyFileSync(CFG, BAK);
    console.log('backup saved -> ' + BAK);
  }
  const j = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  Object.assign(j, RELEASE);
  fs.writeFileSync(CFG, JSON.stringify(j, null, 2) + '\n', 'utf8');
  console.log('RELEASE CONFIG APPLIED');
  show('now');
} else if (mode === 'restore') {
  if (!fs.existsSync(BAK)) {
    console.log('FAIL no backup at ' + BAK);
    process.exit(1);
  }
  fs.copyFileSync(BAK, CFG);
  fs.unlinkSync(BAK);
  console.log('RESTORED from backup');
  show('now');
} else {
  show('current');
}
