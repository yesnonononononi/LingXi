'use strict';

/**
 * 更新链路的安全原语（纯函数，不依赖 Electron，可被单测直接 import）。
 *
 * 为什么单独拆一个文件：
 *   electron/updater.cjs 里有大量 Electron 副作用（app / session / dialog），
 *   头一 require 就得有 Electron 运行时。而下面这些判定是更新机制里最容易出错、
 *   也最需要被测试覆盖的部分 —— 灰名单绕过、降级攻击、签名伪造都发生在这里。
 *   拆出来之后 `node --test` 可以直接喂输入验行为，不需要起 Electron。
 *
 * ⚠️ 改动本文件等于改动安全边界，任何一处放宽都必须有对应的变异测试。
 */

const crypto = require('crypto');

/**
 * 可信下载域名白名单。
 *
 * 为什么是这三个（每一条都有实测依据，不是凭印象加的）：
 *   - github.com                     → Release 下载入口
 *   - objects.githubusercontent.com  → 早期资产重定向落点
 *   - release-assets.githubusercontent.com → **当前**实际的重定向落点
 *
 * ⚠️ 第三条是实测补上的：对线上 `LX.Setup.0.0.0.exe` 发 HEAD，返回 302，
 *    Location 指向 release-assets.githubusercontent.com（证据见
 *    target/github-update-audit/transport.json）。缺了它，守卫会在 302 之后
 *    把真实下载地址拦下来 —— 表现为「能发现新版本，但下载永远失败」。
 *
 * ⚠️ 不要加宽泛通配（如 *.githubusercontent.com）：该域下还有 raw./gist. 等
 *    用户可控内容的子域，等于把「用户能写内容的地方」变成可执行文件的来源。
 *    只列**实际承载 Release 资产**的确切主机。
 */
const ALLOWED_DOWNLOAD_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * 校验一个 URL 是否为可信的下载地址。
 *
 * 规则（全部满足才放行）：
 *   1. 必须是 https —— 明文 http 可被中间人替换二进制
 *   2. 主机名必须命中白名单（精确匹配，或作为子域匹配）
 *   3. 不允许带用户名/密码（https://user:pass@github.com 这类混淆写法）
 *   4. 端口必须是 443 或未指定
 *
 * @param {string} url
 * @returns {{ ok: boolean, reason?: string, host?: string }}
 */
function validateDownloadUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, reason: 'URL 为空' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `URL 无法解析: ${url}` };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `仅允许 https，实际 ${parsed.protocol}` };
  }

  // 带凭据的 URL 是典型的混淆手法：肉眼看着像 github.com，实际由前面的部分决定
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URL 不允许携带用户名/密码' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { ok: false, reason: `端口必须是 443，实际 ${parsed.port}` };
  }

  const host = parsed.hostname.toLowerCase();
  const matched = ALLOWED_DOWNLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!matched) {
    return { ok: false, reason: `主机不在白名单内: ${host}` };
  }

  return { ok: true, host };
}

/**
 * 计算文件 / Buffer 的 sha512（base64，与 electron-updater 的约定一致）。
 *
 * ⚠️ electron-updater 的 latest.yml 里 files[].sha512 是 **base64**，不是 hex。
 *    搞错编码的后果是「永远校验失败」或更糟「用错的摘要去比对」。这里显式写死 base64。
 *
 * @param {Buffer} buffer
 * @returns {string} base64 编码的 sha512
 */
function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}

/**
 * 计算 sha256（hex）。用于发布侧生成清单、人工核对。
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 常量时间字符串比较。
 *
 * 为什么不用 `===`：字符串比较会在首个不同字节处提前返回，攻击者可以通过
 * 测量耗时逐字节爆破摘要/签名。更新链路上的比较一律走这里。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // 长度不同直接 false；digest 长度泄露本身不构成有效攻击面
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 解析版本号为可比较的数字三元组。
 * 只取 major.minor.patch，忽略预发布标签 —— 桌面端发版不走 pre-release 通道。
 *
 * @param {string} raw
 * @returns {{ major:number, minor:number, patch:number, raw:string }|null}
 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { raw: raw.trim(), major: +m[1], minor: +m[2], patch: +m[3] };
}

/**
 * 比较两个版本号。
 * @returns {number} a>b 返回正数，a<b 返回负数，相等返回 0；任一不可解析返回 NaN
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return NaN;
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

/**
 * 判定一次更新是否被允许安装（只升不降 + 不低于最低支持版本）。
 *
 * @param {object} p
 * @param {string} p.currentVersion  当前运行版本（app.getVersion()）
 * @param {string} p.targetVersion   候选版本（来自已校验的远端清单）
 * @param {string} [p.minSupportedVersion] 远端声明的最低可运行版本，低于它必须先装新版
 * @returns {{ allowed: boolean, reason?: string, mandatory?: boolean }}
 *
 * ⚠️ mandatory 的语义与 forceupdate 不同但会合流到同一处 UI 判据：
 *    - forceupdate=true          → 发布方主动要求「必须立刻升级」（签名声明）
 *    - 当前版本 < minSupportedVersion → 当前版本已不受支持，**升级不是可选项**
 *    两者都返回 mandatory=true，控制器据此设为不可跳过。
 *    历史缺口：这里原先只返回一句提示文本，控制器仍仅凭 forceupdate 决定 mandatory，
 *    导致「低于最低支持版本必须升级」在工作流里写了、在客户端却没有执行力。
 */
function isUpdateAllowed({ currentVersion, targetVersion, minSupportedVersion }) {
  const cmp = compareVersions(targetVersion, currentVersion);
  if (Number.isNaN(cmp)) {
    return { allowed: false, reason: `版本号无法解析: current=${currentVersion} target=${targetVersion}` };
  }

  if (cmp === 0) {
    return { allowed: false, reason: '目标版本与当前版本相同' };
  }
  if (cmp < 0) {
    // 降级是典型的攻击手法：把已被修复的旧版本（含已知漏洞）重新推给用户
    return {
      allowed: false,
      reason: `拒绝降级: 目标 ${targetVersion} < 当前 ${currentVersion}`,
    };
  }

  if (minSupportedVersion) {
    const minCmp = compareVersions(currentVersion, minSupportedVersion);
    if (Number.isNaN(minCmp)) {
      return { allowed: false, reason: `minSupportedVersion 无法解析: ${minSupportedVersion}` };
    }
    // 当前版本已低于最低支持版本：允许升级（这正是修复途径），但**必须**升级
    if (minCmp < 0) {
      return {
        allowed: true,
        mandatory: true,
        reason: `当前版本低于最低支持版本 ${minSupportedVersion}，必须升级`,
      };
    }
  }

  return { allowed: true, mandatory: false };
}

/**
 * 构建待签名的载荷。
 *
 * ⚠️ 字段顺序与分隔符是协议的一部分：签名侧（发布脚本）与验签侧必须逐字节一致。
 *    任何一方改了格式，验签会全量失败 —— 而「验签失败 = 拒绝更新」是设计意图，
 *    所以这种改动会表现为「所有客户端突然无法更新」，不是静默放行。这是安全的失败方向。
 *
 * 载荷包含 forceupdate 的意义：
 *   electron-updater 只对 **二进制** 做 sha512 校验，Release 的正文（releaseNotes）
 *   完全不受保护。若直接采信正文里的 "forceupdate: true"，攻击者改正文即可强制
 *   所有用户升级到他自己指定的版本。把 forceupdate 纳入签名载荷后，
 *   它就和 version/sha512 绑死在一起，改一个字节就验不过。
 *
 * @param {object} p
 * @param {string} p.version
 * @param {string} p.sha512
 * @param {boolean} p.forceupdate
 * @param {string} [p.minSupportedVersion]
 * @returns {string}
 */
function buildSignaturePayload({ version, sha512, forceupdate, minSupportedVersion }) {
  // ⚠️ forceupdate 必须显式归一为布尔，不能用 `forceupdate ? 'true' : 'false'`。
  //    正文解析出来的值是**字符串**（'true' / 'false'），而字符串 'false' 是真值，
  //    用真值判断会把它渲染成 forceupdate=true —— 与声明相反，且验签仍能通过，
  //    等于把「不强制更新」静默变成「强制更新」。
  //    各调用点目前都已先行转布尔，这里再兜一层，避免将来新增调用点时踩坑。
  const force = forceupdate === true || forceupdate === 'true' || forceupdate === '1';
  return [
    `version=${version}`,
    `sha512=${sha512}`,
    `forceupdate=${force ? 'true' : 'false'}`,
    `minSupportedVersion=${minSupportedVersion || ''}`,
  ].join('\n');
}

/**
 * 用 Ed25519 验签。
 *
 * 为什么用 Ed25519 而不是 RSA：
 *   - Node 内置支持（node:crypto），零第三方依赖；RSA 还要管 padding 参数
 *   - 公钥短（44 字符 base64），塞进源码不显眼，适合硬编码
 *   - 确定性签名，不存在随机数复用导致私钥泄露的历史问题
 *
 * @param {object} p
 * @param {string} p.payload      待验签的原文
 * @param {string} p.signature    base64 编码的签名
 * @param {string} p.publicKeyPem PEM 格式公钥（硬编码在应用内）
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifySignature({ payload, signature, publicKeyPem }) {
  if (!publicKeyPem || typeof publicKeyPem !== 'string' || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    // 公钥缺失/未配置时必须失败关闭（fail-closed），不能「跳过校验继续更新」
    return { ok: false, reason: '公钥未配置，拒绝更新（fail-closed）' };
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: '签名为空' };
  }

  let sigBuf;
  try {
    sigBuf = Buffer.from(signature.trim(), 'base64');
  } catch {
    return { ok: false, reason: '签名不是合法 base64' };
  }
  if (sigBuf.length !== 64) {
    // Ed25519 签名固定 64 字节，长度不对说明是别的算法或已损坏
    return { ok: false, reason: `签名长度非法（Ed25519 应为 64 字节，实际 ${sigBuf.length}）` };
  }

  try {
    const ok = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKeyPem, sigBuf);
    return ok ? { ok: true } : { ok: false, reason: '签名不匹配' };
  } catch (err) {
    return { ok: false, reason: `验签异常: ${(err && err.message) || err}` };
  }
}

/**
 * 从 Release 正文里提取 LX 的结构化声明块。
 *
 * 约定：正文里的一段代码块，语言标记 lx-update，内容为 `key=value` 行：
 *
 *   ```lx-update
 *   forceupdate=false
 *   minSupportedVersion=0.0.1
 *   signature=<base64>
 *   ```
 *
 * ⚠️ **必须同时认两种形态**，因为 GitHubProvider 返回的是 HTML 而非原始 Markdown：
 *   实测（electron-updater 6.8.9）从 GitHub API 拿到的 body 经 provider 处理后，
 *   代码块变成 `<pre><code class="language-lx-update">…</code></pre>`。
 *   若只认 Markdown 围栏，HTML 正文会被解析成「无声明块」→ 无签名 →
 *   按未签名分支放行**普通更新**。后果有两层：
 *     1) 真实的 forceupdate=true 声明被静默忽略（强制更新失效）；
 *     2) 更糟的是**错误签名也被当成「无签名」**而不再拒绝 ——
 *        原本「验签失败必拒」这道防线在 HTML 形态下整个失效。
 *   所以两种形态必须走**同一条**「解析出 signature 就必须验签，验不过就拒」的路径。
 *
 * 为什么放正文：不引入第三个文件（用户已明确不要多余的展示 json），
 * 且 GitHub Release 正文是随 Release 一起原子发布的 —— 天然与二进制同批。
 * 正文本身不可信，但 signature 覆盖了 version/sha512/forceupdate/minSupportedVersion，
 * 所以攻击者改了正文里的 forceupdate 也验不过签。
 *
 * @param {string} releaseNotes
 * @returns {Record<string,string>} 解析出的键值对；无声明块返回空对象
 */
function parseUpdateClaim(releaseNotes) {
  if (typeof releaseNotes !== 'string' || releaseNotes.length === 0) return {};

  // 允许两种围栏形态，取第一个命中：
  //   ① Markdown 围栏：```lx-update … ```
  //   ② GitHubProvider 的 HTML 形态：<pre><code class="language-lx-update">…</code></pre>
  const markdownRe = /```lx-update\s*\n([\s\S]*?)```/i;
  const htmlRe = /<pre[^>]*>\s*<code[^>]*class="[^"]*language-lx-update[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/i;

  const md = releaseNotes.match(markdownRe);
  const html = md ? null : releaseNotes.match(htmlRe);
  if (!md && !html) return {};

  // HTML 形态要做实体反转义：`&amp;`→`&`、`&lt;`→`<` 等。
  // 签名是 base64，不含这些字符；但 minSupportedVersion 理论上也安全。
  // 反转义放最后统一做，避免在 Markdown 分支引入无谓转换。
  let body = md ? md[1] : decodeHtmlEntities(html[1]);

  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 反转义 HTML 实体。只覆盖声明块里可能出现的字符。
 *
 * ⚠️ 只做实体替换，**不做任何标签剥离或 sanitize** —— 本函数只服务
 *    parseUpdateClaim 的取值，绝不用于渲染。渲染层另有 stripUpdateClaim。
 *
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 把 releaseNotes 归一化成字符串（electron-updater 在 fullChangelog 打开时会返回数组）
 * @param {string|Array<{version:string,note:string|null}>|null|undefined} notes
 * @returns {string}
 */
function normalizeReleaseNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes.map((n) => (n && n.note ? String(n.note) : '')).filter(Boolean).join('\n\n');
  }
  return String(notes);
}

module.exports = {
  ALLOWED_DOWNLOAD_HOSTS,
  validateDownloadUrl,
  sha512Base64,
  sha256Hex,
  timingSafeEqual,
  parseVersion,
  compareVersions,
  isUpdateAllowed,
  buildSignaturePayload,
  verifySignature,
  parseUpdateClaim,
  decodeHtmlEntities,
  normalizeReleaseNotes,
};
