import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, h, nextTick, reactive } from 'vue';
import type { App } from 'vue';
import { AgentAPI } from '../src/services/agent';
import { ToolAPI } from '../src/services/tool';
import { ModelAPI } from '../src/services/model';
import { AgentToolName } from '../src/utils/toolNames';
import { setPreference, t as translate } from '../src/i18n';

interface Node {
  tag: string; text: string; props: Record<string, any>; children: Node[]; parent: Node | null;
  addEventListener: (...args: any[]) => void;
  classList: { add: (...names: string[]) => void; remove: (...names: string[]) => void; contains: (name: string) => boolean };
  options: Node[];
}
/**
 * 合成节点的 classList。
 *
 * <p>为什么必须有：`dd853da` 把四处弹窗收敛到 LxModal 后，弹窗内容被 `<Transition>` 包了一层，
 * 而 Transition 的入场钩子（@vue/runtime-dom runtime-dom.cjs 的 addTransitionClass）会执行
 * {@code el.classList.add(cls)}。真实 DOM 元素天然有这个属性，合成节点没有 ⇒ 钩子抛
 * `TypeError: Cannot read properties of undefined (reading 'add')`，mountElement 中途失败，
 * 子树根本没挂上 —— 表现为「断言找不到元素」，看起来像组件把内容吃掉，实则桩不足。</p>
 */
const makeClassList = () => {
  const names = new Set<string>();
  return {
    add: (...list: string[]) => list.forEach(name => names.add(name)),
    remove: (...list: string[]) => list.forEach(name => names.delete(name)),
    contains: (name: string) => names.has(name),
  };
};
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null, addEventListener() {},
  classList: makeClassList(),
  get options() { return this.children.filter(child => child.tag === 'option'); } });
const text = (value: Node): string => value.tag === '#comment' ? '' : value.text + value.children.map(text).join('');
function find(value: Node, predicate: (item: Node) => boolean): Node | undefined {
  if (predicate(value)) return value;
  for (const child of value.children) { const result = find(child, predicate); if (result) return result; }
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
let activeApp: App | null = null;
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tmpDir = resolve(frontendRoot, 'node_modules/.tmp');

/**
 * 源文件绝对路径 → 编译产出的临时 .mjs 路径。
 *
 * <p>两个作用：①同一组件被多处引用时只编译一次；②**打断循环引用** ——
 * 必须先登记再递归编译，否则 A → B → A 会无限递归。</p>
 */
const compiledModules = new Map<string, string>();

/**
 * 把一条相对导入解析成可直接 import 的 file:// URL。
 *
 * <p>三条分支对应源码里真实存在的三类导入：</p>
 * <ul>
 *   <li><b>{@code .vue} 结尾</b> —— 单文件组件。**绝不能拼 {@code /index.ts}**：
 *       它是文件不是目录。必须递归编译成临时 .mjs。
 *       （{@code AgentsTab.vue:4} → {@code DropUpSelect.vue} → {@code ProviderIcon.vue}
 *       就是这种链，只编译单层会继续崩在下一层。）</li>
 *   <li><b>{@code .ts/.js/.mjs/.cjs/.json} 结尾</b> —— 已带真实扩展名，原样指向。</li>
 *   <li><b>无扩展名</b> —— 依次试 {@code base+.ts} / {@code base+.js} /
 *       {@code base/index.ts} / {@code base/index.js}；全都不存在时**抛错**并列出所有
 *       尝试过的路径。绝不能静默拼出一个必然不存在的路径 —— 否则错误信息会指向
 *       {@code Foo.vue/index.ts} 这种假路径，排查成本极高。</li>
 * </ul>
 */
function resolveImportUrl(componentPath: string, relative: string, context: test.TestContext): string {
  const base = resolve(dirname(componentPath), relative);

  if (/\.vue$/i.test(base)) {
    if (!existsSync(base)) {
      throw new Error(`无法解析导入 '${relative}'（来自 ${componentPath}）：.vue 文件不存在于 ${base}`);
    }
    return pathToFileURL(compileVueModule(base, context)).href;
  }

  if (/\.(ts|js|mjs|cjs|json)$/i.test(base)) {
    if (!existsSync(base)) {
      throw new Error(`无法解析导入 '${relative}'（来自 ${componentPath}）：文件不存在于 ${base}`);
    }
    return pathToFileURL(base).href;
  }

  const candidates = [base + '.ts', base + '.js', resolve(base, 'index.ts'), resolve(base, 'index.js')];
  const hit = candidates.find(candidate => existsSync(candidate));
  if (!hit) {
    throw new Error(
      `无法解析导入 '${relative}'（来自 ${componentPath}）：` +
        `已尝试 ${candidates.join(' / ')} 均不存在。` +
        '若目标是 .vue 单文件组件，请在导入语句里显式写出 .vue 扩展名。'
    );
  }
  return pathToFileURL(hit).href;
}

/** 重写编译产物里的全部相对导入，使其指向真实可加载的模块。 */
function rewriteRelativeImports(source: string, componentPath: string, context: test.TestContext): string {
  return source.replace(/from ['"](\.[^'"]+)['"]/g, (_match, relative: string) =>
    `from '${resolveImportUrl(componentPath, relative, context)}'`
  );
}

/** 把 .vue 编译成临时 .mjs 并返回其路径；同一源文件只编译一次。 */
function compileVueModule(sourcePath: string, context: test.TestContext): string {
  const cached = compiledModules.get(sourcePath);
  if (cached) return cached;

  const temporary = resolve(
    tmpDir,
    sourcePath.replace(frontendRoot, '').replace(/[\\/]+/g, '-').replace(/^-/, '') + '.mjs'
  );
  // 先登记再递归：A → B → A 时 B 能拿到 A 已登记的产物路径，不会无限递归。
  compiledModules.set(sourcePath, temporary);

  const descriptor = parse(readFileSync(sourcePath, 'utf8'), { filename: sourcePath }).descriptor;
  const script = compileScript(descriptor, { id: sourcePath, inlineTemplate: true });
  const source = rewriteRelativeImports(script.content, sourcePath, context);
  mkdirSync(dirname(temporary), { recursive: true });
  writeFileSync(
    temporary,
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
  );
  context.after(() => {
    compiledModules.delete(sourcePath);
    if (existsSync(temporary)) unlinkSync(temporary);
  });
  return temporary;
}

async function mount(context: test.TestContext, path: string, props: Record<string, unknown>) {
  const componentPath = resolve(frontendRoot, 'src', path);
  const temporary = compileVueModule(componentPath, context);
  const renderer = createRenderer<Node, Node>({
    createElement: tag => node(tag), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (item, value) => { item.text = value; }, setElementText: (item, value) => { item.text = value; item.children = []; },
    parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
    patchProp: (item, key, _old, value) => { item.props[key] = value; Object.assign(item, { [key]: value }); },
    insert: (item, parent, anchor = null) => {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1);
      item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item);
    },
    remove: item => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null; },
    // DropUpSelect 用 Teleport to="body" 建浮层。提供 querySelector 让它挂到根节点上，
    // 否则 Vue 会告警 "Current renderer does not support string target for Teleports"
    // 并丢弃浮层内容（对被测断言无影响，但告警会淹没真实失败）。
    querySelector: () => root,
  });
  const component = (await import(pathToFileURL(temporary).href)).default;
  const state = reactive({ ...props, isOpen: false });
  const root = node('root'); const app = renderer.createApp({ render: () => h(component, state) });
  activeApp = app; app.mount(root); state.isOpen = true;
  await settle(); return root;
}

/**
 * 零时长的 computed style。
 *
 * <p>Transition 结束判定（runtime-dom 的 getTransitionInfo）会读 `transitionDelay` 等四个属性；
 * 返回空串即可判定「无过渡」，钩子立刻收尾。桩缺这一项时 `<Transition>` 会以
 * `ReferenceError: window is not defined / getComputedStyle is not a function` 打断挂载。</p>
 */
const ZERO_TRANSITION_STYLE: Record<string, string> = {
  transitionDelay: '', transitionDuration: '', animationDelay: '', animationDuration: '',
};

function prepare(context: test.TestContext) {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  /**
   * 环境桩。
   *
   * <p>材料到「真实子组件的最小 DOM 面」：被测组件会引入 DropUpSelect.vue
   * （{@code AgentsTab.vue:4} 的模型下拉），它在 onMounted 里注册 window/document 的
   * resize、scroll、mousedown、keydown 监听，计算定位时读 innerWidth/innerHeight；
   * 而 useTheme 在模块加载期就会写 {@code document.documentElement} 与 {@code document.body} 的
   * classList。桩缺一项就会在挂载期抛 TypeError，看起来像组件缺陷，实则是桩不足。</p>
   */
  for (const [key, value] of Object.entries({
    document: {
      activeElement: null,
      body: { classList: { toggle() {}, add() {}, remove() {} }, appendChild() {}, removeChild() {} },
      documentElement: { classList: { toggle() {}, add() {}, remove() {} }, dataset: {}, style: {} },
      addEventListener() {}, removeEventListener() {},
      createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
      querySelector() { return null; },
    },
    window: {
      setTimeout, clearTimeout,
      addEventListener() {}, removeEventListener() {},
      innerWidth: 1280, innerHeight: 800,
      // Transition 结束判定读 window.getComputedStyle；缺它会以 ReferenceError 打断挂载。
      getComputedStyle() { return ZERO_TRANSITION_STYLE; },
      requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
      cancelAnimationFrame: (id: any) => clearTimeout(id),
    },
    // Transition 的入场走 nextFrame（双 rAF），裸全局缺它会 ReferenceError。
    requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: any) => clearTimeout(id),
    Document: class {}, ShadowRoot: class {},
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    previousGlobals.set(key, previous);
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  context.after(() => {
    activeApp?.unmount(); activeApp = null;
    for (const [key, previous] of previousGlobals) {
      if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key);
    }
  });
  setPreference('zh-CN');
  const agent = { id: '9', name: '测试助手', modelId: '7', prompt: '认真回答', toolList: [AgentToolName.ExecuteCommand, AgentToolName.ReadFile] };
  context.mock.method(AgentAPI, 'list', async () => ({ code: 1, data: { records: [agent], total: 1 } }));
  context.mock.method(AgentAPI, 'findById', async () => ({ code: 1, data: agent }));
  context.mock.method(ModelAPI, 'list', async () => ({ code: 1, data: { records: [{ id: '7', modelName: '测试模型' }] } }));
  context.mock.method(ToolAPI, 'list', async () => ({ code: 1, data: [
    { name: AgentToolName.ExecuteCommand, readOnly: false }, { name: AgentToolName.ReadSkill, readOnly: true },
    { name: AgentToolName.ReadFile, readOnly: true }, { name: AgentToolName.WebSearch, readOnly: true },
  ] }));
  return context.mock.method(AgentAPI, 'update', async () => ({ code: 1 }));
}

for (const mode of ['settings', 'team'] as const) {
  test(`${mode} 实际组件：工具名映射显示，选中和保存仍使用原始标识`, async context => {
    const update = prepare(context);
    const root = await mount(context, mode === 'settings' ? 'views/settings/tabs/AgentsTab.vue' : 'components/chat/TeamModal.vue',
      { isDark: true, isOpen: true, models: [{ id: '7', modelName: '测试模型' }] });
    if (mode === 'settings') assert.ok(text(root).includes('执行命令'));
    else assert.ok(find(root, item => item.props.title === '执行命令、读取文件'), '工具数量悬浮提示也必须映射完整名');
    const edit = find(root, item => item.tag === 'button' && item.props.title === translate(mode === 'settings' ? 'settings.agents.editAction' : 'chat.team.editAgentTip'));
    assert.ok(edit); await edit.props.onClick({ stopPropagation() {} }); await settle();
    if (mode === 'settings') {
      const prompt = find(root, item => item.tag === 'textarea');
      assert.ok(prompt, '编辑智能体时应显示提示词输入框');
      assert.match(String(prompt.props.class), /(?:^|\s)resize-y(?:\s|$)/, '提示词输入框应允许用户纵向拖拽调节高度');
    }
    assert.ok(text(root).includes('执行命令')); assert.ok(text(root).includes('读取技能'));
    assert.ok(text(root).includes('读取文件')); assert.ok(text(root).includes('网页搜索'));
    for (const name of [AgentToolName.ExecuteCommand, AgentToolName.ReadSkill]) assert.ok(!text(root).includes(name));
    const option = find(root, item => item.tag === 'div' && typeof item.props.onClick === 'function' && text(item).includes('读取技能') && !text(item).includes('执行命令') && find(item, child => child.tag === 'input' && child.props.type === 'checkbox') !== undefined);
    assert.ok(option); option.props.onClick(); await nextTick();
    const selected = find(option, item => item.tag === 'input' && item.props.type === 'checkbox');
    assert.equal(selected?.props.checked, true);
    const save = find(root, item => item.tag === 'button' && text(item).trim() === translate('common.save'));
    assert.ok(save); await save.props.onClick(); await settle();
    assert.equal(update.mock.callCount(), 1);
    assert.deepEqual(update.mock.calls[0]?.arguments[0].toolList, [AgentToolName.ExecuteCommand, AgentToolName.ReadFile, AgentToolName.ReadSkill]);
  });
}
