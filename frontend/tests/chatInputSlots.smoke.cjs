/**
 * ChatInputArea 插槽化试点（B 档 · S5）真渲染验证
 *
 * 七个用例（4 契约 + 生产可达 + 两态互斥 + 浮层触发区归属）：
 *   1. 默认实现正常：上下文环 / 模型下拉 / 发送按钮都在；
 *   2. 替换实现可用：三个探针各自出现，且对应默认节点**不**再渲染（无双渲染）；
 *   3. 行为唯一：探针只拿到一个 `onSend`，发送 → sendMessage ×1；isSending 时 → stopGeneration ×1、sendMessage ×0；
 *   4. `provide(CHAT_INPUT_SLOTS_KEY, {})` 不炸：三个默认实现照常渲染；
 *   5. 生产调用链可达：从 `ChatView.vue` 源码文本里**提取**那条 provide 表达式并在宿主执行，
 *      用 Proxy 记录三个字段的读取 —— 删掉 ChatView 的 provide 必然让本用例变红；
 *   6. modelSelector 两态互斥：`drivenModel` 非空 ⇒ 徽标态且无下拉；为空 ⇒ 只有下拉（默认与替换实现各断言一次）；
 *   7. 浮层触发区归容器：在**容器 div**（`cursor-help`，28px 高）上派发 mouseenter ⇒ 浮层出现，
 *      mouseleave ⇒ 消失。把处理器挪进 svg（触发区缩到 18×18）必须让本用例变红。
 *
 * 运行：`cd frontend && npx electron tests/chatInputSlots.smoke.cjs`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
const output = path.resolve(frontendRoot, 'node_modules/.tmp/chat-input-slots');
const logDir = path.resolve(frontendRoot, '../.lingxi/tmp/qa-input-slot-pilot');
const chatViewPath = path.resolve(frontendRoot, 'src/views/chat/ChatView.vue');

app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => {
  console.error('输入区插槽契约验证超时');
  app.exit(1);
}, 240000);

/** 生成相对 output 目录的 import 说明符（正斜杠，vite 可解析）。 */
function specifierFor(absolutePath) {
  const relative = path.relative(output, absolutePath).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

/** 从 `ChatView.vue` 源码里提取 provide 的对象字面量表达式。提取不到即视为生产注册被移除。 */
function extractProviderExpression(source) {
  const match = /provide\(\s*CHAT_INPUT_SLOTS_KEY\s*,\s*(\{[\s\S]*?\})\s*\)/.exec(source);
  if (!match) {
    throw new Error('ChatView.vue 中未找到 `provide(CHAT_INPUT_SLOTS_KEY, {...})`：生产注册已被移除');
  }
  return match[1];
}

/** 从 ChatView.vue 的 import 语句里取出某个默认导入的真实模块绝对路径。 */
function resolveImportedModule(source, identifier) {
  const match = new RegExp("import\\s+" + identifier + "\\s+from\\s+'([^']+)'").exec(source);
  if (!match) throw new Error(`ChatView.vue 中未找到 \`import ${identifier} from '...'\``);
  return path.resolve(path.dirname(chatViewPath), match[1]);
}

/** 提取表达式里 `field: X` 的标识符，保证宿主导入与生产同源。 */
function extractFieldIdentifier(expression, field) {
  const match = new RegExp(field + '\\s*:\\s*([A-Za-z_$][\\w$]*)').exec(expression);
  if (!match) throw new Error(`ChatView 的 provide 表达式里缺 \`${field}\` 字段：${expression}`);
  return match[1];
}

const SLOT_FIELDS = ['contextUsage', 'modelSelector', 'sendButton'];

/** 生成宿主入口（一次构建，多次挂载不同场景 / 不同 props 预设）。 */
async function writeHarness() {
  const chatViewSource = await fs.readFile(chatViewPath, 'utf8');

  // 提取失败只降级生产场景，不炸掉整个进程 —— 其它 6 个用例仍要给出结论。
  let production = null;
  let productionError = null;
  try {
    const providerExpression = extractProviderExpression(chatViewSource);
    const fields = {};
    for (const field of SLOT_FIELDS) {
      const identifier = extractFieldIdentifier(providerExpression, field);
      fields[field] = { identifier, module: resolveImportedModule(chatViewSource, identifier) };
    }
    production = { providerExpression, fields };
  } catch (error) {
    productionError = String((error && error.message) || error);
  }

  const productionImports = production
    ? SLOT_FIELDS.map(field => `import ${production.fields[field].identifier} from '${specifierFor(production.fields[field].module)}';`).join('\n')
    : '/* 生产注册缺失：未导入 ChatView 的注册组件 */';

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
${SLOT_FIELDS.map(field => `  ${field}: CHAT_VIEW_PROVIDER_VALUE.${field} === ${production.fields[field].identifier}`).join(',\n')}
};`
    : `window.__prodProviderKeys = null;
window.__prodProviderIdentity = null;`;

  const productionScenarioBlock = production
    ? 'production: { provide: OBSERVED_PROVIDER }'
    : `production: { provide: undefined, error: ${JSON.stringify(productionError)} }`;

  await fs.mkdir(output, { recursive: true });

  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, h, nextTick, ref } from 'vue';
import ChatInputArea from '${specifierFor(path.resolve(frontendRoot, 'src/components/chat/ChatInputArea.vue'))}';
import { CHAT_INPUT_SLOTS_KEY } from '${specifierFor(path.resolve(frontendRoot, 'src/types/chatInputSlots.ts'))}';
import { useTheme } from '${specifierFor(path.resolve(frontendRoot, 'src/composables/useTheme.ts'))}';
${productionImports}
import '${specifierFor(path.resolve(frontendRoot, 'src/style.css'))}';

localStorage.setItem('lingxi-locale', 'zh-CN');
useTheme().setTheme('light');

/* ---- 生产注册值：逐字来自 ChatView.vue 源码里的 provide 表达式 ---- */
${productionValueBlock}

${productionIdentityBlock}

/* ---- 三个探针：证明「替换实现可用」+「行为唯一」 ---- */
window.__probeState = { sendCalls: 0 };
const ProbeContextUsage = {
  name: 'ProbeContextUsage',
  props: ['isDark', 'contextUsageText', 'contextRingDash', 'tooltipVisible'],
  setup(props) {
    return () => h('div', {
      'data-slot-probe': 'contextUsage',
      'data-probe-text': props.contextUsageText,
      'data-probe-dash': props.contextRingDash,
      'data-probe-tooltip': String(!!props.tooltipVisible)
    }, 'probe-context');
  }
};
const ProbeModelSelector = {
  name: 'ProbeModelSelector',
  props: ['isDark', 'models', 'selectedModelId', 'drivenModel', 'onUpdateModel', 'onOpenSettingsTab', 'onOpenModelEditor'],
  setup(props) {
    return () => h('div', {
      'data-slot-probe': 'modelSelector',
      'data-probe-driven': String(!!props.drivenModel),
      'data-probe-driven-text': props.drivenModel ? props.drivenModel.text : '',
      'data-probe-models': String((props.models || []).length),
      'data-probe-selected': String(props.selectedModelId ?? '')
    }, 'probe-model');
  }
};
const ProbeSendButton = {
  name: 'ProbeSendButton',
  props: ['isSending', 'armed', 'isDark', 'colors', 'onSend'],
  setup(props) {
    return () => h('button', {
      type: 'button',
      'data-slot-probe': 'sendButton',
      'data-probe-armed': String(!!props.armed),
      'data-probe-sending': String(!!props.isSending),
      'data-probe-pad': props.colors ? props.colors.padColor : '',
      onClick: () => { window.__probeState.sendCalls += 1; props.onSend(); }
    }, 'probe-send');
  }
};

const SCENARIOS = {
  // 1. 不 provide：走内置默认实现
  default: { provide: undefined },
  // 2. / 3. / 6. 三个探针同时注册
  probes: { provide: { contextUsage: ProbeContextUsage, modelSelector: ProbeModelSelector, sendButton: ProbeSendButton } },
  // 4. 空对象注册：字段全缺省 ⇒ 仍走默认实现
  empty: { provide: {} },
  // 5. 生产注册（取值来自 ChatView.vue 源码）
  ${productionScenarioBlock}
};

const MODELS = [
  { id: 'm1', name: 'GPT-Test', modelName: 'gpt-test', providerName: 'OpenAI' },
  { id: 'm2', name: 'Claude-Test', modelName: 'claude-test', providerName: 'Anthropic' }
];
const PRESETS = {
  usage: {
    isDark: false,
    models: MODELS,
    selectedModelId: 'm1',
    contextUsage: { usedTokens: 24600, maxTokens: 200000 }
  },
  driven: {
    isDark: false,
    models: MODELS,
    selectedModelId: 'm1',
    contextUsage: { usedTokens: 24600, maxTokens: 200000 },
    agents: [{ id: 'a1', name: '代码助手', modelId: 'm1' }],
    selectedAgentId: 'a1'
  },
  sending: {
    isDark: false,
    models: MODELS,
    selectedModelId: 'm1',
    contextUsage: { usedTokens: 24600, maxTokens: 200000 },
    isSending: true
  }
};

window.__inputRef = ref(null);
window.__emits = [];

window.__render = async (scenarioKey, presetKey = 'usage') => {
  const spec = SCENARIOS[scenarioKey];
  if (!spec) throw new Error('未知场景：' + scenarioKey);
  if (spec.error) throw new Error(spec.error);
  if (window.__app) { window.__app.unmount(); window.__app = null; }
  const root = document.getElementById('app');
  root.innerHTML = '';
  const host = document.createElement('div');
  root.appendChild(host);
  const record = event => (...args) => { window.__emits.push([event, ...args]); };
  window.__emits = [];
  window.__probeState.sendCalls = 0;
  window.__slotReads.length = 0;
  const inputRef = ref(null);
  window.__inputRef = inputRef;
  const slotApp = createApp({
    render: () => h(ChatInputArea, {
      ref: inputRef,
      ...PRESETS[presetKey],
      onSendMessage: record('sendMessage'),
      onStopGeneration: record('stopGeneration'),
      onUpdateModel: record('updateModel'),
      onOpenSettingsTab: record('openSettingsTab'),
      onOpenModelEditor: record('openModelEditor')
    })
  });
  if (spec.provide !== undefined) slotApp.provide(CHAT_INPUT_SLOTS_KEY, spec.provide);
  slotApp.mount(host);
  window.__app = slotApp;
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 220));
  return true;
};

window.__setInputText = async value => {
  window.__inputRef.value.setInputText(value);
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 60));
  return true;
};

/* ---- DOM 探针 ---- */
window.__slotCounts = () => ({
  defaults: {
    contextUsage: document.querySelectorAll('[data-slot="context-usage"]').length,
    modelSelector: document.querySelectorAll('[data-slot="model-selector"]').length,
    sendButton: document.querySelectorAll('[data-slot="send-button"]').length
  },
  probes: {
    contextUsage: document.querySelectorAll('[data-slot-probe="contextUsage"]').length,
    modelSelector: document.querySelectorAll('[data-slot-probe="modelSelector"]').length,
    sendButton: document.querySelectorAll('[data-slot-probe="sendButton"]').length
  }
});

/** 上下文环的 stroke-dasharray（默认实现把 contextRingDash 绑到第二个 circle 上）。 */
window.__ringDash = () => {
  const svg = document.querySelector('[data-slot="context-usage"]');
  if (!svg) return null;
  const circle = [...svg.querySelectorAll('circle')].find(node => node.hasAttribute('stroke-dasharray'));
  return circle ? circle.getAttribute('stroke-dasharray') : null;
};

/** 模型选择器区域的两个真实态：徽标 button / DropUpSelect 的 div 根。 */
window.__modelSelectorState = () => {
  const nodes = [...document.querySelectorAll('[data-slot="model-selector"]')];
  return {
    count: nodes.length,
    tags: nodes.map(node => node.tagName),
    badge: nodes.filter(node => node.tagName === 'BUTTON').length,
    dropdown: nodes.filter(node => node.tagName === 'DIV' && !!node.querySelector('button[aria-haspopup="listbox"]')).length,
    text: nodes.map(node => node.textContent.trim().slice(0, 60))
  };
};

window.__probeAttrs = marker => {
  const element = document.querySelector('[data-slot-probe="' + marker + '"]');
  if (!element) return null;
  const attrs = {};
  for (const attribute of element.attributes) {
    if (attribute.name.startsWith('data-probe')) attrs[attribute.name] = attribute.value;
  }
  return { tag: element.tagName, attrs };
};

/** 浮层触发区容器：包住 [data-slot="context-usage"] 的那层 cursor-help div（应为 28px 高）。 */
window.__contextContainer = () => {
  const anchor = document.querySelector('[data-slot="context-usage"]');
  const container = anchor && anchor.closest('div.cursor-help');
  if (!container) return { found: false };
  const rect = container.getBoundingClientRect();
  return {
    found: true,
    height: Math.round(rect.height),
    width: Math.round(rect.width),
    hasCursorHelp: /cursor-help/.test(container.className),
    hasH7: /(?:^|\\s)h-7(?:\\s|$)/.test(container.className)
  };
};

window.__hoverContainer = type => {
  const anchor = document.querySelector('[data-slot="context-usage"]');
  const container = anchor && anchor.closest('div.cursor-help');
  if (!container) throw new Error('浮层触发区容器不存在');
  container.dispatchEvent(new MouseEvent(type, { bubbles: false }));
  return true;
};

window.__hoverIcon = type => {
  const icon = document.querySelector('[data-slot="context-usage"]');
  if (!icon) throw new Error('上下文环 svg 不存在');
  icon.dispatchEvent(new MouseEvent(type, { bubbles: false }));
  return true;
};

window.__tooltip = () => {
  const element = [...document.querySelectorAll('div')].find(node => typeof node.className === 'string'
    && /\\babsolute\\b/.test(node.className)
    && /\\bbottom-full\\b/.test(node.className));
  if (!element) return { found: false };
  const style = getComputedStyle(element);
  return {
    found: true,
    text: element.textContent.trim(),
    opacity: style.opacity,
    display: style.display,
    visibility: style.visibility
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    await writeHarness();
    await buildHarness();

    window = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false }
    });
    await window.loadFile(path.join(output, 'dist/index.html'));
    const evaluate = source => window.webContents.executeJavaScript(source);
    assert.equal(await evaluate('window.ready'), true, '宿主未就绪');

    // 用例 1：默认实现正常
    await runCase('用例1 默认实现正常（不注册任何插槽）', async () => {
      await evaluate('window.__render("default", "usage")');
      const counts = await evaluate('window.__slotCounts()');
      assert.equal(counts.defaults.contextUsage, 1, '默认上下文环未渲染');
      assert.equal(counts.defaults.modelSelector, 1, '默认模型选择器未渲染');
      assert.equal(counts.defaults.sendButton, 1, '默认发送按钮未渲染');
      assert.equal(counts.probes.contextUsage + counts.probes.modelSelector + counts.probes.sendButton, 0, '未注册时不应出现探针');
      const dash = await evaluate('window.__ringDash()');
      assert.ok(typeof dash === 'string' && /^[\d.]+ [\d.]+$/.test(dash), `上下文环进度未绑定，实际 ${JSON.stringify(dash)}`);
      const selector = await evaluate('window.__modelSelectorState()');
      assert.equal(selector.dropdown, 1, `无驱动时应显示 DropUpSelect，实际 ${JSON.stringify(selector)}`);
      assert.equal(selector.badge, 0, '无驱动时不应出现驱动徽标');
    });

    // 用例 2：替换实现可用，且默认节点消失（无双渲染）
    await runCase('用例2 三个探针各自出现且默认节点消失', async () => {
      await evaluate('window.__render("probes", "usage")');
      const counts = await evaluate('window.__slotCounts()');
      assert.equal(counts.probes.contextUsage, 1, `contextUsage 探针应恰好 1 个，实际 ${counts.probes.contextUsage}`);
      assert.equal(counts.probes.modelSelector, 1, `modelSelector 探针应恰好 1 个，实际 ${counts.probes.modelSelector}`);
      assert.equal(counts.probes.sendButton, 1, `sendButton 探针应恰好 1 个，实际 ${counts.probes.sendButton}`);
      assert.equal(counts.defaults.contextUsage, 0, `注册探针后默认上下文环仍在（双渲染）：${counts.defaults.contextUsage}`);
      assert.equal(counts.defaults.modelSelector, 0, `注册探针后默认模型选择器仍在（双渲染）：${counts.defaults.modelSelector}`);
      assert.equal(counts.defaults.sendButton, 0, `注册探针后默认发送按钮仍在（双渲染）：${counts.defaults.sendButton}`);
      const contextProbe = await evaluate('window.__probeAttrs("contextUsage")');
      assert.match(contextProbe.attrs['data-probe-text'], /24\.6K/, `探针未拿到格式化用量文本：${JSON.stringify(contextProbe)}`);
      assert.match(contextProbe.attrs['data-probe-dash'], /^[\d.]+ [\d.]+$/, '探针未拿到环形进度值');
      const modelProbe = await evaluate('window.__probeAttrs("modelSelector")');
      assert.equal(modelProbe.attrs['data-probe-models'], '2', `探针未拿到模型列表：${JSON.stringify(modelProbe)}`);
      assert.equal(modelProbe.attrs['data-probe-selected'], 'm1', '探针未拿到当前选中模型');
      assert.equal(modelProbe.attrs['data-probe-driven'], 'false', '未驱动时 drivenModel 应为 null');
      const sendProbe = await evaluate('window.__probeAttrs("sendButton")');
      assert.equal(sendProbe.attrs['data-probe-sending'], 'false', '未发送时 isSending 应为 false');
      assert.ok(sendProbe.attrs['data-probe-pad'] && sendProbe.attrs['data-probe-pad'].length > 0, '探针未拿到配色');
    });

    // 用例 3：行为唯一（发送 / 停止二态共用一个 onSend）
    await runCase('用例3 行为唯一：onSend 发送 1 次、停止 1 次', async () => {
      await evaluate('window.__render("probes", "usage")');
      await evaluate('window.__setInputText("x")');
      await evaluate('document.querySelector(\'[data-slot-probe="sendButton"]\').click()');
      await wait(200);
      let state = await evaluate('({ emits: window.__emits, calls: window.__probeState.sendCalls })');
      assert.equal(state.calls, 1, `探针按钮应只触发 1 次 onSend，实际 ${state.calls}`);
      const sends = state.emits.filter(item => item[0] === 'sendMessage');
      assert.equal(sends.length, 1, `sendMessage 应恰好 emit 1 次，实际 ${sends.length}：${JSON.stringify(state.emits)}`);
      assert.equal(sends[0][1], 'x', `sendMessage 载荷应为输入文本 x，实际 ${JSON.stringify(sends[0][1])}`);
      assert.equal(state.emits.filter(item => item[0] === 'stopGeneration').length, 0,
        `发送时不应触发 stopGeneration：${JSON.stringify(state.emits)}`);

      await evaluate('window.__render("probes", "sending")');
      await evaluate('window.__setInputText("x")');
      await evaluate('document.querySelector(\'[data-slot-probe="sendButton"]\').click()');
      await wait(200);
      state = await evaluate('({ emits: window.__emits, calls: window.__probeState.sendCalls })');
      assert.equal(state.calls, 1, `isSending 时探针仍应只触发 1 次 onSend，实际 ${state.calls}`);
      assert.equal(state.emits.filter(item => item[0] === 'stopGeneration').length, 1,
        `isSending 时 stopGeneration 应 emit 1 次：${JSON.stringify(state.emits)}`);
      assert.equal(state.emits.filter(item => item[0] === 'sendMessage').length, 0,
        `isSending 时不得 emit sendMessage：${JSON.stringify(state.emits)}`);
    });

    // 用例 4：空注册不炸
    await runCase('用例4 provide({}) 仍渲染三个默认实现', async () => {
      await evaluate('window.__render("empty", "usage")');
      const counts = await evaluate('window.__slotCounts()');
      assert.equal(counts.defaults.contextUsage, 1, '空注册后默认上下文环消失');
      assert.equal(counts.defaults.modelSelector, 1, '空注册后默认模型选择器消失');
      assert.equal(counts.defaults.sendButton, 1, '空注册后默认发送按钮消失');
      assert.equal(counts.probes.contextUsage + counts.probes.modelSelector + counts.probes.sendButton, 0, '空注册不应出现探针');
      const selector = await evaluate('window.__modelSelectorState()');
      assert.equal(selector.dropdown, 1, `空注册后应仍显示 DropUpSelect，实际 ${JSON.stringify(selector)}`);
    });

    // 用例 5：生产调用链可达
    await runCase('用例5 生产调用链可达（ChatView 的 provide 真的被 ChatInputArea 走到）', async () => {
      const keys = await evaluate('window.__prodProviderKeys');
      assert.deepEqual(keys, ['contextUsage', 'modelSelector', 'sendButton'],
        `ChatView 的 provide 字段应恰为 contextUsage/modelSelector/sendButton，实际 ${JSON.stringify(keys)}`);
      const identity = await evaluate('window.__prodProviderIdentity');
      assert.deepEqual(identity, { contextUsage: true, modelSelector: true, sendButton: true },
        `ChatView 注册的必须是真实默认实现组件：${JSON.stringify(identity)}`);

      await evaluate('window.__render("production", "usage")');
      const counts = await evaluate('window.__slotCounts()');
      const reads = await evaluate('window.__slotReads');
      assert.equal(counts.defaults.contextUsage, 1, '生产注册下默认上下文环未渲染');
      assert.equal(counts.defaults.modelSelector, 1, '生产注册下默认模型选择器未渲染');
      assert.equal(counts.defaults.sendButton, 1, '生产注册下默认发送按钮未渲染');
      assert.equal(counts.probes.contextUsage + counts.probes.modelSelector + counts.probes.sendButton, 0, '生产注册值来自默认实现，不应出现探针');
      for (const field of ['contextUsage', 'modelSelector', 'sendButton']) {
        assert.ok(reads.includes(field),
          `ChatInputArea 未读取注册表的 ${field} 字段 ⇒ 注册分支不可达，reads=${JSON.stringify(reads)}`);
      }
    });

    // 用例 6：modelSelector 两态互斥（默认 + 替换实现各断言一次）
    await runCase('用例6 modelSelector 两态互斥（驱动徽标 / 权威下拉）', async () => {
      // 6.1 默认实现：drivenModel 非空 ⇒ 徽标态，且没有 DropUpSelect
      await evaluate('window.__render("default", "driven")');
      let selector = await evaluate('window.__modelSelectorState()');
      assert.equal(selector.count, 1, `驱动态应只有 1 个模型选择器节点，实际 ${JSON.stringify(selector)}`);
      assert.equal(selector.badge, 1, `驱动态应显示徽标，实际 ${JSON.stringify(selector)}`);
      assert.equal(selector.dropdown, 0, `驱动态不得同时显示下拉，实际 ${JSON.stringify(selector)}`);

      // 6.2 默认实现：drivenModel 为 null ⇒ 只有 DropUpSelect
      await evaluate('window.__render("default", "usage")');
      selector = await evaluate('window.__modelSelectorState()');
      assert.equal(selector.count, 1, `权威态应只有 1 个模型选择器节点，实际 ${JSON.stringify(selector)}`);
      assert.equal(selector.dropdown, 1, `权威态应显示 DropUpSelect，实际 ${JSON.stringify(selector)}`);
      assert.equal(selector.badge, 0, `权威态不得显示徽标，实际 ${JSON.stringify(selector)}`);

      // 6.3 替换实现：驱动态只出现探针（替代默认徽标，不得双渲染）
      await evaluate('window.__render("probes", "driven")');
      let counts = await evaluate('window.__slotCounts()');
      let probe = await evaluate('window.__probeAttrs("modelSelector")');
      assert.equal(counts.probes.modelSelector, 1, `驱动态探针应恰好 1 个，实际 ${counts.probes.modelSelector}`);
      assert.equal(counts.defaults.modelSelector, 0, `驱动态替换实现下默认选择器仍在（双渲染）：${counts.defaults.modelSelector}`);
      assert.equal(probe.attrs['data-probe-driven'], 'true', `驱动态探针应拿到 drivenModel，实际 ${JSON.stringify(probe)}`);
      assert.ok(probe.attrs['data-probe-driven-text'].length > 0, '驱动态探针应拿到驱动文案');

      // 6.4 替换实现：权威态只出现探针（替代默认下拉，不得双渲染）
      await evaluate('window.__render("probes", "usage")');
      counts = await evaluate('window.__slotCounts()');
      probe = await evaluate('window.__probeAttrs("modelSelector")');
      assert.equal(counts.probes.modelSelector, 1, `权威态探针应恰好 1 个，实际 ${counts.probes.modelSelector}`);
      assert.equal(counts.defaults.modelSelector, 0, `权威态替换实现下默认选择器仍在（双渲染）：${counts.defaults.modelSelector}`);
      assert.equal(probe.attrs['data-probe-driven'], 'false', `权威态探针不应拿到 drivenModel，实际 ${JSON.stringify(probe)}`);
    });

    // 用例 7：浮层触发区归容器（锁主理人的修复）
    await runCase('用例7 浮层触发区是容器 div（28px），不是 18×18 图标', async () => {
      await evaluate('window.__render("default", "usage")');
      const container = await evaluate('window.__contextContainer()');
      assert.equal(container.found, true, '未找到包住上下文环的 cursor-help 容器');
      assert.equal(container.hasCursorHelp, true, '容器缺少 cursor-help（触发区语义变了）');
      assert.equal(container.hasH7, true, '容器缺少 h-7（28px）高度类');
      assert.ok(Math.abs(container.height - 28) <= 1,
        `触发区容器高度应为 28px，实际 ${container.height}（缩到图标高度即行为漂移）`);

      // 只允许在容器上派发：图标（svg）上的悬停不是触发路径
      await evaluate('window.__hoverContainer("mouseenter")');
      await wait(280);
      let tooltip = await evaluate('window.__tooltip()');
      assert.equal(tooltip.found, true, '在容器 div 上派发 mouseenter 后浮层未出现（处理器被挪进 svg？）');
      assert.ok(tooltip.text.includes('24.6K') && /200(?:\.0)?K/.test(tooltip.text),
        `浮层文案应包含上下文用量，实际 ${JSON.stringify(tooltip.text)}`);
      assert.ok(Number(tooltip.opacity) > 0.9, `浮层未完成入场（opacity=${tooltip.opacity}）`);

      await evaluate('window.__hoverContainer("mouseleave")');
      await wait(320);
      tooltip = await evaluate('window.__tooltip()');
      assert.equal(tooltip.found, false, `容器 mouseleave 后浮层未消失：${JSON.stringify(tooltip)}`);
    });

    await fs.writeFile(path.join(logDir, 'smoke-result.json'),
      JSON.stringify(results.map(item => ({
        name: item.name,
        ok: item.ok,
        error: item.ok ? null : String((item.error && item.error.message) || item.error)
      })), null, 2));

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
