import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import http from '../src/services/interceptor';
import { useChatWorkspace } from '../src/views/chat/useChatWorkspace';
import { useUserConfigStore } from '../src/stores/userConfigStore';
import { toServerId } from '../src/utils/ids';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { AgentAPI } from '../src/services/agent';
import type { ChatCommand } from '../src/services/dto/chat_command';

test('模型切换把列表雪花 ID 原样写入 config/current/update，选中状态保持同一 ID', async (t) => {
  setActivePinia(createPinia());
  const id = '2109664456480034818';
  const requests: { url?: string; data: unknown }[] = [];
  const previous = http.defaults.adapter;
  http.defaults.adapter = async config => {
    requests.push({ url: config.url, data: JSON.parse(config.data) });
    return { data: { code: 1 }, status: 200, statusText: 'OK', headers: {}, config };
  };
  t.after(() => { http.defaults.adapter = previous; });
  const state = useChatWorkspace({ localSessions: ref([]),
    localModels: ref([{ id: '4', modelName: 'model-1' }, { id, modelName: 'model-2' }]),
    localWorkspaces: ref([]), localActiveWorkspaceId: ref(null) });
  assert.equal(await state.handleUpdateModel(id), true);
  assert.equal(useUserConfigStore().modelId, id);
  assert.equal(state.selectedModelId.value, id);
  assert.deepEqual(requests, [{ url: '/config/current/update', data: { modelId: id } }]);
  assert.equal(await state.handleUpdateModel('4'), true);
  assert.equal(useUserConfigStore().modelId, '4');
  assert.deepEqual(requests[1].data, { modelId: '4' });
});

test('ID 不经过浮点数转换；拒绝已经失真的数字与无效输入', () => {
  assert.equal(toServerId('2109664456480034818'), '2109664456480034818');
  assert.equal(toServerId(4), '4');
  for (const value of [Number('2109664456480034818'), 1.5, 0, -1, '', '1e3', 'NaN', null]) {
    assert.equal(toServerId(value), null);
  }
});

test('真实视图命令构造和聊天表单同样保留选中的模型 ID', async (t) => {
  const source = readFileSync(new URL('../src/views/chat/useChatView.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('useChatView.ts', source, ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'buildCommand') initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(initializer);
  // 单独执行真实命令构造，避免用量 ID 用例依赖浏览器订阅和滚动生命周期。
  const compiled = ts.transpileModule(`const buildCommand = ${initializer.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const id = '2109664456480034818';
  const selectedTeamId = ref<string | null>(null);
  const build = new Function('workspace', 'localActiveId', 'localActiveWorkspaceId', 'userConfig', 'toServerSessionId', 'localSelectedTeamId',
    `${compiled}\nreturn buildCommand;`)({ selectedModelId: ref(id) }, ref('100'), ref(null), { agentId: null }, (value: string) => value, selectedTeamId);
  const command: ChatCommand = build('测试模型', false, []);
  assert.equal(command.modelId, id);
  selectedTeamId.value = '77';
  assert.equal(build('团队模型', false, []).modelId, '', '选中团队时模型由团队决定');
  selectedTeamId.value = null;
  let sent: FormData | undefined;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent = init?.body as FormData;
    return new Response(JSON.stringify({ code: 1, data: { sessionId: '100', turnId: '200' } }));
  });
  await AgentAPI.acceptCommand(command);
  assert.equal(sent?.get('modelId'), id);
});
