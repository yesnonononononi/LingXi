/**
 * 桌宠 dev 端点真源单测（node:test，不启动 Vite / Electron）。
 *
 * <p><b>守的是什么：</b>"桌宠窗口加载成主应用界面"的根因是<b>端口归属不清</b>——
 * 桌宠和主应用抢同一个 5174，且谁都没有 `strictPort`，Vite 静默漂移 + SPA fallback
 * 把 `/pet.html` 兜成 `index.html`。所以这里逐条守住修复后的架构口径：</p>
 *
 * <ol>
 *   <li>桌宠端口与主应用端口<b>必须不同</b>（防"改回去"）；</li>
 *   <li>端口只允许有一处字面量（单一真源，防第二处硬编码漂移）；</li>
 *   <li>`strictPort: true` + `appType: 'mpa'`（防静默漂移 + 防 history fallback）；</li>
 *   <li>`pet.html` 真的含探活指纹，而 `index.html` 不含（指纹必须能区分两个页面）。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND_ROOT = path.join(__dirname, '..');

/** 按相对路径读文本（断言失败时能一眼看出是哪个文件）。 */
function read(relativePath) {
  return fs.readFileSync(path.join(FRONTEND_ROOT, relativePath), 'utf8');
}

const endpoint = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-endpoint.cjs'));
/**
 * 去掉源码里的注释，但**保留字符串字面量内容**（'…' "…" `…`）。
 *
 * <p><b>为什么不能只用正则粗暴删注释：</b>扫描要能区分"注释里提到算什么"和
 * "代码里写死算什么"。注释里出现 `pet.html` 是说明，不算违规；代码里出现在
 * URL 拼接或路径拼接里才是硬编码。所以必须知道匹配位置是否位于注释内——
 * 而注释判定又必须跳过字符串字面量里的 `//`（例如 `'http://127.0.0.1'`）。</p>
 *
 * <p>算法口径与 `scripts/check-pet-geometry.mjs` 的 `stripComments` 一致（那边守几何魔法数）；
 * 本文件这份额外保住字符串字面量，因为入口页名恰好会出现在 URL/路径字符串里。</p>
 *
 * @param {string} source 源码文本
 * @returns {string} 去掉注释后的文本（行号保持不变）
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  /** 当前所在的字符串引号；空串表示不在字符串里。 */
  let quote = '';
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '\n' && (quote === '"' || quote === "'")) {
      // 单/双引号字符串不能跨行：走到行尾还"在字符串里"，说明这个引号来自
      // 正则字面量或中文注释里的撇号（噪声）。重置状态，避免整份文件从某行起
      // 再也没法识别注释（实测：pet-window.cjs 的 /^["']|["']$/g 会造成这种漂移）。
      quote = '';
    }
    if (quote) {
      out += ch;
      if (ch === '\\') {
        // 转义序列整体跳过，避免 \" 被当成字符串结束
        out += next === undefined ? '' : next;
        index += 2;
        continue;
      }
      if (ch === quote) quote = '';
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 在源码里找某个字面量在**代码**中的出现（注释里的提及不算）。
 *
 * @param {string} source 源码文本
 * @param {string} literal 要查的字面量（如 `5275` 或 `pet.html`）
 * @returns {string[]} 命中列表（`第 N 行：内容`），空数组表示干净
 */
function findLiteralsInCode(source, literal) {
  const code = stripComments(source);
  const hits = [];
  code.split('\n').forEach((line, index) => {
    if (line.includes(literal)) hits.push(`第 ${index + 1} 行：${line.trim()}`);
  });
  return hits;
}


/**
 * 从主应用 `vite.config.ts` 里抓 `server.port`。
 *
 * <p>不 import 那个文件：它引 `vite` / `@vitejs/plugin-vue`，在纯 node 下跑不动。
 * 这里要的只是一个数字，文本匹配足够，而且能抓住"主应用端口被别人改动"的情况。</p>
 *
 * @returns {number} 主应用 dev server 端口
 */
function readMainAppPort() {
  const source = read('vite.config.ts');
  const matched = /port\s*:\s*(\d{2,5})/.exec(source);
  assert.ok(matched, 'vite.config.ts 里找不到 server.port，端口真源结构已变，请同步本测试');
  return Number(matched[1]);
}

test('端点配置：端口是合法整数端口', () => {
  const { port } = endpoint.DEV_ENDPOINT;
  assert.equal(Number.isInteger(port), true, `端口必须是整数，实际 ${JSON.stringify(port)}`);
  assert.equal(port >= endpoint.MIN_PORT && port <= endpoint.MAX_PORT, true, `端口越界：${port}`);
});

test('端口归属：桌宠端口与主应用 dev server 端口不同', () => {
  const mainPort = readMainAppPort();
  assert.notEqual(
    endpoint.DEV_ENDPOINT.port,
    mainPort,
    `桌宠端口与主应用端口撞车（都是 ${mainPort}）：这正是"窗口加载成主应用界面"的根因，禁止改回`,
  );
});

/**
 * 单一真源的消费方清单（真源自身 `electron/pet-dev-endpoint.cjs` 不在其中）。
 *
 * <p>`electron/pet-window.cjs` 由 K4 补入：它是"探活打哪个页面、窗口就加载哪个页面"的
 * 另一头，入口页名一旦在这里写死，两侧就可能各说各话。</p>
 */
const SINGLE_SOURCE_CONSUMERS = [
  'vite.pet.config.ts',
  'electron/pet-window.cjs',
  'electron/pet-dev-probe.cjs',
  'scripts/pet-dev-server.cjs',
  'scripts/pet-dev-mutation-selfcheck.mjs',
  'package.json',
];

test('单一真源：桌宠相关文件里不得再出现端口字面量', () => {
  const portLiteral = String(endpoint.DEV_ENDPOINT.port);
  for (const relative of SINGLE_SOURCE_CONSUMERS) {
    const hits = findLiteralsInCode(read(relative), portLiteral);
    assert.deepEqual(
      hits,
      [],
      `${relative} 出现端口字面量 ${portLiteral}：端口只能定义在 electron/pet-dev-endpoint.cjs，其余消费方一律从它取\n${hits.join('\n')}`,
    );
  }
  // 反向确认：真源文件确实写着这个端口（否则上面的扫描等于空转）
  assert.equal(read('electron/pet-dev-endpoint.cjs').includes(portLiteral), true);
});

test('单一真源：入口页名不得出现字面量（pet-window.cjs 的 dev 与 dist 两条分支都算）', () => {
  const entryPage = endpoint.DEV_ENDPOINT.entryPage;
  assert.equal(entryPage.endsWith('.html'), true, '入口页应当以 .html 结尾');

  for (const relative of SINGLE_SOURCE_CONSUMERS) {
    const source = read(relative);
    const hits = findLiteralsInCode(source, entryPage);
    assert.deepEqual(
      hits,
      [],
      `${relative} 在代码里写死了入口页名 ${entryPage}：只能来自 electron/pet-dev-endpoint.cjs 的 DEV_ENDPOINT.entryPage（注释里的提及不算违规）\n${hits.join('\n')}`,
    );
  }

  // 反向确认真源确实写着这个入口页名，否则上面的扫描等于空转
  assert.equal(read('electron/pet-dev-endpoint.cjs').includes(entryPage), true);

  // 窗口侧两条分支都必须真的引用真源符号（不是"恰好没写死"而已）
  const windowSource = read('electron/pet-window.cjs');
  assert.match(windowSource, /const PET_ENTRY_PAGE = PET_DEV_ENDPOINT\.DEV_ENDPOINT\.entryPage;/);
  assert.match(
    windowSource,
    /resolveEntrySpec\(\{ isDev, frontendRoot, rawUrl: process\.env\.ELECTRON_URL \}\)/,
    'resolveEntry() 必须走纯函数 resolveEntrySpec，两条分支共用真源入口页名',
  );
});

test('单一真源扫描器自证：注释里提及不算违规，代码里的字符串字面量算', () => {
  const page = endpoint.DEV_ENDPOINT.entryPage;
  // 注释里的提及（行注释 / 块注释）→ 不算违规
  assert.deepEqual(findLiteralsInCode(`// 历史：/ ${page} 曾被兜成 index.html`, page), []);
  assert.deepEqual(findLiteralsInCode(`/* ${page} 的由来 */`, page), []);
  assert.deepEqual(findLiteralsInCode(`/**\n * 例如 \${url}${page}\n */`, page), []);

  // 代码里的字符串字面量 → 必须被抓到（三种写法都覆盖）
  assert.equal(findLiteralsInCode(`const u = 'http://127.0.0.1:5275/${page}';`, page).length, 1);
  assert.equal(findLiteralsInCode(`const p = path.join(root, 'dist', "${page}");`, page).length, 1);
  assert.equal(findLiteralsInCode('const v = `${base}' + page + '`;', page).length, 1);
  // 字符串里的 // 不能被当成注释起点（否则会漏掉后半行的硬编码）
  assert.equal(findLiteralsInCode(`const u = 'http://x/${page}'; // 尾注释`, page).length, 1);
});


test('Vite 覆盖项：strictPort 硬失败 + appType mpa 关闭 history fallback', () => {
  const overrides = endpoint.createPetViteOverrides();
  assert.equal(overrides.appType, 'mpa', 'appType 必须是 mpa：spa 模式会把 /pet.html 兜成 index.html 且返回 200');
  assert.equal(overrides.server.strictPort, true, 'strictPort 必须是 true：否则端口被占时 Vite 会静默 +1 漂移');
  assert.equal(overrides.server.port, endpoint.DEV_ENDPOINT.port);
  assert.equal(overrides.server.host, endpoint.DEV_ENDPOINT.host);
  assert.equal(overrides.server.open, false, '桌宠 dev server 不该自动拉浏览器');
});

test('Vite 覆盖项：vite.pet.config.ts 确实消费单一真源', () => {
  const source = read('vite.pet.config.ts');
  assert.equal(source.includes('createPetViteOverrides'), true, 'vite.pet.config.ts 必须从 electron/pet-dev-endpoint.cjs 取端口');
  assert.equal(source.includes('mergeConfig'), true, 'vite.pet.config.ts 应合并 vite.config.ts，避免两份配置各自漂移');
});

test('入口 URL：与端口同源且落在 pet.html 上', () => {
  const origin = endpoint.buildDevOrigin();
  const entry = endpoint.buildEntryUrl();
  assert.equal(origin, `http://${endpoint.DEV_ENDPOINT.host}:${endpoint.DEV_ENDPOINT.port}`);
  assert.equal(entry, `${origin}/pet.html`);
  // 探活目标与窗口入口必须是同一个拼接逻辑，这里直接复算一次
  assert.equal(new URL(endpoint.DEV_ENDPOINT.entryPage, `${origin}/`).toString(), entry);
});

test('内容指纹：pet.html 含全部指纹，index.html 一个都不含', () => {
  const petHtml = read('pet.html');
  const indexHtml = read('index.html');
  for (const marker of endpoint.PET_PAGE_MARKERS) {
    assert.equal(petHtml.includes(marker), true, `pet.html 缺少探活指纹 ${marker}，探活会永远失败`);
    assert.equal(indexHtml.includes(marker), false, `index.html 也含指纹 ${marker}：指纹无法区分桌宠与主应用，探活形同虚设`);
  }
});

test('参数校验：非法端点配置当场抛 TypeError', () => {
  const base = endpoint.DEV_ENDPOINT;
  assert.throws(() => endpoint.createPetViteOverrides({ ...base, port: 0 }), TypeError);
  assert.throws(() => endpoint.createPetViteOverrides({ ...base, port: 70000 }), TypeError);
  assert.throws(() => endpoint.createPetViteOverrides({ ...base, port: 5275.5 }), TypeError);
  assert.throws(() => endpoint.createPetViteOverrides({ ...base, host: '  ' }), TypeError);
  assert.throws(() => endpoint.createPetViteOverrides({ ...base, entryPage: 'pet' }), TypeError);
  assert.throws(() => endpoint.createPetViteOverrides(null), TypeError);
});
