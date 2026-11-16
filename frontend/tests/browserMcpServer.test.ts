import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
  BROWSER_MCP_SERVER_NAME,
  buildBrowserMcpRequest,
  findBrowserMcpRecord,
} from '../src/composables/useBrowserMcp';

const {createBrowserMcpServer, TOOL_DEFINITIONS} = createRequire(import.meta.url)(
  '../electron/browser-mcp-server.cjs',
);

function createMockAutomation() {
  const calls: Array<{method: string; args: unknown}> = [];
  return {
    calls,
    listTabs: async () => {
      calls.push({method: 'listTabs', args: null});
      return {activeTabId: 'tab-1', tabs: [{id: 'tab-1', url: 'https://example.com', title: 'Example'}]};
    },
    navigate: async (args: unknown) => {
      calls.push({method: 'navigate', args});
      return {tabId: 'tab-1', url: (args as {url: string}).url, title: 'Example', loadState: 'loaded'};
    },
    activateTab: async (tabId: string) => {
      calls.push({method: 'activateTab', args: tabId});
      return {activeTabId: tabId};
    },
    closeTab: async (tabId: string) => {
      calls.push({method: 'closeTab', args: tabId});
      return {closed: tabId};
    },
    click: async (args: unknown) => {
      calls.push({method: 'click', args});
      return {ok: true, tag: 'button', className: 'submit-btn'};
    },
    fill: async (args: unknown) => {
      calls.push({method: 'fill', args});
      return {ok: true, tag: 'input', valueLength: 5};
    },
    query: async (args: unknown) => {
      calls.push({method: 'query', args});
      return {url: 'https://example.com', title: 'Example', elements: [{index: 0, tag: 'button', className: 'submit-btn'}]};
    },
    screenshot: async (args: unknown) => {
      calls.push({method: 'screenshot', args});
      return {
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        base64: 'iVBORw0KGgo=',
        filePath: '/tmp/shot.png',
      };
    },
  };
}

test('Browser MCP Server：鉴权、握手、工具清单与调用分派', async () => {
  const automation = createMockAutomation();
  const mcpServer = createBrowserMcpServer({automation});
  const status = await mcpServer.start();
  try {
    assert.equal(status.running, true);
    assert.ok(status.port > 0);
    assert.equal(status.url, `http://127.0.0.1:${status.port}/mcp`);
    assert.ok(status.token.length >= 32);

    // 1. 无鉴权请求必须被拒绝
    const unauth = await fetch(status.url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    assert.equal(unauth.status, 401);

    // 2. initialize 握手
    const initRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {protocolVersion: '2025-11-25', clientInfo: {name: 'test', version: '1.0'}},
      }),
    });
    assert.equal(initRes.status, 200);
    assert.ok(initRes.headers.get('mcp-session-id'));
    const initJson = await initRes.json() as {result: {protocolVersion: string; serverInfo: {name: string}}};
    assert.equal(initJson.result.protocolVersion, '2025-11-25');
    assert.equal(initJson.result.serverInfo.name, 'lingxi-browser-mcp');

    // 3. notifications/initialized 返回 202
    const notifyRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
    });
    assert.equal(notifyRes.status, 202);

    // 4. tools/list 返回 6 个结构化工具
    const listRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
    });
    const listJson = await listRes.json() as {result: {tools: Array<{name: string}>}};
    assert.equal(listJson.result.tools.length, TOOL_DEFINITIONS.length);
    assert.deepEqual(
      listJson.result.tools.map(item => item.name),
      ['browser_navigate', 'browser_click', 'browser_fill', 'browser_query', 'browser_screenshot', 'browser_tabs'],
    );

    // 5. tools/call: click + screenshot
    const clickRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {name: 'browser_click', arguments: {selector: '.submit-btn'}},
      }),
    });
    const clickJson = await clickRes.json() as {result: {isError: boolean; content: Array<{type: string; text: string}>}};
    assert.equal(clickJson.result.isError, false);
    assert.equal(automation.calls.at(-1)?.method, 'click');

    const shotRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {name: 'browser_screenshot', arguments: {}},
      }),
    });
    const shotJson = await shotRes.json() as {
      result: {isError: boolean; content: Array<{type: string; data?: string; mimeType?: string; text?: string}>};
    };
    assert.equal(shotJson.result.isError, false);
    assert.equal(shotJson.result.content[0].type, 'image');
    assert.equal(shotJson.result.content[0].data, 'iVBORw0KGgo=');
    assert.equal(shotJson.result.content[1].type, 'text');
    assert.match(shotJson.result.content[1].text || '', /shot\.png/);
  } finally {
    const stopped = await mcpServer.stop();
    assert.equal(stopped.running, false);
    assert.equal(stopped.url, '');
  }
});

test('Browser MCP 配置构建：遵循 streamable-http 与关闭自动健康检查约定', () => {
  const req = buildBrowserMcpRequest('http://127.0.0.1:45678/mcp', 'secret-token');
  assert.equal(req.name, BROWSER_MCP_SERVER_NAME);
  assert.equal(req.transport, 'streamable-http');
  assert.equal(req.status, 1);
  assert.equal(req.autoHealthCheck, false);
  assert.equal(req.protocolVersion, '2025-11-25');
  assert.equal(req.headers?.Authorization, 'Bearer secret-token');

  const found = findBrowserMcpRecord([
    {id: 1, name: 'other'},
    {id: 2, name: BROWSER_MCP_SERVER_NAME, status: 1},
  ]);
  assert.equal(found?.id, 2);
});
