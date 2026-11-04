'use strict';
/**
 * 源码树指纹 / dev server 身份对账的单测（纯 Node，零依赖，离线，不碰 Electron）。
 *
 * <p><b>为什么这组用例必须存在：</b>画面守卫会**复用**端口上已在跑的 dev server，而那个
 * server 可能是**另一个工作树**拉起的。原来的探活只验"是不是桌宠页面"（`#pet-root` +
 * `lx-app` 两条内容指纹），实测那种页面在另一个工作树上同样命中——守卫会对着别人的代码
 * 报 18/18 PASS。这类缺陷的危险不在于"红"，而在于**绿得没有依据**：
 * 没有一条用例会因为"验错树"而变红的话，守卫就等于没有说话。</p>
 *
 * <p>覆盖：指纹的确定性与敏感性、meta 注入与解析、以及身份判定的四种结论
 * （own / own-弱证据 / foreign / undecidable）。`foreign` 的用例是本文件的核心——
 * 变异体 `identity-meta-always-own` 把它改坏后必须变红。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/**
 * 判据模块是 **ESM**（Vite 配置只能加载 ESM），本文件是 CJS，所以用动态 `import()` 载入。
 *
 * <p>不依赖 Node 的 `require(esm)`：那需要 Node ≥ 22.12 才默认开启，CI 与本地版本一漂移就
 * 变成 `ERR_REQUIRE_ESM`，而这条用例本身是"守卫验树"的核心证据，不能有环境脆弱性。</p>
 *
 * @type {{TREE_IDENTITY: object, TREE_META_NAME: string, computeTreeFingerprint: Function, createTreeFingerprintPlugin: Function, readTreeMeta: Function, verifyOwnTree: Function}|null}
 */
let FP = null;

/** 载入后的常用导出（在 `before` 里赋值，用例体内直接用）。 */
let TREE_IDENTITY;
let TREE_META_NAME;
let computeTreeFingerprint;
let createTreeFingerprintPlugin;
let readTreeMeta;
let verifyOwnTree;

test.before(async () => {
  FP = await import('../electron/pet-tree-fingerprint.mjs');
  ({
    TREE_IDENTITY,
    TREE_META_NAME,
    computeTreeFingerprint,
    createTreeFingerprintPlugin,
    readTreeMeta,
    verifyOwnTree,
  } = FP);
});

/** 临时 fixture 根目录（每个用例一个子目录）。 */
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tree-fingerprint-'));

/** 已启动的假 dev server（用例结束统一关掉）。 */
const SERVERS = [];

test.after(() => {
  for (const server of SERVERS) {
    try {
      server.close();
    } catch (err) {
      // 关不掉只影响测试进程退出速度，不影响结论
    }
  }
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

/**
 * 造一棵"假源码树"（只需要参与指纹的那几类文件）。
 *
 * @param {string} name fixture 名称
 * @param {Record<string, string>} [overrides] 覆盖某个文件的初始内容
 * @returns {string} fixture 根目录
 */
function makeFixtureTree(name, overrides = {}) {
  const root = path.join(FIXTURE_ROOT, name);
  const files = {
    'package.json': JSON.stringify({ name: 'fixture-tree', version: '0.0.0' }, null, 2),
    'pet-layers.json': JSON.stringify({ version: 1, layers: [] }),
    'pet-face-tiles.json': JSON.stringify({ version: 1, faceTiles: {} }),
    'pet-geometry.json': JSON.stringify({ version: 1, artWidth: 196 }),
    'src/pet/main.ts': 'export const boot = 1;\n',
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/**
 * 起一个假 dev server，按路径返回预设内容。
 *
 * @param {Record<string, {status?: number, body?: string}>} routes 路径 → 响应
 * @returns {Promise<string>} 形如 `http://127.0.0.1:PORT`
 */
async function startFakeServer(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[(req.url || '').split('?')[0]];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(route.status || 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(route.body || '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  SERVERS.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

/** 拼一个带注入指纹的 pet.html。 */
function pageWithMeta(digest) {
  return `<!doctype html><html><head>\n  <meta name="${TREE_META_NAME}" content="${digest}" />\n</head><body><div id="pet-root"></div></body></html>`;
}

test('computeTreeFingerprint：同一棵树两次算出的指纹相同，且覆盖 src/pet 与桌宠清单', () => {
  const root = makeFixtureTree('stable');
  const first = computeTreeFingerprint(root);
  const second = computeTreeFingerprint(root);
  assert.equal(first.digest, second.digest, '同一棵树两次指纹必须一致（否则判定会随机抖）');
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  const paths = first.files.map((item) => item.path);
  assert.ok(paths.includes('package.json'), `指纹必须包含 package.json：${paths.join(', ')}`);
  assert.ok(paths.includes('src/pet/main.ts'), `指纹必须包含 src/pet 下的源码：${paths.join(', ')}`);
  assert.ok(paths.includes('pet-layers.json'), `指纹必须包含桌宠清单：${paths.join(', ')}`);
});

test('computeTreeFingerprint：改一个源文件字节，指纹必须变（否则分辨不出另一棵树）', () => {
  const root = makeFixtureTree('mutable');
  const before = computeTreeFingerprint(root).digest;
  fs.writeFileSync(path.join(root, 'src', 'pet', 'main.ts'), 'export const boot = 2;\n', 'utf8');
  const after = computeTreeFingerprint(root).digest;
  assert.notEqual(before, after, '源码改了指纹却不变 ⇒ 判据对"另一棵树"不敏感，形同虚设');
});

test('computeTreeFingerprint：树里一个参与指纹的文件都没有时直接抛错（拒绝空指纹）', () => {
  const empty = path.join(FIXTURE_ROOT, 'empty-tree');
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => computeTreeFingerprint(empty), /拒绝产出空指纹/);
});

test('readTreeMeta：能从注入过的页面里取回指纹，没有则返回 null', () => {
  const digest = 'a'.repeat(64);
  assert.equal(readTreeMeta(pageWithMeta(digest)), digest);
  assert.equal(readTreeMeta('<html><head></head><body>hi</body></html>'), null);
  assert.equal(readTreeMeta(''), null);
});

test('createTreeFingerprintPlugin：把指纹注入到 </head> 之前，且是每次调用现算', () => {
  const root = makeFixtureTree('plugin');
  const plugin = createTreeFingerprintPlugin(root);
  const html = plugin.transformIndexHtml('<html><head><title>x</title></head><body></body></html>');
  const injected = readTreeMeta(html);
  assert.equal(injected, computeTreeFingerprint(root).digest, '插件注入的指纹必须等于本地现算值');
  assert.ok(html.indexOf('lx-pet-tree') < html.indexOf('</head>'), 'meta 必须落在 head 里');
  fs.writeFileSync(path.join(root, 'src', 'pet', 'main.ts'), 'export const boot = 3;\n', 'utf8');
  const again = readTreeMeta(plugin.transformIndexHtml('<html><head></head><body></body></html>'));
  assert.notEqual(again, injected, '源码改动后注入值必须跟着变（否则改完源码还要重启 dev server）');
});

test('verifyOwnTree：页面注入的指纹与本地一致 → own（强证据）', async () => {
  const root = makeFixtureTree('own-meta');
  const digest = computeTreeFingerprint(root).digest;
  const origin = await startFakeServer({ '/pet.html': { body: pageWithMeta(digest) } });
  const verdict = await verifyOwnTree({ origin, frontendRoot: root });
  assert.equal(verdict.status, TREE_IDENTITY.OWN, verdict.message);
  assert.equal(verdict.evidence, 'meta');
  assert.equal(verdict.weak, false);
});

test('verifyOwnTree：页面注入的指纹是别人的 → foreign（守卫必须失败，不许当 PASS）', async () => {
  const root = makeFixtureTree('foreign-meta');
  const foreignDigest = 'b'.repeat(64);
  const origin = await startFakeServer({ '/pet.html': { body: pageWithMeta(foreignDigest) } });
  const verdict = await verifyOwnTree({ origin, frontendRoot: root });
  assert.equal(verdict.status, TREE_IDENTITY.FOREIGN, verdict.message);
  assert.equal(verdict.evidence, 'meta');
  assert.match(verdict.message, /另一棵树/, `报错必须点名"另一棵树"，实际：${verdict.message}`);
  assert.ok(verdict.hint.length > 0, '必须给出可执行的修法');
});

test('verifyOwnTree：没有注入指纹但清单字节不一致 → foreign（兜底弱指纹也要抓住）', async () => {
  const root = makeFixtureTree('foreign-json');
  const origin = await startFakeServer({
    '/pet.html': { body: '<html><head></head><body><div id="pet-root"></div></body></html>' },
    '/package.json': { body: JSON.stringify({ name: 'another-tree', version: '9.9.9' }) },
    '/pet-layers.json': { body: '{"version":2,"layers":[]}' },
  });
  const verdict = await verifyOwnTree({ origin, frontendRoot: root });
  assert.equal(verdict.status, TREE_IDENTITY.FOREIGN, verdict.message);
  assert.equal(verdict.evidence, 'json-bytes');
  assert.match(verdict.message, /另一棵树/, `报错必须点名"另一棵树"，实际：${verdict.message}`);
  assert.deepEqual(verdict.mismatches.includes('package.json'), true, `应点名不一致的文件：${JSON.stringify(verdict.mismatches)}`);
});

test('verifyOwnTree：没有注入指纹但清单字节一致 → own（弱证据，要提示重启 dev server）', async () => {
  const root = makeFixtureTree('own-json');
  const origin = await startFakeServer({
    '/pet.html': { body: '<html><head></head><body><div id="pet-root"></div></body></html>' },
    '/package.json': { body: fs.readFileSync(path.join(root, 'package.json'), 'utf8') },
    '/pet-layers.json': { body: fs.readFileSync(path.join(root, 'pet-layers.json'), 'utf8') },
    '/pet-face-tiles.json': { body: fs.readFileSync(path.join(root, 'pet-face-tiles.json'), 'utf8') },
  });
  const verdict = await verifyOwnTree({ origin, frontendRoot: root });
  assert.equal(verdict.status, TREE_IDENTITY.OWN, verdict.message);
  assert.equal(verdict.evidence, 'json-bytes');
  assert.equal(verdict.weak, true, '清单比对是弱证据，必须标出来');
  assert.match(verdict.hint, /重启 dev server/, `弱证据必须提示启用强指纹，实际：${verdict.hint}`);
});

test('verifyOwnTree：页面取不到 → undecidable（只能 SKIP，且必须写清原因与修法）', async () => {
  const root = makeFixtureTree('undecidable-page');
  const origin = await startFakeServer({});
  const verdict = await verifyOwnTree({ origin, frontendRoot: root });
  assert.equal(verdict.status, TREE_IDENTITY.UNDECIDABLE, verdict.message);
  assert.match(verdict.message, /无法判定/, verdict.message);
  assert.ok(verdict.hint.length > 0, 'SKIP 必须给出怎么修');
});

test('verifyOwnTree：页面里没有指纹、清单也一个都取不到 → undecidable', async () => {
  const root = makeFixtureTree('undecidable-json');
  const origin = await startFakeServer({ '/pet.html': { body: '<html><head></head><body>pet</body></html>' } });
  const verdict = await verifyOwnTree({ origin, frontendRoot: root });
  assert.equal(verdict.status, TREE_IDENTITY.UNDECIDABLE, verdict.message);
  assert.match(verdict.message, /无法判定/, verdict.message);
  assert.ok(verdict.hint.length > 0, 'SKIP 必须给出怎么修');
});

test('verifyOwnTree：origin 非法直接抛 TypeError（不做任何猜测）', async () => {
  await assert.rejects(() => verifyOwnTree({ origin: '127.0.0.1:5275' }), /origin 非法/);
});

// ---------------------------------------------------------------- 守卫接线（判据要被真的用上）

/**
 * 光有"判据正确"还不够：判据写对了但守卫没接线（或把 FOREIGN 当 PASS），
 * 验错树的缺陷照样成立。所以这里对守卫源码做一次**接线断言**。
 *
 * <p>为什么是源码断言而不是行为断言：跑真守卫要 Electron + 真 dev server，
 * 不能在 `node --test` 里做。两类证据互补——「判据行为」由上面 12 条假 server 用例保证，
 * 「判据被用上」由本用例保证；两者缺一都会让 `identity-*-always-own` 这类变异体活下来。</p>
 */
test('守卫接线：assertOwnTree 必须调用树身份判据，且 FOREIGN 分支必须抛错（不许当 PASS/SKIP）', () => {
  const guardPath = path.join(__dirname, '..', 'scripts', 'pet-face-visual-guard.cjs');
  const source = fs.readFileSync(guardPath, 'utf8');
  const start = source.indexOf('async function assertOwnTree');
  assert.ok(start >= 0, '守卫里必须存在 assertOwnTree');
  // 函数体截到第一个顶格 `}` 为止（源码是 CRLF，所以只锚 `\n}`，不锚 `\n}\n`）
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  assert.ok(body.length > 50, 'assertOwnTree 函数体解析失败（切片为空）');
  assert.match(
    body,
    /await verifyOwnTree\(/,
    '守卫必须调用产品判据 verifyOwnTree（判据写对但没接线等于没有守卫）',
  );
  // OWN 之外的两种结论都不许当成 PASS：FOREIGN 显式分支 + undecidable 兜底，两个都抛
  const foreignAt = body.indexOf('TREE_IDENTITY.FOREIGN');
  const fallthroughAt = body.indexOf('IDENTITY-SKIP');
  assert.ok(foreignAt > 0, '守卫必须显式判断 FOREIGN 结论');
  assert.ok(fallthroughAt > foreignAt, 'FOREIGN 分支必须排在 undecidable 兜底之前（不许先吞掉）');
  const foreignBranch = body.slice(foreignAt, fallthroughAt);
  assert.match(foreignBranch, /throw new Error\(/, 'FOREIGN 必须抛出（退出码 2），不许降级成 PASS 或 SKIP');
  assert.match(foreignBranch, /另一棵树/, 'FOREIGN 的报错必须点名"另一棵树"');
  assert.doesNotMatch(foreignBranch, /^\s*return;/m, 'FOREIGN 分支不许"打个日志就继续测量"');
  const undecidableBranch = body.slice(fallthroughAt);
  assert.match(undecidableBranch, /throw new Error\(/, 'undecidable 必须抛错（SKIP 也要非 0 退出）');
  assert.match(undecidableBranch, /怎么修/, 'SKIP 必须写清怎么修');
});

// ---------------------------------------------------------------- 声明 ↔ 实现一致性（防类型声明漂移）

/**
 * 判据模块的**类型声明**路径。
 *
 * <p>`.mjs` → `.d.mts` 是 TypeScript 的既定配对规则（与既有 `pet-dev-endpoint.cjs` →
 * `pet-dev-endpoint.d.cts` 同一套）。声明与实现放在同目录同名，`vue-tsc -b` 才能拿到强类型；
 * 而 `.mjs` 里没有任何运行时信息能约束声明，所以**必须有下面这条一致性守卫**——
 * 否则实现里加/删导出、或把类型写成 `any`，都不会有人发现（`vue-tsc` 照样绿）。</p>
 */
const FP_DECL_PATH = path.join(__dirname, '..', 'electron', 'pet-tree-fingerprint.d.mts');

/** 判据模块的实现路径（用于断言"声明与实现在同一目录、同名配对"）。 */
const FP_MODULE_PATH = path.join(__dirname, '..', 'electron', 'pet-tree-fingerprint.mjs');

/**
 * 去掉注释（块注释 + 行注释），保留代码。
 *
 * <p>注释里写 `any`、写 `@ts-expect-error`（说明"为什么不能用"）都是正当文档，
 * 只有**代码里**出现才算逃逸；所以判据必须先剥注释，否则守卫会被文档误伤。</p>
 *
 * @param {string} source 源码全文
 * @returns {string} 去掉注释的文本
 */
function stripComments(source) {
  const withoutBlocks = String(source).replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''));
  return withoutBlocks
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * 解析声明里 `export declare function|const` 的导出名与种类。
 *
 * @param {string} declText 声明全文
 * @returns {Array<{name: string, kind: 'function'|'const', line: string}>} 导出项（按出现顺序）
 */
function parseDeclaredValueExports(declText) {
  const lines = stripComments(declText).split('\n');
  /** @type {Array<{name: string, kind: 'function'|'const', line: string}>} */
  const found = [];
  for (const line of lines) {
    const matched = /^export declare (function|const)\s+([A-Za-z_$][\w$]*)/.exec(line.trim());
    if (!matched) continue;
    found.push({ name: matched[2], kind: /** @type {'function'|'const'} */ (matched[1]), line: line.trim() });
  }
  return found;
}

test('声明一致性：.d.mts 与 .mjs 同目录同名配对（否则 vue-tsc 又会退化成 any）', () => {
  assert.equal(fs.existsSync(FP_MODULE_PATH), true, `实现不存在：${FP_MODULE_PATH}`);
  assert.equal(fs.existsSync(FP_DECL_PATH), true, `类型声明不存在：${FP_DECL_PATH}`);
  assert.equal(path.basename(FP_DECL_PATH), path.basename(FP_MODULE_PATH).replace(/\.mjs$/, '.d.mts'));
  assert.equal(path.dirname(FP_DECL_PATH), path.dirname(FP_MODULE_PATH), '声明必须与实现同目录（TS 按同目录同名配对）');
  const declText = fs.readFileSync(FP_DECL_PATH, 'utf8');
  assert.ok(declText.length > 500, '声明文件短得不像话，可能被清空或用 declare module 兜底成 any');
});

test('声明一致性：声明里的导出名集合 === .mjs 实际 import() 出来的导出名集合（漂移必红）', () => {
  const declText = fs.readFileSync(FP_DECL_PATH, 'utf8');
  const declared = parseDeclaredValueExports(declText);

  const actualNames = Object.keys(FP).sort();
  const declaredNames = declared.map((item) => item.name).sort();
  assert.deepEqual(
    declaredNames,
    actualNames,
    `声明与实现的导出集合不一致：实现有 [${actualNames.join(', ')}]，声明有 [${declaredNames.join(', ')}]`
      + '（实现加了导出就在 .d.mts 里补上；声明里多了的导出要从定义里删掉）',
  );

  // 种类也要对齐：声明成 function 的，运行时必须是函数；声明成 const 的，运行时必须有值
  const wrongKind = declared.filter((item) => {
    const runtime = FP[item.name];
    if (item.kind === 'function') return typeof runtime !== 'function';
    return runtime === undefined;
  });
  assert.deepEqual(
    wrongKind.map((item) => `${item.name}(${item.kind})`),
    [],
    `声明的导出种类与实现不符：${wrongKind.map((item) => item.line).join(' / ')}`,
  );
});

test('声明一致性：解析器真的认得出导出（防止"解析出 0 条"让上面的集合比对空跑）', () => {
  const declared = parseDeclaredValueExports(fs.readFileSync(FP_DECL_PATH, 'utf8'));
  assert.ok(
    declared.length >= 8,
    `只解析出 ${declared.length} 个 export declare 项：声明结构可能已改成 export { } 之类，`
      + '解析器要同步跟进，否则集合比对会变成空跑',
  );
  assert.equal(
    declared.filter((item) => item.kind === 'function').length >= 4,
    true,
    `函数导出只认出 ${declared.filter((item) => item.kind === 'function').length} 个，声明结构可能已变`,
  );
});

test('声明一致性：TreeIdentityStatus 三态联合与 TREE_IDENTITY 取值逐字一致', () => {
  const declText = stripComments(fs.readFileSync(FP_DECL_PATH, 'utf8'));
  const unionLine = /^export type TreeIdentityStatus = (.+);$/m.exec(declText);
  assert.ok(unionLine, '声明里必须存在 `export type TreeIdentityStatus = ...;`（三态联合）');
  const declaredStates = (unionLine[1].match(/'([^']+)'/g) || []).map((item) => item.slice(1, -1)).sort();
  const runtimeStates = Object.values(TREE_IDENTITY).slice().sort();
  assert.deepEqual(
    declaredStates,
    runtimeStates,
    `三态联合与 TREE_IDENTITY 取值不一致：声明 [${declaredStates.join(', ')}]，运行时 [${runtimeStates.join(', ')}]`,
  );
  assert.equal(runtimeStates.length, 3, '身份判定必须是三态（own / foreign / undecidable），多一个少一个都不行');
});

test('声明一致性：声明里不得出现 any / @ts-* 逃逸，函数导出必须写明返回类型', () => {
  const declText = stripComments(fs.readFileSync(FP_DECL_PATH, 'utf8'));
  assert.doesNotMatch(
    declText,
    /\bany\b/,
    '声明里出现了 any：TypeScript 会因此失去检查能力，等于把 TS7016 换成"静默 any"',
  );
  assert.doesNotMatch(
    declText,
    /@ts-(ignore|nocheck|nocheck|expect-error)/,
    '声明里出现了 @ts-* 指令：那不是修复类型，是掩盖类型',
  );
  const functions = parseDeclaredValueExports(declText).filter((item) => item.kind === 'function');
  assert.ok(functions.length >= 4, `只找到 ${functions.length} 个函数导出，声明结构可能已变`);
  const noReturn = functions.filter((item) => !/\)\s*:\s*[A-Za-z_$]/.test(item.line));
  assert.deepEqual(noReturn.map((item) => item.line), [], '每个函数导出都必须写明返回类型（省略会退化成隐式 any）');
});

test('声明防回退：vite.pet.config.ts 仍 import 树指纹插件（不许靠删 import 来消掉 TS7016）', () => {
  const configPath = path.join(__dirname, '..', 'vite.pet.config.ts');
  const source = stripComments(fs.readFileSync(configPath, 'utf8'));
  assert.match(
    source,
    /import\s*\{\s*createTreeFingerprintPlugin\s*\}\s*from\s*'\.\/electron\/pet-tree-fingerprint\.mjs'/,
    'vite.pet.config.ts 必须继续 import createTreeFingerprintPlugin（删掉它只是把桌宠树指纹关掉，不是修类型）',
  );
  assert.match(source, /plugins:\s*\[\s*createTreeFingerprintPlugin\(\)/, '插件必须仍然挂在 plugins 里（悬空 import 等于没接）');
});
