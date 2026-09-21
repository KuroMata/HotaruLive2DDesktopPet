#!/usr/bin/env node
// run-verify.js — 验证 .enc 能正确解密为原文件（检查文件头 magic），结果写 verify_out.txt
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const KEY = crypto.scryptSync('HotaruDesktopPet-Live2D-2024', 'static-salt-v1', 32);
const root = path.resolve(__dirname, '..', 'app', 'models', 'Hotaru2024');
const lines = [];
const log = (s) => { lines.push(String(s)); };
function magic(buf) {
  if (buf.length < 8) return buf.toString('hex');
  const h = buf.slice(0, 8);
  if (h[0] === 0x7b) return 'JSON-{';
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'PNG';
  if (h[0] === 0xff && h[1] === 0xd8) return 'JPEG';
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46) return 'WEBP/RIFF';
  if (h.toString('latin1').startsWith('MOC3')) return 'MOC3';
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
      const dec = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
      const plain = Buffer.concat([dec.update(data.slice(16)), dec.final()]);
      const m = magic(plain);
      const rel = path.relative(root, p);
      const good = (m === 'JSON-{' || m === 'PNG' || m === 'JPEG' || m === 'MOC3' || m === 'WEBP/RIFF');
      log((good ? 'OK  ' : '??  ') + rel + ' -> ' + m + ' (' + plain.length + ' B)');
      if (good) ok++; else bad++;
    } catch (e) {
      log('FAIL ' + path.relative(root, p) + ' -> ' + e.message);
      bad++;
    }
  }
}
walk(root);
log('验证: ' + ok + ' OK, ' + bad + ' FAIL');
fs.writeFileSync(path.join(__dirname, 'verify_out.txt'), lines.join('\n'), 'utf8');
process.exit(bad ? 1 : 0);
