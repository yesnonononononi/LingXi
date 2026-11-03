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

test('单一真源：桌宠相关文件里不得再出现端口字面量', () => {
  const portLiteral = String(endpoint.DEV_ENDPOINT.port);
  // electron/pet-dev-endpoint.cjs 是真源本身，故不在扫描范围内
  const consumers = [
    'vite.pet.config.ts',
    'electron/pet-window.cjs',
    'electron/pet-dev-probe.cjs',
    'scripts/pet-dev-server.cjs',
    'scripts/pet-dev-mutation-selfcheck.mjs',
    'package.json',
  ];
  for (const relative of consumers) {
    const content = read(relative);
    assert.equal(
      content.includes(portLiteral),
      false,
      `${relative} 出现端口字面量 ${portLiteral}：端口只能定义在 electron/pet-dev-endpoint.cjs，其余消费方一律从它取`,
    );
  }
  // 反向确认：真源文件确实写着这个端口（否则上面的扫描等于空转）
  assert.equal(read('electron/pet-dev-endpoint.cjs').includes(portLiteral), true);
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
