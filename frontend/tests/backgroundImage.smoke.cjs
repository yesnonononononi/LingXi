/**
 * 主页背景自定义（L2）真渲染验证。
 *
 * 覆盖六件事（都是主理人已独立复核过的判据，这里只负责用测试锁死）：
 *   1. 默认态（无偏好）**一个 CSS 变量都不写** —— 用一个 setProperty 间谍直接数「写了几次」，
 *      而不是看 getPropertyValue 是否为空串：`setProperty('--x', '')` 会把属性删掉，
 *      getPropertyValue 同样是空串，只查读值会让「偷偷写空串」蒙混过关；
 *   2. 未注册插槽 ⇒ 回落内置 TokenBackground（glow 光晕在）；
 *   3. 注册 `{ surface: ImageBackground }` ⇒ 出现 scrim，且 glow **不再出现**（不双渲染）；
 *   4. 注册 `{}` ⇒ 仍回落 glow（证明是按字段判空，不是按对象真值判）；
 *   5. 清除必须把三个变量全部复位为空串；
 *   6. localStorage 里的坏偏好（版本不符 / 文件名非法）⇒ init() 后偏好为 null 且零写入。
 *
 * 运行：`cd frontend && npx electron tests/backgroundImage.smoke.cjs`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
const output = path.resolve(frontendRoot, 'node_modules/.tmp/background-image-surface');
const logDir = path.resolve(frontendRoot, '../.lingxi/tmp/qa-background-l2');

app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => {
  console.error('主页背景表面验证超时');
  app.exit(1);
}, 180000);

/** 生成相对 output 目录的 import 说明符（正斜杠，vite 可解析）。 */
function specifierFor(absolutePath) {
  const relative = path.relative(output, absolutePath).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

/**
 * 生成宿主页面：一面 setProperty 间谍 + 一个按场景挂载 ChatBackground 的渲染入口。
 * 场景值由主进程侧选择，避免把组件实例序列化到页面里。
 */
async function writeHarness() {
  const files = {
    ChatBackground: path.resolve(frontendRoot, 'src/components/chat/ChatBackground.vue'),
    TokenBackground: path.resolve(frontendRoot, 'src/components/background/TokenBackground.vue'),
    ImageBackground: path.resolve(frontendRoot, 'src/components/background/ImageBackground.vue'),
    slotsKey: path.resolve(frontendRoot, 'src/types/backgroundSlots.ts'),
    preference: path.resolve(frontendRoot, 'src/composables/useBackgroundPreference.ts'),
    style: path.resolve(frontendRoot, 'src/style.css'),
  };

  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, h, nextTick } from 'vue';
import ChatBackground from '${specifierFor(files.ChatBackground)}';
import TokenBackground from '${specifierFor(files.TokenBackground)}';
import ImageBackground from '${specifierFor(files.ImageBackground)}';
import { BACKGROUND_SLOTS_KEY } from '${specifierFor(files.slotsKey)}';
import { BACKGROUND_STORAGE_KEY, useBackgroundPreference, isDocumentVariablesApplied } from '${specifierFor(files.preference)}';
import '${specifierFor(files.style)}';

/* ---- setProperty 间谍：不加它就无法区分「没写」与「写了个空串」 ---- */
window.__calls = [];
const cssProto = CSSStyleDeclaration.prototype;
const originalSetProperty = cssProto.setProperty;
cssProto.setProperty = function (name, value, priority) {
  window.__calls.push({ name: String(name), value: String(value) });
  return originalSetProperty.call(this, name, value, priority);
};

window.__resetCalls = () => { window.__calls.length = 0; };
window.__callsNow = () => window.__calls.slice();

/* 场景：undefined 表示「不 provide」，{} 表示「provide 空对象」 */
const SCENARIOS = {
  none: undefined,
  image: { surface: ImageBackground },
  empty: {},
};

window.__render = async (scenario) => {
  const spec = SCENARIOS[scenario];
  if (spec === undefined && scenario !== 'none') throw new Error('未知场景：' + scenario);
  if (window.__app) { window.__app.unmount(); window.__app = null; }
  const root = document.getElementById('app');
  root.innerHTML = '';
  const host = document.createElement('div');
  host.setAttribute('data-host', '1');
  root.appendChild(host);
  const instance = createApp({ render: () => h(ChatBackground) });
  if (scenario !== 'none') instance.provide(BACKGROUND_SLOTS_KEY, spec);
  instance.mount(host);
  window.__app = instance;
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 120));
  return true;
};

/* ---- DOM / 变量探针 ---- */
window.__probe = () => {
  const root = document.querySelector('.lx-chat-background');
  return {
    rootFound: !!root,
    glow: document.querySelectorAll('.lx-chat-background__glow').length,
    scrim: document.querySelectorAll('.lx-image-background__scrim').length,
    childCount: root ? root.children.length : -1,
    backgroundImage: root ? getComputedStyle(root).backgroundImage : null,
    canvasImageVar: document.documentElement.style.getPropertyValue('--lx-canvas-image'),
    scrimVar: document.documentElement.style.getPropertyValue('--lx-background-scrim'),
    fitVar: document.documentElement.style.getPropertyValue('--lx-canvas-fit'),
    styleAttr: document.documentElement.getAttribute('style'),
    inlineLength: document.documentElement.style.length,
    calls: window.__callsNow(),
  };
};

/* ---- 偏好操作入口（都走真实组合式函数，不自己造真值） ---- */
window.__api = {
  init: () => useBackgroundPreference().init(),
  clear: () => useBackgroundPreference().clear(),
  preferenceValue: () => {
    const current = useBackgroundPreference().preference.value;
    return current ? JSON.parse(JSON.stringify(current)) : null;
  },
  documentVariablesApplied: () => isDocumentVariablesApplied(),
  resetDocument() {
    document.documentElement.removeAttribute('style');
    window.__calls.length = 0;
  },
  readStorage: () => localStorage.getItem(BACKGROUND_STORAGE_KEY),
  writeStorage: (raw) => localStorage.setItem(BACKGROUND_STORAGE_KEY, raw),
  clearStorage: () => localStorage.removeItem(BACKGROUND_STORAGE_KEY),
  setVariable: (name, value) => document.documentElement.style.setProperty(name, value),
  /** 把三个变量摆成「已经有背景图在生效」的状态，供清除用例建立前置条件。 */
  seedVariables: (imageValue) => {
    document.documentElement.style.setProperty('--lx-canvas-image', imageValue);
    document.documentElement.style.setProperty('--lx-background-scrim', '0.8');
    document.documentElement.style.setProperty('--lx-canvas-fit', 'contain');
  },
  resetCalls: () => { window.__calls.length = 0; },
  storageKey: BACKGROUND_STORAGE_KEY,
};

window.ready = true;`);

  await fs.writeFile(path.join(output, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
    + '<div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
}

async function buildHarness() {
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({
    configFile: false,
    root: output,
    base: './',
    plugins: [vue()],
    logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true },
  });
}

app.whenReady().then(async () => {
  const results = [];
  const runCase = async (name, body) => {
    try {
      await body();
      results.push({ name, ok: true });
      console.log(`[PASS] ${name}`);
    } catch (error) {
      results.push({ name, ok: false, error });
      console.log(`[FAIL] ${name}`);
      console.log('       ' + String((error && error.message) || error).split('\n').join('\n       '));
    }
  };

  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.mkdir(output, { recursive: true });
    await writeHarness();
    await buildHarness();

    window = new BrowserWindow({
      width: 900, height: 700, show: false,
      webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false },
    });
    await window.loadFile(path.join(output, 'dist/index.html'));
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    // 渲染层错误只在失败时才需要看：这里把 error 级日志打出来，便于复现「Script failed to execute」类问题
    window.webContents.on('console-message', (event) => {
      const level = typeof (event && event.level) === 'number' ? event.level : -1;
      const message = String((event && event.message) || '');
      if (level >= 3 && message) console.log(`[renderer] ${message}`);
    });
    assert.equal(await evaluate('window.ready'), true, '宿主未就绪');

    // 用例1：默认态零写入（没有偏好时一个 CSS 变量都不写，且画布根回落到 none）
    await runCase('用例1 默认态零写入：init() 无偏好不写任何 CSS 变量，画布回落 none', async () => {
      await evaluate('window.__api.clearStorage()');
      await evaluate('window.__api.resetDocument()');
      await evaluate('window.__api.init()');
      const afterInit = await evaluate('window.__probe()');
      assert.deepEqual(afterInit.calls, [],
        `默认态 init() 不得调用 setProperty（写空串也算写），实际：${JSON.stringify(afterInit.calls)}`);
      assert.equal(afterInit.canvasImageVar, '', '默认态 --lx-canvas-image 必须未设置');
      assert.equal(afterInit.scrimVar, '', '默认态 --lx-background-scrim 必须未设置');
      assert.equal(afterInit.fitVar, '', '默认态 --lx-canvas-fit 必须未设置');
      assert.equal(afterInit.inlineLength, 0, `文档根不得有任何内联声明，实际 style：${JSON.stringify(afterInit.styleAttr)}`);

      await evaluate('window.__render("none")');
      const probe = await evaluate('window.__probe()');
      assert.equal(probe.rootFound, true, '画布根 .lx-chat-background 未渲染');
      assert.equal(probe.backgroundImage, 'none',
        `背景图必须回落到 none（var(--lx-canvas-image, none) 生效），实际：${probe.backgroundImage}`);
      assert.equal(probe.canvasImageVar, '', '渲染本身不得写入 --lx-canvas-image');
    });

    // 用例2：未注册插槽 ⇒ 回落内置 TokenBackground
    await runCase('用例2 未注册回落：不 provide 时渲染出 glow 光晕（TokenBackground 生效）', async () => {
      await evaluate('window.__render("none")');
      const probe = await evaluate('window.__probe()');
      assert.equal(probe.glow, 1, `未注册时必须回落内置光晕，实际 glow=${probe.glow}`);
      assert.equal(probe.scrim, 0, `未注册时不得出现图片遮罩，实际 scrim=${probe.scrim}`);
      assert.equal(probe.childCount, 1, `画布根内应恰好一个装饰表面，实际 ${probe.childCount}`);
    });

    // 用例3：替换生效（且不双渲染）
    await runCase('用例3 替换生效：provide surface=ImageBackground ⇒ 出现 scrim 且 glow 消失', async () => {
      await evaluate('window.__render("image")');
      const probe = await evaluate('window.__probe()');
      assert.equal(probe.scrim, 1, `注册图片表面后必须出现可读性遮罩 .lx-image-background__scrim，实际 scrim=${probe.scrim}`);
      assert.equal(probe.glow, 0, `替换后内置 glow 必须消失（不双渲染），实际 glow=${probe.glow}`);
      assert.equal(probe.childCount, 1, `画布根内应恰好一个装饰表面，实际 ${probe.childCount}`);
    });

    // 用例4：空对象仍回落（按字段判空，不是按对象真值）
    await runCase('用例4 空对象仍回落：provide {} 时渲染 glow（按字段判空）', async () => {
      await evaluate('window.__render("empty")');
      const probe = await evaluate('window.__probe()');
      assert.equal(probe.glow, 1, `provide {} 必须回落到内置光晕（按字段判空），实际 glow=${probe.glow}`);
      assert.equal(probe.scrim, 0, `provide {} 不得渲染图片遮罩，实际 scrim=${probe.scrim}`);
      assert.equal(probe.childCount, 1, `provide {} 不得渲染空占位，实际子节点 ${probe.childCount}`);
    });

    // 用例5：清除复位三个变量
    await runCase('用例5 清除复位：clear() 把三个 CSS 变量全部复位为空串', async () => {
      await evaluate(`window.__api.writeStorage(JSON.stringify({
        version: 1,
        fileName: 'a.png',
        fit: 'contain',
        scrim: 0.8,
        updatedAt: '2026-10-29T00:00:00.000Z'
      }))`);
      await evaluate('window.__api.resetDocument()');
      await evaluate('window.__api.seedVariables("url(\\"data:image/png;base64,AQID\\")")');
      const before = await evaluate('window.__probe()');
      assert.match(before.canvasImageVar, /data:image\/png/, '前置条件未建立：--lx-canvas-image 没写上');
      assert.equal(before.scrimVar, '0.8', '前置条件未建立：--lx-background-scrim 没写上');
      assert.equal(before.fitVar, 'contain', '前置条件未建立：--lx-canvas-fit 没写上');

      await evaluate('window.__api.resetCalls()');
      await evaluate('window.__api.clear()');
      const after = await evaluate('window.__probe()');
      assert.equal(after.canvasImageVar, '', `清除后 --lx-canvas-image 必须复位，实际：${JSON.stringify(after.canvasImageVar)}`);
      assert.equal(after.scrimVar, '', `清除后 --lx-background-scrim 必须复位，实际：${JSON.stringify(after.scrimVar)}`);
      assert.equal(after.fitVar, '', `清除后 --lx-canvas-fit 必须复位，实际：${JSON.stringify(after.fitVar)}`);
      const cleared = after.calls.filter((call) => ['--lx-canvas-image', '--lx-background-scrim', '--lx-canvas-fit'].includes(call.name));
      assert.deepEqual(cleared.map((call) => call.name).sort(),
        ['--lx-background-scrim', '--lx-canvas-fit', '--lx-canvas-image'],
        `清除必须逐个复位三个变量（走唯一写入口），实际：${JSON.stringify(after.calls)}`);
      for (const call of cleared) {
        assert.equal(call.value, '', `复位必须写空串，${call.name} 实际写了：${JSON.stringify(call.value)}`);
      }
      assert.equal(await evaluate('window.__api.readStorage()'), null, '清除后持久化项必须删除');
      assert.equal(await evaluate('window.__api.preferenceValue()'), null, '清除后偏好必须为 null');
    });

    // 用例6：坏偏好静默回落
    await runCase('用例6 坏偏好静默回落：版本不符 / 文件名非法 ⇒ 偏好 null 且零写入', async () => {
      const dirty = [
        ['版本不符', { version: 2, fileName: 'a.png', fit: 'cover', scrim: 0.5 }],
        ['文件名非法', { version: 1, fileName: '../evil.png', fit: 'cover', scrim: 0.5 }],
        ['文件名隐藏', { version: 1, fileName: '.hidden.png', fit: 'cover', scrim: 0.5 }],
        ['非 JSON', 'not-json-at-all'],
      ];
      for (const [label, payload] of dirty) {
        await evaluate('window.__api.resetDocument()');
        const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
        await evaluate(`window.__api.writeStorage(${JSON.stringify(raw)})`);
        await evaluate('window.__api.resetCalls()');
        await evaluate('window.__api.init()');
        const probe = await evaluate('window.__probe()');
        assert.equal(await evaluate('window.__api.preferenceValue()'), null, `${label}：偏好必须为 null`);
        assert.deepEqual(probe.calls, [], `${label}：init() 不得写任何 CSS 变量，实际：${JSON.stringify(probe.calls)}`);
        assert.equal(probe.canvasImageVar, '', `${label}：--lx-canvas-image 不得被写入`);
        assert.equal(probe.scrimVar, '', `${label}：--lx-background-scrim 不得被写入`);
        assert.equal(probe.fitVar, '', `${label}：--lx-canvas-fit 不得被写入`);
        assert.equal(await evaluate('window.__api.documentVariablesApplied()'), false,
          `${label}：内部状态不得标记为「已写入」`);
      }
    });
  } catch (error) {
    console.error('宿主准备失败：', error);
    results.push({ name: 'harness', ok: false, error });
  } finally {
    clearTimeout(deadline);
  }

  const failed = results.filter((item) => !item.ok);
  console.log('');
  console.log(`用例总数 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  - ${item.name}: ${String((item.error && item.error.message) || item.error)}`);
  }
  app.exit(failed.length > 0 ? 1 : 0);
});
