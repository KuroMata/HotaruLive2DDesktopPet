#!/usr/bin/env node
// encrypt-models.js — 构建期把 Live2D 模型资源加密为 .enc（AES-256-CBC，随机 IV 存文件头）
// 与 main.js 的解密钩子共用同一派生密钥。磁盘只留 .enc，运行期由主进程内存解密后返回给 renderer。
// 用法：node tools/encrypt-models.js [--dir <模型根目录>] [--decrypt]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 混淆级密钥（非 DRM）：固定 password+salt 经 scrypt 派生 32 字节。main.js 用完全相同参数派生。
const PASSWORD = 'HotaruDesktopPet-Live2D-2024';
const SALT = 'static-salt-v1';
const KEY = crypto.scryptSync(PASSWORD, SALT, 32);
const ALGO = 'aes-256-cbc';

const args = process.argv.slice(2);
const dec = args.includes('--decrypt');
let dir = 'app/models/Hotaru2024';
const di = args.indexOf('--dir');
if (di >= 0 && args[di + 1]) dir = args[di + 1];
const root = path.resolve(__dirname, '..', dir);

if (!fs.existsSync(root)) {
  console.error('模型目录不存在:', root);
  process.exit(1);
}

let count = 0;
let bytes = 0;

function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) { walk(p); continue; }
    if (dec) {
      if (!ent.name.endsWith('.enc')) continue;
      const enc = fs.readFileSync(p);
      const iv = enc.slice(0, 16);
      const d2 = crypto.createDecipheriv(ALGO, KEY, iv);
      const plain = Buffer.concat([d2.update(enc.slice(16)), d2.final()]);
      fs.writeFileSync(p.slice(0, -4), plain); // 去掉 .enc
      fs.unlinkSync(p);
      count++; bytes += plain.length;
    } else {
      if (ent.name.endsWith('.enc')) continue; // 已加密，跳过
      const plain = fs.readFileSync(p);
      const iv = crypto.randomBytes(16);
      const c = crypto.createCipheriv(ALGO, KEY, iv);
      const enc = Buffer.concat([iv, c.update(plain), c.final()]);
      fs.writeFileSync(p + '.enc', enc);
      fs.unlinkSync(p); // 删明文
      count++; bytes += plain.length;
    }
  }
}

walk(root);
console.log(`${(dec ? '解密' : '加密')}完成: ${count} 文件, ${(bytes / 1048576).toFixed(1)} MB @ ${root}`);
