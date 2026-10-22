/**
 * 极简 Chrome DevTools Protocol 客户端（零依赖）。
 *
 * <p>不依赖 playwright / puppeteer：这两个包不在本仓库依赖里，视觉基线又要求「拉下来就能跑」。
 * Node ≥ 22 自带 WebSocket，因此直接讲 CDP 协议即可：起一个 headless Chromium →
 * 连页面 target → {@code Page.navigate} / {@code Runtime.evaluate} / {@code Page.captureScreenshot}。</p>
 *
 * <p>浏览器来源（按优先级）：环境变量 {@code VISUAL_CHROME} → Playwright 浏览器缓存里的
 * chrome-headless-shell / chrome → 本机 Chrome 安装路径。项目里若没有 Playwright，
 * 建议 {@code npx playwright install chromium} 或直接指向系统 Chrome。</p>
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** 候选浏览器可执行文件（Windows 优先，其次常见 POSIX 路径）。 */
const CHROME_CANDIDATES = [
  () => pickLatestPlaywrightChromium('chromium_headless_shell-', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  () => pickLatestPlaywrightChromium('chromium-', 'chrome-win64', 'chrome.exe'),
  () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  () => 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  () => '/usr/bin/google-chrome',
  () => '/usr/bin/chromium',
];

/**
 * 在 Playwright 浏览器缓存目录里挑一个最新的 Chromium 构建。
 *
 * @param {string} prefix 目录名前缀（如 `chromium-`）。
 * @param {string} innerDir 构建内层目录名。
 * @param {string} executable 可执行文件名。
 * @returns {string | null} 存在的可执行文件路径。
 */
function pickLatestPlaywrightChromium(prefix, innerDir, executable) {
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(cacheRoot)) return null;
  const builds = fs.readdirSync(cacheRoot)
    .filter(name => name.startsWith(prefix))
    .sort()
    .reverse();
  for (const build of builds) {
    const candidate = path.join(cacheRoot, build, innerDir, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 解析可执行的 Chromium 路径。
 *
 * @returns {string} 可执行文件绝对路径。
 * @throws 全部候选都不存在时抛出，并给出补救办法。
 */
export function resolveChromePath() {
  if (process.env.VISUAL_CHROME && fs.existsSync(process.env.VISUAL_CHROME)) return process.env.VISUAL_CHROME;
  for (const factory of CHROME_CANDIDATES) {
    const candidate = factory();
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    '未找到可用的 Chromium。请任选其一：\n'
    + '  ① 设置环境变量 VISUAL_CHROME=<chrome.exe 绝对路径>\n'
    + '  ② npx playwright install chromium（浏览器缓存里已有构建则无需再装）\n'
    + '  ③ 安装本机 Google Chrome',
  );
}

/**
 * 探测端口是否空闲。
 *
 * @param {number} port 端口。
 * @returns {Promise<boolean>} 空闲为 true。
 */
export function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 从起始端口向上找一个空闲端口（端口被占时换端口，而不是失败）。
 *
 * @param {number} start 起始端口。
 * @param {number} [span] 最多尝试多少个。
 * @returns {Promise<number>} 可用端口。
 */
export async function findFreePort(start, span = 40) {
  for (let port = start; port < start + span; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`从 ${start} 起连续 ${span} 个端口都被占用，无法起服务`);
}

/**
 * 轮询直到 HTTP 端点可用。
 *
 * @param {string} url 探测地址。
 * @param {number} [timeoutMs] 超时毫秒。
 * @returns {Promise<boolean>} 就绪为 true。
 */
export async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.text();
        return true;
      }
    } catch {
      /* 还没起来，继续轮询 */
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

/** 一个 CDP 页面会话。 */
export class PageSession {
  /**
   * @param {WebSocket} socket 页面级 WebSocket。
   * @param {number} chromePid Chromium 进程号（收尾清理用）。
   */
  constructor(socket, chromePid) {
    this.socket = socket;
    this.chromePid = chromePid;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    /** @type {{level: string, text: string}[]} */
    this.consoleMessages = [];
    /** @type {string[]} */
    this.consoleErrors = [];
    /** @type {string[]} */
    this.exceptions = [];
    socket.addEventListener('message', event => this.dispatch(JSON.parse(event.data)));
  }

  /**
   * 分发一条 CDP 消息到等待中的命令或事件监听者。
   *
   * @param {any} message CDP 消息。
   */
  dispatch(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, method } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${method} 失败：${message.error.message}`));
      else resolve(message.result);
      return;
    }
    const method = message.method;
    if (!method) return;
    if (method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map(arg => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      this.consoleMessages.push({ level: message.params.type, text });
      if (message.params.type === 'error') this.consoleErrors.push(text);
    } else if (method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails;
      this.exceptions.push(detail?.exception?.description ?? detail?.text ?? '未知异常');
    } else if (method === 'Log.entryAdded') {
      const entry = message.params.entry;
      this.consoleMessages.push({ level: entry.level, text: entry.text });
      if (entry.level === 'error') this.consoleErrors.push(entry.text);
    }
    for (const handler of this.listeners.get(method) ?? []) handler(message.params);
  }

  /**
   * 发送一条 CDP 命令。
   *
   * @param {string} method 方法名。
   * @param {object} [params] 参数。
   * @returns {Promise<any>} 结果。
   */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 等待某个 CDP 事件（一次性）。
   *
   * @param {string} method 事件名。
   * @param {number} [timeoutMs] 超时毫秒。
   * @returns {Promise<any>} 事件参数。
   */
  waitEvent(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const handler = params => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter(item => item !== handler));
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter(item => item !== handler));
        reject(new Error(`等待事件 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), handler]);
    });
  }

  /**
   * 开启需要的域并固定视口尺寸（尺寸固定是截图可比的前提）。
   *
   * @param {{width?: number, height?: number}} [options] 视口参数。
   */
  async prepare(options = {}) {
    const width = options.width ?? 1440;
    const height = options.height ?? 900;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  }

  /**
   * 注入一段「每次新文档都先跑」的脚本（例如写 localStorage 的主题偏好）。
   *
   * @param {string} source 脚本源码。
   */
  async addInitScript(source) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  /**
   * 导航并等待页面就绪。
   *
   * 以 {@code Page.loadEventFired} 为主信号，但它存在两类天然不可靠：一是事件在
   * {@code Page.navigate} 返回前就已回放（竞态），二是缓存命中时事件可能不再重放。
   * 因此该事件超时只降级为「轮询 document.readyState」，不直接判失败——就绪判定
   * 的真正依据始终是调用方随后的显式等待（如 waitForReady 的应用渲染断言）。
   *
   * @param {string} url 目标地址。
   */
  async navigate(url) {
    const loaded = this.waitEvent('Page.loadEventFired', 40000).then(() => true, () => false);
    await this.send('Page.navigate', { url });
    if (await loaded) return;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState');
      if (state === 'complete' || state === 'interactive') return;
      await new Promise(resolve => { setTimeout(resolve, 200); });
    }
    throw new Error(`导航后页面始终未就绪：${url}`);
  }

  /**
   * 在页面里执行表达式（自动 await Promise，按值返回）。
   *
   * @param {string} expression 表达式源码。
   * @returns {Promise<any>} 结果。
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面求值抛错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  /**
   * 截取当前视口并写入 PNG。
   *
   * @param {string} filePath 输出路径。
   * @returns {string} 输出路径。
   */
  async screenshot(filePath) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  /** 关闭本页会话。 */
  close() {
    try { this.socket.close(); } catch { /* 忽略 */ }
  }
}

/** 一个 headless Chromium 实例。 */
export class Browser {
  /**
   * @param {import('node:child_process').ChildProcess} child 进程。
   * @param {number} port 调试端口。
   */
  constructor(child, port) {
    this.child = child;
    this.port = port;
  }

  /**
   * 新开一个页面 target。
   *
   * @returns {Promise<PageSession>} 页面会话。
   */
  async newPage() {
    // 端口刚监听时偶发 ECONNRESET（Chromium 的 HTTP 处理器还在初始化），重试几次即可。
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' });
        if (!response.ok) throw new Error(`创建页面失败：HTTP ${response.status}`);
        const target = await response.json();
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
        });
        return new PageSession(socket, this.child.pid);
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  /** 关闭浏览器进程树。 */
  close() {
    if (this.child?.pid) {
      spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
}

/**
 * 启动 headless Chromium。
 *
 * @param {{width?: number, height?: number, logFile?: string}} [options] 参数。
 * @returns {Promise<Browser>} 浏览器实例。
 */
export async function launchBrowser(options = {}) {
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const chromePath = resolveChromePath();
  const port = await findFreePort(9400);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-visual-'));

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--disable-gpu',
    'about:blank',
  ];
  const stdio = options.logFile
    ? (() => {
      const fd = fs.openSync(options.logFile, 'a');
      return ['ignore', fd, fd];
    })()
    : 'ignore';
  const child = spawn(chromePath, args, { stdio, windowsHide: true });
  const ready = await waitForHttp(`http://127.0.0.1:${port}/json/version`, 25000);
  if (!ready) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    throw new Error(`Chromium 调试端口 ${port} 未就绪`);
  }
  return new Browser(child, port);
}
