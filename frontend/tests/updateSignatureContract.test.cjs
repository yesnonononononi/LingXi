'use strict';

/**
 * 发布侧签名 ↔ 应用侧验签 的交叉一致性测试。
 *
 * 为什么必须存在：
 *   scripts/sign-update.mjs 与 electron/update-security.cjs 是**两份独立的**
 *   buildSignaturePayload 实现（发布脚本刻意不依赖 Electron 侧代码）。
 *   两份实现一旦漂移（字段顺序、分隔符、布尔拼写），后果是「所有客户端
 *   拒绝全部更新」—— 而且是 fail-closed，表现为更新功能彻底静默失效，
 *   排查代价很高。本测试用真实的私钥签、真实的验签函数验，把这种漂移钉死。
 *
 *   ⚠️ 这是**跨文件契约测试**，不是普通单测。改动任一侧的 payload 格式时它必须变红。
 *
 * 运行：node --test tests/updateSignatureContract.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const sec = require('../electron/update-security.cjs');

// 复刻 scripts/sign-update.mjs 的 buildSignaturePayload（逐字节相同）
// ⚠️ 如果这里和 sign-update.mjs 不一致，测试就没意义了 —— 对比时请两边一起看。
function publishSideBuildPayload({ version, sha512, forceupdate, minSupportedVersion }) {
  return [
    `version=${version}`,
    `sha512=${sha512}`,
    `forceupdate=${forceupdate ? 'true' : 'false'}`,
    `minSupportedVersion=${minSupportedVersion || ''}`,
  ].join('\n');
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

function publishSideSign(payload) {
  return crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

test('契约：发布侧 payload 与应用侧 payload 逐字节一致', () => {
  const cases = [
    { version: '0.0.2', sha512: 'AbC+/=', forceupdate: false, minSupportedVersion: '0.0.1' },
    { version: '0.1.0', sha512: 'XyZ123==', forceupdate: true, minSupportedVersion: '0.0.1' },
    // 边界：未设置 minSupportedVersion（应为空串，不是字面量 "undefined"）
    { version: '1.0.0', sha512: 'QQ==', forceupdate: false, minSupportedVersion: undefined },
  ];

  for (const c of cases) {
    assert.equal(
      publishSideBuildPayload(c),
      sec.buildSignaturePayload(c),
      `payload 不一致（forceupdate=${c.forceupdate}, min=${c.minSupportedVersion}）—— ` +
        '两侧格式漂移会导致全量更新失效'
    );
  }
});

test('契约：未设置 minSupportedVersion 时为空串而非 "undefined"', () => {
  const p = sec.buildSignaturePayload({ version: '1.0.0', sha512: 'Q', forceupdate: false });
  assert.match(p, /minSupportedVersion=$/m, '必须是空值结尾，不能出现 "undefined" 字面量');
  assert.doesNotMatch(p, /undefined/, 'payload 里绝不允许出现 undefined 字面量');
});

test('契约：发布侧签名能被应用侧验签通过', () => {
  const payload = publishSideBuildPayload({
    version: '0.0.2',
    sha512: 'dGVzdA==',
    forceupdate: false,
    minSupportedVersion: '0.0.1',
  });
  const sig = publishSideSign(payload);
  const r = sec.verifySignature({ payload, signature: sig, publicKeyPem: PUBLIC_PEM });
  assert.equal(r.ok, true, `验签应通过，实际失败: ${r.reason}`);
});

test('契约：应用侧拼的 payload 也能被发布侧签名验证（双向）', () => {
  // 这条覆盖的是「应用侧构造 payload 去验签」的路径：
  // 应用侧先 buildSignaturePayload，再由发布侧私钥签，两边必须能对上
  const appPayload = sec.buildSignaturePayload({
    version: '0.0.3',
    sha512: 'Zm9v',
    forceupdate: true,
    minSupportedVersion: '0.0.2',
  });
  const sig = crypto.sign(null, Buffer.from(appPayload, 'utf8'), privateKey).toString('base64');
  const r = sec.verifySignature({ payload: appPayload, signature: sig, publicKeyPem: PUBLIC_PEM });
  assert.equal(r.ok, true);
});

test('契约：完整 Release 正文 → 解析 → 验签 全链路', () => {
  const sha512 = 'c2hhNTEyLXRlc3Q=';
  const payload = publishSideBuildPayload({
    version: '0.0.2',
    sha512,
    forceupdate: true,
    minSupportedVersion: '0.0.1',
  });
  const signature = publishSideSign(payload);

  // 发布脚本实际产出的正文形态
  const releaseBody = [
    '## 本次更新',
    '',
    '- 新增自动更新机制',
    '',
    '<!-- 以下声明块由 scripts/sign-update.mjs 生成，请勿手改 -->',
    '```lx-update',
    'forceupdate=true',
    'minSupportedVersion=0.0.1',
    `signature=${signature}`,
    '```',
  ].join('\n');

  // 应用侧路径：normalize → parse → 用 sha512 重建 payload → 验签
  const notes = sec.normalizeReleaseNotes(releaseBody);
  const claim = sec.parseUpdateClaim(notes);

  assert.equal(claim.forceupdate, 'true');
  assert.equal(claim.minSupportedVersion, '0.0.1');

  const rebuilt = sec.buildSignaturePayload({
    version: '0.0.2',
    sha512, // 来自 latest.yml（受保护的清单）
    forceupdate: claim.forceupdate === 'true',
    minSupportedVersion: claim.minSupportedVersion,
  });

  const r = sec.verifySignature({ payload: rebuilt, signature: claim.signature, publicKeyPem: PUBLIC_PEM });
  assert.equal(r.ok, true, '完整链路应验签通过');
});

test('契约：篡改 Release 正文的 forceupdate 后全链路拒绝', () => {
  // 这是最核心的攻击场景：攻击者有 Release 写权限，但拿不到私钥
  const sha512 = 'c2hhNTEyLXRlc3Q=';
  const honestPayload = publishSideBuildPayload({
    version: '0.0.2',
    sha512,
    forceupdate: false, // 诚实发布：不强制
    minSupportedVersion: '0.0.1',
  });
  const signature = publishSideSign(honestPayload);

  const tamperedBody = [
    '```lx-update',
    'forceupdate=true', // ← 攻击者改成强制更新
    'minSupportedVersion=0.0.1',
    `signature=${signature}`, // ← 签名照抄
    '```',
  ].join('\n');

  const claim = sec.parseUpdateClaim(tamperedBody);
  const rebuilt = sec.buildSignaturePayload({
    version: '0.0.2',
    sha512,
    forceupdate: claim.forceupdate === 'true',
    minSupportedVersion: claim.minSupportedVersion,
  });

  const r = sec.verifySignature({ payload: rebuilt, signature: claim.signature, publicKeyPem: PUBLIC_PEM });
  assert.equal(r.ok, false, '篡改 forceupdate 必须导致验签失败 → 更新被拒绝');
});

test('契约：篡改 sha512（换二进制）后验签失败', () => {
  const payload = publishSideBuildPayload({
    version: '0.0.2',
    sha512: 'b3JpZ2luYWw=',
    forceupdate: false,
    minSupportedVersion: '0.0.1',
  });
  const signature = publishSideSign(payload);

  // 攻击者替换了二进制，latest.yml 里的 sha512 随之变化
  const swapped = sec.buildSignaturePayload({
    version: '0.0.2',
    sha512: 'bWFs' + 'aWNpb3Vz', // 不同的摘要
    forceupdate: false,
    minSupportedVersion: '0.0.1',
  });
  const r = sec.verifySignature({ payload: swapped, signature, publicKeyPem: PUBLIC_PEM });
  assert.equal(r.ok, false, '换二进制必须验签失败 —— 这是 sha512 纳入签名载荷的意义');
});
