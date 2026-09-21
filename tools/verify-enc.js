#!/usr/bin/env node
// verify-enc.js — 验证 .enc 能正确解密为原文件（检查文件头 magic），确认主进程解密钩子可用。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY = crypto.scryptSync('HotaruDesktopPet-Live2D-2024', 'static-salt-v1', 32);
const root = path.resolve(__dirname, '..', 'app', 'models', 'Hotaru2024');

function magic(buf) {
  if (buf.length < 8) return buf.toString('hex');
  const h = buf.slice(0, 8);
  if (h[0] === 0x7b) return 'JSON-{' ; // model3/physics/motion json
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'PNG';
  if (h[0] === 0xff && h[1] === 0xd8) return 'JPEG';
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) return 'WEBP/RIFF';
  const s = h.toString('latin1');
  if (s.startsWith('MOC3')) return 'MOC3';
  return h.toString('hex');
}

let ok = 0, bad = 0;
function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) { walk(p); continue; }
    if (!ent.name.endsWith('.enc')) continue;
    const data = fs.readFileSync(p);
    const iv = data.slice(0, 16);
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
      const plain = Buffer.concat([decipher.update(data.slice(16)), decipher.final()]);
      const m = magic(plain);
      const rel = path.relative(root, p);
      console.log((m.startsWith('JSON') || m === 'PNG' || m === 'JPEG' || m === 'MOC3' || m === 'WEBP/RIFF' ? 'OK ' : '?? ') + rel + '  -> ' + m + '  (' + plain.length + ' B)');
      ok++;
    } catch (e) {
      console.log('FAIL ' + path.relative(root, p) + '  -> ' + e.message);
      bad++;
    }
  }
}
walk(root);
console.log(`\n验证: ${ok} OK, ${bad} FAIL`);
process.exit(bad ? 1 : 0);
