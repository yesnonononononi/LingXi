/**
 * 内置浏览器本地 MCP Server（Streamable HTTP）。
 *
 * <p>仅监听本机回环地址，使用一次性随机 Bearer Token 鉴权，
 * 将内置 WebContentsView 浏览器能力作为可选按需加载的 MCP 工具暴露给后端。</p>
 */
const http = require('node:http');
const {randomBytes, randomUUID, timingSafeEqual} = require('node:crypto');

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const MAX_BODY_BYTES = 1024 * 1024;

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'browser_navigate',
    description: 'Open a URL in the built-in desktop browser (or navigate the active tab) and wait for page load.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {type: 'string', description: 'Target http/https URL to open.'},
        tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
        newTab: {type: 'boolean', description: 'Whether to open in a new tab. Defaults to false.'},
        waitUntilLoad: {type: 'boolean', description: 'Wait for page load completion. Defaults to true.'},
        waitTimeoutMs: {type: 'integer', description: 'Load wait timeout in milliseconds (max 30000).'},
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element in the built-in browser page by CSS selector (supports .className, #id, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {type: 'string', description: 'CSS selector matching the target element (e.g. ".submit-btn", "#login").'},
        index: {type: 'integer', description: 'Zero-based index when multiple visible elements match. Defaults to 0.'},
        tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill text into an input, textarea, select, or contenteditable element by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {type: 'string', description: 'CSS selector matching the input element.'},
        value: {type: 'string', description: 'Text value to fill into the element.'},
        index: {type: 'integer', description: 'Zero-based index when multiple visible elements match. Defaults to 0.'},
        clear: {type: 'boolean', description: 'Clear existing content before filling. Defaults to true.'},
        submit: {type: 'boolean', description: 'Dispatch Enter key and submit enclosing form after filling. Defaults to false.'},
        tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_query',
    description: 'Inspect visible interactive elements (classes, ids, text, placeholders) and page text excerpt.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {type: 'string', description: 'Optional CSS selector filter. Defaults to common interactive elements.'},
        limit: {type: 'integer', description: 'Maximum elements to return (1-100). Defaults to 40.'},
        tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current built-in browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
        maxWidth: {type: 'integer', description: 'Resize width cap in pixels. Defaults to 1280.'},
      },
    },
  },
  {
    name: 'browser_tabs',
    description: 'List, activate, or close tabs in the built-in browser.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['list', 'activate', 'close'], description: 'Tab operation. Defaults to list.'},
        tabId: {type: 'string', description: 'Target tab ID for activate or close.'},
      },
    },
  },
]);

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('请求体超出大小限制'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('JSON 请求体格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

function createBrowserMcpServer({automation}) {
  if (!automation) throw new Error('automation 依赖不能为空');

  let server = null;
  let port = 0;
  let token = '';
  const sessions = new Set();

  const callTool = async (name, args = {}) => {
    switch (name) {
      case 'browser_navigate': {
        const data = await automation.navigate(args);
        return {content: [{type: 'text', text: JSON.stringify(data)}], isError: false};
      }
      case 'browser_click': {
        const data = await automation.click(args);
        return {content: [{type: 'text', text: JSON.stringify(data)}], isError: false};
      }
      case 'browser_fill': {
        const data = await automation.fill(args);
        return {content: [{type: 'text', text: JSON.stringify(data)}], isError: false};
      }
      case 'browser_query': {
        const data = await automation.query(args);
        return {content: [{type: 'text', text: JSON.stringify(data)}], isError: false};
      }
      case 'browser_screenshot': {
        const shot = await automation.screenshot({...args, saveToTemp: true});
        return {
          content: [
            {type: 'image', data: shot.base64, mimeType: shot.mimeType},
            {
              type: 'text',
              text: JSON.stringify({
                tabId: shot.tabId,
                url: shot.url,
                title: shot.title,
                width: shot.width,
                height: shot.height,
                filePath: shot.filePath,
              }),
            },
          ],
          isError: false,
        };
      }
      case 'browser_tabs': {
        const action = args.action || 'list';
        let data;
        if (action === 'activate') data = await automation.activateTab(args.tabId);
        else if (action === 'close') data = await automation.closeTab(args.tabId);
        else data = await automation.listTabs();
        return {content: [{type: 'text', text: JSON.stringify(data)}], isError: false};
      }
      default:
        return {content: [{type: 'text', text: `未知浏览器工具: ${name}`}], isError: true};
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
      sessions.add(sessionId);
      res.setHeader('Mcp-Session-Id', sessionId);
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: {tools: {}},
            serverInfo: {name: 'lingxi-browser-mcp', version: '1.0.0'},
          },
        },
      };
    }

    if (method === 'ping') {
      return {status: 200, body: {jsonrpc: '2.0', id, result: {}}};
    }

    if (method === 'tools/list') {
      return {status: 200, body: {jsonrpc: '2.0', id, result: {tools: TOOL_DEFINITIONS}}};
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        const result = await callTool(toolName, toolArgs);
        return {status: 200, body: {jsonrpc: '2.0', id, result}};
      } catch (error) {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id,
            result: {content: [{type: 'text', text: error instanceof Error ? error.message : String(error)}], isError: true},
          },
        };
      }
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

    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
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

    try {
      const payload = await readJsonBody(req);
      const {status, body} = await handleRpc(payload, res);
      if (status === 202 || body === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(body));
    } catch (error) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {code: -32700, message: error instanceof Error ? error.message : String(error)},
      }));
    }
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
    if (!server) {
      port = 0;
      token = '';
      return getStatus();
    }
    const closing = server;
    server = null;
    port = 0;
    token = '';
    await new Promise(resolve => closing.close(() => resolve()));
    return getStatus();
  };

  return {start, stop, getStatus};
}

module.exports = {createBrowserMcpServer, TOOL_DEFINITIONS, isAllowedLoopbackHost, safeTokenEquals};
