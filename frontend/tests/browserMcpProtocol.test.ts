import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';

const requireCjs = createRequire(import.meta.url);
const {createBrowserMcpServer} = requireCjs('../electron/browser-mcp-server.cjs');

const automation = {
  listTabs: async () => ({activeTabId: 'tab-1', tabs: [{id: 'tab-1', url: 'https://example.com', title: 'Example'}]}),
  click: async () => ({ok: true}),
};

/** 原始 HTTP 请求：要伪造 Host、发超大 body、留 keep-alive 连接，fetch 都插不了手。 */
function rawRequest(options: {port: number; path?: string; method?: string; headers?: Record<string, string>; body?: string; agent?: http.Agent}) {
  return new Promise<{status: number; headers: http.IncomingHttpHeaders; text: string}>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: options.port,
      path: options.path ?? '/mcp',
      method: options.method ?? 'POST',
      headers: options.headers ?? {},
      agent: options.agent,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(options.body ?? '');
  });
}

test('Browser MCP 协议边角：Host 校验、路径、方法、会话与请求体上限', async () => {
  const server = createBrowserMcpServer({automation});
  const status = await server.start();
  const auth = {Authorization: `Bearer ${status.token}`, 'Content-Type': 'application/json'};
  try {
    // 1. Host 不是回环：防 DNS rebinding，直接 403（哪怕 Token 对）
    const badHost = await rawRequest({
      port: status.port,
      headers: {...auth, Host: 'evil.example.com'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    assert.equal(badHost.status, 403);

    // 2. 路径不对 → 404
    const badPath = await rawRequest({
      port: status.port,
      path: '/other',
      headers: {Host: `127.0.0.1:${status.port}`, ...auth},
      body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'}),
    });
    assert.equal(badPath.status, 404);

    // 3. GET → 405，且带 Allow
    const getRes = await rawRequest({
      port: status.port,
      method: 'GET',
      headers: {Host: `127.0.0.1:${status.port}`, ...auth},
    });
    assert.equal(getRes.status, 405);
    assert.match(String(getRes.headers.allow), /POST/);

    // 4. 未知方法 → JSON-RPC -32601
    const unknown = await rawRequest({
      port: status.port,
      headers: {Host: `127.0.0.1:${status.port}`, ...auth},
      body: JSON.stringify({jsonrpc: '2.0', id: 4, method: 'tools/nonexistent'}),
    });
    assert.equal(unknown.status, 200);
    assert.equal((JSON.parse(unknown.text) as {error: {code: number}}).error.code, -32601);

    // 5. 未知会话 → 404（不要再假装认这个会话）
    const badSession = await rawRequest({
      port: status.port,
      headers: {Host: `127.0.0.1:${status.port}`, ...auth, 'mcp-session-id': 'not-a-real-session'},
      body: JSON.stringify({jsonrpc: '2.0', id: 5, method: 'tools/list'}),
    });
    assert.equal(badSession.status, 404);

    // 6. 请求体超 1MB → 413，且连接能正常读到响应（不能被 destroy）
    const huge = JSON.stringify({jsonrpc: '2.0', id: 6, method: 'tools/call', params: {name: 'x', padding: 'p'.repeat(1024 * 1024 + 16)}});
    const tooLarge = await rawRequest({
      port: status.port,
      headers: {Host: `127.0.0.1:${status.port}`, ...auth},
      body: huge,
    });
    assert.equal(tooLarge.status, 413);

    // 7. 未知工具名 → isError，文案要说清是哪个工具
    const unknownTool = await rawRequest({
      port: status.port,
      headers: {Host: `127.0.0.1:${status.port}`, ...auth},
      body: JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'browser_nope', arguments: {}}}),
    });
    const unknownToolJson = JSON.parse(unknownTool.text) as {result: {isError: boolean; content: Array<{text: string}>}};
    assert.equal(unknownToolJson.result.isError, true);
    assert.match(unknownToolJson.result.content[0].text, /browser_nope/);

    // 8. DELETE 结束会话 → 204；此后同一会话不再被认
    const init = await rawRequest({
      port: status.port,
      headers: {Host: `127.0.0.1:${status.port}`, ...auth},
      body: JSON.stringify({jsonrpc: '2.0', id: 8, method: 'initialize', params: {protocolVersion: '2025-11-25'}}),
    });
    const sessionId = String(init.headers['mcp-session-id']);
    assert.ok(sessionId);

    const del = await rawRequest({
      port: status.port,
      method: 'DELETE',
      headers: {Host: `127.0.0.1:${status.port}`, ...auth, 'mcp-session-id': sessionId},
    });
    assert.equal(del.status, 204);

    const afterDelete = await rawRequest({
      port: status.port,
      headers: {Host: `127.0.0.1:${status.port}`, ...auth, 'mcp-session-id': sessionId},
      body: JSON.stringify({jsonrpc: '2.0', id: 9, method: 'tools/list'}),
    });
    assert.equal(afterDelete.status, 404);
  } finally {
    await server.stop();
  }
});

test('Browser MCP 停止：飞着长请求时 stop() 也必须立刻返回', async () => {
  // tools/call 一直不返回，模拟人工接管或长耗时动作占着连接
  const hangingAutomation = {
    ...automation,
    wait: () => new Promise(() => {}),
  };
  const server = createBrowserMcpServer({automation: hangingAutomation});
  const status = await server.start();
  const agent = new http.Agent({keepAlive: true, maxSockets: 1});
  let inflight: Promise<unknown> | null = null;
  try {
    inflight = rawRequest({
      port: status.port,
      agent,
      headers: {Host: `127.0.0.1:${status.port}`, Authorization: `Bearer ${status.token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 10, method: 'tools/call', params: {name: 'browser_wait', arguments: {ms: 100}}}),
    }).catch(() => 'aborted');
    // 等请求真正进到 tools/call 里再停，否则还没占住连接
    await new Promise(resolve => setTimeout(resolve, 150));

    const startedAt = Date.now();
    const stopped = await server.stop();
    const elapsed = Date.now() - startedAt;
    assert.equal(stopped.running, false);
    // 只 close() 不掐连接时，close 回调要等这个长请求结束，stop() 会挂死
    assert.ok(elapsed < 2000, `stop() 用了 ${elapsed}ms，closeAllConnections 没生效`);
  } finally {
    await inflight;
    agent.destroy();
    await server.stop();
  }
});
