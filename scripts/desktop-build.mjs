/**
 * 跨平台桌面构建入口。
 *
 * electron-builder 默认从 GitHub 下载 Electron / NSIS 工具；部分网络环境下
 * 会出现 `unable to verify the first certificate`。这里统一：
 *   - 默认走 npmmirror 镜像（可用 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 覆盖）
 *   - 让 Node 使用系统根证书（--use-system-ca）
 *   - 极端网络下可设 PAPERLENS_INSECURE_TLS=1 临时跳过证书校验
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const env = { ...process.env };

env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
env.ELECTRON_BUILDER_BINARIES_MIRROR =
  env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

const nodeOptions = String(env.NODE_OPTIONS || '');
if (!nodeOptions.includes('--use-system-ca')) {
  env.NODE_OPTIONS = `${nodeOptions} --use-system-ca`.trim();
}

if (env.PAPERLENS_INSECURE_TLS === '1') {
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('⚠ PAPERLENS_INSECURE_TLS=1：本次构建跳过 TLS 证书校验');
}

console.log(`electron-builder（镜像：${env.ELECTRON_BUILDER_BINARIES_MIRROR}）`);
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
