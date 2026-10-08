'use strict';

/**
 * 更新链路安全原语的单测。
 *
 * 为什么这个文件必须存在（别删）：
 *   「测试标题不是证据，只有变异是证据」——本文件里的每条断言都应该在
 *   对应实现被放宽时变红。下面每个 describe 块都标注了「变异方式」，
 *   复现步骤 = 按标注改实现 → 跑本测试 → 必须红 → 再改回来。
 *
 * 运行：node --test tests/updateSecurity.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const sec = require('../electron/update-security.cjs');

// ---------------------------------------------------------------- 测试用密钥对

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const OTHER_KEY = crypto.generateKeyPairSync('ed25519');

function sign(payload, key = privateKey) {
  return crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

// ================================================================ URL 白名单

test('validateDownloadUrl: 放行 github.com 与其资产重定向域', () => {
  // 变异：从 ALLOWED_DOWNLOAD_HOSTS 删掉 objects.githubusercontent.com → 第 2 条断言红
  const a = sec.validateDownloadUrl(
    'https://github.com/yesnonononononi/LingXi/releases/download/0.0.1/LX.Setup.0.0.1.exe'
  );
  assert.equal(a.ok, true, 'github.com 应放行');

  const b = sec.validateDownloadUrl(
    'https://objects.githubusercontent.com/github-production-release-asset-2e65be/123/456?X-Amz-Signature=abc'
  );
  assert.equal(b.ok, true, 'GitHub 资产重定向域应放行');
});

test('validateDownloadUrl: 拒绝 http 明文', () => {
  // 变异：把 protocol 检查从 !== 'https:' 改成不检查 → 本测试红
  const r = sec.validateDownloadUrl('http://github.com/a/b.exe');
  assert.equal(r.ok, false);
  assert.match(r.reason, /https/);
});

test('validateDownloadUrl: 拒绝白名单外的域名', () => {
  const r = sec.validateDownloadUrl('https://evil.example.com/LX.Setup.0.0.1.exe');
  assert.equal(r.ok, false);
  assert.match(r.reason, /白名单/);
});

test('validateDownloadUrl: 拒绝形似域名（后缀欺骗）', () => {
  // notgithub.com 以 "github.com" 结尾但并非子域 —— 必须靠 hostname 解析而非字符串包含
  // 变异：把 host === allowed || host.endsWith('.'+allowed) 改成 url.includes(allowed) → 本测试红
  const r = sec.validateDownloadUrl('https://notgithub.com/x.exe');
  assert.equal(r.ok, false, 'notgithub.com 不应因字符串包含而放行');
});

test('validateDownloadUrl: 拒绝带凭据的 URL（混淆手法）', () => {
  // https://github.com@evil.com/ → 真实 host 是 evil.com，但肉眼像 github.com
  const r = sec.validateDownloadUrl('https://github.com@evil.com/x.exe');
  assert.equal(r.ok, false, 'userinfo 混淆必须被拒');

  // 反向：真实 host 是 github.com，凭据是 evil
  const r2 = sec.validateDownloadUrl('https://evil:pass@github.com/x.exe');
  assert.equal(r2.ok, false, '带凭据一律拒绝');
});

test('validateDownloadUrl: 拒绝非 443 端口', () => {
  const r = sec.validateDownloadUrl('https://github.com:8443/x.exe');
  assert.equal(r.ok, false);
  assert.match(r.reason, /443/);
});

test('validateDownloadUrl: 拒绝空值与非法输入', () => {
  assert.equal(sec.validateDownloadUrl('').ok, false);
  assert.equal(sec.validateDownloadUrl(null).ok, false);
  assert.equal(sec.validateDownloadUrl(undefined).ok, false);
  assert.equal(sec.validateDownloadUrl('not-a-url').ok, false);
});

// ================================================================ 摘要

test('sha512Base64: 输出 base64 且长度符合 sha512', () => {
  // 变异：把 digest('base64') 改成 digest('hex') → 本测试红
  const out = sec.sha512Base64(Buffer.from('hello'));
  assert.match(out, /^[A-Za-z0-9+/]+=*$/, '应是 base64 字符集，不能是 hex');
  assert.equal(out, crypto.createHash('sha512').update('hello').digest('base64'));
});

test('sha256Hex: 输出 hex', () => {
  const out = sec.sha256Hex(Buffer.from('hello'));
  assert.match(out, /^[0-9a-f]{64}$/);
});

test('timingSafeEqual: 相等为真、不等为假、长度不同不抛异常', () => {
  // 变异：改成 a === b → 行为仍正确但失去常量时间；此处只能验语义
  assert.equal(sec.timingSafeEqual('abc', 'abc'), true);
  assert.equal(sec.timingSafeEqual('abc', 'abd'), false);
  assert.equal(sec.timingSafeEqual('abc', 'abcd'), false, '长度不同必须返回 false 而不是抛异常');
  assert.equal(sec.timingSafeEqual('', ''), true);
  assert.equal(sec.timingSafeEqual(null, 'a'), false);
});

// ================================================================ 版本比较与降级防护

test('compareVersions: 语义化比较', () => {
  assert.ok(sec.compareVersions('0.0.2', '0.0.1') > 0);
  assert.ok(sec.compareVersions('0.1.0', '0.0.9') > 0);
  assert.ok(sec.compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(sec.compareVersions('1.2.3', 'v1.2.3'), 0, '应容忍 v 前缀');
  assert.ok(Number.isNaN(sec.compareVersions('abc', '1.0.0')));
});

test('isUpdateAllowed: 允许升级', () => {
  const r = sec.isUpdateAllowed({ currentVersion: '0.0.1', targetVersion: '0.0.2' });
  assert.equal(r.allowed, true);
});

test('isUpdateAllowed: 拒绝降级（降级攻击防护）', () => {
  // 变异：把 cmp < 0 的分支改成 return { allowed: true } → 本测试红
  const r = sec.isUpdateAllowed({ currentVersion: '0.0.5', targetVersion: '0.0.1' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /降级/);
});

test('isUpdateAllowed: 拒绝同版本', () => {
  const r = sec.isUpdateAllowed({ currentVersion: '0.0.1', targetVersion: '0.0.1' });
  assert.equal(r.allowed, false);
});

test('isUpdateAllowed: 当前低于最低支持版本时放行（升级即修复）', () => {
  const r = sec.isUpdateAllowed({
    currentVersion: '0.0.1',
    targetVersion: '0.1.0',
    minSupportedVersion: '0.0.9',
  });
  assert.equal(r.allowed, true);
  assert.match(r.reason, /最低支持版本/);
});

test('isUpdateAllowed: 版本号不可解析时拒绝（fail-closed）', () => {
  const r = sec.isUpdateAllowed({ currentVersion: '0.0.1', targetVersion: 'garbage' });
  assert.equal(r.allowed, false, '解析失败必须拒绝而不是放行');
});

// ================================================================ 签名

test('verifySignature: 正确签名通过、篡改内容失败', () => {
  const payload = sec.buildSignaturePayload({
    version: '0.0.2',
    sha512: 'abc123',
    forceupdate: false,
    minSupportedVersion: '0.0.1',
  });
  const sig = sign(payload);

  assert.equal(sec.verifySignature({ payload, signature: sig, publicKeyPem: PUBLIC_KEY_PEM }).ok, true);

  // 篡改任意一个字节都必须失败
  const tampered = payload.replace('forceupdate=false', 'forceupdate=true');
  const bad = sec.verifySignature({ payload: tampered, signature: sig, publicKeyPem: PUBLIC_KEY_PEM });
  assert.equal(bad.ok, false, '改了 forceupdate 必须验签失败 —— 这是强制更新不可伪造的根据');
});

test('verifySignature: forceupdate 被纳入签名载荷', () => {
  // 反向证明：如果 forceupdate 不进载荷，改它就不会影响签名
  const a = sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: false });
  const b = sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: true });
  assert.notEqual(a, b, 'forceupdate 必须改变载荷，否则它是可任意伪造的');
});

test('buildSignaturePayload: 字符串 "false" 必须渲染为 false（不得被真值判断翻成 true）', () => {
  // 事迹背景：正文解析出来的 forceupdate 是**字符串**，而字符串 'false' 是真值。
  // 若实现写成 `forceupdate ? 'true' : 'false'`，'false' 会被渲染成 'true' ——
  // 语义反转且验签照样通过，等于把「不强制」静默变成「强制」。
  // 变异：把归一逻辑去掉、退回真值判断 → 本测试红。
  const asString = sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: 'false' });
  const asBool = sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: false });
  assert.equal(asString, asBool, "字符串 'false' 与布尔 false 必须产出同一载荷");
  assert.match(asString, /forceupdate=false/);

  // 'true' / '1' 两种真值写法应归一为 true
  assert.match(sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: 'true' }), /forceupdate=true/);
  assert.match(sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: '1' }), /forceupdate=true/);

  // 未提供（undefined）按 false 处理，不能渲染出 'undefined'
  const missing = sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x' });
  assert.match(missing, /forceupdate=false/);
  assert.ok(!missing.includes('undefined'), '不能把 undefined 渲染进载荷');
});

test('verifySignature: minSupportedVersion 为空时渲染为空串而非 "undefined"', () => {
  const p = sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: false, minSupportedVersion: undefined });
  assert.ok(!p.includes('undefined'), '空值必须渲染为空串');
  assert.match(p, /minSupportedVersion=$/m);
});

test('verifySignature: 用别的私钥签的签名不通过', () => {
  const payload = sec.buildSignaturePayload({ version: '0.0.2', sha512: 'x', forceupdate: false });
  const foreignSig = sign(payload, OTHER_KEY.privateKey);
  const r = sec.verifySignature({ payload, signature: foreignSig, publicKeyPem: PUBLIC_KEY_PEM });
  assert.equal(r.ok, false);
});

test('verifySignature: 公钥未配置时 fail-closed', () => {
  // 变异：把 `if (!publicKeyPem ...) return {ok:false}` 改成 return {ok:true} → 本测试红
  const payload = 'anything';
  const r = sec.verifySignature({ payload, signature: sign(payload), publicKeyPem: '' });
  assert.equal(r.ok, false, '未配置公钥时必须拒绝更新，绝不能跳过校验');
  assert.match(r.reason, /fail-closed/);
});

test('verifySignature: 签名长度非法被拒', () => {
  const payload = 'x';
  const shortSig = Buffer.alloc(32).toString('base64'); // RSA-2048 是 256 字节，这里给 32
  const r = sec.verifySignature({ payload, signature: shortSig, publicKeyPem: PUBLIC_KEY_PEM });
  assert.equal(r.ok, false);
  assert.match(r.reason, /长度/);
});

test('verifySignature: 空签名被拒', () => {
  const r = sec.verifySignature({ payload: 'x', signature: '', publicKeyPem: PUBLIC_KEY_PEM });
  assert.equal(r.ok, false);
});

// ================================================================ Release 正文声明块解析

test('parseUpdateClaim: 解析 lx-update 块', () => {
  const notes = [
    '## 本次更新',
    '',
    '- 修复了会话加载时的重复气泡',
    '',
    '```lx-update',
    'forceupdate=false',
    'minSupportedVersion=0.0.1',
    'signature=QUJD',
    '```',
  ].join('\n');

  const claim = sec.parseUpdateClaim(notes);
  assert.equal(claim.forceupdate, 'false');
  assert.equal(claim.minSupportedVersion, '0.0.1');
  assert.equal(claim.signature, 'QUJD');
});

test('parseUpdateClaim: 无声明块返回空对象', () => {
  assert.deepEqual(sec.parseUpdateClaim('## 普通更新说明\n\n没有声明块'), {});
  assert.deepEqual(sec.parseUpdateClaim(''), {});
  assert.deepEqual(sec.parseUpdateClaim(null), {});
});

test('parseUpdateClaim: 忽略注释与空行', () => {
  const notes = '```lx-update\n# 这是注释\n\nforceupdate=true\n```';
  const claim = sec.parseUpdateClaim(notes);
  assert.deepEqual(claim, { forceupdate: 'true' });
});

test('normalizeReleaseNotes: 兼容数组形态（fullChangelog）', () => {
  const arr = [
    { version: '0.0.2', note: '```lx-update\nforceupdate=true\n```' },
    { version: '0.0.1', note: '旧版本说明' },
  ];
  const s = sec.normalizeReleaseNotes(arr);
  assert.match(s, /forceupdate=true/);
  assert.match(s, /旧版本说明/);
  assert.equal(sec.normalizeReleaseNotes(null), '');
  assert.equal(sec.normalizeReleaseNotes('直接字符串'), '直接字符串');
});

// ================================================================ 端到端：伪造 forceupdate 应失败

test('端到端：攻击者篡改正文里的 forceupdate 无法通过验签', () => {
  // 场景：发布方签名的是 forceupdate=false，攻击者拿到 Release 写权限后
  // 把正文改成 forceupdate=true 并保留原 signature 字段
  const realSha = sec.sha512Base64(Buffer.from('fake-installer'));
  const realPayload = sec.buildSignaturePayload({
    version: '0.0.2',
    sha512: realSha,
    forceupdate: false,
    minSupportedVersion: '0.0.1',
  });
  const realSig = sign(realPayload);

  const realNotes = [
    '说明文本',
    '```lx-update',
    `forceupdate=false`,
    `minSupportedVersion=0.0.1`,
    `signature=${realSig}`,
    '```',
  ].join('\n');

  const realClaim = sec.parseUpdateClaim(realNotes);
  const okVerify = sec.verifySignature({
    payload: sec.buildSignaturePayload({
      version: '0.0.2',
      sha512: realSha,
      forceupdate: realClaim.forceupdate === 'true',
      minSupportedVersion: realClaim.minSupportedVersion,
    }),
    signature: realClaim.signature,
    publicKeyPem: PUBLIC_KEY_PEM,
  });
  assert.equal(okVerify.ok, true, '原始发布内容应验签通过');

  // 攻击者只改正文的 forceupdate，sig 照抄
  const forgedNotes = realNotes.replace('forceupdate=false', 'forceupdate=true');
  const forgedClaim = sec.parseUpdateClaim(forgedNotes);
  assert.equal(forgedClaim.forceupdate, 'true', '解析层确实读到了篡改后的值');

  const forgedVerify = sec.verifySignature({
    payload: sec.buildSignaturePayload({
      version: '0.0.2',
      sha512: realSha,
      forceupdate: forgedClaim.forceupdate === 'true', // ← 攻击者想要的效果
      minSupportedVersion: forgedClaim.minSupportedVersion,
    }),
    signature: forgedClaim.signature,
    publicKeyPem: PUBLIC_KEY_PEM,
  });
  assert.equal(forgedVerify.ok, false, '篡改 forceupdate 后验签必须失败，更新流程据此拒绝');
});
