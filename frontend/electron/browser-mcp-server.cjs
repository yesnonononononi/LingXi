/**
 * 内置浏览器本地 MCP Server（Streamable HTTP）。
 *
 * <p>仅监听本机回环地址，使用一次性随机 Bearer Token 鉴权，把内置 WebContentsView
 * 浏览器与 Design 画布能力作为可选工具暴露给后端。</p>
 *
 * <p>工具清单与分派都来自 electron/mcp/registry.cjs：这里只负责 HTTP/JSON-RPC、
 * 鉴权、会话与 content 组装，不再自己维护一份工具表。</p>
 */
const http = require('node:http');
const {randomBytes, randomUUID, timingSafeEqual} = require('node:crypto');
const {BROWSER_TOOLS, DESIGN_TOOLS, findTool} = require('./mcp/registry.cjs');
const {describeForModel} = require('./mcp/errors.cjs');

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const MAX_BODY_BYTES = 1024 * 1024;
/** 会话表上限：SDK 不一定发 DELETE，不加限制就是无上限增长。 */
const MAX_SESSIONS = 64;

/** 浏览器工具的 automation 方法名 → 工具声明里的 method 字段是唯一真源，这里只留 tabs 的多动作映射。 */
const TAB_ACTIONS = Object.freeze({list: 'listTabs', activate: 'activateTab', close: 'closeTab'});

/** 对外暴露的工具定义：只要 name/description/inputSchema，执行函数不进协议。 */
const toDefinition = tool => ({name: tool.name, description: tool.description, inputSchema: tool.inputSchema});
const TOOL_DEFINITIONS = Object.freeze(BROWSER_TOOLS.map(toDefinition));
const DESIGN_TOOL_DEFINITIONS = Object.freeze(DESIGN_TOOLS.map(toDefinition));

function safeTokenEquals(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAllowedLoopbackHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || !port) return false;
  const normalized = hostHeader.trim().toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

/**
 * 读 JSON 请求体。
 *
 * <p>超限时不 destroy 连接：连接断了响应就写不回去，调用方只会看到「连接被重置」而不是 413。</p>
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        const error = new Error('请求体超出 1MB 限制');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('JSON 请求体格式不正确'));
      }
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * 工具返回值 → MCP content blocks。
 *
 * <p>工具用 `images: [{data, mimeType}]` 声明图片块，其余字段序列化成一个文本块，
 * 图片块排在前面（模型先看图，再看元信息）。</p>
 */
function toContent(result) {
  if (!result || !Array.isArray(result.images) || result.images.length === 0) {
    return [{type: 'text', text: JSON.stringify(result)}];
  }
  const rest = {...result};
  const images = rest.images;
  delete rest.images;
  return [
    ...images.map(image => ({type: 'image', data: image.data, mimeType: image.mimeType || 'image/png'})),
    {type: 'text', text: JSON.stringify(rest)},
  ];
}

/**
 * 建一个本地 MCP 服务实例。
 *
 * @param automation 由 project-page-preview 暴露的自动化门面（方法名与工具 method 对应）
 * @param designBridge Design 画布桥接器，未接线时为 null
 */
function createBrowserMcpServer({automation, designBridge = null}) {
  if (!automation) throw new Error('automation 依赖不能为空');

  const activeTools = Object.freeze(designBridge ? [...TOOL_DEFINITIONS, ...DESIGN_TOOL_DEFINITIONS] : TOOL_DEFINITIONS);

  let server = null;
  let port = 0;
  let token = '';
  const sessions = new Set();

  /** 记住会话并淘汰最旧的，避免 SDK 漏发 DELETE 时无限增长。 */
  const rememberSession = sessionId => {
    sessions.add(sessionId);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.values().next().value;
      sessions.delete(oldest);
    }
  };

  /** 按工具名分派：浏览器工具走 automation 门面，Design 工具直接持有桥接器。 */
  const invokeTool = (tool, args) => {
    if (tool.name === 'browser_tabs') {
      const action = String(args.action || 'list').toLowerCase();
      const method = TAB_ACTIONS[action] || 'listTabs';
      return method === 'listTabs' ? automation.listTabs() : automation[method](args.tabId);
    }
    if (tool.method) return automation[tool.method](args);
    return tool.run({designBridge}, args);
  };

  const callTool = async (name, args = {}) => {
    const tool = findTool(name);
    if (!tool) {
      return {content: [{type: 'text', text: `未知工具: ${name}`}], isError: true};
    }
    try {
      return {content: toContent(await invokeTool(tool, args)), isError: false};
    } catch (error) {
      return {content: [{type: 'text', text: describeForModel(error)}], isError: true};
    }
  };

  const handleRpc = async (payload, res) => {
    if (!payload || typeof payload !== 'object' || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
      return {status: 400, body: {jsonrpc: '2.0', id: payload?.id ?? null, error: {code: -32600, message: 'Invalid JSON-RPC request'}}};
    }

    const {id, method, params} = payload;
    // 通知类消息（无 id）按 MCP Streamable HTTP 规范返回 202
    if (id === undefined || id === null) {
      return {status: 202, body: null};
    }

    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      const sessionId = randomUUID();
      rememberSession(sessionId);
      res.setHeader('Mcp-Session-Id', sessionId);
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: {tools: {}},
            serverInfo: {name: 'lingxi-browser-mcp', version: '2.0.0'},
          },
        },
      };
    }

    if (method === 'ping') {
      return {status: 200, body: {jsonrpc: '2.0', id, result: {}}};
    }

    if (method === 'tools/list') {
      return {status: 200, body: {jsonrpc: '2.0', id, result: {tools: activeTools}}};
    }

    if (method === 'tools/call') {
      const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      return {status: 200, body: {jsonrpc: '2.0', id, result: await callTool(params?.name, toolArgs)}};
    }

    return {status: 200, body: {jsonrpc: '2.0', id, error: {code: -32601, message: `Method not found: ${method}`}}};
  };

  const handleRequest = async (req, res) => {
    if (!isAllowedLoopbackHost(req.headers.host, port)) {
      res.writeHead(403, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Forbidden host'}));
      return;
    }

    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!safeTokenEquals(bearer, token)) {
      res.writeHead(401, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Unauthorized'}));
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (reqUrl.pathname !== '/mcp') {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Not found'}));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      if (typeof sessionId === 'string') sessions.delete(sessionId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, {'Content-Type': 'application/json', Allow: 'POST, DELETE'});
      res.end(JSON.stringify({error: 'Method not allowed'}));
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      const tooLarge = error && error.code === 'BODY_TOO_LARGE';
      res.writeHead(tooLarge ? 413 : 400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {code: -32700, message: tooLarge ? 'Payload too large' : (error instanceof Error ? error.message : String(error))},
      }));
      return;
    }

    // 会话校验：带上来的 session id 必须是本进程发过的，否则按规范回 404
    if (payload?.method !== 'initialize' && typeof sessionId === 'string' && sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Session not found'}));
      return;
    }

    const {status, body} = await handleRpc(payload, res);
    if (status === 202 || body === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
  };

  const getStatus = () => ({
    running: Boolean(server && server.listening && port > 0),
    port,
    url: server && server.listening && port > 0 ? `http://127.0.0.1:${port}/mcp` : '',
    token: server && server.listening ? token : '',
  });

  const start = async () => {
    if (server && server.listening) return getStatus();
    token = randomBytes(24).toString('hex');
    server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    // 放宽 keep-alive 与请求超时：避免 Java HTTP 连接池复用超过默认 5s 的长连接时触发 ClosedChannelException，
    // 也防止人工接管或长耗时 browser_wait/design_capture 被 Node 提前断开。
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 0;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
    return getStatus();
  };

  const stop = async () => {
    sessions.clear();
    const closing = server;
    server = null;
    port = 0;
    token = '';
    if (!closing) return getStatus();
    await new Promise(resolve => {
      closing.close(() => resolve());
      // keep-alive 连接不会自己断，长耗时的 tools/call 也在飞：直接掐掉，否则 close 回调永远不来
      if (typeof closing.closeAllConnections === 'function') closing.closeAllConnections();
    });
    return getStatus();
  };

  return {start, stop, getStatus};
}

module.exports = {createBrowserMcpServer, TOOL_DEFINITIONS, DESIGN_TOOL_DEFINITIONS, isAllowedLoopbackHost, safeTokenEquals};
