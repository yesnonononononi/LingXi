/**
 * 桌宠 dev server 探活单测（node:test，起真实 HTTP 服务，不启动 Vite / Electron）。
 *
 * <p><b>守的是什么：</b>"看状态码"这种探活方式在真实事故里骗过了所有人——
 * 主应用 dev server 占着端口时，`GET /pet.html` 被 SPA fallback 兜成 `index.html`，
 * <b>状态码 200</b>，于是探活通过、桌宠 dev server 没启动、窗口里显示主应用。</p>
 *
 * <p>所以这里用<b>真实的 pet.html / index.html 文件内容</b>喂真实 HTTP 服务，
 * 覆盖四种必须区分的结论：</p>
 * <ol>
 *   <li>200 + 桌宠页面 → 通过；</li>
 *   <li>200 + 主应用 index.html → 失败，且根因必须是 `wrong-app`；</li>
 *   <li>非 200 → 失败（`bad-status`）；</li>
 *   <li>连接被拒 → 失败（`no-service`）。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FRONTEND_ROOT = path.join(__dirname, '..');
const { DEV_ENDPOINT } = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-endpoint.cjs'));
const {
  PROBE_REASON,
  PROBE_EXIT_CODE,
  PROBE_CAUSE,
  EXIT_USAGE,
  probePetDevServer,
  classifyBodyFailure,
  parseArgs,
  formatResult,
} = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-probe.cjs'));

/** 真实桌宠页面（含指纹）。 */
const PET_PAGE = fs.readFileSync(path.join(FRONTEND_ROOT, 'pet.html'), 'utf8');
/** 真实主应用页面（不含指纹）——就是事故现场被兜出来的那个页面。 */
const MAIN_APP_PAGE = fs.readFileSync(path.join(FRONTEND_ROOT, 'index.html'), 'utf8');

/**
 * 起一个临时 HTTP 服务（端口交给内核分配）。
 *
 * <p>关闭时**主动销毁所有 socket**：本文件里有若干"故意不结束响应体"的用例，
 * 依赖客户端自行断开会让 `server.close()` 一直等下去（实测会让整个测试文件挂住）。</p>
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler 请求处理器
 * @returns {Promise<{origin: string, port: number, hits: number[], close: () => Promise<void>}>} 服务句柄
 */
async function startServer(handler) {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    try {
      handler(req, res);
    } catch {
      try {
        res.destroy();
      } catch {
        // 连接已断开：忽略，测试关注的是探活结论
      }
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    hits,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

/**
 * 回一个 HTML 200。
 *
 * @param {import('node:http').ServerResponse} res 响应
 * @param {string} body 响应体
 * @param {number} [status=200] 状态码
 * @returns {void}
 */
function sendHtml(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

test('探活：200 且含桌宠指纹 → 通过', async (t) => {
  const server = await startServer((req, res) => sendHtml(res, PET_PAGE));
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html` });
  assert.equal(result.ok, true, `应通过，实际：${result.message}`);
  assert.equal(result.reason, PROBE_REASON.OK);
  assert.equal(result.status, 200);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.missingMarkers, []);
});

test('探活：200 但内容是主应用 index.html → 失败且根因是"端口上的服务不是桌宠"', async (t) => {
  const server = await startServer((req, res) => sendHtml(res, MAIN_APP_PAGE));
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html` });
  assert.equal(result.ok, false, '主应用页面绝不能被判成桌宠已就绪');
  assert.equal(result.reason, PROBE_REASON.WRONG_APP);
  assert.equal(result.exitCode, PROBE_EXIT_CODE['wrong-app']);
  assert.match(result.message, /不是桌宠/);
  assert.match(result.message, /主应用占用/);
  // 必须指出具体缺哪条指纹，否则排障只能靠猜
  assert.equal(result.missingMarkers.length, 2);
  assert.match(result.hint, /npm run dev:pet/);
});

test('探活：200 但只命中一半指纹（缺 meta）→ 仍判定失败', async (t) => {
  const server = await startServer((req, res) => sendHtml(res, '<!doctype html><body><div id="pet-root"></div></body>'));
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html` });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASON.WRONG_APP);
  assert.equal(result.missingMarkers.length, 1);
  assert.equal(result.missingMarkers[0].includes('lx-app'), true);
});

test('探活：404（history fallback 已关闭）→ 失败且根因是 bad-status', async (t) => {
  const server = await startServer((req, res) => sendHtml(res, 'not found', 404));
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html` });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASON.BAD_STATUS);
  assert.equal(result.status, 404);
  assert.equal(result.exitCode, PROBE_EXIT_CODE['bad-status']);
  assert.match(result.message, /HTTP 404/);
  assert.match(result.hint, /appType/);
});

test('探活：500 → 失败（非 200 一律不通过）', async (t) => {
  const server = await startServer((req, res) => sendHtml(res, PET_PAGE, 500));
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html` });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASON.BAD_STATUS);
  assert.equal(result.status, 500);
});

test('探活：连接被拒 → 失败且根因是"端口无服务"', async () => {
  // 先拿一个内核刚分配过的端口，再立刻关掉：这个端口必然没人监听
  const probe = await startServer((req, res) => sendHtml(res, PET_PAGE));
  await probe.close();

  const result = await probePetDevServer({ url: `${probe.origin}/pet.html` });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASON.NO_SERVICE);
  assert.equal(result.exitCode, PROBE_EXIT_CODE['no-service']);
  assert.match(result.message, /端口无服务/);
  assert.match(result.hint, /npm run dev:pet/);
});

test('探活：服务不响应 → 超时失败（不挂死调用方）', async (t) => {
  const server = await startServer((req, res) => {
    setTimeout(() => {
      try {
        res.end(PET_PAGE);
      } catch {
        // 探活已经放弃这次连接：忽略
      }
    }, 400);
  });
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html`, timeoutMs: 60 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASON.TIMEOUT);
  assert.equal(result.exitCode, PROBE_EXIT_CODE.timeout);
  // K1：连接阶段超时（连响应头都没等到）要有独立 cause，便于与"响应体停滞"区分
  assert.equal(result.cause, PROBE_CAUSE.CONNECT_TIMEOUT);
  assert.equal(result.phase, 'connect');
});

test('K1：响应头已到但响应体停滞 → timeout / exit 5（不再误判 network-error）', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // 只写半截就再也不推进：复刻"发了头但 body 停滞"的真实故障
    res.write('<!doctype html><html><body><div id="pet-root"');
  });
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html`, timeoutMs: 120 });
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    PROBE_REASON.TIMEOUT,
    `响应体停滞必须归入 timeout（exit 5），实际 reason=${result.reason} exit=${result.exitCode}`,
  );
  assert.equal(result.exitCode, PROBE_EXIT_CODE.timeout);
  assert.equal(result.cause, PROBE_CAUSE.BODY_TIMEOUT);
  assert.equal(result.phase, 'body');
  assert.equal(result.status, 200, '已经拿到响应头，状态码应当保留给排障用');
  assert.match(result.message, /响应体停滞/);
  assert.doesNotMatch(result.message, /连接超时/, '响应体停滞不能被说成连接超时');
});

test('K1：连接阶段超时与响应体停滞可以被区分（同 reason 不同 cause）', async (t) => {
  // 只握手不回包的裸 TCP 服务：请求发出去了，响应头永远不会来
  const silentSockets = new Set();
  const silent = net.createServer((socket) => {
    silentSockets.add(socket);
    socket.on('close', () => silentSockets.delete(socket));
  });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of silentSockets) socket.destroy();
    silentSockets.clear();
    silent.close(() => resolve());
  }));
  const port = silent.address().port;

  const connectTimeout = await probePetDevServer({ url: `http://127.0.0.1:${port}/pet.html`, timeoutMs: 120 });
  assert.equal(connectTimeout.reason, PROBE_REASON.TIMEOUT);
  assert.equal(connectTimeout.cause, PROBE_CAUSE.CONNECT_TIMEOUT);
  assert.match(connectTimeout.message, /连接超时/);

  const stalled = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('partial');
  });
  t.after(() => stalled.close());
  const bodyTimeout = await probePetDevServer({ url: `${stalled.origin}/pet.html`, timeoutMs: 120 });
  assert.equal(bodyTimeout.reason, connectTimeout.reason, '两者都是 timeout（exit 5）');
  assert.notEqual(bodyTimeout.cause, connectTimeout.cause, 'cause 必须能区分连接超时与响应体停滞');
  assert.equal(bodyTimeout.cause, PROBE_CAUSE.BODY_TIMEOUT);
});

test('K1 反向：响应体读到一半被掐断是网络错误（exit 6），不是超时', async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '9999' });
    res.write('<!doctype html><html><body><div id="pet-root"');
    // 声明了更长的 content-length 之后稍等片刻再掐断：确保客户端已经进入"读响应体"阶段
    setTimeout(() => {
      try {
        res.destroy();
      } catch {
        // 已经断了：忽略
      }
    }, 80);
  });
  t.after(() => server.close());

  const result = await probePetDevServer({ url: `${server.origin}/pet.html`, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PROBE_REASON.NETWORK_ERROR, `连接中断不是超时，实际 ${result.reason}/${result.cause}`);
  assert.equal(result.exitCode, PROBE_EXIT_CODE['network-error']);
  assert.equal(result.phase, 'body');
  assert.notEqual(result.cause, PROBE_CAUSE.BODY_TIMEOUT);
});

test('K1 反向：读取响应体时的 ECONNRESET → network-error / exit 6 且 cause=body-interrupted', async () => {
  const reset = Object.assign(new Error('read ECONNRESET'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
  const fakeFetch = async () => ({
    status: 200,
    text: async () => {
      throw reset;
    },
  });
  const result = await probePetDevServer({ url: 'http://127.0.0.1/pet.html', fetchImpl: fakeFetch });
  assert.equal(result.reason, PROBE_REASON.NETWORK_ERROR);
  assert.equal(result.exitCode, PROBE_EXIT_CODE['network-error']);
  assert.equal(result.cause, PROBE_CAUSE.BODY_INTERRUPTED);
  assert.equal(result.phase, 'body');
});

test('K1 反向：普通网络错误（非超时）仍是 exit 6', async () => {
  const broken = Object.assign(new Error('connect EPIPE'), { code: 'EPIPE' });
  const fakeFetch = async () => {
    throw broken;
  };
  const result = await probePetDevServer({ url: 'http://127.0.0.1/pet.html', fetchImpl: fakeFetch });
  assert.equal(result.reason, PROBE_REASON.NETWORK_ERROR);
  assert.equal(result.exitCode, PROBE_EXIT_CODE['network-error']);
  assert.equal(result.cause, PROBE_CAUSE.NETWORK_ERROR);
  assert.equal(result.phase, 'connect');
});

test('K1：classifyBodyFailure 的三条分支自证', () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.deepEqual(classifyBodyFailure(timeoutErr), {
    reason: PROBE_REASON.TIMEOUT,
    cause: PROBE_CAUSE.BODY_TIMEOUT,
    detail: '请求超时',
  });

  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyBodyFailure(abortErr).cause, PROBE_CAUSE.BODY_TIMEOUT);

  const resetErr = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const resetVerdict = classifyBodyFailure(resetErr);
  assert.equal(resetVerdict.reason, PROBE_REASON.NETWORK_ERROR, 'ECONNRESET 是真网络错误，不能被伪装成超时');
  assert.equal(resetVerdict.cause, PROBE_CAUSE.BODY_INTERRUPTED);

  const otherErr = Object.assign(new Error('boom'), { code: 'EPIPE' });
  assert.equal(classifyBodyFailure(otherErr).cause, PROBE_CAUSE.NETWORK_ERROR);
});

test('K1：--help / 文档的退出码说明与实现一致', () => {
  const script = path.join(FRONTEND_ROOT, 'electron', 'pet-dev-probe.cjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /5 超时（连接超时 \/ 响应体停滞）/, '--help 必须写明 exit 5 覆盖两种超时');
  assert.match(help.stdout, /6 其他网络错误/, '--help 必须保留 exit 6 的口径');
  // 文档口径：reason.timeout → 5，且 PROBE_CAUSE 里两种超时都在
  assert.equal(PROBE_EXIT_CODE.timeout, 5);
  assert.equal(PROBE_EXIT_CODE['network-error'], 6);
  assert.equal(PROBE_CAUSE.CONNECT_TIMEOUT, 'connect-timeout');
  assert.equal(PROBE_CAUSE.BODY_TIMEOUT, 'body-timeout');
});

test('探活：--wait 轮询能容忍 dev server 冷启动', async (t) => {
  let attempt = 0;
  const server = await startServer((req, res) => {
    attempt += 1;
    sendHtml(res, attempt < 3 ? 'starting' : PET_PAGE, attempt < 3 ? 503 : 200);
  });
  t.after(() => server.close());

  const result = await probePetDevServer({
    url: `${server.origin}/pet.html`,
    waitMs: 3000,
    intervalMs: 50,
  });
  assert.equal(result.ok, true, `轮询应等到就绪，实际：${result.message}`);
  assert.equal(attempt, 3);
});

test('探活：参数校验（非法 URL / 超时 / 等待 / fetch）', async () => {
  await assert.rejects(() => probePetDevServer({ url: 'not a url' }), TypeError);
  await assert.rejects(() => probePetDevServer({ url: 'ftp://127.0.0.1/pet.html' }), TypeError);
  await assert.rejects(() => probePetDevServer({ url: 'http://127.0.0.1:1/pet.html', timeoutMs: 0 }), TypeError);
  await assert.rejects(() => probePetDevServer({ url: 'http://127.0.0.1:1/pet.html', waitMs: -1 }), TypeError);
  await assert.rejects(() => probePetDevServer({ url: 'http://127.0.0.1:1/pet.html', intervalMs: 0 }), TypeError);
  await assert.rejects(() => probePetDevServer({ url: 'http://127.0.0.1:1/pet.html', fetchImpl: 'nope' }), TypeError);
});

test('探活：默认目标取自单一真源（端口与入口页）', async () => {
  const result = await probePetDevServer({ timeoutMs: 300 });
  assert.equal(result.url, `http://${DEV_ENDPOINT.host}:${DEV_ENDPOINT.port}/${DEV_ENDPOINT.entryPage}`);
});

test('CLI：--print-port / --print-url 透出单一真源，供批处理取值', () => {
  const script = path.join(FRONTEND_ROOT, 'electron', 'pet-dev-probe.cjs');
  const printedPort = spawnSync(process.execPath, [script, '--print-port'], { encoding: 'utf8' });
  assert.equal(printedPort.status, 0);
  assert.equal(printedPort.stdout.trim(), String(DEV_ENDPOINT.port));

  const printedUrl = spawnSync(process.execPath, [script, '--print-url'], { encoding: 'utf8' });
  assert.equal(printedUrl.status, 0);
  assert.equal(printedUrl.stdout.trim(), `http://${DEV_ENDPOINT.host}:${DEV_ENDPOINT.port}/${DEV_ENDPOINT.entryPage}`);
});

test('CLI：未知参数以非 0 退出（PET-UP 不能把参数错误当成就绪）', () => {
  const script = path.join(FRONTEND_ROOT, 'electron', 'pet-dev-probe.cjs');
  const bogus = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.equal(bogus.status, EXIT_USAGE);

  assert.throws(() => parseArgs(['--wait']), /需要非负整数毫秒/);
  assert.throws(() => parseArgs(['--wait', 'abc']), /需要非负整数毫秒/);
});

test('结论渲染：失败时同时给出结论与处理建议', async () => {
  const result = await probePetDevServer({ url: 'http://127.0.0.1:1/pet.html', timeoutMs: 300 });
  const text = formatResult(result);
  assert.match(text, /^\[FAIL\]/);
  assert.match(text, /处理建议：/);
});
