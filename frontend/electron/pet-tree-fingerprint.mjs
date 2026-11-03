'use strict';
/**
 * **源码树指纹**：证明"端口上那个 dev server 渲染的，就是本地这棵树"。
 *
 * <p><b>它解决的缺陷：</b>桌宠画面守卫（`scripts/pet-face-visual-guard.cjs`）会**复用**
 * 端口上已在跑的 dev server。而 dev server 可能是**另一个工作树**拉起的——两个工作树共用
 * 同一个端口真源（`5275`）。原来的探活只验两条内容指纹（`#pet-root` + `<meta name="lx-app">`），
 * 它们只能证明"这是个桌宠页面"，<b>证明不了"是本地的桌宠页面"</b>：
 * 实测 5275 上跑的是 `desktop-pet-visual` 工作树，两条指纹全中，守卫照旧报 18/18 PASS。
 * 那种 PASS 验的是别人的代码，比 FAIL 更危险。</p>
 *
 * <p><b>判据设计（两层，先强后弱）：</b></p>
 * <ol>
 *   <li><b>强指纹（首选）：dev server 注入的 `&lt;meta name="lx-pet-tree"&gt;`。</b>
 *       `vite.pet.config.ts` 通过本模块的 {@link createTreeFingerprintPlugin} 在**每次请求**
 *       时按自己磁盘上的 `src/pet/**` 与桌宠清单现算一个摘要，写进 `pet.html` 的 `<head>`。
 *       守卫拿它和自己磁盘上算出来的摘要比对：一致 = 同一棵树。因为是**每次请求现算**，
 *       源码改动（包括变异自检的变异体）会同时反映到两边，不会出现"改了源码却报指纹不一致"。
 *       这也正是"注入端点"优于"比对某个 script 是否存在"的地方——不依赖偶然差异。</li>
 *   <li><b>弱指纹（兜底）：`/package.json` 等清单的字节比对。</b>
 *       给"没有注入 meta 的 dev server"（旧配置、别的工具起的）用：字节不同 ⇒ 明确是另一棵树；
 *       字节全同 ⇒ 视为本地这棵树，但**标记为弱证据**并在守卫日志里提示重启 dev server。</li>
 * </ol>
 *
 * <p><b>无法判定时返回 `undecidable`</b>（例如页面取不到、清单也取不到），由调用方明确 SKIP
 * 并打印"为什么无法判定 + 怎么修"，绝不允许当成 PASS。</p>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录（ESM 没有 __dirname；下面几处默认值要用它）。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 注入进 `pet.html` 的 meta 名（守卫按这个名字取值）。 */
const TREE_META_NAME = 'lx-pet-tree';

/** 参与指纹的目录（相对 frontend 根，递归收集）。 */
const TREE_FINGERPRINT_DIRS = Object.freeze(['src/pet']);

/** 参与指纹的散文件（相对 frontend 根）。 */
const TREE_FINGERPRINT_FILES = Object.freeze([
  'package.json',
  'vite.config.ts',
  'vite.pet.config.ts',
  'pet-layers.json',
  'pet-face-tiles.json',
  'pet-geometry.json',
  'pet-motions.json',
  'pet-assets.json',
]);

/** 目录扫描只收这些后缀（图标/素材不属于"源码树身份"，且数量大）。 */
const TREE_SCAN_SUFFIXES = Object.freeze(['.ts', '.css', '.json', '.vue', '.html']);

/** 身份对账结论。 */
const TREE_IDENTITY = Object.freeze({
  /** 已证明是本地这棵树。 */
  OWN: 'own',
  /** 明确是另一棵树（必须失败，绝不允许当成 PASS）。 */
  FOREIGN: 'foreign',
  /** 判不了（页面/指纹都取不到）。调用方只能 SKIP，且必须打印原因与修法。 */
  UNDECIDABLE: 'undecidable',
});

/** 单次 HTTP 请求的默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * 计算一段字节的 SHA-256（十六进制）。
 *
 * @param {Buffer|string} data 待哈希数据
 * @returns {string} 64 位十六进制摘要
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 递归列出某个目录下参与指纹的文件（相对 frontend 根，正斜杠）。
 *
 * @param {string} frontendRoot frontend 根目录绝对路径
 * @param {string} relDir 相对目录（正斜杠）
 * @returns {string[]} 相对路径列表（已排序）
 */
function listDirFiles(frontendRoot, relDir) {
  const absDir = path.join(frontendRoot, ...relDir.split('/'));
  /** @type {string[]} */
  const collected = [];
  if (!fs.existsSync(absDir)) return collected;
  /** @type {Array<{dir: string}>} */
  const stack = [{ dir: absDir }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      const abs = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: abs });
      } else if (entry.isFile() && TREE_SCAN_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        collected.push(path.relative(frontendRoot, abs).split(path.sep).join('/'));
      }
    }
  }
  return collected.sort();
}

/**
 * 计算整棵树的指纹。
 *
 * <p>摘要口径：把每个文件写成 `相对路径\0文件SHA-256\n` 再整体哈希，按路径排序 ⇒ 结果只取决于
 * 内容与路径集合，与遍历顺序无关。</p>
 *
 * @param {string} [frontendRoot] frontend 根目录（默认本文件所在目录的上一级）
 * @returns {{digest: string, files: Array<{path: string, bytes: number, sha256: string}>, totalBytes: number, missing: string[]}}
 *   指纹结果；`missing` 列出声明了但磁盘上没有的散文件
 * @throws {Error} 一个文件都没收集到时抛出（指纹无从谈起）
 */
function computeTreeFingerprint(frontendRoot) {
  const root = typeof frontendRoot === 'string' && frontendRoot.length > 0
    ? frontendRoot
    : path.resolve(__dirname, '..');
  /** @type {string[]} */
  const relPaths = [];
  for (const relDir of TREE_FINGERPRINT_DIRS) relPaths.push(...listDirFiles(root, relDir));
  /** @type {string[]} */
  const missing = [];
  for (const relFile of TREE_FINGERPRINT_FILES) {
    if (fs.existsSync(path.join(root, ...relFile.split('/')))) relPaths.push(relFile);
    else missing.push(relFile);
  }
  const unique = Array.from(new Set(relPaths)).sort();
  if (unique.length === 0) throw new Error(`源码树指纹：${root} 下一个参与指纹的文件都没有，拒绝产出空指纹`);
  /** @type {Array<{path: string, bytes: number, sha256: string}>} */
  const files = [];
  let totalBytes = 0;
  for (const rel of unique) {
    const buffer = fs.readFileSync(path.join(root, ...rel.split('/')));
    files.push({ path: rel, bytes: buffer.length, sha256: sha256(buffer) });
    totalBytes += buffer.length;
  }
  const digest = sha256(files.map((item) => `${item.path}\u0000${item.sha256}\n`).join(''));
  return { digest, files, totalBytes, missing };
}

/**
 * 从 `pet.html` 文本里取注入的树指纹。
 *
 * @param {string} html 页面文本
 * @returns {string|null} 指纹（缺失时 null）
 */
function readTreeMeta(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const pattern = new RegExp(`<meta\\s+name=["']${TREE_META_NAME}["']\\s+content=["']([0-9a-f]{64})["']\\s*/?>`, 'i');
  const matched = pattern.exec(html);
  return matched ? matched[1].toLowerCase() : null;
}

/**
 * 生成注入树指纹的 Vite 插件（只在桌宠 config 里挂）。
 *
 * <p>`transformIndexHtml` 在 dev 下**每次请求**都会跑，所以它总是反映磁盘当前内容——
 * 改源码、跑变异体都不需要重启 dev server。</p>
 *
 * @param {string} [frontendRoot] frontend 根目录
 * @returns {{name: string, transformIndexHtml: (html: string) => string}} Vite 插件
 */
function createTreeFingerprintPlugin(frontendRoot) {
  const root = typeof frontendRoot === 'string' && frontendRoot.length > 0
    ? frontendRoot
    : path.resolve(__dirname, '..');
  return {
    name: 'lx-pet-tree-fingerprint',
    transformIndexHtml(html) {
      // 取不到指纹时不要把页面搞挂：不注入，守卫那边会落到"弱指纹 / 无法判定"
      let digest = '';
      try {
        digest = computeTreeFingerprint(root).digest;
      } catch (err) {
        return html;
      }
      const tag = `<meta name="${TREE_META_NAME}" content="${digest}" />`;
      return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `  ${tag}\n</head>`) : `${tag}\n${html}`;
    },
  };
}

/**
 * 取一个 URL 的文本响应。
 *
 * @param {string} url 目标
 * @param {{timeoutMs: number, fetchImpl: typeof fetch}} options 选项
 * @returns {Promise<{ok: boolean, status: number, body: string, error: string}>} 结果
 */
async function fetchText(url, options) {
  try {
    const response = await options.fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    let body = '';
    try {
      body = await response.text();
    } catch (err) {
      return { ok: false, status: response.status, body: '', error: `读取响应体失败：${(err && err.message) || err}` };
    }
    return { ok: response.status === 200, status: response.status, body, error: response.status === 200 ? '' : `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: (err && err.message) || String(err) };
  }
}

/**
 * 判定端口上的 dev server 是否**本地这棵树**。
 *
 * @param {object} [options] 选项
 * @param {string} options.origin dev server 源，如 `http://127.0.0.1:5275`
 * @param {string} [options.entryPage] 入口页（默认 `pet.html`，由调用方从单一真源取）
 * @param {string} [options.frontendRoot] frontend 根目录（默认本文件上一级）
 * @param {number} [options.timeoutMs] 单次请求超时（毫秒）
 * @param {typeof fetch} [options.fetchImpl] fetch 实现（测试可注入）
 * @returns {Promise<{status: string, evidence: string, weak: boolean, message: string, hint: string, local: object|null, remote: object|null, mismatches: string[]}>}
 *   判定结果
 * @throws {TypeError} `origin` 非法时抛出
 */
async function verifyOwnTree(options = {}) {
  const origin = typeof options.origin === 'string' ? options.origin.replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^/]+$/.test(origin)) {
    throw new TypeError(`verifyOwnTree: origin 非法（应为 http://host:port）：${String(options.origin)}`);
  }
  const entryPage = typeof options.entryPage === 'string' && options.entryPage.length > 0 ? options.entryPage : 'pet.html';
  const frontendRoot = typeof options.frontendRoot === 'string' && options.frontendRoot.length > 0
    ? options.frontendRoot
    : path.resolve(__dirname, '..');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('verifyOwnTree: 当前运行时没有 fetch，请注入 fetchImpl');

  let local = null;
  try {
    local = computeTreeFingerprint(frontendRoot);
  } catch (err) {
    local = null;
  }
  const base = { status: TREE_IDENTITY.UNDECIDABLE, evidence: 'none', weak: false, local, remote: null, mismatches: [] };

  const page = await fetchText(`${origin}/${entryPage}`, { timeoutMs, fetchImpl });
  if (!page.ok) {
    return {
      ...base,
      message: `无法判定 dev server 属于哪棵树：取 ${origin}/${entryPage} 失败（${page.error}）`,
      hint: '先确认 dev server 在跑：用 "npm run dev:pet" 启动（配置 vite.pet.config.ts，会注入 lx-pet-tree 指纹），再重跑本检查。',
    };
  }

  const remoteDigest = readTreeMeta(page.body);
  if (local === null) {
    return {
      ...base,
      message: `无法判定 dev server 属于哪棵树：本地算不出源码树指纹（${frontendRoot} 下没有可哈希的文件）`,
      hint: '确认在 frontend 目录下运行，且 src/pet 与桌宠清单存在。',
    };
  }
  if (remoteDigest !== null) {
    const own = remoteDigest === local.digest;
    return {
      status: own ? TREE_IDENTITY.OWN : TREE_IDENTITY.FOREIGN,
      evidence: 'meta',
      weak: false,
      local,
      remote: { digest: remoteDigest },
      mismatches: [],
      message: own
        ? `已证明端口上的 dev server 服务的是本地这棵树（树指纹 ${local.digest.slice(0, 12)}，${local.files.length} 个文件）`
        : `端口上的 dev server 服务的是**另一棵树**：页面注入指纹 ${remoteDigest.slice(0, 12)} ≠ 本地 ${local.digest.slice(0, 12)}`,
      hint: own
        ? ''
        : '请停掉占用该端口的 dev server 后重跑（它可能是另一个工作树拉起的）；本守卫不会把别人的代码当成 PASS。'
          + `排查：curl ${origin}/${entryPage} 看 lx-pet-tree，与本机 ${path.join(frontendRoot, 'src', 'pet')} 现算值比对。`,
    };
  }

  // 没有注入指纹：退到弱指纹（清单字节比对）。老配置/别的工具起的 dev server 走这条。
  /** @type {string[]} */
  const mismatches = [];
  let compared = 0;
  let fetched = 0;
  for (const relFile of ['package.json', 'pet-layers.json', 'pet-face-tiles.json']) {
    const remote = await fetchText(`${origin}/${relFile}`, { timeoutMs, fetchImpl });
    if (!remote.ok) continue;
    fetched += 1;
    let localText = null;
    try {
      localText = fs.readFileSync(path.join(frontendRoot, ...relFile.split('/')), 'utf8');
    } catch (err) {
      localText = null;
    }
    if (localText === null) continue;
    compared += 1;
    if (remote.body !== localText) mismatches.push(relFile);
  }
  if (mismatches.length > 0) {
    return {
      status: TREE_IDENTITY.FOREIGN,
      evidence: 'json-bytes',
      weak: true,
      local,
      remote: { mismatches },
      mismatches,
      message: `端口上的 dev server 服务的是**另一棵树**：${mismatches.join(' / ')} 与本地字节不一致（该 server 没有注入 lx-pet-tree 指纹）`,
      hint: '请停掉占用该端口的 dev server 后重跑（它可能是另一个工作树拉起的）；本守卫不会把别人的代码当成 PASS。'
        + ' 停掉后用 "npm run dev:pet" 启动本树的 dev server，新配置会注入 lx-pet-tree 指纹，判定会更直接。',
    };
  }
  if (compared > 0) {
    return {
      status: TREE_IDENTITY.OWN,
      evidence: 'json-bytes',
      weak: true,
      local,
      remote: { compared },
      mismatches: [],
      message: `端口上的 dev server 与本树清单字节一致（${compared} 个文件），但它没有注入 lx-pet-tree 指纹 —— 这是弱证据`,
      hint: '重启 dev server（"npm run dev:pet"）即可启用强指纹（lx-pet-tree），之后判定不依赖清单恰好相同。',
    };
  }
  return {
    ...base,
    local,
    message: `无法判定 dev server 属于哪棵树：页面里没有 lx-pet-tree 指纹，${fetched === 0 ? '清单也一个都取不到' : '本地对应文件读不到'}`,
    hint: '用 "npm run dev:pet" 重启桌宠 dev server（vite.pet.config.ts 会注入指纹）；若是别的工具起的 server，请改用 npm run dev:pet。',
  };
}

export {
  TREE_IDENTITY,
  TREE_META_NAME,
  TREE_FINGERPRINT_DIRS,
  TREE_FINGERPRINT_FILES,
  computeTreeFingerprint,
  createTreeFingerprintPlugin,
  readTreeMeta,
  verifyOwnTree,
};
