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
