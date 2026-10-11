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
  options: Node[];
}
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null, addEventListener() {},
  get options() { return this.children.filter(child => child.tag === 'option'); } });
const text = (value: Node): string => value.tag === '#comment' ? '' : value.text + value.children.map(text).join('');
function find(value: Node, predicate: (item: Node) => boolean): Node | undefined {
  if (predicate(value)) return value;
  for (const child of value.children) { const result = find(child, predicate); if (result) return result; }
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
let activeApp: App | null = null;
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function mount(context: test.TestContext, path: string, props: Record<string, unknown>) {
  const componentPath = resolve(frontendRoot, 'src', path);
  const descriptor = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor;
  const script = compileScript(descriptor, { id: path, inlineTemplate: true });
  const source = script.content.replace(/from ['"](\.[^'"]+)['"]/g, (_match, relative: string) => {
    const base = resolve(dirname(componentPath), relative);
    return `from '${pathToFileURL(existsSync(base + '.ts') ? base + '.ts' : resolve(base, 'index.ts')).href}'`;
  });
  const temporary = resolve(frontendRoot, 'node_modules/.tmp', path.replaceAll('/', '-') + '.mjs');
  mkdirSync(dirname(temporary), { recursive: true });
  writeFileSync(temporary, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  context.after(() => unlinkSync(temporary));
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
  });
  const component = (await import(pathToFileURL(temporary).href)).default;
  const state = reactive({ ...props, isOpen: false });
  const root = node('root'); const app = renderer.createApp({ render: () => h(component, state) });
  activeApp = app; app.mount(root); state.isOpen = true;
  await settle(); return root;
}

function prepare(context: test.TestContext) {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    document: { activeElement: null, documentElement: { classList: { toggle() {} }, dataset: {}, style: {} }, addEventListener() {}, removeEventListener() {} },
    window: { setTimeout, clearTimeout }, Document: class {}, ShadowRoot: class {},
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
