'use strict';

/**
 * 桌宠 dev server 探活（内容指纹版）。
 *
 * <p><b>为什么不能只看状态码（真实事故）：</b>桌宠与主应用曾经共用端口 5174。主应用的
 * dev server 先占用该端口后，`GET /pet.html` 被 Vite 的 SPA history fallback 兜成
 * `index.html`——<b>状态码 200，响应体却是整个主应用</b>。旧探活脚本
 * （`Invoke-WebRequest ... | Out-Null`，只看是否抛错）据此认定"桌宠已就绪"，
 * 跳过启动桌宠 dev server，最终 Electron 窗口里显示的是主应用界面。</p>
 *
 * <p>所以本模块的判定口径是：**HTTP 200 且响应体同时命中全部桌宠内容指纹**才算就绪。
 * 并且失败时必须区分两类根因，给出可操作提示：</p>
 * <ul>
 *   <li>`wrong-app` —— 端口上有服务，但<b>不是桌宠</b>（疑似被主应用占用）；</li>
 *   <li>`no-service` —— 端口上<b>没有服务</b>（没启动 / 刚停）。</li>
 * </ul>
 *
 * <p>CLI 契约（供仓外 `pet-up.cmd` 使用，退出码即判据）：</p>
 * <pre>
 *   node electron/pet-dev-probe.cjs               # 探活一次，打印结论
 *   node electron/pet-dev-probe.cjs --wait 20000  # 轮询到就绪或超时
 *   node electron/pet-dev-probe.cjs --print-port  # 打印端口（单一真源透出）
 *   node electron/pet-dev-probe.cjs --print-url   # 打印入口页 URL
 *   node electron/pet-dev-probe.cjs --json        # 机器可读结果
 * </pre>
 *
 * <p>退出码：0 就绪；2 端口上的服务不是桌宠；3 端口无服务；4 非 200 响应；
 * 5 超时（连接超时<b>或</b>响应体停滞）；6 其他网络错误（含响应体读到一半被中断）；64 参数错误。</p>
 *
 * <p><b>超时口径（K1）：</b>`timeout`/exit 5 覆盖两个阶段——"响应头都没等到"（`connect-timeout`）
 * 与"响应头已到、body 不再推进"（`body-timeout`）。两者用结果里的 `cause` 字段区分，
 * 因为排障动作完全不同；而"body 读到一半被掐断"属于真网络错误，仍是 exit 6
 * （`body-interrupted`），不能被伪装成超时。</p>
 */

const { DEV_ENDPOINT, PET_PAGE_MARKERS, buildEntryUrl } = require('./pet-dev-endpoint.cjs');

/**
 * 探活结论的根因分类。
 *
 * <p>分类而不是只给布尔值：调用方（批处理）要按根因打印不同提示，
 * 否则用户只会看到一句"探活失败"，还得自己猜是没启动还是被占了端口。</p>
 */
const PROBE_REASON = Object.freeze({
  /** 就绪：200 且指纹全中。 */
  OK: 'ok',
  /** 端口上有服务，但不是桌宠页面（疑似被主应用占用）。 */
  WRONG_APP: 'wrong-app',
  /** 端口上有服务，但返回非 200。 */
  BAD_STATUS: 'bad-status',
  /** 端口上无服务（连接被拒）。 */
  NO_SERVICE: 'no-service',
  /** 超时无响应。 */
  TIMEOUT: 'timeout',
  /** 其他网络错误。 */
  NETWORK_ERROR: 'network-error',
});

/** 根因 → 进程退出码。 */
const PROBE_EXIT_CODE = Object.freeze({
  ok: 0,
  'wrong-app': 2,
  'no-service': 3,
  'bad-status': 4,
  timeout: 5,
  'network-error': 6,
});

/**
 * 失败细分原因（`cause`），比 `reason` 更细一层。
 *
 * <p><b>为什么需要它（K1）：</b>`reason` 是"用户/批处理该怎么反应"的粗分类，而
 * "连接超时"和"响应体停滞"都会落到同一个 `timeout`（exit 5）——它们在排障时含义完全不同：
 * 前者是端口上根本没人应答，后者是服务已经发了响应头却把 body 卡住（vite 冷启动、
 * 代理缓冲、半开连接）。只给一个 `timeout` 会让调用方无从下手。同理，
 * "响应体读到一半被掐断"是真正的网络错误（exit 6，`body-interrupted`），
 * 不能被混进 `timeout`，否则 `pet-up.cmd` 会把可重试的连接故障当成超时处理。</p>
 */
const PROBE_CAUSE = Object.freeze({
  /** 就绪。 */
  OK: 'ok',
  /** 连接阶段超时：响应头都没等到。 */
  CONNECT_TIMEOUT: 'connect-timeout',
  /** 响应体停滞：拿到了响应头，但 body 没读完（K1 的修复点）。 */
  BODY_TIMEOUT: 'body-timeout',
  /** 端口无服务：连接被拒 / 主机不可达。 */
  CONNECTION_REFUSED: 'connection-refused',
  /** 响应体读到一半连接被掐断（真网络错误，仍 exit 6）。 */
  BODY_INTERRUPTED: 'body-interrupted',
  /** 其他网络错误。 */
  NETWORK_ERROR: 'network-error',
  /** 返回了非 200。 */
  BAD_STATUS: 'bad-status',
  /** 200 但不是桌宠页面。 */
  WRONG_APP: 'wrong-app',
});

/** 参数错误退出码（沿用 BSD sysexits 的 EX_USAGE）。 */
const EXIT_USAGE = 64;

/** 单次请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 2000;
/** 轮询间隔（毫秒）。 */
const DEFAULT_INTERVAL_MS = 300;

/**
 * 主应用页面的特征串。
 *
 * <p>只用于<b>诊断提示</b>，不参与判定：判定只认桌宠指纹。有了这些特征，
 * "端口被主应用占用"才能从"响应体不对"升级成一句用户看得懂的话。</p>
 */
const MAIN_APP_SIGNATURES = Object.freeze(['<div id="app">', '/src/main.ts']);

/** 可归入"端口无服务"的网络错误码。 */
const NO_SERVICE_CODES = Object.freeze(
  new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EADDRNOTAVAIL', 'ECONNABORTED']),
);

/**
 * 打日志用的统一前缀。
 *
 * @param {string} level 级别（info / warn / error）
 * @returns {(message: string) => void} 打印函数
 */
function logger(level) {
  return (message) => {
    const line = `[pet-probe] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

/**
 * 睡眠若干毫秒。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 定时结束即 resolve
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把 fetch 抛出的异常翻译成根因分类。
 *
 * <p><b>注意（K1）：</b>同一个 `TimeoutError` 在"连接阶段"和"读 body 阶段"都会出现，
 * 本函数只负责把它识别成 `timeout`；两阶段的区分由调用点决定（连接阶段用
 * `CONNECT_TIMEOUT`，body 阶段用 {@link classifyBodyFailure} 得到 `BODY_TIMEOUT`）。</p>
 *
 * @param {unknown} err fetch 抛出的异常
 * @returns {{reason: string, detail: string}} 根因与可读细节
 */
function classifyError(err) {
  const name = err && typeof err.name === 'string' ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { reason: PROBE_REASON.TIMEOUT, detail: '请求超时' };
  }
  const cause = err && typeof err === 'object' && err.cause ? err.cause : null;
  const code = (cause && typeof cause.code === 'string' && cause.code)
    || (err && typeof err === 'object' && typeof err.code === 'string' ? err.code : '');
  if (code && NO_SERVICE_CODES.has(code)) {
    return { reason: PROBE_REASON.NO_SERVICE, detail: code };
  }
  const message = err && typeof err.message === 'string' ? err.message : String(err);
  return { reason: PROBE_REASON.NETWORK_ERROR, detail: code || message };
}

/**
 * 归类「响应体读取失败」。
 *
 * <p><b>这就是 K1 的修复点：</b>旧实现把 `await response.text()` 的异常**一律**
 * 判成 `network-error`（exit 6）。而真实故障里最常见的是"服务已经回了 200 响应头，
 * body 却不再推进"——`AbortSignal.timeout` 在此时抛的是 `TimeoutError`，
 * 语义上属于超时（exit 5），旧实现却报了 exit 6，与 CLI 文档写的 `5 超时` 不一致。</p>
 *
 * <p>新的口径：</p>
 * <ul>
 *   <li>`TimeoutError` / `AbortError` → `timeout` + `body-timeout`（exit 5）；</li>
 *   <li>读到一半被掐断（ECONNRESET 之类）→ `network-error` + `body-interrupted`（exit 6，
 *       真网络错误不能被伪装成超时）；</li>
 *   <li>其他 → `network-error`（exit 6）。</li>
 * </ul>
 *
 * @param {unknown} err 读取响应体时抛出的异常
 * @returns {{reason: string, cause: string, detail: string}} 归类结果
 */
function classifyBodyFailure(err) {
  const verdict = classifyError(err);
  if (verdict.reason === PROBE_REASON.TIMEOUT) {
    return { reason: PROBE_REASON.TIMEOUT, cause: PROBE_CAUSE.BODY_TIMEOUT, detail: verdict.detail };
  }
  if (verdict.reason === PROBE_REASON.NO_SERVICE) {
    // 连接已建立、body 读到一半被掐断：这是真网络错误，不要混进 timeout
    return { reason: PROBE_REASON.NETWORK_ERROR, cause: PROBE_CAUSE.BODY_INTERRUPTED, detail: verdict.detail };
  }
  return { reason: PROBE_REASON.NETWORK_ERROR, cause: PROBE_CAUSE.NETWORK_ERROR, detail: verdict.detail };
}

/**
 * 单次探活。
 *
 * @param {string} url 探活目标
 * @param {number} timeoutMs 单次请求超时（毫秒）
 * @param {typeof fetch} fetchImpl fetch 实现（测试可注入）
 * @returns {Promise<object>} 结论对象
 */
async function probeOnce(url, timeoutMs, fetchImpl) {
  /** 统一的失败结果构造器：保证字段齐全，调用方不必判空。 */
  const fail = (reason, message, hint, extra = {}) => ({
    ok: false,
    reason,
    // 细一级的失败原因：让"连接超时"与"响应体停滞"能区分开（K1）
    cause: extra.cause ?? PROBE_CAUSE.NETWORK_ERROR,
    // 失败发生在哪个阶段：connect（要响应头）/ body（要响应体）/ response（判内容）
    phase: extra.phase ?? 'connect',
    url,
    status: extra.status ?? null,
    exitCode: PROBE_EXIT_CODE[reason],
    message,
    hint,
    missingMarkers: extra.missingMarkers ?? [],
    ...extra,
  });

  let response;
  try {
    response = await fetchImpl(url, {
      // 不跟随重定向：探活要盯的就是这个端口上的这个路径，跳走说明服务配置不对
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const { reason, detail } = classifyError(err);
    if (reason === PROBE_REASON.TIMEOUT) {
      return fail(
        PROBE_REASON.TIMEOUT,
        `连接超时：${url} 在 ${timeoutMs}ms 内没等到响应头（${detail}）`,
        '端口可能被半开连接或防火墙占着。先确认没有残留的 vite 进程占住该端口，再重跑 pet-up.cmd。',
        { cause: PROBE_CAUSE.CONNECT_TIMEOUT, phase: 'connect' },
      );
    }
    if (reason === PROBE_REASON.NO_SERVICE) {
      return fail(
        PROBE_REASON.NO_SERVICE,
        `端口无服务：${url} 连接被拒绝（${detail}）`,
        `桌宠 dev server 没在跑。用 "npm run dev:pet" 启动（端口取自 electron/pet-dev-endpoint.cjs），或直接重跑 pet-up.cmd 让它自动拉起。`,
        { cause: PROBE_CAUSE.CONNECTION_REFUSED, phase: 'connect' },
      );
    }
    return fail(
      PROBE_REASON.NETWORK_ERROR,
      `探活请求失败：${url}（${detail}）`,
      '检查本机网络栈与代理设置；探活只走 127.0.0.1 回环，不应经过任何代理。',
      { cause: PROBE_CAUSE.NETWORK_ERROR, phase: 'connect' },
    );
  }

  let body = '';
  try {
    body = await response.text();
  } catch (err) {
    // K1：读 body 的异常必须走同一套归类，不能再一律判成 network-error/exit 6
    const verdict = classifyBodyFailure(err);
    if (verdict.cause === PROBE_CAUSE.BODY_TIMEOUT) {
      return fail(
        PROBE_REASON.TIMEOUT,
        `响应体停滞：${url} 已返回 HTTP ${response.status} 响应头，但 ${timeoutMs}ms 内没读完响应体（${verdict.detail}）`,
        '服务把响应体卡住了（vite 冷启动、代理缓冲、半开连接都可能）。先重试一次；持续出现就重启 dev server 并看日志。',
        { status: response.status, cause: PROBE_CAUSE.BODY_TIMEOUT, phase: 'body' },
      );
    }
    if (verdict.cause === PROBE_CAUSE.BODY_INTERRUPTED) {
      return fail(
        PROBE_REASON.NETWORK_ERROR,
        `读取响应体时连接被中断：${url}（${verdict.detail}）`,
        '服务在中途断开了连接，多半是 dev server 正在重启，稍后重试即可。',
        { status: response.status, cause: PROBE_CAUSE.BODY_INTERRUPTED, phase: 'body' },
      );
    }
    return fail(
      PROBE_REASON.NETWORK_ERROR,
      `读取响应体失败：${url}（${verdict.detail}）`,
      '这不是超时：连接建立后读取出错，检查本机网络栈/代理与 dev server 日志。',
      { status: response.status, cause: PROBE_CAUSE.NETWORK_ERROR, phase: 'body' },
    );
  }

  if (response.status !== 200) {
    const isNotFound = response.status === 404;
    return fail(
      PROBE_REASON.BAD_STATUS,
      `端口上的服务没有返回桌宠页面：${url} 返回 HTTP ${response.status}`,
      isNotFound
        ? '404 说明这个 dev server 认不出 ${DEV_ENDPOINT.entryPage}：请确认它由 vite.pet.config.ts 启动（appType: mpa + root 指向 frontend），而不是主应用那份 vite.config.ts。'
        : '这个端口上的服务不是桌宠 dev server。停掉它，再用 "npm run dev:pet" 重启。',
      { status: response.status, cause: PROBE_CAUSE.BAD_STATUS, phase: 'response' },
    );
  }

  const missingMarkers = PET_PAGE_MARKERS.filter((marker) => !body.includes(marker));
  if (missingMarkers.length === 0) {
    return {
      ok: true,
      reason: PROBE_REASON.OK,
      cause: PROBE_CAUSE.OK,
      phase: 'complete',
      url,
      status: response.status,
      exitCode: PROBE_EXIT_CODE.ok,
      message: `桌宠 dev server 就绪：${url}（HTTP 200，内容指纹 ${PET_PAGE_MARKERS.length}/${PET_PAGE_MARKERS.length} 命中）`,
      hint: '',
      missingMarkers: [],
    };
  }

  const foreign = MAIN_APP_SIGNATURES.filter((signature) => body.includes(signature));
  const foreignNote = foreign.length > 0
    ? `响应体含主应用特征（${foreign.join(' / ')}），说明该端口被主应用 dev server 占用。`
    : '响应体既不是桌宠页面，也没有识别出主应用特征。';
  return fail(
    PROBE_REASON.WRONG_APP,
    `端口上的服务不是桌宠（疑似被主应用占用）：${url} 返回 HTTP 200，但响应体缺少桌宠指纹 ${missingMarkers.join(' / ')}`,
    `${foreignNote}请先停掉占用该端口的服务，再用 "npm run dev:pet"（vite.pet.config.ts，端口 ${DEV_ENDPOINT.port}）启动桌宠 dev server；不要绕过探活直接把窗口拉起来。`,
    { status: response.status, missingMarkers, cause: PROBE_CAUSE.WRONG_APP, phase: 'response' },
  );
}

/**
 * 探活桌宠 dev server（可选轮询等待）。
 *
 * @param {object} [options] 选项
 * @param {string} [options.url] 探活目标，默认取单一真源拼出的入口页
 * @param {number} [options.timeoutMs] 单次请求超时（毫秒）
 * @param {number} [options.waitMs] 最长等待时间（毫秒），0 表示只探一次
 * @param {number} [options.intervalMs] 轮询间隔（毫秒）
 * @param {typeof fetch} [options.fetchImpl] fetch 实现（测试注入）
 * @returns {Promise<object>} 结论对象
 * @throws {TypeError} 参数非法时抛出
 */
async function probePetDevServer(options = {}) {
  const {
    url = buildEntryUrl(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitMs = 0,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof url !== 'string') {
    throw new TypeError(`探活目标必须是字符串，收到 ${typeof url}`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`探活目标不是合法 URL：${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`探活目标协议不受支持：${parsed.protocol}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs 必须是正数，收到 ${JSON.stringify(timeoutMs)}`);
  }
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new TypeError(`waitMs 必须是非负数，收到 ${JSON.stringify(waitMs)}`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError(`intervalMs 必须是正数，收到 ${JSON.stringify(intervalMs)}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl 必须是函数（Node 18+ 自带全局 fetch）');
  }

  const deadline = Date.now() + waitMs;
  let result = await probeOnce(url, timeoutMs, fetchImpl);
  while (!result.ok && Date.now() + intervalMs <= deadline) {
    await sleep(intervalMs);
    result = await probeOnce(url, timeoutMs, fetchImpl);
  }
  return result;
}

/**
 * 把结论渲染成人类可读的多行文本。
 *
 * @param {object} result 结论对象
 * @returns {string} 多行文本（含 \n，末尾无换行）
 */
function formatResult(result) {
  const lines = [result.ok ? `[OK] ${result.message}` : `[FAIL] ${result.message}`];
  if (result.hint) lines.push(`       处理建议：${result.hint}`);
  return lines.join('\n');
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数列表（不含 node 与脚本路径）
 * @returns {object} 解析结果
 * @throws {Error} 参数非法时抛出（调用方转成 EXIT_USAGE）
 */
function parseArgs(argv) {
  const options = { printPort: false, printUrl: false, json: false, help: false, waitMs: 0, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--print-port') options.printPort = true;
    else if (token === '--print-url') options.printUrl = true;
    else if (token === '--json') options.json = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--wait' || token === '--timeout') {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${token} 需要非负整数毫秒，收到 ${JSON.stringify(raw)}`);
      }
      if (token === '--wait') options.waitMs = value;
      else options.timeoutMs = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${token}（--help 查看用法）`);
    }
  }
  return options;
}

/** 用法说明。 */
const USAGE = [
  '桌宠 dev server 探活',
  '',
  '用法：node electron/pet-dev-probe.cjs [选项]',
  '',
  '  --wait <ms>     轮询等待直到就绪或超时（默认 0，只探一次）',
  '  --timeout <ms>  单次请求超时（默认 2000）',
  '  --print-port    打印桌宠 dev server 端口后退出',
  '  --print-url     打印桌宠入口页 URL 后退出',
  '  --json          以 JSON 输出结论',
  '  --help          显示本说明',
  '',
  `退出码：0 就绪；2 端口上的服务不是桌宠；3 端口无服务；4 非 200；5 超时（连接超时 / 响应体停滞）；6 其他网络错误（含响应体读取中断）；${EXIT_USAGE} 参数错误`,
].join('\n');

/**
 * CLI 入口。
 *
 * @param {string[]} argv 参数列表
 * @returns {Promise<number>} 进程退出码
 */
async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    logger('error')(err && err.message ? err.message : String(err));
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (options.help) {
    console.log(USAGE);
    return PROBE_EXIT_CODE.ok;
  }
  if (options.printPort) {
    process.stdout.write(`${DEV_ENDPOINT.port}\n`);
    return PROBE_EXIT_CODE.ok;
  }
  if (options.printUrl) {
    process.stdout.write(`${buildEntryUrl()}\n`);
    return PROBE_EXIT_CODE.ok;
  }

  const result = await probePetDevServer({ waitMs: options.waitMs, timeoutMs: options.timeoutMs });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    logger('info')(result.message);
  } else {
    logger('error')(formatResult(result));
  }
  return result.exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      // 用 exitCode 而不是 process.exit()：后者会截断还没刷完的 stdout（Windows 管道上尤其明显）
      process.exitCode = code;
    },
    (err) => {
      console.error(`[pet-probe] 未捕获异常：${err && err.stack ? err.stack : String(err)}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  PROBE_REASON,
  PROBE_EXIT_CODE,
  PROBE_CAUSE,
  EXIT_USAGE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  MAIN_APP_SIGNATURES,
  probePetDevServer,
  classifyBodyFailure,
  formatResult,
  parseArgs,
  main,
};
