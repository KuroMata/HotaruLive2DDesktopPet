#!/usr/bin/env node
'use strict';
// ===========================================================================
// preflight-github.js —— 上传 GitHub 前的自检
//
// 用法：  node tools/pack/preflight-github.js
//         node tools/pack/preflight-github.js --fix-hint   （额外打印处置建议）
//
// 做四件事：
//   1. 检查 .gitignore 是否存在、关键排除项是否齐全
//   2. 若已是 git 仓库，检查「将被提交的文件」里有没有敏感路径或大文件
//   3. 若还不是 git 仓库，扫描工作区，列出目前存在哪些敏感文件（预告）
//   4. 扫描 > 20 MB 的文件（Git 对二进制大文件不友好，且单文件 100 MB 是硬上限）
//
// 只读，不修改任何文件。报告同时写入 tools/pack/preflight-report.txt
// （本机 PowerShell 的 stdout 不回显，写文件便于查看）。
// ===========================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJ = path.resolve(__dirname, '..', '..');
const REPORT = path.join(__dirname, 'preflight-report.txt');
const SHOW_HINT = process.argv.includes('--fix-hint');

const lines = [];
const problems = [];
const warns = [];

function out(s) { lines.push(s === undefined ? '' : s); }
function rel(p) { return path.relative(PROJ, p).replace(/\\/g, '/'); }

// ---------------------------------------------------------------------------
// 敏感路径规则：命中即视为「不该出现在仓库里」
// ---------------------------------------------------------------------------
const SENSITIVE = [
  { re: /^app\/models\/(?!README\.md$)/, why: 'Live2D 模型（第三方版权资产）' },
  { re: /^tts\/ref\//, why: 'TTS 音色参考音频（含声纹样本）' },
  { re: /\.wav$/i, why: '音频（台词语音，音色派生）' },
  { re: /\.enc$/i, why: '加密模型资源' },
  { re: /^node_modules\//, why: '依赖目录（体积，可重装）' },
  { re: /^dist\//, why: '构建产物（体积，可重生）' },
  { re: /^audio\/venv\//, why: 'Python venv（体积 + 绝对路径不可搬迁）' },
  { re: /^_launcher_build\/build\//, why: 'PyInstaller 中间产物' },
  { re: /^_icon_work\//, why: '图标原料（来源待确认）' },
  { re: /^backup-/, why: '旧版备份' },
  { re: /^\.workbuddy\//, why: '本机项目数据（非项目内容）' },
  { re: /(^|\/)nul$/, why: 'Windows 保留名垃圾文件' },
  { re: /(^|\/)__pycache__\//, why: 'Python 字节码缓存' },
  { re: /\.(log|pyc|tmp)$/i, why: '日志 / 缓存' },
  // app/data 下的 .bak 是人设台词档（内容资产，有意保留），不算敏感
  { re: /^(?!app\/data\/).*\.bak$/i, why: '备份文件' },
  { re: /^tools\/pack\/preflight-report\.txt$/, why: '本自检脚本的产物' },
  { re: /(window-bounds|acp-port\.cache|_config_release_backup)\.json$/i, why: '运行时状态（含本机路径）' },
  { re: /\.(exe|dmg|msi|zip|7z)$/i, why: '二进制分发件（走 Release，不进 Git）' },
];

const GITIGNORE_MUST = [
  ['node_modules/', '依赖目录'],
  ['dist/', '构建产物'],
  ['app/models/', '模型资产'],
  ['tts/ref/', '音色样本'],
  ['audio/venv/', 'Python venv'],
  ['.workbuddy/', '本机项目数据'],
  ['*.log', '日志'],
  ['nul', 'Windows 保留名'],
];

const BIG_MB = 20;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'venv', '__pycache__', '.electron-cache']);

// ---------------------------------------------------------------------------
out('============================================================');
out('  黑叶萤桌宠 · GitHub 上传前自检');
out('  项目：' + PROJ);
out('  时间：' + new Date().toLocaleString('zh-CN'));
out('============================================================');
out();

// ---- 1. .gitignore --------------------------------------------------------
out('【1】.gitignore');
const giPath = path.join(PROJ, '.gitignore');
if (!fs.existsSync(giPath)) {
  problems.push('.gitignore 不存在 —— 没有它，模型/日志/依赖会一起被提交');
  out('  ✗ 不存在');
} else {
  const gi = fs.readFileSync(giPath, 'utf-8');
  const giLines = gi.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  out('  ✓ 存在（' + fs.statSync(giPath).size + ' B）');
  for (const [pat, label] of GITIGNORE_MUST) {
    const key = pat.replace(/\*\./,'').replace(/\/$/,'');
    const hit = giLines.some((l) => l.replace(/^!/, '').includes(key));
    out('    ' + (hit ? '✓' : '✗') + ' ' + label + '  (' + pat + ')');
    if (!hit) problems.push('.gitignore 缺少规则：' + pat + '（' + label + '）');
  }
}
out();

// ---- 2. git 仓库状态 ------------------------------------------------------
out('【2】Git 仓库状态');
let isRepo = false;
let gitOk = true;
try { execSync('git rev-parse --is-inside-work-tree', { cwd: PROJ, stdio: 'pipe' }); isRepo = true; }
catch (e) { isRepo = false; }
try { const v = execSync('git --version', { cwd: PROJ, encoding: 'utf-8', stdio: 'pipe' }).trim(); out('  git: ' + v); }
catch (e) { gitOk = false; out('  git: 不可用（跳过 2、3 的检查）'); }

if (!gitOk) {
  out('  跳过仓库检查');
} else if (!isRepo) {
  out('  尚未 git init —— 下面第 3 步列出「当前存在哪些敏感文件」，可作预告。');
} else {
  out('  ✓ 已是 git 仓库');
  // 远程
  try {
    const rem = execSync('git remote -v', { cwd: PROJ, encoding: 'utf-8', stdio: 'pipe' }).trim();
    out('  远程：' + (rem ? '\n    ' + rem.split('\n').join('\n    ') : '（尚未配置）'));
  } catch (e) { /* 忽略 */ }
  // 已跟踪的文件
  let tracked = [];
  try { tracked = execSync('git ls-files', { cwd: PROJ, encoding: 'utf-8', stdio: 'pipe' }).split('\n').filter(Boolean); }
  catch (e) { /* 忽略 */ }
  out('  已跟踪文件数：' + tracked.length);
  const badTracked = [];
  for (const f of tracked) {
    for (const s of SENSITIVE) {
      if (s.re.test(f)) { badTracked.push([f, s.why]); break; }
    }
  }
  if (badTracked.length) {
    out('  ✗ 已跟踪的文件里有 ' + badTracked.length + ' 个不该入库的：');
    badTracked.slice(0, 40).forEach(([f, w]) => out('      ' + f + '   ← ' + w));
    if (badTracked.length > 40) out('      ...（其余 ' + (badTracked.length - 40) + ' 个省略）');
    problems.push('有 ' + badTracked.length + ' 个敏感文件已被 git 跟踪（需 git rm --cached 并补 .gitignore；若已 push 过则须清历史）');
  } else {
    out('  ✓ 已跟踪文件里没有命中敏感规则');
  }
  // 未提交的改动里有没有敏感项
  let status = '';
  try { status = execSync('git status --porcelain', { cwd: PROJ, encoding: 'utf-8', stdio: 'pipe' }); } catch (e) { /* 忽略 */ }
  const staged = status.split('\n').filter((l) => /^[AMDR]/.test(l)).map((l) => l.slice(3).trim());
  if (staged.length) {
    const badStaged = staged.filter((f) => SENSITIVE.some((s) => s.re.test(f)));
    out('  暂存区文件数：' + staged.length);
    if (badStaged.length) {
      out('  ✗ 暂存区里有敏感文件：');
      badStaged.slice(0, 20).forEach((f) => out('      ' + f));
      problems.push('暂存区有敏感文件，先 git reset 再提交');
    } else {
      out('  ✓ 暂存区干净');
    }
  }
}
out();

// ---- 3. 工作区扫描（敏感文件 + 大文件）-----------------------------------
out('【3】工作区扫描');
let walkCount = 0, hits = {}, big = [];
function walk(dir, depth) {
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, depth + 1);
      continue;
    }
    walkCount++;
    const r = rel(full);
    for (const s of SENSITIVE) {
      if (s.re.test(r)) { (hits[s.why] = hits[s.why] || []).push(r); break; }
    }
    let st = null;
    try { st = fs.statSync(full); } catch (err) { continue; }
    if (st && st.size > BIG_MB * 1024 * 1024) big.push([r, st.size]);
  }
}
walk(PROJ, 0);
out('  扫描文件数：' + walkCount + '（已跳过 node_modules / dist / venv / .git）');
out();
out('  命中敏感规则的文件（按原因归类）：');
const whyKeys = Object.keys(hits);
if (!whyKeys.length) {
  out('    ✓ 一个都没有');
} else {
  whyKeys.forEach((w) => {
    const arr = hits[w];
    out('    · ' + w + '  —— ' + arr.length + ' 个');
    arr.slice(0, 6).forEach((f) => out('        ' + f));
    if (arr.length > 6) out('        ...（其余 ' + (arr.length - 6) + ' 个省略）');
  });
}
out();
out('  > ' + BIG_MB + ' MB 的文件：');
if (!big.length) { out('    ✓ 没有'); }
else {
  big.sort((a, b) => b[1] - a[1]);
  big.slice(0, 25).forEach(([f, sz]) => {
    const mb = sz / 1048576;
    out('    ' + (mb >= 100 ? '✗' : mb >= 50 ? '!' : '·') + ' ' +
      mb.toFixed(1).padStart(7) + ' MB  ' + f);
  });
  if (big.length > 25) out('    ...（其余 ' + (big.length - 25) + ' 个省略）');
  const over100 = big.filter(([, sz]) => sz >= 100 * 1048576);
  if (over100.length) problems.push('有 ' + over100.length + ' 个文件 ≥ 100 MB，GitHub 会直接拒绝（单文件硬上限）');
  else warns.push('存在 > ' + BIG_MB + ' MB 的文件，请确认都已被 .gitignore 排除（Git 不适合存二进制大文件）');
}
out();

// ---- 4. 结论 --------------------------------------------------------------
out('============================================================');
out('  结论');
out('============================================================');
if (!problems.length && !warns.length) {
  out('  ALL OK —— 未发现问题。');
} else {
  if (problems.length) {
    out('  阻塞项（' + problems.length + '）：');
    problems.forEach((p, i) => out('    ' + (i + 1) + '. ' + p));
  }
  if (warns.length) {
    out('  提醒（' + warns.length + '）：');
    warns.forEach((p, i) => out('    ' + (i + 1) + '. ' + p));
  }
}
if (SHOW_HINT) {
  out();
  out('  处置建议：');
  out('    · 模型/音色/日志这类文件：确认已被 .gitignore 覆盖即可，不要 git add -f 强行加。');
  out('    · 若已 git add 过：git rm -r --cached <路径>  （--cached 保留磁盘文件）。');
  out('    · 若已 push 过：历史里仍有该文件，需用 git filter-repo 清历史后再强推，或直接删库重建。');
  out('    · 二进制分发件（exe/zip）：走 GitHub Releases，不要进 Git。');
}
out();
out('（报告已写入 tools/pack/preflight-report.txt）');

const text = lines.join('\r\n');
try { fs.writeFileSync(REPORT, text, 'utf-8'); } catch (e) { /* 忽略 */ }
console.log(text);
