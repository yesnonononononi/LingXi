import test from 'node:test';
import assert from 'node:assert/strict';
import {effectScope} from 'vue';
import {McpAPI} from '../src/services/mcp';
import http, {ApiError} from '../src/services/interceptor';
import {useMcpTab} from '../src/views/settings/tabs/useMcpTab';
import {t as translate} from '../src/i18n';
import type {Result} from '../src/services/types';
import type {McpConnectionVO, McpRequest} from '../src/types/chat';

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

test('已保存和编辑中的服务均可测试，凭据由后端还原且不保存', async (t) => {
  const item = { id: '42', name: 'saved', url: 'http://saved/mcp', status: 0, headers: { Authorization: '******' } };
  let finish!: (result: Result<McpConnectionVO>) => void;
  const connect = t.mock.method(McpAPI, 'connect', (_data: McpRequest) => new Promise<Result<McpConnectionVO>>(resolve => { finish = resolve; }));
  const update = t.mock.method(McpAPI, 'update', async () => ({ code: 1 }));
  const { value, scope } = state();
  try {
    const pending = value.handleConnectSavedMcp(item);
    assert.equal(value.mcpRowConnections.value['42']?.loading, true);
    await value.handleConnectSavedMcp(item);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(connect.mock.calls[0]!.arguments[0].id, '42');
    assert.equal(connect.mock.calls[0]!.arguments[0].headers, undefined);
    finish(connected);
    await pending;
    assert.equal(value.mcpRowConnections.value['42']?.success, true);
    assert.equal(value.mcpRowConnections.value['42']?.loading, false);
    value.startEditMcp(item);
    value.mcpForm.value.url = 'http://edited/mcp';
    const editing = value.handleConnectMcp();
    assert.equal(connect.mock.calls[1]!.arguments[0].id, '42');
    assert.equal(connect.mock.calls[1]!.arguments[0].url, 'http://edited/mcp');
    assert.equal(connect.mock.calls[1]!.arguments[0].headers, undefined);
    finish(connected);
    await editing;
    assert.equal(update.mock.callCount(), 0);
    connect.mock.mockImplementation(async () => ({ code: 0, errMsg: '连接失败' }));
    await value.handleConnectSavedMcp(item);
    assert.deepEqual(value.mcpRowConnections.value['42'], { loading: false, success: false, error: '连接失败' });
    connect.mock.mockImplementation(() => new Promise<Result<McpConnectionVO>>(resolve => { finish = resolve; }));
    t.mock.method(McpAPI, 'list', async () => ({ code: 1, data: { records: [item], total: 1, current: 1, size: 100 } }));
    const stale = value.handleConnectSavedMcp(item);
    await value.loadMcp();
    finish(connected);
    await stale;
    assert.equal(value.mcpRowConnections.value['42'], undefined, '列表刷新后不能恢复旧配置的连接结果');
  } finally { scope.stop(); }
});

test('连接接口使用当前配置和足够的超时，不调用保存接口', async (t) => {
  let request: unknown[] = [];
  t.mock.method(http, 'post', async (...args: unknown[]) => { request = args; return connected; });
  const payload = { name: 'draft', initializationTimeout: 180_000, executionTimeout: 60_000 };
  assert.deepEqual(await McpAPI.connect(payload), connected);
  assert.deepEqual(request, ['/mcp/connect', payload, { timeout: 430_000 }]);
});

test('列表测试按传输方式提交参数：HTTP 空 command 不触发 stdio 校验', async (t) => {
  const requests: McpRequest[] = [];
  t.mock.method(McpAPI, 'connect', async (payload: McpRequest) => {
    requests.push(payload);
    return connected;
  });
  const { value, scope } = state();
  try {
    for (const transport of ['streamable-http', 'sse']) {
      await value.handleConnectSavedMcp({
        id: transport, name: 'http', transport, url: 'https://example.com/mcp', command: [],
      });
      const payload = requests.at(-1)!;
      assert.equal(payload.url, 'https://example.com/mcp');
      assert.equal(payload.command, undefined, 'HTTP 配置不能提交仓储返回的空 command');
    }
    await value.handleConnectSavedMcp({
      id: 'stdio', name: 'stdio', transport: 'stdio', url: '', command: ['python', 'server.py'],
    });
    assert.deepEqual(requests.at(-1)!.command, ['python', 'server.py']);
    assert.equal(requests.at(-1)!.url, undefined, 'stdio 配置不能提交无效的 HTTP 地址');
  } finally { scope.stop(); }
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

test('批量查询共享连接状态并支持重新连接已启用服务', async (t) => {
  const item = { id: '7', name: 'git', url: 'https://mcp.example.test/git', status: 1, initializationTimeout: 10_000, executionTimeout: 20_000 };
  t.mock.method(McpAPI, 'list', async () => ({ code: 1, data: { records: [item], total: 1, current: 1, size: 100 } }));
  const listStates = t.mock.method(McpAPI, 'listStates', async (ids: Array<number | string>) => ({
    code: 1,
    data: ids.map(id => ({ id, state: 'FAILED' as const, toolCount: null, error: 'ConnectException' })),
  }));
  const reconnect = t.mock.method(McpAPI, 'reconnect', async () => ({
    code: 1,
    data: { id: '7', state: 'CONNECTED' as const, toolCount: 4, error: null },
  }));
  const { value, scope } = state();
  try {
    await value.loadMcp();
    await Promise.resolve();
    assert.deepEqual(listStates.mock.calls[0]?.arguments[0], ['7']);
    assert.equal(value.mcpStates.value['7']?.state, 'FAILED');
    assert.equal(value.mcpStates.value['7']?.error, 'ConnectException');

    listStates.mock.mockImplementation(async (ids: Array<number | string>) => ({
      code: 1,
      data: ids.map(id => ({ id, state: 'CONNECTED' as const, toolCount: 4, error: null })),
    }));
    await value.handleReconnectMcp(item);
    assert.equal(reconnect.mock.callCount(), 1);
    assert.equal(value.mcpStates.value['7']?.state, 'CONNECTED');
    assert.equal(value.mcpStates.value['7']?.toolCount, 4);
    assert.equal(value.mcpToast.value, '已重新连接');

    // 未授权的 oauth 服务后端不会真的握手：这时报「已重新连接」是假话，提示必须指向「去授权」。
    reconnect.mock.mockImplementation(async () => ({
      code: 1,
      data: { id: '7', state: 'AUTHORIZATION_REQUIRED' as const, toolCount: null, error: '该服务需要登录授权' },
    }));
    await value.handleReconnectMcp(item);
    assert.equal(value.mcpToast.value, translate('settings.mcp.stateAuthorizationRequired'),
      '跳过连接时 toast 必须指向「去授权」，不能报已重新连接');
  } finally { scope.stop(); }
});

/**
 * 列表内启停：方向与 toast 必须出自同一个判定。
 *
 * <p>方向曾在 handler 里算两次（`nextEnabled` 一次、提交时再算一次），两处写法一改就
 * 会出现「提示已启用、实际下发 0」的自相矛盾。这里同时钉住下发值与 toast 文案。</p>
 */
test('列表内启停：停用下 1 提示已启用，启用下 0 提示已停用，且只提交 id/status', async (t) => {
  const update = t.mock.method(McpAPI, 'update', async () => ({ code: 1 }));
  t.mock.method(McpAPI, 'list', async () => ({
    code: 1, data: { records: [], total: 0, current: 1, size: 100 },
  }));
  const { value, scope } = state();
  try {
    await value.handleToggleMcp({ id: '81', name: 'github', status: 0 });
    assert.equal(update.mock.calls[0]!.arguments[0].status, 1, '停用的服务必须下发 1');
    assert.equal(value.mcpToast.value, translate('settings.mcp.toastEnabled'),
      'toast 必须与下发的 status 一致：下发 1 就说「已启用」');
    const firstKeys = Object.keys(update.mock.calls[0]!.arguments[0]).sort();
    assert.deepEqual(firstKeys, ['id', 'status'], `启停只能提交 id 与 status，实际 ${JSON.stringify(firstKeys)}`);

    await value.handleToggleMcp({ id: '82', name: 'context7', status: 1 });
    assert.equal(update.mock.calls[1]!.arguments[0].status, 0, '启用的服务必须下发 0');
    assert.equal(value.mcpToast.value, translate('settings.mcp.toastDisabled'),
      'toast 必须与下发的 status 一致：下发 0 就说「已停用」');

    await value.handleToggleMcp({ id: '83', name: 'legacy' });
    assert.equal(update.mock.calls[2]!.arguments[0].status, 0,
      'status 缺省按已启用处理，下发 0，不得回写 1');
    assert.equal(value.mcpToast.value, translate('settings.mcp.toastDisabled'));
  } finally {
    scope.stop();
  }
});
