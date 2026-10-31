/**
 * 跨平台语法检查：对仓库内的 .js / .mjs 逐个执行 node --check。
 * 不依赖 shell，Windows / macOS / Linux 行为一致。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['server', 'public', 'scripts', 'tools'];
const SKIP = new Set(['node_modules', '.git', 'vendor']);

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) files.push(full);
  }
}

for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`✗ ${file}`);
    const detail = String(err.stderr || err.message || '').trim();
    if (detail) console.error(detail);
  }
}

console.log(`checked ${files.length} files, ${failed} failed`);
if (failed) process.exit(1);
