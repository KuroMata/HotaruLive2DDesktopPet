// 验证打包后（或任意目录）的 .enc 模型资源能被 main.js 的解密逻辑还原。
// 复刻 main.js 的密钥派生与 AES-256-CBC 解密，并校验文件头 magic。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASSWORD = 'HotaruDesktopPet-Live2D-2024';
const SALT = 'static-salt-v1';
const KEY = crypto.scryptSync(PASSWORD, SALT, 32);
const ALGO = 'aes-256-cbc';

const base = process.argv[2];
if (!base) { console.error('usage: node verify-packaged-enc.js <models-base-dir>'); process.exit(2); }

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.enc')) acc.push(p);
  }
  return acc;
}

const files = walk(base, []);
let ok = 0, fail = 0;
const fails = [];
for (const f of files) {
  try {
    const data = fs.readFileSync(f);
    const iv = data.slice(0, 16);
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    const plain = Buffer.concat([decipher.update(data.slice(16)), decipher.final()]);
    const head4 = plain.slice(0, 4).toString('latin1');
    const isPNG = plain[0] === 0x89 && plain[1] === 0x50 && plain[2] === 0x4e && plain[3] === 0x47;
    const isMOC3 = head4 === 'MOC3';
    const isJSON = (() => {
      const s = plain.toString('utf8', 0, Math.min(plain.length, 256)).trim();
      return s[0] === '{' || s[0] === '[';
    })();
    const isWAV = head4 === 'RIFF';
    if (isPNG || isMOC3 || isJSON || isWAV) ok++;
    else { fail++; fails.push(`${f} (unrecognized magic, len=${plain.length})`); }
  } catch (e) {
    fail++; fails.push(`${f} (${e.message})`);
  }
}
console.log(`base=${base}`);
console.log(`encrypted files=${files.length}  OK=${ok}  FAIL=${fail}`);
for (const x of fails) console.log('FAIL: ' + x);
process.exit(fail === 0 ? 0 : 1);
