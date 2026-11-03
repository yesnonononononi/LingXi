'use strict';

/**
 * 桌宠开发服务器端点真源（single source of truth）。
 *
 * <p><b>为什么必须有这个文件（真实事故）：</b>桌宠的 dev server 一度与主应用共用 5174。
 * 两边都跑起来时先到先得，且都没有 `strictPort`，Vite 在端口被占时会静默 +1 漂移。于是
 * `pet-up.cmd` 探活打到的是<b>主应用的 dev server</b>：`/pet.html` 被 Vite 的 SPA history
 * fallback 兜成 `index.html`，<b>状态码仍是 200</b>。只看状态码的探活据此认定"桌宠已就绪"，
 * 跳过启动桌宠 dev server，最终 Electron 窗口里显示的是整个主应用界面。</p>
 *
 * <p>修复的架构口径：**端口、宿主、入口页、身份标记只在这里定义一次**。
 * 消费方一律从本模块取，任何地方再写字面量都算缺陷：</p>
 * <ul>
 *   <li>`frontend/vite.pet.config.ts` —— 经 {@link createPetViteOverrides} 拿到
 *       `port` / `strictPort` / `appType`；</li>
 *   <li>`frontend/electron/pet-window.cjs` —— 兜底入口地址经 {@link buildDevOrigin}；</li>
 *   <li>`frontend/electron/pet-dev-probe.cjs` —— 探活目标经 {@link buildEntryUrl}；</li>
 *   <li>仓外 `.lingxi/tools/pet-up.cmd` / `pet-launcher.cjs` —— 经 CLI（`--print-port` /
 *       `--print-url`）或 `require` 本模块取值。</li>
 * </ul>
 *
 * <p><b>为什么是 CommonJS：</b>它要同时被 `node --test`、批处理脚本（`node xxx.cjs --print-port`）
 * 和 Electron 主进程读取，CJS 是三者唯一都零配置支持的格式。TypeScript 侧用同目录的
 * `pet-dev-endpoint.d.cts` 提供类型声明。</p>
 */

/**
 * 桌宠 dev server 端点配置。
 *
 * <p>`port` 选 5275：主应用固定 5174（见 `frontend/vite.config.ts` 的 `server.port`），
 * 两者必须错开，否则"探活打到别人家"这类缺陷会再次发生。</p>
 *
 * <p>`appMetaMarker` / `rootMarker` 是探活的内容指纹。<b>指纹必须落在响应体里</b>，
 * 而不是只看状态码——原因见文件头注释。</p>
 */
const DEV_ENDPOINT = Object.freeze({
  /** 监听地址：只绑回环，避免把开发服务器暴露到局域网。 */
  host: '127.0.0.1',
  /** 桌宠 dev server 端口（唯一真源）。 */
  port: 5275,
  /** 桌宠入口页（相对 Vite root）。 */
  entryPage: 'pet.html',
  /** `pet.html` 头部的身份标记。 */
  appMetaMarker: '<meta name="lx-app" content="pet"',
  /** `pet.html` body 里的唯一 DOM 锚点（渲染层也依赖它挂载）。 */
  rootMarker: '<div id="pet-root"',
});

/**
 * 探活必须命中的全部内容指纹。
 *
 * <p>全都要命中才算"是桌宠页面"：少写一个 meta 就意味着"任何页面只要含 `pet-root`
 * 就能冒充桌宠"，指纹就失效了。</p>
 */
const PET_PAGE_MARKERS = Object.freeze([DEV_ENDPOINT.rootMarker, DEV_ENDPOINT.appMetaMarker]);

/** 端口合法区间（TCP 端口规范）。 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * 校验端点配置。
 *
 * <p>配置是纯数据、但会被批处理与 Electron 一起消费，脏值必须在这里就炸掉，
 * 而不是等到 `new URL()` 抛 `Invalid URL` 把主进程弹窗崩溃（历史事故）。</p>
 *
 * @param {object} endpoint 待校验的端点配置
 * @returns {object} 原样返回校验通过的配置
 * @throws {TypeError} 宿主、端口或入口页非法时抛出
 */
function assertEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new TypeError('桌宠 dev 端点配置缺失');
  }
  const { host, port, entryPage } = endpoint;
  if (typeof host !== 'string' || host.trim() === '') {
    throw new TypeError(`桌宠 dev server 宿主非法：${JSON.stringify(host)}`);
  }
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new TypeError(`桌宠 dev server 端口非法：${JSON.stringify(port)}（合法区间 ${MIN_PORT}-${MAX_PORT}）`);
  }
  if (typeof entryPage !== 'string' || !entryPage.endsWith('.html')) {
    throw new TypeError(`桌宠入口页非法：${JSON.stringify(entryPage)}（应为 *.html）`);
  }
  return endpoint;
}

/**
 * 桌宠 dev server 的来源地址（不带结尾斜杠）。
 *
 * @param {object} [endpoint=DEV_ENDPOINT] 端点配置
 * @returns {string} 形如 `http://127.0.0.1:5275`
 */
function buildDevOrigin(endpoint = DEV_ENDPOINT) {
  const { host, port } = assertEndpoint(endpoint);
  return `http://${host}:${port}`;
}

/**
 * 桌宠入口页的完整 URL。
 *
 * <p>探活与 Electron 窗口入口都用它：<b>"探活的目标"和"窗口加载的目标"必须是同一个
 * 字符串拼接逻辑</b>，否则探活通过不代表窗口一定拿到对的页面。</p>
 *
 * @param {object} [endpoint=DEV_ENDPOINT] 端点配置
 * @returns {string} 形如 `http://127.0.0.1:5275/pet.html`
 */
function buildEntryUrl(endpoint = DEV_ENDPOINT) {
  return `${buildDevOrigin(endpoint)}/${assertEndpoint(endpoint).entryPage}`;
}

/**
 * 生成 `vite.pet.config.ts` 的覆盖项。
 *
 * <p>三个字段各司其职，缺一不可：</p>
 * <ol>
 *   <li>`server.port` —— 与主应用 5174 隔离；</li>
 *   <li>`server.strictPort: true` —— 端口被占时<b>硬失败</b>。没有它 Vite 会静默
 *       `5174 → 5176` 地漂移，探活与窗口入口就指向了错误端口；</li>
 *   <li>`appType: 'mpa'` —— 关掉 SPA 的 history fallback。这是根治手段：
 *       `strictPort` 只保证"我拿到了这个端口"，`appType: 'mpa'` 才保证
 *       "`/pet.html` 不存在时返回 404，而不是被兜成 `index.html`"。</li>
 * </ol>
 *
 * @param {object} [endpoint=DEV_ENDPOINT] 端点配置
 * @returns {{appType: string, server: {host: string, port: number, strictPort: boolean, open: boolean}}} Vite 配置片段
 */
function createPetViteOverrides(endpoint = DEV_ENDPOINT) {
  const { host, port } = assertEndpoint(endpoint);
  return {
    // 'mpa' 多入口模式：dev 下不注册 html fallback / spa fallback 中间件
    appType: 'mpa',
    server: {
      host,
      port,
      // 端口被占直接失败，绝不允许 Vite 自动 +1 漂移
      strictPort: true,
      // 启动即开浏览器对桌宠毫无意义（它只在 Electron 窗口里跑）
      open: false,
    },
  };
}

module.exports = {
  DEV_ENDPOINT,
  PET_PAGE_MARKERS,
  MIN_PORT,
  MAX_PORT,
  assertEndpoint,
  buildDevOrigin,
  buildEntryUrl,
  createPetViteOverrides,
};
