#!/usr/bin/env node
/**
 * 平台无关的 app 层装配 —— 把构建好的 launcher + web-ui + 各包代码 staging 到
 * philont/dist-app/,并生成启动脚本 + MANIFEST。可在任何机器跑、可测。
 *
 * 用法:node launcher/scripts/assemble.mjs [--no-build]
 *
 * 剩下的平台步骤(真机做,见 PACKAGING.md):在 dist-app 各包跑 `npm ci --omit=dev`、
 * 塞入对应平台 Node 二进制、用 NSIS / pkg / AppImage 封壳。
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(repo, 'dist-app');
const noBuild = process.argv.includes('--no-build');

const run = (cmd, cwd) => { console.log(`$ ${cmd}  (${cwd})`); execSync(cmd, { cwd, stdio: 'inherit' }); };
// 拷贝时跳过:node_modules、.git、Rust 构建目录 target/(几百 MB)、.cargo、临时文件。
// 先把路径分隔符归一为 '/',否则 Windows 的反斜杠路径匹配不到这些段,会把 node_modules
// / target 全拷进来。
const SKIP = ['/node_modules', '/.git', '/target/', '/.cargo', '/src-rust'];
const copy = (src, dest) =>
  cpSync(src, dest, {
    recursive: true,
    filter: (raw) => {
      const s = raw.replace(/\\/g, '/');
      return !SKIP.some((seg) => s.includes(seg)) && !s.endsWith('/target') && !s.endsWith('.tsbuildinfo');
    },
  });

// 1) 构建
if (!noBuild) {
  run('npm run build', join(repo, 'launcher'));
  run('npm run build', join(repo, 'web-ui'));
}

// 2) staging 目录
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 3) launcher dist + package.json
copy(join(repo, 'launcher', 'dist'), join(out, 'launcher', 'dist'));
copy(join(repo, 'launcher', 'package.json'), join(out, 'launcher', 'package.json'));

// 4) web-ui 构建产物
if (!existsSync(join(repo, 'web-ui', 'dist'))) throw new Error('web-ui/dist 不存在,先 build');
copy(join(repo, 'web-ui', 'dist'), join(out, 'web-ui'));

// 5) server + 运行时 agent 包(不含 node_modules / Rust target)。
// 注:agent-core 是 Rust crate,只在**构建期**用(编译进 agent-node 的预构建 .node),
// 运行时不依赖,故不打包。server 的运行时依赖 = node/memory/policy/tools/mcp。
const pkgs = ['server', 'agent-node', 'agent-memory', 'agent-policy', 'agent-tools', 'agent-mcp', 'agent-plugins'];
for (const p of pkgs) {
  const src = join(repo, p);
  if (existsSync(src)) copy(src, join(out, p));
}

// 6) 启动脚本(指向 staging 内的 server / web-ui)
const shared = [
  'PHILONT_SERVER_DIR=server',
  'PHILONT_WEBUI_DIR=web-ui',
];
writeFileSync(
  join(out, 'start.sh'),
  `#!/bin/sh\ncd "$(dirname "$0")"\nexport PHILONT_SERVER_DIR="$PWD/server"\nexport PHILONT_WEBUI_DIR="$PWD/web-ui"\nexec node launcher/dist/index.js\n`,
  'utf8',
);
chmodSync(join(out, 'start.sh'), 0o755);
writeFileSync(
  join(out, 'start.cmd'),
  `@echo off\r\ncd /d "%~dp0"\r\nset PHILONT_SERVER_DIR=%CD%\\server\r\nset PHILONT_WEBUI_DIR=%CD%\\web-ui\r\nnode launcher\\dist\\index.js\r\n`,
  'utf8',
);

// 7) MANIFEST:还差什么(平台步骤)
writeFileSync(
  join(out, 'MANIFEST.txt'),
  [
    'PHILONT dist-app —— app 层装配产物(平台无关)。',
    '',
    '已含:launcher/dist、web-ui(静态)、server + agent-* 源码/dist、start.sh / start.cmd。',
    '',
    '还需(平台步骤,见 PACKAGING.md):',
    '  1. 在 launcher/ 和各 agent 包 + server/ 跑 `npm ci --omit=dev` 拉生产依赖',
    '     (含 agent-node 预构建 .node、better-sqlite3 原生模块;无需 Rust)。',
    '  2. 塞入对应平台 Node 运行时二进制(用户机不预装 Node)。',
    '  3. 用 NSIS(win)/ pkg(mac)/ AppImage(linux)封壳,注册自启 + 桌面快捷方式。',
    '',
    `生成时间占位(由打包流水线在真机戳)。共 ${pkgs.length + 2} 个组件。`,
    '',
  ].join('\n'),
  'utf8',
);

console.log(`\n✓ 装配完成 → ${out}`);
console.log('  下一步(真机):各包 npm ci --omit=dev + 塞 Node 二进制 + 封安装包(见 PACKAGING.md)');
