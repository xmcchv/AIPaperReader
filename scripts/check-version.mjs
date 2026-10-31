/**
 * 发版前校验：tag 名必须与 package.json 的 version 一致。
 * 手动触发 workflow 时没有 tag，直接通过。
 */
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const refName = process.env.GITHUB_REF_NAME || '';
const refType = process.env.GITHUB_REF_TYPE || '';

if (refType === 'tag' && refName !== `v${pkg.version}`) {
  console.error(`tag「${refName}」与 package.json version「${pkg.version}」不一致`);
  console.error(`请把 package.json 改成 ${refName.replace(/^v/, '')}，或改用 v${pkg.version} 的 tag`);
  process.exit(1);
}

console.log(`version ${pkg.version}${refName ? ` · ${refName}` : ''}`);
