import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
  BROWSER_MCP_SERVER_NAME,
  buildBrowserMcpRequest,
  findBrowserMcpRecord,
} from '../src/composables/useBrowserMcp';

const {createBrowserMcpServer, TOOL_DEFINITIONS, DESIGN_TOOL_DEFINITIONS} = createRequire(import.meta.url)(
  '../electron/browser-mcp-server.cjs',
);
const {registerDesignMcpBridge, DESIGN_MCP_CHANNELS} = createRequire(import.meta.url)(
  '../electron/design-mcp-bridge.cjs',
);

// 桥接器会拒收 8 字节空图（PNG 签名），这里给一份够大的假图
const PNG_STUB = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 0x41),
]);

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
    wait: async (args: unknown) => {
      calls.push({method: 'wait', args});
      return {ok: true, waitedMs: 120};
    },
    scroll: async (args: unknown) => {
      calls.push({method: 'scroll', args});
      return {ok: true, scrollTop: 400, atBottom: false};
    },
    screenshot: async (args: unknown) => {
      calls.push({method: 'screenshot', args});
      return {
        images: [{data: 'iVBORw0KGgo=', mimeType: 'image/png'}],
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        width: 800,
        height: 600,
        filePath: '/tmp/shot.png',
      };
    },
    console: async (args: unknown) => {
      calls.push({method: 'console', args});
      return {tabId: 'tab-1', totalCount: 1, entries: [{level: 'error', message: 'Uncaught ReferenceError'}]};
    },
    network: async (args: unknown) => {
      calls.push({method: 'network', args});
      return {
        tabId: 'tab-1',
        totalCount: 1,
        entries: [{
          id: 'req-1',
          method: 'GET',
          url: 'https://example.com/api',
          statusCode: 500,
          ok: false,
          contentType: 'application/json',
          requestHeaders: {'x-test': '1'},
          responseHeaders: {'content-type': 'application/json'},
          bodyPreview: '{"error":"boom"}',
        }],
      };
    },
    networkDetail: async (args: unknown) => {
      calls.push({method: 'networkDetail', args});
      return {
        tabId: 'tab-1',
        id: 'req-1',
        method: 'GET',
        url: 'https://example.com/api',
        statusCode: 500,
        ok: false,
        contentType: 'application/json',
        requestHeaders: {'x-test': '1'},
        responseHeaders: {'content-type': 'application/json'},
        requestBody: '',
        responseBody: '{"error":"boom"}',
        totalBodyLength: 16,
        offset: 0,
        truncated: false,
        base64Encoded: false,
      };
    },
    evaluate: async (args: unknown) => {
      calls.push({method: 'evaluate', args});
      return {ok: true, type: 'string', result: '"ok"', truncated: false};
    },
    pressKey: async (args: unknown) => {
      calls.push({method: 'pressKey', args});
      return {ok: true, key: 'Escape', modifiers: []};
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
      [
        'browser_navigate',
        'browser_click',
        'browser_fill',
        'browser_query',
        'browser_screenshot',
        'browser_tabs',
        'browser_wait',
        'browser_scroll',
        'browser_console',
        'browser_network',
        'browser_network_detail',
        'browser_evaluate',
        'browser_press_key',
      ],
    );

    // 5. tools/call: click + wait + scroll + screenshot
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
        params: {name: 'browser_click', arguments: {selector: '.submit-btn', text: '提交'}},
      }),
    });
    const clickJson = await clickRes.json() as {result: {isError: boolean; content: Array<{type: string; text: string}>}};
    assert.equal(clickJson.result.isError, false);
    assert.equal(automation.calls.at(-1)?.method, 'click');

    const waitRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {name: 'browser_wait', arguments: {selector: '.toast-success', timeoutMs: 3000}},
      }),
    });
    const waitJson = await waitRes.json() as {result: {isError: boolean}};
    assert.equal(waitJson.result.isError, false);
    assert.equal(automation.calls.at(-1)?.method, 'wait');

    const scrollRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {name: 'browser_scroll', arguments: {direction: 'down'}},
      }),
    });
    const scrollJson = await scrollRes.json() as {result: {isError: boolean}};
    assert.equal(scrollJson.result.isError, false);
    assert.equal(automation.calls.at(-1)?.method, 'scroll');

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

    // 6. browser_screenshot 支持传入 savePath、viewportWidth、viewportHeight、fullPage，透传给 automation.screenshot
    const screenshotDef = TOOL_DEFINITIONS.find((t: {name: string}) => t.name === 'browser_screenshot');
    assert.ok(screenshotDef?.inputSchema?.properties?.viewportWidth);
    assert.ok(screenshotDef?.inputSchema?.properties?.viewportHeight);
    assert.ok(screenshotDef?.inputSchema?.properties?.fullPage);

    const saveRes = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'browser_screenshot',
          arguments: {
            savePath: 'D:/workspace/shot.png',
            viewportWidth: 1440,
            viewportHeight: 900,
            fullPage: true,
          },
        },
      }),
    });
    const saveJson = await saveRes.json() as {result: {isError: boolean}};
    assert.equal(saveJson.result.isError, false);
    const lastArgs = automation.calls.at(-1)?.args as {
      savePath?: string;
      viewportWidth?: number;
      viewportHeight?: number;
      fullPage?: boolean;
    };
    assert.equal(lastArgs?.savePath, 'D:/workspace/shot.png');
    assert.equal(lastArgs?.viewportWidth, 1440);
    assert.equal(lastArgs?.viewportHeight, 900);
    assert.equal(lastArgs?.fullPage, true);
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
  assert.ok(
    (req.description?.length ?? 0) <= 200,
    `BROWSER_MCP_DESCRIPTION 长度 ${req.description?.length} 超过后端 Mcp.DESCRIPTION_MAX_LENGTH(200)`,
  );

  const found = findBrowserMcpRecord([
    {id: 1, name: 'other'},
    {id: 2, name: BROWSER_MCP_SERVER_NAME, status: 1},
  ]);
  assert.equal(found?.id, 2);
});

test('Browser MCP 新增调试原语（console/network/evaluate/press_key）与 ref 参数分派', async () => {
  const automation = createMockAutomation();
  const mcpServer = createBrowserMcpServer({automation});
  const status = await mcpServer.start();
  const postTool = async (id: number, name: string, args: Record<string, unknown>) => {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${status.token}`,
      },
      body: JSON.stringify({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}}),
    });
    return res.json() as Promise<{result: {isError: boolean; content: Array<{type: string; text?: string}>}}>;
  };
  try {
    const refClick = await postTool(10, 'browser_click', {ref: 'e3'});
    assert.equal(refClick.result.isError, false);
    assert.deepEqual(automation.calls.at(-1), {method: 'click', args: {ref: 'e3'}});

    const refFill = await postTool(11, 'browser_fill', {ref: 'e2', value: 'hello'});
    assert.equal(refFill.result.isError, false);
    assert.deepEqual(automation.calls.at(-1), {method: 'fill', args: {ref: 'e2', value: 'hello'}});

    const consoleRes = await postTool(12, 'browser_console', {level: 'error', limit: 20});
    assert.equal(consoleRes.result.isError, false);
    assert.equal(automation.calls.at(-1)?.method, 'console');
    assert.match(consoleRes.result.content[0]?.text || '', /ReferenceError/);

    const networkRes = await postTool(13, 'browser_network', {onlyErrors: true});
    assert.equal(networkRes.result.isError, false);
    assert.equal(automation.calls.at(-1)?.method, 'network');
    assert.match(networkRes.result.content[0]?.text || '', /500/);

    const networkDetailRes = await postTool(131, 'browser_network_detail', {requestId: 'req-1', offset: 0, maxLength: 100});
    assert.equal(networkDetailRes.result.isError, false);
    assert.deepEqual(automation.calls.at(-1), {method: 'networkDetail', args: {requestId: 'req-1', offset: 0, maxLength: 100}});
    assert.match(networkDetailRes.result.content[0]?.text || '', /boom/);

    // 校验 screenshot savePath 与 design_capture saveDir 参数说明明确告知临时目录默认行为及工作区直存建议
    const shotSchema = (TOOL_DEFINITIONS.find((t: {name: string}) => t.name === 'browser_screenshot') as {
      inputSchema: {properties: {savePath: {description: string}}};
    }).inputSchema;
    assert.match(shotSchema.properties.savePath.description, /temporary directory/i);
    assert.match(shotSchema.properties.savePath.description, /workspace/i);
    const designCapSchema = (DESIGN_TOOL_DEFINITIONS.find((t: {name: string}) => t.name === 'design_capture') as {
      inputSchema: {properties: {saveDir: {description: string}}};
    }).inputSchema;
    assert.match(designCapSchema.properties.saveDir.description, /temporary directory/i);
    assert.match(designCapSchema.properties.saveDir.description, /workspace/i);

    const evalRes = await postTool(14, 'browser_evaluate', {expression: 'document.title'});
    assert.equal(evalRes.result.isError, false);
    assert.equal(automation.calls.at(-1)?.method, 'evaluate');

    const keyRes = await postTool(15, 'browser_press_key', {key: 'Escape', modifiers: ['shift']});
    assert.equal(keyRes.result.isError, false);
    assert.deepEqual(automation.calls.at(-1), {method: 'pressKey', args: {key: 'Escape', modifiers: ['shift']}});
  } finally {
    await mcpServer.stop();
  }
});

test('Design × MCP 联动闭环：design_get_state、design_capture 多视口截图与 design_resolve_comment', async () => {
  const automation = createMockAutomation();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const mockIpcMain = {
    on: (ch: string, fn: (...args: unknown[]) => void) => listeners.set(ch, fn),
    removeListener: (ch: string) => listeners.delete(ch),
  };

  let resolvedIds: string[] = [];
  const mockWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, req: {requestId: string; action: string; payload?: Record<string, unknown>}) => {
        assert.equal(channel, DESIGN_MCP_CHANNELS.request);
        const respond = listeners.get(DESIGN_MCP_CHANNELS.response);
        assert.ok(respond);
        if (req.action === 'get_state') {
          respond({}, {
            requestId: req.requestId,
            ok: true,
            data: {
              active: true,
              fileName: 'landing.html',
              boundPath: '.lingxi/design/landing.html',
              viewportWidth: '100%',
              selected: {selector: 'body > header > button.cta', label: 'button.cta'},
              comments: [{id: 'c1', selector: 'body > h1', elementLabel: 'h1', text: '字号加大', resolved: false}],
              html: req.payload?.includeHtml ? '<!DOCTYPE html><html><body><h1>Hi</h1></body></html>' : undefined,
            },
          });
        } else if (req.action === 'resolve_comment') {
          if (req.payload?.commentId) resolvedIds.push(String(req.payload.commentId));
          respond({}, {requestId: req.requestId, ok: true, data: {resolvedCount: 1, remainingCount: 0}});
        }
      },
    },
  };

  const renderedViewports: Array<{width: number; height: number}> = [];
  const designBridge = registerDesignMcpBridge({
    ipcMain: mockIpcMain,
    getWindow: () => mockWindow,
    renderHtmlViewport: async ({width, height}: {width: number; height: number}) => {
      renderedViewports.push({width, height});
      return {
        width,
        height,
        mimeType: 'image/png',
        base64: PNG_STUB.toString('base64'),
        pngBuffer: PNG_STUB,
      };
    },
  });

  const mcpServer = createBrowserMcpServer({automation, designBridge});
  const status = await mcpServer.start();
  const postRpc = async (id: number, method: string, params?: Record<string, unknown>) => {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${status.token}`},
      body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
    });
    return res.json() as Promise<{result: {tools?: Array<{name: string}>; isError?: boolean; content?: Array<{type: string; text?: string; data?: string}>}}>;
  };

  try {
    // 1. tools/list 应自动包含 3 个 design_* 工具
    const listJson = await postRpc(1, 'tools/list');
    assert.equal(listJson.result.tools?.length, TOOL_DEFINITIONS.length + DESIGN_TOOL_DEFINITIONS.length);
    const names = (listJson.result.tools || []).map(item => item.name);
    assert.ok(names.includes('design_get_state'));
    assert.ok(names.includes('design_capture'));
    assert.ok(names.includes('design_resolve_comment'));

    // 2. design_get_state 返回选中元素与批注
    const stateJson = await postRpc(2, 'tools/call', {name: 'design_get_state', arguments: {}});
    assert.equal(stateJson.result.isError, false);
    assert.match(stateJson.result.content?.[0]?.text || '', /\.lingxi\/design\/landing\.html/);
    assert.match(stateJson.result.content?.[0]?.text || '', /字号加大/);

    // 3. design_capture 默认生成桌面 + 移动两张 PNG 图片块
    const capJson = await postRpc(3, 'tools/call', {name: 'design_capture', arguments: {}});
    assert.equal(capJson.result.isError, false);
    const imageBlocks = (capJson.result.content || []).filter(item => item.type === 'image');
    assert.equal(imageBlocks.length, 2);
    assert.deepEqual(renderedViewports, [
      {width: 1280, height: 800},
      {width: 390, height: 844},
    ]);

    // 4. design_resolve_comment 正确转发到渲染层
    const resolveJson = await postRpc(4, 'tools/call', {name: 'design_resolve_comment', arguments: {commentId: 'c1'}});
    assert.equal(resolveJson.result.isError, false);
    assert.deepEqual(resolvedIds, ['c1']);
  } finally {
    designBridge.close();
    await mcpServer.stop();
  }
});

test('内置浏览器 MCP 断线防护：keepAliveTimeout 放宽且重连/测试前自动同步最新端口与 Token', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const serverCode = fs.readFileSync(path.resolve(dir, '../electron/browser-mcp-server.cjs'), 'utf8');
  const tabCode = fs.readFileSync(path.resolve(dir, '../src/views/settings/tabs/useMcpTab.ts'), 'utf8');
  const hookCode = fs.readFileSync(path.resolve(dir, '../src/composables/useBrowserMcp.ts'), 'utf8');

  assert.match(serverCode, /keepAliveTimeout\s*=\s*65_000/);
  assert.match(hookCode, /export async function syncBrowserMcpRecord/);
  assert.match(hookCode, /retryDelaysMs/);
  assert.match(tabCode, /syncBrowserMcpRecord\(item\)/);
});
