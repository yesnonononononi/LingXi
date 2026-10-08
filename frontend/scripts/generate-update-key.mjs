#!/usr/bin/env node
/**
 * 生成更新签名用的 Ed25519 密钥对。
 *
 * ⚠️ 私钥绝不进仓库。本脚本只负责生成，把它往哪存由你决定（默认写到
 *    ~/.lingxi/keys/，并提示加入 .gitignore）。
 *
 * 用法：
 *   node scripts/generate-update-key.mjs                  # 生成并写入 ~/.lingxi/keys/
 *   node scripts/generate-update-key.mjs --stdout         # 只打印，不落盘
 *   node scripts/generate-update-key.mjs --dir=<path>     # 指定输出目录
 *
 * 生成后：
 *   1. 把打印出的 **公钥 PEM** 粘到 frontend/electron/updater.cjs 的
 *      UPDATE_PUBLIC_KEY_PEM 常量（替换占位公钥）。
 *   2. 私钥路径配到发布环境（本地或 CI secret），供 scripts/sign-update.mjs 使用。
 *
 * ⚠️ 换密钥 = 换信任根：已发布的旧客户端只认旧公钥。换密钥前必须先发一版
 *    同时内置新旧两把公钥的版本，否则所有老用户会永久无法更新（fail-closed 的代价）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const argv = process.argv.slice(2);
const toStdout = argv.includes('--stdout');
const dirArg = argv.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
const outDir = dirArg ? path.resolve(dirArg) : path.join(os.homedir(), '.lingxi', 'keys');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

if (toStdout) {
  console.log('===== 公钥（粘到 updater.cjs 的 UPDATE_PUBLIC_KEY_PEM）=====');
  console.log(publicPem.trim());
  console.log('\n===== 私钥（保存到发布环境，不要提交）=====');
  console.log(privatePem.trim());
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

const pubPath = path.join(outDir, 'update-public.pem');
const privPath = path.join(outDir, 'update-private.pem');

if (fs.existsSync(privPath)) {
  console.error(`\n❌ ${privPath} 已存在，拒绝覆盖。`);
  console.error('   覆盖私钥会让所有已发布客户端再也无法验证新签名。');
  console.error('   如确实要换密钥，请先移走旧文件，并阅读脚本头部的「换密钥」说明。\n');
  process.exit(1);
}

fs.writeFileSync(pubPath, publicPem, { mode: 0o644 });
fs.writeFileSync(privPath, privatePem, { mode: 0o600 });

console.log('\n✅ 密钥对已生成');
console.log(`   公钥  ${pubPath}`);
console.log(`   私钥  ${privPath}  (权限 600)`);
console.log('\n下一步：');
console.log('  1. 把下面这段公钥粘到 frontend/electron/updater.cjs 的 UPDATE_PUBLIC_KEY_PEM，');
console.log('     替换掉占位公钥（并同时删掉 PLACEHOLDER_PUBLIC_KEY_PEM 的赋值，使其不再生效）：\n');
console.log(publicPem.trim());
console.log('\n  2. 确认私钥目录已在 .gitignore 中：');
console.log(`     echo "${path.relative(process.cwd(), privPath)}" >> .gitignore`);
console.log('\n  ⚠️ 占位公钥的私钥是公开的，未替换前构建的版本不会采信 forceupdate。\n');
