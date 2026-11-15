import test from 'node:test';
import assert from 'node:assert/strict';
import {effectScope} from 'vue';
import {createRequire} from 'node:module';
import {McpAPI} from '../src/services/mcp';
import {useMcpTab} from '../src/views/settings/tabs/useMcpTab';
import {isMcpAuthorizationRequired} from '../src/utils/mcpStatus';
import {t as translate} from '../src/i18n';
import type {Result} from '../src/services/types';
import type {McpConnectionStateVO, McpRequest} from '../src/types/chat';

/**
 * MCP OAuth 授权：设置页的授权动作与 auth 字段的提交契约。
 *
 * <p>缺陷现场：远程 MCP 服务返回 401 时后端只能报「连接失败」，界面没有去授权的入口，
 * 浏览器永远不会被拉起来。这里钉住三件事 —— 授权地址只开一次窗口、回调完成后自动重连、
 * 授权参数如实下发（含「改回静态凭据」这种反向路径）。</p>
 */

const requireCjs = createRequire(import.meta.url);

const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  readSource: (relativeFromTests: string) => string;
};

const connectedState: Result<McpConnectionStateVO> = {
  code: 1, data: {id: '9', state: 'CONNECTED', toolCount: 3, error: null},
};

function mountTab() {
  const scope = effectScope();
  const value = scope.run(() => useMcpTab())!;
  return {value, scope};
}

/** 表单填写一份可提交的 http 服务，只留认证相关字段给用例改写。 */
function fillDraft(value: ReturnType<typeof useMcpTab>) {
  value.startAddMcp();
  value.mcpForm.value.name = 'linear';
  value.mcpForm.value.url = 'https://mcp.linear.app/mcp';
  return value;
}

/** 只把轮询用的 2s 定时器换成微任务；其它定时器（toast 自清）不排期，方便断言当前文案。 */
function stubTimers(t: {after: (fn: () => void) => void}) {
  const realSetTimeout = globalThis.setTimeout;
  const fake = ((handler: () => void, delay?: number) => {
    if (delay === 2000) void Promise.resolve().then(handler);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.setTimeout = fake;
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    if (realWindow) Object.defineProperty(globalThis, 'window', realWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
}

const openedUrls: string[] = [];

function stubBrowser(t: {after: (fn: () => void) => void}) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {open: (url: string) => { openedUrls.push(url); return null; }},
  });
  t.after(() => { openedUrls.length = 0; });
}

test('OAuth 表单：授权参数如实下发，留空项落 null 而不是空串', async (t) => {
  const saved: McpRequest[] = [];
  t.mock.method(McpAPI, 'add', async (data: McpRequest) => { saved.push(data); return {code: 1}; });
  t.mock.method(McpAPI, 'list', async () => ({code: 1, data: {records: [], total: 0, current: 1, size: 100}}));
  t.mock.method(McpAPI, 'listStates', async () => ({code: 1, data: []}));
  const {value, scope} = mountTab();
  try {
    fillDraft(value);
    value.mcpForm.value.authMode = 'oauth';
    value.mcpForm.value.authClientId = '  client-1 ';
    value.mcpForm.value.authScopes = 'mcp:read, mcp:write  offline';
    value.mcpForm.value.authServer = 'https://auth.example.com';
    await value.handleSaveMcp();
    assert.equal(saved.length, 1, '合法配置必须提交');
    assert.deepEqual(saved[0]!.auth, {
      mode: 'oauth',
      clientId: 'client-1',
      scopes: ['mcp:read', 'mcp:write', 'offline'],
      authorizationServer: 'https://auth.example.com',
    }, `授权参数必须逐项下发，实际 ${JSON.stringify(saved[0]!.auth)}`);

    value.startAddMcp();
    value.mcpForm.value.name = 'plain';
    value.mcpForm.value.url = 'https://mcp.example.com/mcp';
    value.mcpForm.value.authMode = 'oauth';
    await value.handleSaveMcp();
    assert.deepEqual(saved[1]!.auth, {mode: 'oauth', clientId: null, scopes: [], authorizationServer: null},
      '三项可选参数留空必须落 null / 空数组，交给服务端发现');
  } finally { scope.stop(); }
});

test('认证方式改回静态凭据时显式下发 none：否则库里会一直留着 oauth', async (t) => {
  const updated: McpRequest[] = [];
  t.mock.method(McpAPI, 'update', async (data: McpRequest) => { updated.push(data); return {code: 1}; });
  t.mock.method(McpAPI, 'list', async () => ({code: 1, data: {records: [], total: 0, current: 1, size: 100}}));
  t.mock.method(McpAPI, 'listStates', async () => ({code: 1, data: []}));
  const {value, scope} = mountTab();
  try {
    value.startEditMcp({
      id: '7', name: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.app/mcp', status: 1,
      auth: {mode: 'oauth', clientId: 'client-1', scopes: ['mcp:read'], authorizationServer: null},
    });
    assert.equal(value.mcpForm.value.authMode, 'oauth', '编辑时必须回填 OAuth 模式');
    assert.equal(value.mcpForm.value.authClientId, 'client-1');
    assert.equal(value.mcpForm.value.authScopes, 'mcp:read');

    value.mcpForm.value.authMode = 'none';
    await value.handleSaveMcp();
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0]!.auth, {mode: 'none', clientId: null, scopes: [], authorizationServer: null},
      `切回静态凭据必须显式提交 none，实际 ${JSON.stringify(updated[0]!.auth)}`);
  } finally { scope.stop(); }
});

test('stdio 服务按 none 提交：表单里根本看不到认证方式，就不能替用户留一个改不掉的 oauth', async (t) => {
  const saved: McpRequest[] = [];
  t.mock.method(McpAPI, 'add', async (data: McpRequest) => { saved.push(data); return {code: 1}; });
  t.mock.method(McpAPI, 'list', async () => ({code: 1, data: {records: [], total: 0, current: 1, size: 100}}));
  t.mock.method(McpAPI, 'listStates', async () => ({code: 1, data: []}));
  const {value, scope} = mountTab();
  try {
    value.startAddMcp();
    value.mcpForm.value.name = 'local';
    value.mcpForm.value.transport = 'stdio';
    value.mcpForm.value.commandLines = 'npx.cmd\n-y\n@playwright/mcp@latest';
    value.mcpForm.value.authMode = 'oauth';
    value.mcpForm.value.authServer = 'https://auth.example.com';
    await value.handleSaveMcp();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.auth?.mode, 'none', 'stdio 下必须按 none 提交');
  } finally { scope.stop(); }
});

test('授权服务器地址不是 http(s) 时拦在表单里，不发请求', async (t) => {
  const add = t.mock.method(McpAPI, 'add', async () => ({code: 1}));
  const {value, scope} = mountTab();
  try {
    fillDraft(value);
    value.mcpForm.value.authMode = 'oauth';
    value.mcpForm.value.authServer = 'ftp://auth.example.com';
    await value.handleSaveMcp();
    assert.equal(add.mock.callCount(), 0, '非法地址不得提交');
    assert.equal(value.mcpFormError.value, translate('settings.mcp.errAuthServerScheme'));
  } finally { scope.stop(); }
});

test('去授权：只开一次浏览器窗口，轮询到 AUTHORIZED 后自动重建连接', async (t) => {
  stubTimers(t);
  stubBrowser(t);
  const authorize = t.mock.method(McpAPI, 'authorizeById', async () => ({code: 1, data: 'https://auth.example.com/authorize?state=x'}));
  let polls = 0;
  t.mock.method(McpAPI, 'oauthState', async () => {
    polls += 1;
    return {code: 1, data: {state: polls < 2 ? 'PENDING' : 'AUTHORIZED', errMsg: null}};
  });
  const reconnect = t.mock.method(McpAPI, 'reconnect', async () => connectedState);
  t.mock.method(McpAPI, 'listStates', async () => ({code: 1, data: []}));
  const {value, scope} = mountTab();
  try {
    await value.handleAuthorizeMcp({id: '9', name: 'linear', status: 1});
    assert.equal(authorize.mock.callCount(), 1);
    assert.deepEqual(openedUrls, ['https://auth.example.com/authorize?state=x'],
      `浏览器必须拿到后端拼好的授权地址，实际 ${JSON.stringify(openedUrls)}`);
    assert.equal(reconnect.mock.callCount(), 1, '授权完成后必须自动重建连接，否则工具仍然不可用');
    assert.equal(value.mcpAuthorizing.value['9'], false, '结束后必须解除 busy，否则按钮永远点不动');
  } finally { scope.stop(); }
});

test('授权失败：不重建连接，给出可重试的提示', async (t) => {
  stubTimers(t);
  stubBrowser(t);
  t.mock.method(McpAPI, 'authorizeById', async () => ({code: 1, data: 'https://auth.example.com/authorize?state=x'}));
  t.mock.method(McpAPI, 'oauthState', async () => ({code: 1, data: {state: 'FAILED', errMsg: '授权未完成'}}));
  const reconnect = t.mock.method(McpAPI, 'reconnect', async () => connectedState);
  t.mock.method(McpAPI, 'listStates', async () => ({code: 1, data: []}));
  const {value, scope} = mountTab();
  try {
    await value.handleAuthorizeMcp({id: '9', name: 'linear', status: 1});
    assert.equal(reconnect.mock.callCount(), 0, '没拿到令牌就重连只会再吃一次 401');
    assert.equal(value.mcpToast.value, translate('settings.mcp.errAuthorize'));
  } finally { scope.stop(); }
});

test('授权中连点只发起一次：否则浏览器会被开出好几个窗口并互相覆盖令牌', async (t) => {
  stubTimers(t);
  stubBrowser(t);
  let finish!: (result: Result<string>) => void;
  const authorize = t.mock.method(McpAPI, 'authorizeById', () =>
    new Promise<Result<string>>(resolve => { finish = resolve; }));
  t.mock.method(McpAPI, 'oauthState', async () => ({code: 1, data: {state: 'AUTHORIZED', errMsg: null}}));
  t.mock.method(McpAPI, 'reconnect', async () => connectedState);
  t.mock.method(McpAPI, 'listStates', async () => ({code: 1, data: []}));
  const {value, scope} = mountTab();
  try {
    const first = value.handleAuthorizeMcp({id: '9', name: 'linear', status: 1});
    await value.handleAuthorizeMcp({id: '9', name: 'linear', status: 1});
    assert.equal(value.mcpAuthorizing.value['9'], true, '等待回调期间该行必须保持 busy');
    assert.equal(authorize.mock.callCount(), 1, `连点只能发起一次授权，实际 ${authorize.mock.callCount()}`);
    finish({code: 1, data: 'https://auth.example.com/authorize?state=x'});
    await first;
    assert.deepEqual(openedUrls, ['https://auth.example.com/authorize?state=x']);
  } finally { scope.stop(); }
});

/**
 * 卡片与设置页的接线（源码级锚点）。
 *
 * <p>为什么不用挂载用例：本地 harness 把 `LxListCard` 桩成「只透传默认插槽」，
 * 卡片的状态徽标与操作条（`#header` / `#actions`）根本不会渲染，挂上去只能测到假绿。
 * 真实渲染的用例在 `mcpConnectComponent.test.ts`，但它盯的是连接测试那条链路。</p>
 */
test('服务卡片：授权按钮只在需要授权的行出现，点击 emit authorize 并带 busy 态', () => {
  const card = harness.readSource('../src/views/settings/tabs/McpServiceCard.vue');
  assert.match(card, /v-if="item\.status !== 0 && statusKind === 'AUTHORIZATION_REQUIRED'"/,
    '授权按钮必须以运行态为条件，写宽了连正常的服务也会冒出「去授权」');
  assert.match(card, /data-testid="mcp-authorize"[\s\S]{0,240}@click="emit\('authorize', item\)"/,
    '授权按钮必须 emit authorize，否则点了什么都不会发生');
  assert.match(card, /:disabled="authorizing"/, '等待回调期间必须 disabled，连点会开出多个浏览器窗口');
  assert.match(card, /authorizing \? t\('settings\.mcp\.authorizing'\) : t\('settings\.mcp\.authorize'\)/,
    '进行中文案必须换成「等待授权」，否则用户以为没点到');

  const tab = harness.readSource('../src/views/settings/tabs/McpTab.vue');
  assert.match(tab, /:authorizing="!!mcpAuthorizing\[item\.id\]"/, '卡片必须拿到该行的授权 busy 态');
  assert.match(tab, /@authorize="handleAuthorizeMcp"/, '卡片事件必须接到 useMcpTab 的授权动作');
});

test('轮询必须能被卸载打断：关掉设置页后还在打后端就是泄漏', () => {
  const source = harness.readSource('../src/views/settings/tabs/useMcpTab.ts');
  assert.match(source, /let disposed = false/, '缺少卸载标记');
  assert.match(source, /while \(!disposed && Date\.now\(\) < deadline\)/,
    '轮询循环条件必须包含 disposed，否则组件销毁后仍会继续请求');
  assert.match(source, /onBeforeUnmount\(\(\) => \{\s*\n\s*disposed = true;/,
    'onBeforeUnmount 必须先把 disposed 置位');
});

test('授权判定与启停方向互不污染：AUTHORIZATION_REQUIRED 只是运行态的一种', () => {
  assert.equal(isMcpAuthorizationRequired('AUTHORIZATION_REQUIRED'), true);
  assert.equal(isMcpAuthorizationRequired('CONNECTED'), false);
  assert.equal(isMcpAuthorizationRequired('FAILED'), false);
  assert.equal(isMcpAuthorizationRequired(null), false);
  assert.equal(isMcpAuthorizationRequired(undefined), false);
});

/**
 * 缺陷现场：切到 OAuth 时自动摊开「高级选项」，于是在静态凭据与 OAuth 之间来回切，
 * 面板反复弹开又收回，把下面几行输入一起顶走。开合只允许由「进入编辑态」决定一次。
 */
test('切换认证方式不得自动展开高级选项：开合只由编辑态决定', () => {
  const tab = harness.readSource('../src/views/settings/tabs/McpTab.vue');
  const writes = tab.match(/isAdvancedOpen\.value\s*=/g) ?? [];
  assert.equal(writes.length, 1,
    '只允许编辑态入口写 isAdvancedOpen，多出来的 watcher 会让面板在切认证方式时自己弹开');
  assert.doesNotMatch(tab, /watch\(\s*\(\)\s*=>\s*mcpForm\.value\.(authMode|transport)/,
    '认证方式/传输方式的变化不得触发高级选项展开');
});
