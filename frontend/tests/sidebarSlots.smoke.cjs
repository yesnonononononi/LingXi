/**
 * Sidebar 插槽化试点（B 档 · S5）真渲染验证
 *
 * 八个用例，重点钉住三件最容易被"优化"掉的事：
 *   1. **isDefaultTree 身份判断的两条路径**（用例 2 / 用例 3）：注册「默认实现本身」必须与不注册
 *      逐字等价（走 24 项内部 props）；注册第三方组件必须只拿到对外 7 项契约。身份判断一旦失效，
 *      注册默认实现会静默退化成 7 项、行为漂移且不报错 —— 那是最贵的 bug，所以两边都要正面钉。
 *   2. **7 项契约边界**（用例 3 的键集合断言）：替换实现拿不到 groups 之外的任何内部状态，
 *      哪怕只多塞一个 `branchedMenuItems` 也算契约变宽。
 *   3. **死事件不进契约**（用例 6）：`onOpenModels` / `onToggleTheme` 是 Sidebar 声明但全文 0 处
 *      emit 的死事件（D-1），不得出现在 `SidebarFooterSlotProps` 里 —— 用类型源文件文本 + 运行时
 *      探针键集合双重断言。
 *
 * 运行：`cd frontend && npx electron tests/sidebarSlots.smoke.cjs`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
const output = path.resolve(frontendRoot, 'node_modules/.tmp/sidebar-slots');
const logDir = path.resolve(frontendRoot, '../.lingxi/tmp/qa-sidebar-slot-pilot');
const chatViewPath = path.resolve(frontendRoot, 'src/views/chat/ChatView.vue');
const sidebarPath = path.resolve(frontendRoot, 'src/components/chat/Sidebar.vue');
const sidebarTypesPath = path.resolve(frontendRoot, 'src/types/sidebarSlots.ts');

app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => {
  console.error('Sidebar 插槽契约验证超时');
  app.exit(1);
}, 240000);

/** 生成相对 output 目录的 import 说明符（正斜杠，vite 可解析）。 */
function specifierFor(absolutePath) {
  const relative = path.relative(output, absolutePath).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

/** 从 `ChatView.vue` 源码里提取 provide 的对象字面量表达式。提取不到即视为生产注册被移除。 */
function extractProviderExpression(source) {
  const match = /provide\(\s*SIDEBAR_SLOTS_KEY\s*,\s*(\{[\s\S]*?\})\s*\)/.exec(source);
  if (!match) {
    throw new Error('ChatView.vue 中未找到 `provide(SIDEBAR_SLOTS_KEY, {...})`：生产注册已被移除');
  }
  return match[1];
}

/**
 * 把 provide 表达式里的字段标识符解析成"可导入的真实实现名 + 模块路径"。
 *
 * <p>`workspaceTree: defaultWorkspaceTree` 里的 `defaultWorkspaceTree` 是 ChatView 里的本地别名
 * （`const defaultWorkspaceTree = SidebarWorkspaceTree as unknown as Component<...>`），
 * 所以这里既支持 `import X from '...'`，也支持一跳 `const X = Y`（类型断言在别名里，不能被搬进 .js 宿主）。
 * 解析不出来 ⇒ 生产链路的"组件身份"已经不可复现，用例 8 必须红。</p>
 */
function resolveIdentifier(source, identifier, depth = 0) {
  if (depth > 3) throw new Error(`无法解析标识符 ${identifier}：别名链过深`);
  const importMatch = new RegExp("import\\s+" + identifier + "\\s+from\\s+'([^']+)'").exec(source);
  if (importMatch) {
    return { identifier, module: path.resolve(path.dirname(chatViewPath), importMatch[1]) };
  }
  const aliasMatch = new RegExp('const\\s+' + identifier + '\\s*=\\s*([A-Za-z_$][\\w$]*)').exec(source);
  if (aliasMatch) return resolveIdentifier(source, aliasMatch[1], depth + 1);
  throw new Error(`ChatView.vue 中无法解析 \`${identifier}\`（既不是导入名，也不是一跳别名）`);
}

/** 提取表达式里 `field: X` 的标识符。 */
function extractFieldIdentifier(expression, field) {
  const match = new RegExp(field + '\\s*:\\s*([A-Za-z_$][\\w$]*)').exec(expression);
  if (!match) throw new Error(`ChatView 的 provide 表达式里缺 \`${field}\` 字段：${expression}`);
  return match[1];
}

const SLOT_FIELDS = ['workspaceTree', 'sidebarFooter'];

async function writeHarness() {
  const chatViewSource = await fs.readFile(chatViewPath, 'utf8');

  // 提取失败只降级生产场景，其它 7 个用例照常给结论。
  let production = null;
  let productionError = null;
  try {
    let providerExpression = extractProviderExpression(chatViewSource);
    const fields = {};
    for (const field of SLOT_FIELDS) {
      const raw = extractFieldIdentifier(providerExpression, field);
      fields[field] = { raw, ...resolveIdentifier(chatViewSource, raw) };
    }
    // 把 ChatView 里的别名声（如 defaultWorkspaceTree）改写成真实实现名：宿主导入的是真实实现，
    // 表达式本身（字段名与结构）保持逐字不变。
    for (const field of SLOT_FIELDS) {
      const { raw, identifier } = fields[field];
      if (raw !== identifier) {
        providerExpression = providerExpression.replace(new RegExp('\\b' + raw + '\\b', 'g'), identifier);
      }
    }
    production = { providerExpression, fields };
  } catch (error) {
    productionError = String((error && error.message) || error);
  }

  // 默认实现的模块路径直接从 ChatView 的导入解析（与 Sidebar.vue 的 `import SidebarWorkspaceTree` 同模块 ⇒ 同对象身份）。
  const defaultTreeModule = production
    ? production.fields.workspaceTree.module
    : path.resolve(frontendRoot, 'src/components/chat/SidebarWorkspaceTree.vue');
  const defaultTreeIdentifier = production ? production.fields.workspaceTree.identifier : 'SidebarWorkspaceTree';

  // 导入表按标识符去重：生产注册解析出来的往往就是同名同模块的默认实现，重复 import 会让构建直接失败。
  const imports = new Map([
    ['Sidebar', sidebarPath],
    [defaultTreeIdentifier, defaultTreeModule],
    ['SidebarFooterBar', path.resolve(frontendRoot, 'src/components/chat/SidebarFooterBar.vue')]
  ]);
  if (production) {
    for (const field of SLOT_FIELDS) {
      const resolved = production.fields[field];
      if (!imports.has(resolved.identifier)) imports.set(resolved.identifier, resolved.module);
    }
  }
  const importBlock = [...imports].map(([identifier, module]) => `import ${identifier} from '${specifierFor(module)}';`).join('\n');

  const productionValueBlock = production
    ? `const CHAT_VIEW_PROVIDER_VALUE = ${production.providerExpression};
window.__slotReads = [];
const OBSERVED_PROVIDER = new Proxy(CHAT_VIEW_PROVIDER_VALUE, {
  get(target, key) {
    if (typeof key === 'string') window.__slotReads.push(key);
    return target[key];
  }
});
window.__prodIdentity = {
  workspaceTreeIsDefault: CHAT_VIEW_PROVIDER_VALUE.workspaceTree === ${production ? production.fields.workspaceTree.identifier : 'SidebarWorkspaceTree'},
  sidebarFooterIsDefault: CHAT_VIEW_PROVIDER_VALUE.sidebarFooter === ${production ? production.fields.sidebarFooter.identifier : 'SidebarFooterBar'}
};
window.__prodProviderKeys = Object.keys(CHAT_VIEW_PROVIDER_VALUE).sort();`
    : `const CHAT_VIEW_PROVIDER_VALUE = null;
const OBSERVED_PROVIDER = null;
window.__prodIdentity = null;
window.__prodProviderKeys = null;
window.__slotReads = [];`;

  const productionScenarioBlock = production
    ? 'production: { provide: OBSERVED_PROVIDER }'
    : `production: { provide: undefined, error: ${JSON.stringify(productionError)} }`;

  await fs.mkdir(output, { recursive: true });

  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, h, nextTick } from 'vue';
import { SIDEBAR_SLOTS_KEY } from '${specifierFor(sidebarTypesPath)}';
import { useTheme } from '${specifierFor(path.resolve(frontendRoot, 'src/composables/useTheme.ts'))}';
${importBlock}
import '${specifierFor(path.resolve(frontendRoot, 'src/style.css'))}';

localStorage.setItem('lingxi-locale', 'zh-CN');
useTheme().setTheme('light');

/* ---- 生产注册值：逐字来自 ChatView.vue 源码里的 provide 表达式 ---- */
${productionValueBlock}

/* ---- 工作区树探针：不声明任何 props，用 attrs 精确观察"到底收到了哪几项" ---- */
const TreeProbe = {
  name: 'TreeProbe',
  setup(_, { attrs }) {
    return () => {
      const keys = Object.keys(attrs).sort();
      const actions = attrs.actions;
      const groups = attrs.groups || [];
      const historyGroup = groups.find(group => group.key === 'ws-unassigned');
      return h('div', {
        'data-slot-probe': 'tree',
        'data-slot-probe-keys': keys.join(','),
        'data-probe-groups': String(groups.length),
        'data-probe-group-keys': groups.map(group => group.key).join(','),
        'data-probe-history-null': String(!!historyGroup && historyGroup.workspace === null),
        'data-probe-history-sessions': String(historyGroup ? historyGroup.sessions.length : -1),
        'data-probe-first-sessions': String(groups[0] ? groups[0].sessions.length : -1),
        'data-probe-limit': String(attrs.sessionLimit),
        'data-probe-active': String(attrs.activeSessionId),
        'data-probe-collapsed': String(!!attrs.isCollapsed)
      }, [
        'probe-tree',
        h('button', { type: 'button', 'data-probe-action': 'select', onClick: () => actions.onSelectSession('s1') }, 'p-select'),
        h('button', { type: 'button', 'data-probe-action': 'rename', onClick: () => actions.onRenameSession('s2', '改过的标题') }, 'p-rename')
      ]);
    };
  }
};

/* ---- 底部栏探针：同样用 attrs 观察键集合 ---- */
const FooterProbe = {
  name: 'FooterProbe',
  setup(_, { attrs }) {
    return () => {
      const keys = Object.keys(attrs).sort();
      return h('div', {
        'data-slot-probe': 'footer',
        'data-slot-probe-keys': keys.join(','),
        'data-probe-collapsed': String(!!attrs.isCollapsed)
      }, [
        'probe-footer',
        h('button', { type: 'button', 'data-probe-action': 'settings', onClick: () => attrs.onOpenSettings() }, 'p-settings')
      ]);
    };
  }
};

const SCENARIOS = {
  // 1. 不 provide：走内置默认实现（兜底分支）
  default: { provide: undefined },
  // 2. 注册"默认实现本身"：必须与用例 1 逐字等价（内部 24 项 props 分支）
  registeredDefault: { provide: { workspaceTree: ${defaultTreeIdentifier} } },
  // 3. 注册第三方组件：只应拿到对外 7 项契约
  treeProbe: { provide: { workspaceTree: TreeProbe } },
  // 4. 空对象注册：字段全缺省 ⇒ 仍走默认实现
  empty: { provide: {} },
  // 5. 底部栏替换
  footerProbe: { provide: { sidebarFooter: FooterProbe } },
  // 8. 生产注册（取值来自 ChatView.vue 源码）
  ${productionScenarioBlock}
};

const WORKSPACES = [
  { id: '1', name: 'LingXi 项目', workDir: 'D:/work/lingxi' },
  { id: '2', name: '第二个项目', workDir: 'D:/work/two' }
];
const SESSIONS = [
  { id: 's1', title: '第一个会话', workspaceId: '1', timestamp: 1700000003000 },
  { id: 's2', title: '第二个会话', workspaceId: '1', timestamp: 1700000002000 },
  { id: 's9', title: '历史里的会话', timestamp: 1700000001000 }
];
const PRESETS = {
  // activeSessionId 落在工作区 1 里 ⇒ useWorkspaceExpansion 自动展开该组，会话标题可见
  expanded: {
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    activeSessionId: 's1',
    activeWorkspaceId: '1',
    isCollapsed: false,
    isDark: false
  },
  collapsed: {
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    activeSessionId: 's1',
    activeWorkspaceId: '1',
    isCollapsed: true,
    isDark: false
  }
};

window.__emits = [];
window.__render = async (scenarioKey, presetKey = 'expanded') => {
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
  window.__slotReads.length = 0;
  const slotApp = createApp({
    render: () => h(Sidebar, {
      ...PRESETS[presetKey],
      onSelectSession: record('selectSession'),
      onRenameSession: record('renameSession'),
      onOpenSettings: record('openSettings'),
      onDeleteSession: record('deleteSession'),
      onNewSession: record('newSession'),
      onNewWorkspace: record('newWorkspace'),
      onDeleteWorkspace: record('deleteWorkspace'),
      onSelectWorkspace: record('selectWorkspace'),
      onToggleCollapse: record('toggleCollapse')
    })
  });
  if (spec.provide !== undefined) slotApp.provide(SIDEBAR_SLOTS_KEY, spec.provide);
  slotApp.mount(host);
  window.__app = slotApp;
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 220));
  return true;
};

/* ---- DOM 探针 ---- */
const normalize = element => (element ? element.innerHTML.replace(/\\s+/g, ' ').trim() : null);
const textOf = element => (element ? element.textContent.replace(/\\s+/g, ' ').trim() : null);

window.__slots = () => {
  const plantedTrees = document.querySelectorAll('[data-slot="workspace-tree"]');
  const plantedFooters = document.querySelectorAll('[data-slot="sidebar-footer"]');
  const treeProbes = document.querySelectorAll('[data-slot-probe="tree"]');
  const footerProbes = document.querySelectorAll('[data-slot-probe="footer"]');
  return {
    defaultTree: plantedTrees.length,
    defaultFooter: plantedFooters.length,
    treeProbe: treeProbes.length,
    footerProbe: footerProbes.length
  };
};

/** 渲染指纹：同一份 props 必须是同一份 DOM（用例 2 / 用例 4 / 用例 8 的"逐字等价"判据）。 */
window.__fingerprint = () => {
  const tree = document.querySelector('[data-slot="workspace-tree"]');
  const footer = document.querySelector('[data-slot="sidebar-footer"]');
  return {
    treeHtml: normalize(tree),
    treeText: textOf(tree),
    footerHtml: normalize(footer),
    footerText: textOf(footer),
    footerButtons: footer ? footer.querySelectorAll('button').length : 0
  };
};

window.__probeKeys = marker => {
  const element = document.querySelector('[data-slot-probe="' + marker + '"]');
  return element ? element.getAttribute('data-slot-probe-keys') : null;
};

window.__probeAttr = (marker, name) => {
  const element = document.querySelector('[data-slot-probe="' + marker + '"]');
  return element ? element.getAttribute(name) : null;
};

window.__clickProbeAction = action => {
  const button = document.querySelector('[data-probe-action="' + action + '"]');
  if (!button) throw new Error('探针动作按钮不存在：' + action);
  button.click();
  return true;
};

window.ready = true;`);

  await fs.writeFile(path.join(output, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
    + '<div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  return { productionError };
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

/** 契约字段清单：从类型源文件里读，避免测试自带一份"副本真相"。 */
function footerContractFields(source) {
  const match = /export interface SidebarFooterSlotProps \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(match, '未解析到 SidebarFooterSlotProps 接口（契约改名了？）');
  return [...match[1].matchAll(/readonly\s+([A-Za-z_$][\w$]*)\s*[?:]/g)].map(item => item[1]);
}

function treeContractFields(source) {
  const match = /export interface SidebarTreeSlotProps \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(match, '未解析到 SidebarTreeSlotProps 接口（契约改名了？）');
  return [...match[1].matchAll(/readonly\s+([A-Za-z_$][\w$]*)\s*[?:]/g)].map(item => item[1]);
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
    const { productionError } = await writeHarness();
    await buildHarness();

    const typesSource = await fs.readFile(sidebarTypesPath, 'utf8');
    const sidebarSource = await fs.readFile(sidebarPath, 'utf8');
    const treeFields = treeContractFields(typesSource).sort();
    const footerFields = footerContractFields(typesSource).sort();
    assert.deepEqual(treeFields, ['actions', 'activeSessionId', 'editingSessionId', 'groups', 'isCollapsed', 'isDark', 'sessionLimit'],
      `SidebarTreeSlotProps 应为 7 项，实际 ${JSON.stringify(treeFields)}`);
    assert.deepEqual(footerFields, ['isCollapsed', 'isDark', 'onOpenSettings'],
      `SidebarFooterSlotProps 应为 3 项，实际 ${JSON.stringify(footerFields)}`);

    window = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false }
    });
    // 渲染器错误直通标准输出：宿主构建出错时不会只剩一句"宿主未就绪"
    window.webContents.on('console-message', (event, level, message) => {
      const payload = event && typeof event === 'object' && 'message' in event ? event : { level, message };
      const isError = payload.level === 'error' || payload.level === 3;
      if (isError) console.log(`[renderer] ${String(payload.message).slice(0, 400)}`);
    });
    window.webContents.on('render-process-gone', (_event, details) => console.log(`[renderer-gone] ${JSON.stringify(details)}`));
    await window.loadFile(path.join(output, 'dist/index.html'));
    const evaluate = source => window.webContents.executeJavaScript(source);
    assert.equal(await evaluate('window.ready'), true, '宿主未就绪');
    if (productionError) console.log(`       （生产注册提取失败，用例8 将红：${productionError}）`);

    // 用例 1：默认实现（不注册）
    await evaluate('window.__render("default", "expanded")');
    const defaultFingerprint = await evaluate('window.__fingerprint()');
    let baselineSlots;
    await runCase('用例1 默认实现正常（工作区分组 / 会话标题 / footer 设置按钮）', async () => {
      baselineSlots = await evaluate('window.__slots()');
      assert.equal(baselineSlots.defaultTree, 1, `默认工作区树未渲染，slots=${JSON.stringify(baselineSlots)}`);
      assert.equal(baselineSlots.treeProbe, 0, '未注册时不应出现树探针');
      assert.equal(baselineSlots.defaultFooter, 1, '默认底部栏未渲染');
      assert.ok(defaultFingerprint.treeText.includes('LingXi 项目'),
        `工作区分组名缺失，实际树文本 ${JSON.stringify(defaultFingerprint.treeText)}`);
      assert.ok(defaultFingerprint.treeText.includes('第一个会话'),
        `会话标题缺失（工作区未自动展开？），实际树文本 ${JSON.stringify(defaultFingerprint.treeText)}`);
      assert.ok(defaultFingerprint.treeText.includes('历史里的会话'),
        `「历史对话」分组的会话缺失，实际树文本 ${JSON.stringify(defaultFingerprint.treeText)}`);
      assert.equal(defaultFingerprint.footerButtons, 1,
        `底部栏应恰好 1 个入口按钮（设置），实际 ${defaultFingerprint.footerButtons}`);
      assert.ok(defaultFingerprint.footerText.length > 0, '底部栏没有任何可见文案');
    });

    // 用例 2：注册「默认实现本身」⇒ 与不注册逐字等价（证明 isDefaultTree 分支正确）
    await runCase('用例2 注册默认实现本身：渲染与不注册逐字一致', async () => {
      await evaluate('window.__render("registeredDefault", "expanded")');
      const slots = await evaluate('window.__slots()');
      const fingerprint = await evaluate('window.__fingerprint()');
      assert.equal(slots.treeProbe, 0, '注册默认实现不应出现探针');
      assert.equal(slots.defaultTree, 1,
        `注册默认实现后工作区树未渲染（身份判断失效 ⇒ 被当成第三方、只喂 7 项？）slots=${JSON.stringify(slots)}`);
      assert.equal(fingerprint.treeHtml, defaultFingerprint.treeHtml,
        `注册默认实现的树 DOM 与不注册不一致（身份判断失效 ⇒ 走了对外 7 项契约）\n注册后：${String(fingerprint.treeHtml).slice(0, 320)}\n不注册：${String(defaultFingerprint.treeHtml).slice(0, 320)}`);
      assert.equal(fingerprint.treeText, defaultFingerprint.treeText,
        `注册默认实现的树文本与不注册不一致：注册后 ${JSON.stringify(fingerprint.treeText)} / 不注册 ${JSON.stringify(defaultFingerprint.treeText)}`);
      assert.equal(fingerprint.footerText, defaultFingerprint.footerText, '注册默认实现后底部栏与不注册不一致');
    });

    // 用例 3：注册第三方替换 ⇒ 探针出现、默认树消失、props 恰好 7 项
    await runCase('用例3 第三方替换：默认树消失且只收到 7 项契约', async () => {
      await evaluate('window.__render("treeProbe", "expanded")');
      const slots = await evaluate('window.__slots()');
      assert.equal(slots.treeProbe, 1, `树探针应恰好 1 个，实际 ${slots.treeProbe}`);
      assert.equal(slots.defaultTree, 0, `注册第三方后默认树仍在（双渲染）：${slots.defaultTree}`);
      const keys = await evaluate('window.__probeKeys("tree")');
      assert.equal(keys, treeFields.join(','),
        `替换实现收到的 props 应恰好是契约 7 项（不得变宽/变窄），实际 ${JSON.stringify(keys)}`);
      for (const leaked of ['branchedMenuItems', 'projectGroups', 'unassignedSessions', 'expandedWorkspaces', 'editingTitle', 'limitSessions']) {
        assert.ok(!String(keys).split(',').includes(leaked),
          `内部字段 ${leaked} 泄漏进了对外契约：${keys}`);
      }
      const groups = await evaluate('window.__probeAttr("tree", "data-probe-groups")');
      assert.equal(groups, '3', `探针应拿到 3 个分组（2 个工作区 + 历史对话），实际 ${groups}`);
      const groupKeys = await evaluate('window.__probeAttr("tree", "data-probe-group-keys")');
      assert.equal(groupKeys, 'ws-1,ws-2,ws-unassigned',
        `分组语义键应为 ws-<id> / ws-unassigned，实际 ${JSON.stringify(groupKeys)}`);
      const historyNull = await evaluate('window.__probeAttr("tree", "data-probe-history-null")');
      assert.equal(historyNull, 'true', '「历史对话」分组必须以 workspace: null 表达');
      const historySessions = await evaluate('window.__probeAttr("tree", "data-probe-history-sessions")');
      assert.equal(historySessions, '1', `历史分组应有 1 条会话，实际 ${historySessions}`);
      const firstSessions = await evaluate('window.__probeAttr("tree", "data-probe-first-sessions")');
      assert.equal(firstSessions, '2', `工作区 1 应有 2 条会话，实际 ${firstSessions}`);
      const limit = await evaluate('window.__probeAttr("tree", "data-probe-limit")');
      assert.equal(limit, '5', `sessionLimit 应为 5，实际 ${limit}`);
      const active = await evaluate('window.__probeAttr("tree", "data-probe-active")');
      assert.equal(active, 's1', `activeSessionId 应为 s1，实际 ${active}`);
    });

    // 用例 4：空注册不炸（覆盖"按对象真值判空"这个坑）
    await runCase('用例4 provide({}) 仍渲染两个默认实现', async () => {
      await evaluate('window.__render("empty", "expanded")');
      const slots = await evaluate('window.__slots()');
      const fingerprint = await evaluate('window.__fingerprint()');
      assert.equal(slots.defaultTree, 1, `空注册后默认树消失，slots=${JSON.stringify(slots)}`);
      assert.equal(slots.defaultFooter, 1, '空注册后默认底部栏消失');
      assert.equal(slots.treeProbe + slots.footerProbe, 0, '空注册不应出现探针');
      assert.equal(fingerprint.treeText, defaultFingerprint.treeText,
        `空注册后的树文本与默认不一致：${JSON.stringify(fingerprint.treeText)}`);
      assert.equal(fingerprint.footerButtons, 1, `空注册后底部栏按钮数应为 1，实际 ${fingerprint.footerButtons}`);
    });

    // 用例 5：底部栏替换
    await runCase('用例5 sidebarFooter 替换：默认底部栏消失且只收到 3 项', async () => {
      await evaluate('window.__render("footerProbe", "expanded")');
      const slots = await evaluate('window.__slots()');
      assert.equal(slots.footerProbe, 1, `底部栏探针应恰好 1 个，实际 ${slots.footerProbe}`);
      assert.equal(slots.defaultFooter, 0, `注册底部栏探针后默认底部栏仍在（双渲染）：${slots.defaultFooter}`);
      assert.equal(slots.defaultTree, 1, '替换底部栏不应影响工作区树');
      const keys = await evaluate('window.__probeKeys("footer")');
      assert.equal(keys, footerFields.join(','),
        `底部栏替换实现应恰好收到 3 项（2 状态 + 1 回调），实际 ${JSON.stringify(keys)}`);
      await evaluate('window.__clickProbeAction("settings")');
      await wait(120);
      const emits = await evaluate('window.__emits');
      const settings = emits.filter(item => item[0] === 'openSettings');
      assert.equal(settings.length, 1, `onOpenSettings 应只 emit 1 次，实际 ${JSON.stringify(emits)}`);
    });

    // 用例 6：契约负向断言 —— 死事件不得进契约
    await runCase('用例6 死事件 onOpenModels / onToggleTheme 不得进契约', async () => {
      // 6.1 类型源文件文本：footer 契约里不许出现这两个名字
      const footerBlock = /export interface SidebarFooterSlotProps \{([\s\S]*?)\n\}/.exec(typesSource)[1];
      assert.doesNotMatch(footerBlock, /onOpenModels/, `SidebarFooterSlotProps 里出现了死事件 onOpenModels：\n${footerBlock}`);
      assert.doesNotMatch(footerBlock, /onToggleTheme/, `SidebarFooterSlotProps 里出现了死事件 onToggleTheme：\n${footerBlock}`);
      assert.deepEqual(footerContractFields(typesSource).sort(), ['isCollapsed', 'isDark', 'onOpenSettings'],
        '底部栏契约应恰好 3 项（isCollapsed / isDark / onOpenSettings）');
      // 6.2 金丝雀：这两个事件在 Sidebar 里确实"声明但永不 emit"（否则负向断言就没有意义）
      assert.match(sidebarSource, /'openModels'\)\s*:\s*void/, 'Sidebar 已不再声明 openModels —— 负向断言的依据变了，请复核 D-1');
      assert.match(sidebarSource, /'toggleTheme'\)\s*:\s*void/, 'Sidebar 已不再声明 toggleTheme —— 负向断言的依据变了，请复核 D-1');
      assert.doesNotMatch(sidebarSource, /emit\(\s*'openModels'/, 'openModels 竟然有 emit 调用：它不再是死事件，需重新评估是否入契约');
      assert.doesNotMatch(sidebarSource, /emit\(\s*'toggleTheme'/, 'toggleTheme 竟然有 emit 调用：它不再是死事件，需重新评估是否入契约');
      // 6.3 运行时键集合：双重断言（替换实现手里也确实没有这两个回调）
      await evaluate('window.__render("footerProbe", "expanded")');
      const keys = await evaluate('window.__probeKeys("footer")');
      for (const dead of ['onOpenModels', 'onToggleTheme']) {
        assert.ok(!String(keys).split(',').includes(dead),
          `运行时探针收到了死事件 ${dead}：${keys}`);
      }
    });

    // 用例 7：行为唯一（替换实现的 actions 只有一条路径）
    await runCase('用例7 行为唯一：替换实现调 actions 不双触发', async () => {
      await evaluate('window.__render("treeProbe", "expanded")');
      await evaluate('window.__clickProbeAction("select")');
      await wait(160);
      let emits = await evaluate('window.__emits');
      let selects = emits.filter(item => item[0] === 'selectSession');
      assert.equal(selects.length, 1, `selectSession 应恰好 emit 1 次（双触发会 2 次），实际 ${JSON.stringify(emits)}`);
      assert.equal(selects[0][1], 's1', `selectSession 载荷应为 s1，实际 ${JSON.stringify(selects[0][1])}`);
      assert.equal(emits.filter(item => item[0] === 'renameSession').length, 0,
        `选中会话不应触发 renameSession：${JSON.stringify(emits)}`);

      await evaluate('window.__render("treeProbe", "expanded")');
      await evaluate('window.__clickProbeAction("rename")');
      await wait(160);
      emits = await evaluate('window.__emits');
      const renames = emits.filter(item => item[0] === 'renameSession');
      assert.equal(renames.length, 1, `renameSession 应恰好 emit 1 次，实际 ${JSON.stringify(emits)}`);
      assert.deepEqual(renames[0].slice(1), ['s2', '改过的标题'],
        `renameSession 载荷应为 (s2, 改过的标题)，实际 ${JSON.stringify(renames[0])}`);
      assert.equal(emits.filter(item => item[0] === 'selectSession').length, 0,
        `重命名不应触发 selectSession：${JSON.stringify(emits)}`);
    });

    // 用例 8：生产调用链可达
    await runCase('用例8 生产调用链可达（ChatView 的 provide 真的被 Sidebar 走到）', async () => {
      const keys = await evaluate('window.__prodProviderKeys');
      assert.deepEqual(keys, ['sidebarFooter', 'workspaceTree'],
        `ChatView 的 provide 字段应恰为 workspaceTree/sidebarFooter（死事件不入契约），实际 ${JSON.stringify(keys)}`);
      const identity = await evaluate('window.__prodIdentity');
      assert.deepEqual(identity, { workspaceTreeIsDefault: true, sidebarFooterIsDefault: true },
        `ChatView 注册的必须是真实默认实现组件（身份判断的前提）：${JSON.stringify(identity)}`);

      await evaluate('window.__render("production", "expanded")');
      const slots = await evaluate('window.__slots()');
      const fingerprint = await evaluate('window.__fingerprint()');
      const reads = await evaluate('window.__slotReads');
      assert.equal(slots.defaultTree, 1, `生产注册下默认树未渲染，slots=${JSON.stringify(slots)}`);
      assert.equal(slots.defaultFooter, 1, '生产注册下默认底部栏未渲染');
      assert.equal(slots.treeProbe + slots.footerProbe, 0, '生产注册值来自默认实现，不应出现探针');
      for (const field of SLOT_FIELDS) {
        assert.ok(reads.includes(field),
          `Sidebar 未读取注册表的 ${field} 字段 ⇒ 注册分支不可达，reads=${JSON.stringify(reads)}`);
      }
      // 生产路径必须与「不注册」逐字一致（身份分支正确 ⇒ 内部 24 项 props 照常喂）
      assert.equal(fingerprint.treeText, defaultFingerprint.treeText,
        `生产注册下的树文本与默认不一致：${JSON.stringify(fingerprint.treeText)}`);
      assert.equal(fingerprint.treeHtml, defaultFingerprint.treeHtml,
        '生产注册下的树 DOM 与默认不一致（身份判断失效会退化成 7 项契约）');
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
