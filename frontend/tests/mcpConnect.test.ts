import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { McpAPI } from '../src/services/mcp';
import http, { ApiError } from '../src/services/interceptor';
import { useMcpTab } from '../src/views/settings/tabs/useMcpTab';
import type { Result } from '../src/services/types';
import type { McpConnectionVO, McpRequest } from '../src/types/chat';

const connected: Result<McpConnectionVO> = {
  code: 1, data: { toolCount: 1, toolNames: ['echo'], elapsedMillis: 25 },
};

function state() {
  const scope = effectScope();
  const value = scope.run(() => useMcpTab())!;
  value.startAddMcp();
  value.mcpForm.value.name = 'draft';
  value.mcpForm.value.url = 'http://localhost:9000/mcp';
  return { value, scope };
}

test('连接接口使用当前配置和足够的超时，不调用保存接口', async (t) => {
  let request: unknown[] = [];
  t.mock.method(http, 'post', async (...args: unknown[]) => { request = args; return connected; });
  const payload = { name: 'draft', initializationTimeout: 180_000, executionTimeout: 60_000 };
  assert.deepEqual(await McpAPI.connect(payload), connected);
  assert.deepEqual(request, ['/mcp/connect', payload, { timeout: 430_000 }]);
});

test('新增表单测试当前 HTTP 请求头，显示工具数量和耗时', async (t) => {
  let payload: McpRequest | undefined;
  t.mock.method(McpAPI, 'connect', async (data: McpRequest) => { payload = data; return connected; });
  const add = t.mock.method(McpAPI, 'add', async () => ({ code: 1 }));
  const { value, scope } = state();
  try {
    value.mcpForm.value.headerLines = 'Authorization: Bearer test';
    await value.handleConnectMcp();
    assert.equal(payload?.headers?.Authorization, 'Bearer test');
    assert.equal(payload?.id, undefined);
    assert.deepEqual(value.mcpConnectionResult.value, connected.data);
    assert.equal(value.isConnectingMcp.value, false);
    assert.equal(add.mock.callCount(), 0);
  } finally { scope.stop(); }
});

test('stdio 表单按行提交 argv 与环境变量', async (t) => {
  let payload: McpRequest | undefined;
  t.mock.method(McpAPI, 'connect', async (data: McpRequest) => { payload = data; return connected; });
  const { value, scope } = state();
  try {
    Object.assign(value.mcpForm.value, { transport: 'stdio', commandLines: 'uvx\nwindows-mcp\nserve', envLines: 'NO_COLOR=1' });
    await value.handleConnectMcp();
    assert.deepEqual(payload?.command, ['uvx', 'windows-mcp', 'serve']);
    assert.deepEqual(payload?.env, { NO_COLOR: '1' });
    assert.equal(payload?.url, undefined);
  } finally { scope.stop(); }
});

test('连接期间拒绝重复测试与保存，修改配置后忽略迟到成功', async (t) => {
  let finish!: (result: Result<McpConnectionVO>) => void;
  const connect = t.mock.method(McpAPI, 'connect', () => new Promise<Result<McpConnectionVO>>(resolve => { finish = resolve; }));
  const add = t.mock.method(McpAPI, 'add', async () => ({ code: 1 }));
  const { value, scope } = state();
  try {
    const pending = value.handleConnectMcp();
    assert.equal(value.isConnectingMcp.value, true);
    await value.handleConnectMcp();
    await value.handleSaveMcp();
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(add.mock.callCount(), 0);
    value.mcpForm.value.url = 'http://different/mcp';
    finish(connected);
    await pending;
    assert.equal(value.mcpConnectionResult.value, null);
    assert.equal(value.isConnectingMcp.value, false);
  } finally { scope.stop(); }
});

test('业务失败与网络失败解除连接状态并显示错误，允许再次测试', async (t) => {
  const { value, scope } = state();
  const connect = t.mock.method(McpAPI, 'connect', async () => ({ code: 0, errMsg: 'MCP 连接失败' }));
  try {
    await value.handleConnectMcp();
    assert.equal(value.mcpConnectionError.value, 'MCP 连接失败');
    assert.equal(value.isConnectingMcp.value, false);
    connect.mock.mockImplementation(async () => { throw new Error('网络连接失败'); });
    await value.handleConnectMcp();
    assert.equal(value.mcpConnectionError.value, '网络连接失败');
    assert.equal(value.isConnectingMcp.value, false);
    connect.mock.mockImplementation(async () => { throw new ApiError('network', 'timeout exceeded'); });
    await value.handleConnectMcp();
    assert.equal(value.mcpConnectionError.value, '连接测试请求失败或超时，请检查后端是否可用');
    connect.mock.mockImplementation(async () => connected);
    await value.handleConnectMcp();
    assert.equal(value.mcpConnectionError.value, '');
    value.mcpForm.value.name = 'changed';
    assert.equal(value.mcpConnectionResult.value, null);
  } finally { scope.stop(); }
});

test('表单非法时不发送连接请求，取消后忽略迟到响应', async (t) => {
  let finish!: (result: Result<McpConnectionVO>) => void;
  const connect = t.mock.method(McpAPI, 'connect', () => new Promise<Result<McpConnectionVO>>(resolve => { finish = resolve; }));
  const { value, scope } = state();
  try {
    value.mcpForm.value.name = '';
    await value.handleConnectMcp();
    assert.equal(connect.mock.callCount(), 0);
    assert.match(value.mcpFormError.value, /服务名称/);
    value.mcpForm.value.name = 'draft';
    const pending = value.handleConnectMcp();
    value.cancelMcpForm();
    finish(connected);
    await pending;
    assert.equal(value.mcpConnectionResult.value, null);
  } finally { scope.stop(); }
});
