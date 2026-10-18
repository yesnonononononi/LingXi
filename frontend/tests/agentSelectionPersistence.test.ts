import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';
import ts from 'typescript';
import http from '../src/services/interceptor';
import { useUserConfigStore } from '../src/stores/userConfigStore';
import { toPositiveInt } from '../src/utils/api';

interface PatchCall {
  field: string;
  value: unknown;
  payload: Record<string, unknown>;
}

/**
 * 只抽出 useChatView 里的 handleUpdateAgent 单独执行。
 *
 * <p>整只 useChatView 会挂载 SSE 订阅与滚动生命周期，跑在 node 环境里没有浏览器上下文；
 * 这里要验证的是它发给配置接口的请求体形状，抽取函数体即可覆盖。</p>
 */
function compileHandleUpdateAgent(): string {
  const source = readFileSync(new URL('../src/views/chat/useChatView.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('useChatView.ts', source, ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleUpdateAgent') {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(initializer, 'useChatView 里应当存在 handleUpdateAgent');
  return ts.transpileModule(`const handleUpdateAgent = ${initializer.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function buildHandleUpdateAgent(calls: PatchCall[]) {
  const userConfig = {
    patch: (field: string, value: unknown, payload: Record<string, unknown>): Promise<boolean> => {
      calls.push({ field, value, payload });
      return Promise.resolve(true);
    },
  };
  const factory = new Function('userConfig', 'toPositiveInt',
    `${compileHandleUpdateAgent()}\nreturn handleUpdateAgent;`);
  return factory(userConfig, toPositiveInt) as (agentId: string | number | null) => void;
}

test('取消选中 Agent 时请求体显式携带 agentId 键，值为 null', () => {
  const calls: PatchCall[] = [];
  buildHandleUpdateAgent(calls)(null);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].field, 'agentId');
  assert.equal(calls[0].value, null);
  assert.ok(
    Object.prototype.hasOwnProperty.call(calls[0].payload, 'agentId'),
    '请求体必须出现 agentId 键：后端按「键是否存在」区分解绑与没传，缺键会静默保留旧 Agent',
  );
  assert.equal(calls[0].payload.agentId, null);
});

test('选中 Agent 时请求体带数字 id，且本地值与请求体一致', () => {
  const calls: PatchCall[] = [];
  buildHandleUpdateAgent(calls)('10');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].field, 'agentId');
  assert.equal(calls[0].value, 10);
  assert.deepEqual(calls[0].payload, { agentId: 10 });
});

test('解绑请求落到 /config/current/update 时 agentId 键不被序列化丢弃', async (t) => {
  setActivePinia(createPinia());
  const requests: { url?: string; data: unknown }[] = [];
  const previous = http.defaults.adapter;
  http.defaults.adapter = async config => {
    requests.push({ url: config.url, data: JSON.parse(config.data) });
    return { data: { code: 1 }, status: 200, statusText: 'OK', headers: {}, config };
  };
  t.after(() => { http.defaults.adapter = previous; });

  const store = useUserConfigStore();
  store.agentId = '10';
  assert.equal(await store.patch('agentId', null, { agentId: null }), true);
  assert.equal(store.agentId, null);
  assert.deepEqual(requests, [{ url: '/config/current/update', data: { agentId: null } }]);
});
