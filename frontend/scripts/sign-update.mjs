#!/usr/bin/env node
/**
 * 为一次发布生成签名后的 lx-update 声明块。
 *
 * 产出的 Markdown 片段直接贴进 GitHub Release 的正文即可。
 * 应用侧（electron/updater.cjs）会从正文里解析这个块并用内置公钥验签。
 *
 * 用法：
 *   node scripts/sign-update.mjs \
 *     --version=0.0.2 \
 *     --exe=release/LX.Setup.0.0.2.exe \
 *     --notes=CHANGELOG.md \
 *     --force=false \
 *     --min-supported=0.0.1                     # 输出到 stdout
 *
 *   node scripts/sign-update.mjs ... --out=release/RELEASE_BODY.md
 *
 * 私钥来源（按优先级）：
 *   1. --key=<path>
 *   2. 环境变量 LX_UPDATE_PRIVATE_KEY（内容为 PEM 或文件路径）
 *   3. 默认路径 ~/.lingxi/keys/update-private.pem
 *
 * ⚠️ 为什么 sha512 要取「和 latest.yml 里一致的那一份」：
 *    应用侧验签用的 payload 里包含 sha512，而这个 sha512 来自 electron-updater
 *    解析 latest.yml 的结果。若这里算的算法/编码跟 latest.yml 不同，
 *    签名永远验不过 —— 表现为「所有客户端拒绝全部更新」。所以这里：
 *      - 优先读 electron-builder 产出的 latest.yml，直接取其中的 sha512（最可靠）
 *      - 读不到才退化为自己算 base64(sha512(文件))
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
function arg(name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const version = arg('version');
const exePath = arg('exe');
const notesPath = arg('notes');
const forceRaw = (arg('force') || 'false').toLowerCase();
const minSupported = arg('min-supported');
const outPath = arg('out');
const keyPath = arg('key');

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!version) fail('必须提供 --version=<x.y.z>');
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`--version 不是合法 SemVer: ${version}`);

const forceupdate = forceRaw === 'true' || forceRaw === '1' || forceRaw === 'yes';

// ---------------------------------------------------------------- 1. 定位私钥

function resolvePrivateKey() {
  const candidates = [];
  if (keyPath) candidates.push({ label: `--key=${keyPath}`, value: path.resolve(keyPath) });
  if (process.env.LX_UPDATE_PRIVATE_KEY) {
    const v = process.env.LX_UPDATE_PRIVATE_KEY;
    // 环境变量既可能是路径也可能是 PEM 正文（CI secret 常直接塞正文）
    candidates.push(
      v.includes('BEGIN PRIVATE KEY') || v.includes('BEGIN')
        ? { label: 'env:LX_UPDATE_PRIVATE_KEY(内容)', value: v }
        : { label: 'env:LX_UPDATE_PRIVATE_KEY(路径)', value: path.resolve(v) }
    );
  }
  candidates.push({
    label: '默认路径',
    value: path.join(os.homedir(), '.lingxi', 'keys', 'update-private.pem'),
  });

  for (const c of candidates) {
    const isPemBody = c.value.includes('BEGIN');
    if (isPemBody) return { label: c.label, pem: c.value };
    if (fs.existsSync(c.value)) return { label: c.label, pem: fs.readFileSync(c.value, 'utf8') };
  }
  fail(
    '找不到私钥。请用 --key=<path>、环境变量 LX_UPDATE_PRIVATE_KEY，' +
      '或先跑 node scripts/generate-update-key.mjs 生成。'
  );
  return null;
}

const keyInfo = resolvePrivateKey();
let privateKey;
try {
  privateKey = crypto.createPrivateKey(keyInfo.pem);
} catch (err) {
  fail(`私钥无法解析（来源 ${keyInfo.label}）: ${err.message}`);
}

// ---------------------------------------------------------------- 2. 取 sha512

/**
 * 从 latest.yml 中读指定文件的 sha512（base64）。
 * latest.yml 形如：
 *   files:
 *     - url: LX.Setup.0.0.2.exe
 *       sha512: <base64>
 *       size: 205946405
 */
function sha512FromLatestYml() {
  const ymlPath = path.join(frontendRoot, 'release', 'latest.yml');
  if (!fs.existsSync(ymlPath)) return null;
  const text = fs.readFileSync(ymlPath, 'utf8');
  const m = text.match(/sha512:\s*(\S+)/);
  if (!m) return null;
  return { sha512: m[1], source: 'release/latest.yml' };
}

function sha512FromFile() {
  if (!exePath) return null;
  const p = path.isAbsolute(exePath) ? exePath : path.join(frontendRoot, exePath);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return {
    sha512: crypto.createHash('sha512').update(buf).digest('base64'),
    source: `自算(${path.relative(frontendRoot, p)})`,
    size: buf.length,
  };
}

const sha = sha512FromLatestYml() || sha512FromFile();
if (!sha) {
  fail(
    '无法确定 sha512。请确认 release/latest.yml 已由 electron-builder 生成，' +
      '或用 --exe=<安装包路径> 指定文件。'
  );
}

// ---------------------------------------------------------------- 3. 组装 payload 并签名

// ⚠️ 与 electron/update-security.cjs#buildSignaturePayload 必须逐字节一致。
//    这里刻意重复实现（而不是 import）——发布脚本可能要跑在没有构建产物的机器上，
//    不引入 Electron 侧的依赖链。两处的字段顺序/分隔符改动必须同步。
function buildSignaturePayload({ version, sha512, forceupdate, minSupportedVersion }) {
  // ⚠️ 与 electron/update-security.cjs 保持一致的布尔归一（字符串 'false' 是真值，直接判真值会翻成 true）
  const force = forceupdate === true || forceupdate === 'true' || forceupdate === '1';
  return [
    `version=${version}`,
    `sha512=${sha512}`,
    `forceupdate=${force ? 'true' : 'false'}`,
    `minSupportedVersion=${minSupportedVersion || ''}`,
  ].join('\n');
}

const payload = buildSignaturePayload({
  version,
  sha512: sha.sha512,
  forceupdate,
  minSupportedVersion: minSupported,
});

const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');

// 自检：立刻用公钥验一遍，避免「签错了格式却发出去了」
const publicKey = crypto.createPublicKey(privateKey);
const selfCheck = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
if (!selfCheck) fail('自检失败：签名无法被对应公钥验证，拒绝输出');

// ---------------------------------------------------------------- 4. 组装 Release 正文

let changelog = '';
if (notesPath) {
  const p = path.isAbsolute(notesPath) ? notesPath : path.join(frontendRoot, notesPath);
  if (!fs.existsSync(p)) fail(`找不到更新说明文件: ${p}`);
  changelog = fs.readFileSync(p, 'utf8').trim();
}

const lines = [];
if (changelog) {
  lines.push(changelog, '');
}

lines.push(
  '<!-- 以下声明块由 scripts/sign-update.mjs 生成，请勿手改：',
  '     应用侧会用内置公钥验签，改动任意字段都会导致验签失败、更新被拒绝。 -->',
  '```lx-update',
  `forceupdate=${forceupdate === true ? 'true' : 'false'}`,
  `minSupportedVersion=${minSupported || ''}`,
  `signature=${signature}`,
  '```'
);

const body = lines.join('\n');

const target = outPath
  ? path.isAbsolute(outPath)
    ? outPath
    : path.join(frontendRoot, outPath)
  : null;

if (target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
}

console.log('\n✅ lx-update 声明块已生成');
console.log(`   版本        ${version}`);
console.log(`   强制更新    ${forceupdate ? '是' : '否'}`);
console.log(`   最低支持    ${minSupported || '(未设置)'}`);
console.log(`   sha512 来源 ${sha.source}`);
console.log(`   sha512      ${sha.sha512.slice(0, 24)}…`);
console.log(`   签名        ${signature.slice(0, 24)}…`);
console.log(`   自检        通过（已用对应公钥验证）`);
if (target) console.log(`   输出        ${target}`);

if (forceupdate) {
  console.log('\n   ⚠️ 本次为强制更新：客户端下载完成后会立即安装并重启应用。');
  console.log('      请确认当前公钥不是占位公钥，否则客户端会忽略 forceupdate。');
}

if (!target) {
  console.log('\n────── 以下内容贴进 GitHub Release 正文 ──────\n');
  console.log(body);
  console.log('\n─────────────────────────────────────────────\n');
}
