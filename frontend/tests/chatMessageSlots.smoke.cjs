/**
 * ChatMessageItem 插槽化试点（B 档 · S5）真渲染验证
 *
 * 覆盖两件事：
 *   1. 契约行为：默认实现 / 注册替换 / 行为唯一（反双触发）/ 空注册不炸；
 *   2. 生产可达：从 `ChatView.vue` 源码文本里**提取**那条
 *      `provide(CHAT_MESSAGE_SLOTS_KEY, {...})` 表达式并在宿主里执行，
 *      因此「把 ChatView 里那行 provide 删掉」必然让本用例变红；
 *      同时在宿主侧用 Proxy 记录 `body` / `actions` 字段的读取，
 *      证明 Item 真的走的是「inject 到注册表」这条分支（而不是自造的 provider）。
 *
 * 运行：`cd frontend && npx electron tests/chatMessageSlots.smoke.cjs`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
const output = path.resolve(frontendRoot, 'node_modules/.tmp/chat-message-slots');
const logDir = path.resolve(frontendRoot, '../.lingxi/tmp/qa-slot-pilot');

const chatViewPath = path.resolve(frontendRoot, 'src/views/chat/ChatView.vue');

app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => {
  console.error('插槽契约验证超时');
  app.exit(1);
}, 180000);

/** 生成相对 output 目录的 import 说明符（正斜杠，vite 可解析）。 */
function specifierFor(absolutePath) {
  const relative = path.relative(output, absolutePath).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

/**
 * 从 `ChatView.vue` 源码里提取 provide 的对象字面量表达式。
 * 提取不到直接抛错 —— 这就是「删掉 provide 必红」的落点。
 */
function extractChatViewProviderExpression(source) {
  const match = /provide\(\s*CHAT_MESSAGE_SLOTS_KEY\s*,\s*(\{[\s\S]*?\})\s*\)/.exec(source);
  if (!match) {
    throw new Error('ChatView.vue 中未找到 `provide(CHAT_MESSAGE_SLOTS_KEY, {...})`：生产注册已被移除');
  }
  return match[1];
}

/** 从 ChatView.vue 的 import 语句里取出某个默认导入的真实模块绝对路径。 */
function resolveImportedModule(source, identifier) {
  const match = new RegExp("import\\s+" + identifier + "\\s+from\\s+'([^']+)'").exec(source);
  if (!match) throw new Error(`ChatView.vue 中未找到 \`import ${identifier} from '...'\``);
  return path.resolve(path.dirname(chatViewPath), match[1]);
}

/** 提取表达式里 `body: X` / `actions: Y` 的标识符，保证宿主导入与生产同源。 */
function extractFieldIdentifier(expression, field) {
  const match = new RegExp(field + '\\s*:\\s*([A-Za-z_$][\\w$]*)').exec(expression);
  if (!match) throw new Error(`ChatView 的 provide 表达式里缺 \`${field}\` 字段：${expression}`);
  return match[1];
}

/** 生成宿主 App 入口（一次构建，多次挂载不同场景）。 */
async function writeHarness() {
  const chatViewSource = await fs.readFile(chatViewPath, 'utf8');

  // 提取失败不能被静默吞掉：它是「删掉 ChatView 里那行 provide ⇒ 用例5 必红」的落点。
  // 其它用例仍要照常跑，所以这里只降级生产场景，不炸掉整个进程。
  let production = null;
  let productionError = null;
  try {
    const providerExpression = extractChatViewProviderExpression(chatViewSource);
    const bodyIdentifier = extractFieldIdentifier(providerExpression, 'body');
    const actionsIdentifier = extractFieldIdentifier(providerExpression, 'actions');
    production = {
      providerExpression,
      bodyIdentifier,
      actionsIdentifier,
      bodyModule: resolveImportedModule(chatViewSource, bodyIdentifier),
      actionsModule: resolveImportedModule(chatViewSource, actionsIdentifier)
    };
  } catch (error) {
    productionError = String((error && error.message) || error);
  }

  const productionImports = production
    ? `import ${production.bodyIdentifier} from '${specifierFor(production.bodyModule)}';\n`
      + `import ${production.actionsIdentifier} from '${specifierFor(production.actionsModule)}';`
    : '/* 生产注册缺失：未导入 ChatView 的注册组件 */';

  // 生产注册值逐字来自 ChatView.vue 的 provide 表达式；Proxy 只记录字段读取，不改值。
  const productionValueBlock = production
    ? `const CHAT_VIEW_PROVIDER_VALUE = ${production.providerExpression};
window.__slotReads = [];
const OBSERVED_PROVIDER = new Proxy(CHAT_VIEW_PROVIDER_VALUE, {
  get(target, key) {
    if (typeof key === 'string') window.__slotReads.push(key);
    return target[key];
  }
});`
    : `const CHAT_VIEW_PROVIDER_VALUE = null;
const OBSERVED_PROVIDER = null;
window.__slotReads = [];`;

  const productionIdentityBlock = production
    ? `window.__prodProviderKeys = Object.keys(CHAT_VIEW_PROVIDER_VALUE).sort();
window.__prodProviderIdentity = {
  body: CHAT_VIEW_PROVIDER_VALUE.body === ${production.bodyIdentifier},
  actions: CHAT_VIEW_PROVIDER_VALUE.actions === ${production.actionsIdentifier}
};`
    : `window.__prodProviderKeys = null;
window.__prodProviderIdentity = null;`;

  const productionScenarioBlock = production
    ? 'production: { provide: OBSERVED_PROVIDER }'
    : `production: { provide: undefined, error: ${JSON.stringify(productionError)} }`;

  await fs.mkdir(output, { recursive: true });

  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, h, nextTick, watch } from 'vue';
import ChatMessageList from '${specifierFor(path.resolve(frontendRoot, 'src/components/chat/ChatMessageList.vue'))}';
import { CHAT_MESSAGE_SLOTS_KEY } from '${specifierFor(path.resolve(frontendRoot, 'src/types/chatMessageSlots.ts'))}';
import { useTheme } from '${specifierFor(path.resolve(frontendRoot, 'src/composables/useTheme.ts'))}';
${productionImports}
import '${specifierFor(path.resolve(frontendRoot, 'src/style.css'))}';

useTheme().setTheme('light');

/* ---- 生产注册值：逐字来自 ChatView.vue 源码里的 provide 表达式 ---- */
${productionValueBlock}

/* ---- 探针组件：证明「替换实现可用」与「行为唯一」 ---- */
window.__probeState = { copyCalls: 0, copiedSeen: [] };
const ActionsProbe = {
  name: 'ActionsProbe',
  props: ['copied', 'copyContent'],
  setup(props) {
    watch(() => props.copied, value => { window.__probeState.copiedSeen.push(!!value); });
    return () => h('div', { 'data-slot-probe': 'actions' }, [
      h('button', {
        type: 'button',
        'data-slot-probe-copy': '1',
        onClick: () => { window.__probeState.copyCalls += 1; props.copyContent(); }
      }, 'probe-copy'),
      h('span', { 'data-slot-probe-copied': String(!!props.copied) }, 'probe-copied')
    ]);
  }
};

const BodyProbe = {
  name: 'BodyProbe',
  props: ['message'],
  setup(props) {
    return () => h('div', { 'data-slot-probe': 'body' },
      'body-probe:' + (props.message && props.message.content ? 'got-message' : 'missing-message'));
  }
};

const SCENARIOS = {
  // 1. 不 provide：应当走内置默认实现
  default: { provide: undefined },
  // 2. / 3. 注册探针
  probe: { provide: { actions: ActionsProbe } },
  // 4. 空对象注册：字段全缺省 ⇒ 仍走默认实现
  empty: { provide: {} },
  // 6. 正文替换探针
  bodyProbe: { provide: { body: BodyProbe } },
  // 5. 生产注册（取值来自 ChatView.vue 源码）
  ${productionScenarioBlock}
};

${productionIdentityBlock}

window.__render = async (scenario, options = {}) => {
  const spec = SCENARIOS[scenario];
  if (!spec) throw new Error('未知场景：' + scenario);
  if (spec.error) throw new Error(spec.error);
  if (window.__app) { window.__app.unmount(); window.__app = null; }
  const root = document.getElementById('app');
  root.innerHTML = '';
  const host = document.createElement('div');
  root.appendChild(host);
  const messages = [{
    id: 'slot-case-' + scenario,
    role: 'assistant',
    content: options.content || '插槽试点正文内容',
    timestamp: Date.UTC(2024, 0, 2, 9, 5)
  }];
  window.__messages = messages;
  window.__slotReads.length = 0;
  const slotApp = createApp({ render: () => h(ChatMessageList, { messages, isDark: false }) });
  if (spec.provide !== undefined) slotApp.provide(CHAT_MESSAGE_SLOTS_KEY, spec.provide);
  slotApp.mount(host);
  window.__app = slotApp;
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 160));
  return true;
};

/* ---- DOM 探针：正文 / 操作区 ---- */
function isProbeNode(node) {
  return !!(node && node.closest && node.closest('[data-slot-probe]'));
}

window.__bodyInfo = () => {
  const element = [...document.querySelectorAll('div')].find(node =>
    typeof node.className === 'string'
    && /\\bw-full\\b/.test(node.className)
    && /\\btext-sm\\b/.test(node.className)
    && /\\bfont-normal\\b/.test(node.className)
    && /\\bmy-1\\b/.test(node.className));
  return {
    found: !!element,
    text: element ? element.textContent.trim() : null,
    childCount: element ? element.querySelectorAll('*').length : 0,
    probeCount: element ? element.querySelectorAll('[data-slot-probe]').length : 0
  };
};

window.__actionsInfo = () => {
  const element = [...document.querySelectorAll('div')].find(node => typeof node.className === 'string'
    && /\\bflex-wrap\\b/.test(node.className)
    && /\\bitems-center\\b/.test(node.className)
    && /\\bgap-4\\b/.test(node.className)
    && /\\bpt-1\\b/.test(node.className));
  if (!element) return { found: false };
  const defaultButtons = [...element.querySelectorAll('button')].filter(node => !isProbeNode(node));
  return {
    found: true,
    probeCount: element.querySelectorAll('[data-slot-probe]').length,
    probeText: element.querySelector('[data-slot-probe]') ? element.querySelector('[data-slot-probe]').textContent.trim() : null,
    defaultButtons: defaultButtons.length,
    defaultTitledButtons: defaultButtons.filter(node => node.hasAttribute('title')).length,
    quoteButtons: element.querySelectorAll('[data-quote-action="1"]').length,
    defaultSpans: [...element.querySelectorAll('span')].filter(node => !isProbeNode(node)).map(node => node.textContent.trim()).filter(Boolean)
  };
};

window.ready = true;`);

  await fs.writeFile(path.join(output, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
    + '<div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  return { production, productionError };
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
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true }
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
      console.log('       ' + String(error && error.message || error).split('\n').join('\n       '));
    }
  };

  try {
    await fs.mkdir(logDir, { recursive: true });
    const extracted = await writeHarness();
    await buildHarness();

    window = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false }
    });
    await window.loadFile(path.join(output, 'dist/index.html'));
    const evaluate = source => window.webContents.executeJavaScript(source);
    assert.equal(await evaluate('window.ready'), true, '宿主未就绪');

    // 用例 1：默认实现正常（不 provide 任何 slots）
    await runCase('用例1 默认实现正常（无任何注册）', async () => {
      await evaluate('window.__render("default")');
      const body = await evaluate('window.__bodyInfo()');
      const actions = await evaluate('window.__actionsInfo()');
      assert.equal(body.found, true, '正文容器不存在');
      assert.match(body.text, /插槽试点正文内容/, `正文未渲染，实际：${JSON.stringify(body.text)}`);
      assert.ok(body.childCount > 0, '正文没有任何渲染子节点');
      assert.equal(actions.found, true, '默认操作区容器不存在');
      assert.equal(actions.probeCount, 0, '未注册时不应出现探针');
      assert.equal(actions.defaultButtons, 1, `默认复制按钮应恰好 1 个，实际 ${actions.defaultButtons}`);
      assert.equal(actions.defaultTitledButtons, 1, '默认复制按钮缺少 title');
      // 兜底实现不得带替换实现的新增按钮（否则「默认」被污染）
      assert.equal(actions.quoteButtons, 0, `兜底实现不应出现引用按钮，实际 ${actions.quoteButtons}`);
      assert.ok(actions.defaultSpans.some(text => /\d{1,2}:\d{2}/.test(text)),
        `默认时间戳缺失，实际 spans=${JSON.stringify(actions.defaultSpans)}`);
    });

    // 用例 2：替换实现可用（且默认工具条节点消失 = 单层兜底无双渲染）
    await runCase('用例2 替换实现可用且默认工具条不双渲染', async () => {
      await evaluate('window.__render("probe")');
      const actions = await evaluate('window.__actionsInfo()');
      const body = await evaluate('window.__bodyInfo()');
      assert.equal(actions.found, true, '操作区容器不存在');
      assert.equal(actions.probeCount, 1, `探针应恰好 1 个，实际 ${actions.probeCount}`);
      assert.ok(actions.probeText && actions.probeText.length > 0, '探针未渲染出内容');
      assert.equal(actions.defaultButtons, 0,
        `注册探针后默认工具条仍被渲染（双渲染）：defaultButtons=${actions.defaultButtons}`);
      assert.equal(actions.defaultSpans.length, 0,
        `注册探针后默认工具条的时间戳仍在：${JSON.stringify(actions.defaultSpans)}`);
      assert.match(body.text, /插槽试点正文内容/, '正文不应受 actions 替换影响');
    });

    // 用例 6：正文替换实现可用（typed slot props 真的把 message 送到消费者；默认正文不双渲染）
    await runCase('用例6 正文替换实现可用且默认正文不双渲染', async () => {
      await evaluate('window.__render("bodyProbe")');
      const body = await evaluate('window.__bodyInfo()');
      const actions = await evaluate('window.__actionsInfo()');
      assert.equal(body.found, true, '正文容器不存在');
      assert.equal(body.probeCount, 1, `正文探针应恰好 1 个，实际 ${body.probeCount}`);
      assert.match(body.text, /body-probe:got-message/,
        `正文探针未拿到 typed slot props（message），实际：${JSON.stringify(body.text)}`);
      assert.doesNotMatch(body.text, /插槽试点正文内容/, '注册正文探针后默认 Markdown 正文仍被渲染（双渲染）');
      assert.equal(actions.probeCount, 0, '替换 body 不应影响 actions');
      assert.equal(actions.defaultButtons, 1,
        `替换 body 后默认复制按钮应恰好 1 个，实际 ${actions.defaultButtons}`);
    });

    // 用例 3：行为唯一（反双触发）—— 探针调 props.copyContent() 只发生一次
    await runCase('用例3 行为唯一：copyContent 只执行一次', async () => {
      await evaluate(`(() => {
        window.__writes = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async text => { window.__writes.push(text); } }
        });
        window.__probeState.copyCalls = 0;
        window.__probeState.copiedSeen = [];
        return true;
      })()`);
      await evaluate('window.__render("probe")');
      await evaluate('document.querySelector("[data-slot-probe-copy]").click()');
      await new Promise(resolve => setTimeout(resolve, 220));
      const state = await evaluate(`({
        writes: window.__writes,
        copyCalls: window.__probeState.copyCalls,
        copiedSeen: window.__probeState.copiedSeen,
        copiedAttr: document.querySelector('[data-slot-probe-copied]').getAttribute('data-slot-probe-copied')
      })`);
      assert.equal(state.copyCalls, 1, `探针按钮应只触发 1 次 copyContent，实际 ${state.copyCalls}`);
      assert.equal(state.writes.length, 1,
        `剪贴板写入应恰好 1 次（双触发会写 2 次），实际 ${state.writes.length}`);
      assert.equal(state.writes[0], '插槽试点正文内容', `复制内容应为消息正文，实际 ${JSON.stringify(state.writes[0])}`);
      assert.deepEqual(state.copiedSeen, [true],
        `copied 应只翻转一次 false→true，实际 ${JSON.stringify(state.copiedSeen)}`);
      assert.equal(state.copiedAttr, 'true', `探针拿到的 copied 应为 true，实际 ${state.copiedAttr}`);
    });

    // 用例 4：空注册不炸（provide(CHAT_MESSAGE_SLOTS_KEY, {})）
    await runCase('用例4 空对象注册仍渲染默认实现', async () => {
      await evaluate('window.__render("empty")');
      const body = await evaluate('window.__bodyInfo()');
      const actions = await evaluate('window.__actionsInfo()');
      assert.equal(body.found, true, '空注册后正文容器消失');
      assert.match(body.text, /插槽试点正文内容/, `空注册后正文未渲染：${JSON.stringify(body.text)}`);
      assert.equal(actions.found, true, '空注册后操作区容器消失');
      assert.equal(actions.probeCount, 0, '空注册不应出现探针');
      assert.equal(actions.defaultButtons, 1, `空注册后默认复制按钮应恰好 1 个，实际 ${actions.defaultButtons}`);
      assert.ok(actions.defaultSpans.some(text => /\d{1,2}:\d{2}/.test(text)),
        `空注册后时间戳缺失，实际 spans=${JSON.stringify(actions.defaultSpans)}`);
    });

    // 用例 5：生产调用链可达（provide 值逐字来自 ChatView.vue 源码）
    await runCase('用例5 生产调用链可达（ChatView 的 provide 真的被 Item 走到）', async () => {
      // 5.1 注册值必须逐字来自 ChatView.vue（提取失败 / 字段被改都红）
      const providerKeys = await evaluate('window.__prodProviderKeys');
      assert.deepEqual(providerKeys, ['actions', 'body'],
        `ChatView 的 provide 字段应恰为 body/actions，实际 ${JSON.stringify(providerKeys)}`);
      const providerIdentity = await evaluate('window.__prodProviderIdentity');
      assert.deepEqual(providerIdentity, { body: true, actions: true },
        `ChatView 注册的组件必须与它 import 的模块同一（注册链可达）：${JSON.stringify(providerIdentity)}`);
      // 5.2 再用这份生产注册值挂真实 ChatMessageList → ChatMessageItem
      await evaluate('window.__render("production")');
      const actions = await evaluate('window.__actionsInfo()');
      const body = await evaluate('window.__bodyInfo()');
      const reads = await evaluate('window.__slotReads');
      assert.equal(body.found, true, '生产注册下正文容器不存在');
      assert.match(body.text, /插槽试点正文内容/, '生产注册下正文未渲染');
      assert.equal(actions.found, true, '生产注册下操作区容器不存在');
      assert.equal(actions.probeCount, 0, '生产注册值来自默认实现，不应出现探针');
      assert.equal(actions.defaultButtons, 1, '生产操作栏只保留一个复制按钮');
      assert.equal(actions.defaultTitledButtons, 1, '复制按钮保留提示');
      assert.equal(actions.quoteButtons, 0, '生产操作栏不提供复制为引用');
      assert.ok(actions.defaultSpans.some(text => /\d{1,2}:\d{2}/.test(text)),
        `原有时间戳必须保留（复用默认操作栏），实际 spans=${JSON.stringify(actions.defaultSpans)}`);
      assert.ok(reads.includes('body'),
        `Item 未读取注册表的 body 字段 ⇒ 注册分支不可达，reads=${JSON.stringify(reads)}`);
      assert.ok(reads.includes('actions'),
        `Item 未读取注册表的 actions 字段 ⇒ 注册分支不可达，reads=${JSON.stringify(reads)}`);
      const executed = await evaluate('window.__prodProviderKeys');
      assert.deepEqual(executed, ['actions', 'body'],
        `执行的 provide 表达式字段异常：${JSON.stringify(executed)}`);
    });

    await runCase('用例7 生产复制保留完整 Markdown 原文，且只写入一次', async () => {
      const markdown = '# 标题\n\n**强调**与 [链接](https://example.com)\n\n> 原有引用\n\n```ts\nconst answer = 42;\n```\n';
      await evaluate(`(() => {
        window.__writes = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async text => { window.__writes.push(text); } }
        });
        return window.__render("production", { content: ${JSON.stringify(markdown)} });
      })()`);
      const state = await evaluate(`(() => {
        const element = [...document.querySelectorAll('div')].find(node => typeof node.className === 'string'
          && /\\bflex-wrap\\b/.test(node.className) && /\\bgap-4\\b/.test(node.className) && /\\bpt-1\\b/.test(node.className));
        const buttons = [...element.querySelectorAll('button')];
        buttons[0].click();
        return { count: buttons.length };
      })()`);
      assert.equal(state.count, 1, '生产操作栏只提供原文复制');
      await new Promise(resolve => setTimeout(resolve, 220));
      assert.deepEqual(await evaluate('window.__writes'), [markdown], 'Markdown 标记、空行和代码块均原样复制');
      assert.match(await evaluate(`(() => {
        const element = [...document.querySelectorAll('div')].find(node => typeof node.className === 'string'
          && /\\bflex-wrap\\b/.test(node.className) && /\\bgap-4\\b/.test(node.className) && /\\bpt-1\\b/.test(node.className));
        return element.querySelector('button').title;
      })()`), /已复制|Copied/, '复制成功后显示反馈');
    });

    await fs.writeFile(path.join(logDir, 'smoke-result.json'),
      JSON.stringify(results.map(item => ({ name: item.name, ok: item.ok, error: item.ok ? null : String(item.error && item.error.message || item.error) })), null, 2));

    const failed = results.filter(item => !item.ok);
    console.log('');
    console.log(`汇总：${results.length} 个用例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    clearTimeout(deadline);
    if (window) window.destroy();
    app.exit(failed.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    if (window) window.destroy();
    app.exit(1);
  }
});
