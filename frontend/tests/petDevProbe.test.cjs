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
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FRONTEND_ROOT = path.join(__dirname, '..');
const { DEV_ENDPOINT } = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-endpoint.cjs'));
const {
  PROBE_REASON,
  PROBE_EXIT_CODE,
  EXIT_USAGE,
  probePetDevServer,
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
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler 请求处理器
 * @returns {Promise<{origin: string, port: number, hits: number[], close: () => Promise<void>}>} 服务句柄
 */
async function startServer(handler) {
  const hits = [];
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
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
