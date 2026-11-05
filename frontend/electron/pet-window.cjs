/**
 * 桌宠窗口（Live2D 阶段一：只做窗口骨架，不含任何渲染依赖）。
 *
 * <p><b>为什么单独一个模块而不是塞进 main.cjs：</b>桌宠窗口的窗口参数（透明、置顶层级、
 * 不抢焦点、不进任务栏）与桌面主窗口完全相反，而且它还有独立的 IPC（穿透 / 拖拽 / 位置持久化）。
 * 放在 main.cjs 里会让那份文件继续膨胀，也不好单独验证。</p>
 *
 * <p><b>为什么要求「默认点击穿透」：</b>桌宠常驻在所有应用之上，如果整块窗口（含四周透明留白）
 * 都吃鼠标，用户就会在空白处「点不动」，观感极差。因此默认 `setIgnoreMouseEvents(true, { forward: true })`，
 * 只有渲染层报告的命中区（假宠物的圆形本体，将来换成 Live2D 模型的包围盒）内才临时关掉穿透。</p>
 *
 * <p><b>为什么 `forward: true` 是必需的：</b>不开 forward 时穿透中的窗口收不到任何 mousemove，
 * 渲染层就永远无法重新报告「鼠标进来了」，等于把自己永久锁死在穿透状态。这是本功能最容易踩的坑。</p>
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 桌宠 dev 端点真源（端口 / 入口页 / 身份指纹）。
 *
 * <p>"兜底入口地址"与"探活目标"必须同源：以前这里是第二处 `5174` 字面量，
 * 一旦探活脚本和服务端口对不上，`resolveDevEntryUrl` 的兜底会把窗口指向**主应用**。</p>
 */
const PET_DEV_ENDPOINT = require('./pet-dev-endpoint.cjs');

/**
 * 延迟取 electron 运行时。
 *
 * <p>本模块里只有创建窗口与查询屏幕才真正需要 electron；把 require 提到顶层会让这个文件
 * 在纯 node 下（单元测试）直接崩掉，而其中的坐标换算函数是纯函数，最值得被测。</p>
 */
function electron() {
  return require('electron');
}

// ---------------------------------------------------------------- 常量

/**
 * 桌宠几何真源。
 *
 * <p><b>为什么主进程也读同一份 JSON：</b>窗口尺寸以前是这里的 4 个字面量，`pet.css` 里再抄一份
 * 同名变量，靠注释互相指认——注释不会在 CI 里失败。真源收敛到 `frontend/pet-geometry.json`，
 * 主进程、渲染层（`src/pet/layout.ts`）、门禁脚本三方共读，`npm run gate:pet` 兜底。</p>
 *
 * <p><b>打包必须带上这个文件</b>：`package.json` → `build.files` 已显式加入它；漏了的话，
 * 打包版的桌宠窗口会在 require 阶段直接抛错。</p>
 */
const GEOMETRY = require('../pet-geometry.json');

/**
 * 立绘箱宽度（CSS px）。
 *
 * <p>v2 立绘是 1024×1536 的**正立**图，立绘箱按画布 2:3 比例定、渲染等比 `contain`——
 * 箱子比例等于画布比例，才既不裁尾巴也不留横白。</p>
 */
const ART_WIDTH = GEOMETRY.artWidth;
/** 立绘箱高度（CSS px）。 */
const ART_HEIGHT = GEOMETRY.artHeight;
/**
 * 立绘四周留给「光晕 / 投影」的透明余量（兼容保留）。
 *
 * <p>M3 起真正的边距是四边 `effectMargin`（见下），`glowPad` 只在**老版本真源缺少
 * `effectMargin` 时**作为四边的回退值，保证双仓共用同一份 JSON 时不会因字段新增而炸。
 * `pet.css` 的首帧兜底仍引用它（`--pet-art-glow-pad`），所以这里不能删。</p>
 */
const GLOW_PAD = GEOMETRY.glowPad;
/**
 * 四边特效边距（上/右/下/左，CSS px）。
 *
 * <p>为什么不再用单值：<b>四类溢出方向本来就不对称</b>——呆毛弹动向上、光晕/接地阴影向下、
 * 气泡只占顶部、左右只需给耳根一点位移余量。单值只能取最大值，等于为了底部多花顶部空间。
 * M3 先做等值迁移（四边 16，窗口 188×338）；M4 拿到视觉批准后定为 24/20/18/20，
 * 窗口变成 `196×348`，立绘箱仍是 156×234（宠物本体没变大，只是留白变对了）。
 * M2 的 D-01 再改左右为 24/56/18/56 ⇒ 窗口 `268×348`：pose 批次的墨迹比立绘宽，
 * `run` 在 20px 边距下左右都要越界（详见 `pet-geometry.json` 与设计 §C1）。</p>
 */
const EFFECT_MARGIN = GEOMETRY.effectMargin ?? { top: GLOW_PAD, right: GLOW_PAD, bottom: GLOW_PAD, left: GLOW_PAD };
/**
 * 顶部为「一句话气泡」预留的高度。
 *
 * <p>预留而不是动态撑高窗口：气泡出现时改窗口尺寸会让已经拖动过的位置跳一下。</p>
 */
const BUBBLE_H = GEOMETRY.bubbleHeight;

/**
 * 桌宠窗口尺寸 = 立绘箱 + 四边特效边距 + 顶部气泡预留（**含留白**）。
 *
 * <p>四边必须分开加：一旦边距不对称，`GLOW_PAD × 2` 会让窗口比立绘箱窄，
 * 等比 `contain` 立刻被窗口边缘裁掉（尾巴最先遭殃）。`gate:pet` 会核对这两条表达式形态。</p>
 */
const PET_WIDTH = ART_WIDTH + EFFECT_MARGIN.left + EFFECT_MARGIN.right;
const PET_HEIGHT = ART_HEIGHT + EFFECT_MARGIN.top + EFFECT_MARGIN.bottom + BUBBLE_H;

/**
 * 立绘箱左上角在窗口里的位置（CSS px）。
 *
 * <p>它就是"视觉原点"：宠物在屏幕上看起来在哪儿，只由 `窗口左上角 + 这个偏移` 决定。
 * 特效边距一改（M4：上 16→24、左 16→20），窗口也要跟着变宽变高——
 * 如果只改尺寸不补位置，用户升级后会发现桌宠**凭空跳了 4px 左、8px 上**。</p>
 */
const ART_ORIGIN = { x: EFFECT_MARGIN.left, y: EFFECT_MARGIN.top + BUBBLE_H };

/**
 * 旧版（M4 之前，四边边距都是 `glowPad`）的立绘箱原点。
 *
 * <p>只用于**老状态文件补位**：那些文件里存的是旧窗口的左上角，没有记录当时的原点，
 * 于是按这份历史值反算偏移，把立绘拉回原来的屏幕位置（`x - 4`、`y - 8`）。</p>
 */
const LEGACY_ART_ORIGIN = { x: GLOW_PAD, y: GLOW_PAD + BUBBLE_H };

/** 尺寸的安全区间：太小装不下模型，太大会挡住桌面操作。 */
const MIN_DIMENSION = 120;
const MAX_DIMENSION = 1200;
/** 距离工作区边缘的默认留白（首次启动摆在右下角）。 */
const EDGE_MARGIN = 24;
/** 位置持久化文件名（落在 `app.getPath('userData')` 下）。 */
const STATE_FILE_NAME = 'pet-window-state.json';
/**
 * 置顶层级。
 *
 * <p>`screen-saver` 是 Electron 里可用到的最高层级，能盖住全屏应用之外的一切窗口；
 * 默认的 `floating` 会被某些全屏/置顶应用压住，桌宠「消失」却查不出原因。</p>
 */
const ALWAYS_ON_TOP_LEVEL = 'screen-saver';
/**
 * 穿透状态的下发合并窗口（毫秒）。
 *
 * <p>渲染层按 rAF 频率上报命中状态（一次移动最多 60 次/秒），每次都调
 * `setIgnoreMouseEvents` 会在 Windows 上产生可见的窗口事件风暴。这里合并 + 去重：
 * 只在「值真的变了」的时候下发一次。</p>
 */
const HIT_APPLY_DELAY_MS = 30;
/** 拖拽过程中位置落盘的节流间隔（毫秒）：每帧写盘既慢又伤盘。 */
const SAVE_THROTTLE_MS = 400;
/**
 * 恢复位置时要求窗口至少有这么大比例落在某块屏幕内。
 *
 * <p>用「比例」而不是「坐标在某个 workArea 内」，是因为用户可能把窗口拖到两块屏的接缝处；
 * 只要还有相当一部分可见就算合法，完全不可见（屏幕被拔掉 / 分辨率变小）才回默认角落。</p>
 */
const MIN_VISIBLE_RATIO = 0.4;

// ---------------------------------------------------------------- 纯函数（可单测）

/**
 * 归一化一个尺寸值。
 *
 * @param value 任意输入
 * @param fallback 非法或缺失时的兜底值
 * @returns 落在 [MIN_DIMENSION, MAX_DIMENSION] 内的整数
 */
function normalizeDimension(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, num)));
}

/**
 * 计算两个矩形的相交面积。
 *
 * @param a 矩形 { x, y, width, height }
 * @param b 矩形 { x, y, width, height }
 * @returns 相交面积；不相交时为 0
 */
function intersectArea(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * 把矩形夹进某块工作区。
 *
 * @param rect 目标矩形
 * @param area 工作区 { x, y, width, height }
 * @returns 完全落在工作区内的新矩形（尺寸不变；工作区比窗口还小时贴左上角）
 */
function clampRectToWorkArea(rect, area) {
  const maxX = area.x + area.width - rect.width;
  const maxY = area.y + area.height - rect.height;
  return {
    x: Math.round(Math.min(Math.max(rect.x, area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(rect.y, area.y), Math.max(area.y, maxY))),
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 默认落点：工作区右下角内缩 EDGE_MARGIN。
 *
 * @param size 窗口尺寸
 * @param area 工作区
 * @returns 矩形
 */
function defaultRect(size, area) {
  return {
    x: Math.round(area.x + area.width - size.width - EDGE_MARGIN),
    y: Math.round(area.y + area.height - size.height - EDGE_MARGIN),
    width: size.width,
    height: size.height,
  };
}

/**
 * 在屏幕列表里挑出与矩形重叠最多的那块屏。
 *
 * @param rect 矩形
 * @param displays 显示器信息数组
 * @returns 命中的显示器与可见比例（都不命中时为 null 与 0）
 */
function pickDisplay(rect, displays) {
  let matched = null;
  let bestArea = 0;
  const totalArea = Math.max(1, rect.width * rect.height);
  const list = Array.isArray(displays) ? displays : [];
  for (const display of list) {
    if (!display || !display.workArea) continue;
    const area = intersectArea(rect, display.workArea);
    if (area > bestArea) {
      bestArea = area;
      matched = display;
    }
  }
  return { display: matched, visibleRatio: bestArea / totalArea };
}

/**
 * 解算桌宠窗口的启动位置。
 *
 * <p>三种情况：没存过 / 存的是脏数据 → 默认角落；存过但已经越界（屏幕被拔掉、分辨率变小）
 * → 默认角落；仍在某块屏上有足够可见面积 → 夹进那块屏。**永远返回一个完全可见的位置**，
 * 因为一个跑到屏幕外的桌宠用户没法用鼠标找回来（它还不进任务栏）。</p>
 *
 * @param options.saved 上次持久化的状态（可为 null）
 * @param options.size 目标尺寸 { width, height }
 * @param options.displays 显示器信息数组（来自 `screen.getAllDisplays()`）
 * @param options.primaryArea 主显示器工作区（兜底落点用）
 * @returns 完全落在某块工作区内的矩形
 */
function resolveInitialBounds({ saved, size, displays, primaryArea }) {
  const width = normalizeDimension(size && size.width, PET_WIDTH);
  const height = normalizeDimension(size && size.height, PET_HEIGHT);
  const wanted = { width, height };
  const savedX = saved ? Number(saved.x) : Number.NaN;
  const savedY = saved ? Number(saved.y) : Number.NaN;
  if (!Number.isFinite(savedX) || !Number.isFinite(savedY)) {
    return defaultRect(wanted, primaryArea);
  }
  // 视觉位置补偿：用户记住的是"桌宠看起来在屏幕哪块"，不是"窗口左上角在哪"。
  // 特效边距一变，窗口左上角就得反向挪同样的量，否则升级后桌宠会凭空跳位。
  // 新状态文件带 artOrigin；老文件没有，按 LEGACY_ART_ORIGIN 反算（M4 即 x-4 / y-8）。
  const savedOrigin =
    saved && saved.artOrigin && Number.isFinite(Number(saved.artOrigin.x)) && Number.isFinite(Number(saved.artOrigin.y))
      ? { x: Number(saved.artOrigin.x), y: Number(saved.artOrigin.y) }
      : LEGACY_ART_ORIGIN;
  const rect = {
    x: Math.round(savedX + (savedOrigin.x - ART_ORIGIN.x)),
    y: Math.round(savedY + (savedOrigin.y - ART_ORIGIN.y)),
    width,
    height,
  };
  const { display, visibleRatio } = pickDisplay(rect, displays);
  if (!display || visibleRatio < MIN_VISIBLE_RATIO) {
    return defaultRect(wanted, primaryArea);
  }
  return clampRectToWorkArea(rect, display.workArea);
}

// ---------------------------------------------------------------- 状态文件

/**
 * 读取持久化的窗口状态。
 *
 * @param filePath 状态文件绝对路径
 * @returns 解析成功的对象，任何异常都返回 null（位置读不出来就回默认角落，不能阻塞启动）
 */
function readState(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写入窗口状态。
 *
 * @param filePath 状态文件绝对路径
 * @param state 待写入的对象
 * @returns 是否写入成功（失败只记日志：位置存不下不影响本次使用）
 */
function writeState(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`[pet] 位置保存失败: path=${filePath}, error=${(err && err.message) || err}`);
    return false;
  }
}

// ---------------------------------------------------------------- 窗口管理器

/**
 * 注册桌宠窗口。
 *
 * @param options.ipcMain Electron 的 ipcMain
 * @param options.isDev 是否开发态（决定入口走 Vite 服务还是 dist 产物）
 * @param options.frontendRoot 前端根目录（解析 `dist/pet.html`）
 * @param options.statePath 可选：状态文件路径覆盖（测试用）
 * @returns 窗口管理 API
 */
/**
 * 开发态入口兜底地址。
 *
 * <p><b>为什么从单一真源取：</b>以前这里是 `http://localhost:5174` 字面量——5174 是
 * <b>主应用</b>的 dev server 端口，于是"兜底"变成"兜到主应用界面"。端口、宿主、入口页
 * 现在只有 `electron/pet-dev-endpoint.cjs` 一处真源，`ELECTRON_URL` 脏值时退化到它。</p>
 */
const DEV_ENTRY_FALLBACK = PET_DEV_ENDPOINT.buildDevOrigin();

/**
 * 桌宠入口页文件名（`pet.html`）。
 *
 * <p><b>为什么不是字面量（K4）：</b>入口页名以前在 `resolveEntry()` 里写了两遍——
 * dev 分支 `${url}pet.html`、dist 分支 `path.join(root,'dist','pet.html')`。
 * 而探活侧（`electron/pet-dev-probe.cjs`）用的是真源里的 `entryPage`：
 * <b>一处改名就变成"探活这个页面、窗口加载那个页面"</b>，与当初"探活指向主应用、
 * 窗口指向别处"是同一类缺陷。所以只认 `electron/pet-dev-endpoint.cjs` 的
 * `DEV_ENDPOINT.entryPage`，dev / dist 两条分支共用它。</p>
 */
const PET_ENTRY_PAGE = PET_DEV_ENDPOINT.DEV_ENDPOINT.entryPage;

/**
 * 把 `ELECTRON_URL` 规整成一个可安全拼接的 base URL（恒以 `/` 结尾）。
 *
 * <p><b>为什么需要这层（真实事故）：</b>这个环境变量由批处理脚本设置，而
 * `set VAR=value &amp;&amp; cmd` 会把 value 后面那个空格一起设进去。旧实现是
 * `${url}/` 先拼字符串再 `new URL()`——空格落在主机名里变成 `5174 /`，
 * URL 解析器再怎么容错也救不回来，直接抛 `Invalid URL`，主进程弹
 * 「A JavaScript error occurred in the main process」。
 *
 * <p>所以顺序必须是：**先解析校验，再拼路径**。入口地址是可降级配置，
 * 脏值只该退化成默认端口加一条告警，绝不该阻断启动。</p>
 *
 * @param raw 环境变量原值（不可信：可能为空、带空格、带引号、根本不是 URL）
 * @returns 规范化后的 base URL，恒以 `/` 结尾
 */
function resolveDevEntryUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
  if (!value) return `${DEV_ENTRY_FALLBACK}/`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.warn(`[pet] ELECTRON_URL 不是合法 URL（原值=${JSON.stringify(raw)}），已回退到 ${DEV_ENTRY_FALLBACK}`);
    return `${DEV_ENTRY_FALLBACK}/`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn(`[pet] ELECTRON_URL 协议不受支持（${parsed.protocol}），已回退到 ${DEV_ENTRY_FALLBACK}`);
    return `${DEV_ENTRY_FALLBACK}/`;
  }
  const href = parsed.toString();
  return href.endsWith('/') ? href : `${href}/`;
}

/**
 * 计算桌宠窗口的入口（纯函数，不需要 Electron，便于单测）。
 *
 * <p>两条分支共用同一个入口页名 {@link PET_ENTRY_PAGE}（来自单一真源）：</p>
 * <ul>
 *   <li>开发态：`ELECTRON_URL` 规整后 + 入口页名，走 Vite 服务；</li>
 *   <li>打包态：`&lt;frontendRoot&gt;/dist/` + 入口页名，走本地文件。</li>
 * </ul>
 *
 * <p><b>为什么抽成纯函数（K4 副产物）：</b>原来这段逻辑埋在 `registerPetWindow` 的闭包里，
 * 要测"入口页到底用了哪个名字"必须起 Electron。抽出来以后可以只喂参数就断言两条分支
 * 都等于真源里的 `entryPage`，改名/硬编码会立刻被发现。</p>
 *
 * @param options 入参
 * @param options.isDev 是否开发态
 * @param options.frontendRoot 前端根目录（打包态解析 `dist/`）
 * @param options.rawUrl `ELECTRON_URL` 原值（未可信：可能为空/带空格/带引号）
 * @returns {{kind: 'url' | 'file', value: string}} 入口描述
 * @throws {TypeError} 打包态未提供合法 `frontendRoot` 时抛出
 */
function resolveEntrySpec({ isDev, frontendRoot, rawUrl }) {
  if (isDev === true) {
    return { kind: 'url', value: `${resolveDevEntryUrl(rawUrl)}${PET_ENTRY_PAGE}` };
  }
  if (typeof frontendRoot !== 'string' || frontendRoot.trim() === '') {
    throw new TypeError('resolveEntrySpec：打包态必须提供非空的 frontendRoot');
  }
  return { kind: 'file', value: path.join(frontendRoot, 'dist', PET_ENTRY_PAGE) };
}

/**
 * 注册桌宠窗口（窗口参数 + IPC + 显隐与持久化）。
 *
 * @param options 依赖注入
 * @returns 窗口控制器
 */
function registerPetWindow({ ipcMain, isDev, frontendRoot, statePath }) {
  const resolvedStatePath = statePath || path.join(electron().app.getPath('userData'), STATE_FILE_NAME);

  /** 当前桌宠窗口（懒创建：托盘被点之前不占任何资源）。 */
  let win = null;
  /** 当前是否处于点击穿透。初始为 true：窗口一出现就必须是穿透的。 */
  let ignoring = true;
  /** 穿透状态的合并定时器与其待下发值。 */
  let ignoreTimer = null;
  let pendingIgnore = null;
  /** 是否正在自定义拖拽。 */
  let dragging = false;
  /** 拖拽起点：光标相对窗口左上角的偏移，保证「抓起哪就从哪拖」。 */
  let dragOffset = { x: 0, y: 0 };
  /** 位置落盘定时器。 */
  let saveTimer = null;
  /** 可见性变化订阅者（托盘要跟着刷新勾选状态）。 */
  const visibilityListeners = new Set();
  /** 屏幕变化监听是否已挂（screen 只能在 app ready 之后用，故延迟到首次创建）。 */
  let displayListenersBound = false;

  /**
   * 通知外界可见性变了。
   *
   * <p><b>两个收件人，缺一不可：</b></p>
   * <ol>
   *   <li>主进程订阅者（托盘据此刷新"显示桌宠"的勾选）——一直是这么用的；</li>
   *   <li><b>渲染层</b>（M6-b 补上）：渲染层的功耗策略里 `off` 档的判据是 `visible === false`，
   *       而在此之前**没有任何代码把可见性下发给渲染层**，于是 `off` 是一条死分支：
   *       桌宠被藏起来以后只落到 `low`（动画时长 ×2，仍在跑合成器 + 眨眼定时器照常）。
   *       分层开闸后这句话的分量变了：藏起来的桌宠原来是 2 张静止帧，现在是
   *       **9 层各跑一条 CSS 动画**，白烧的电直接翻了好几倍。</li>
   * </ol>
   *
   * <p>时序安全：窗口还没建/DOM 还没就绪时 `webContents.send` 发出去也没人听，
   * 加载完成后 `did-finish-load` 会再发一条 `ready`，渲染层以最后一条状态为准。</p>
   */
  function notifyVisibility() {
    const visible = isVisible();
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:command', { type: 'visible', visible });
    }
    for (const listener of visibilityListeners) {
      try {
        listener(visible);
      } catch (err) {
        console.warn(`[pet] 可见性回调异常: error=${(err && err.message) || err}`);
      }
    }
  }

  /** 当前是否可见。 */
  function isVisible() {
    return !!win && !win.isDestroyed() && win.isVisible();
  }

  /** 取屏幕 API（app ready 之后才可用）。 */
  function screenApi() {
    return electron().screen;
  }

  /**
   * 窗口入口：开发态走 Vite 服务，打包态走 dist 内的多入口产物。
   *
   * <p>开发态 URL 一律经 {@link resolveDevEntryUrl} 规整：先解析校验再拼入口页，
   * 不要反过来（历史上就是先拼字符串、空格落进主机名，抛 `Invalid URL` 崩主进程）。</p>
   *
   * <p>两条分支的入口页名都来自单一真源（见 {@link resolveEntrySpec}），
   * 这里不再出现 `'pet.html'` 字面量：探活打哪个页面，窗口就加载哪个页面。</p>
   */
  function resolveEntry() {
    return resolveEntrySpec({ isDev, frontendRoot, rawUrl: process.env.ELECTRON_URL });
  }

  /** 清掉穿透合并定时器。 */
  function clearIgnoreTimer() {
    if (ignoreTimer) {
      clearTimeout(ignoreTimer);
      ignoreTimer = null;
    }
    pendingIgnore = null;
  }

  /**
   * 把「是否穿透」合并后下发给窗口。
   *
   * <p>去重是关键：渲染层每帧都可能有 mousemove，状态没变的时候绝不能重复调用
   * `setIgnoreMouseEvents`（Windows 上会看到鼠标指针状态抖动）。</p>
   *
   * @param next 目标值，true = 穿透
   */
  function applyIgnoreMouse(next) {
    pendingIgnore = next === true;
    if (ignoreTimer) return;
    ignoreTimer = setTimeout(() => {
      ignoreTimer = null;
      const target = pendingIgnore;
      pendingIgnore = null;
      if (target === null || target === ignoring) return;
      if (!win || win.isDestroyed()) return;
      ignoring = target;
      // 穿透态必须带 forward，否则收不到 mousemove，就再也无法恢复交互
      win.setIgnoreMouseEvents(target, target ? { forward: true } : undefined);
      // 回执给渲染层：它用它来显示「穿透中 / 可交互」的调试标记
      win.webContents.send('pet:command', { type: 'hit-state', hit: !target });
    }, HIT_APPLY_DELAY_MS);
  }

  /** 取窗口当前几何；窗口不存在时返回 null。 */
  function captureBounds() {
    if (!win || win.isDestroyed()) return null;
    const bounds = win.getBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  /** 立即把当前位置写盘。 */
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const bounds = captureBounds();
    if (!bounds) return;
    writeState(resolvedStatePath, { ...bounds, artOrigin: ART_ORIGIN, updatedAt: new Date().toISOString() });
  }

  /** 拖拽期间的落盘节流。 */
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const bounds = captureBounds();
      if (!bounds) return;
      writeState(resolvedStatePath, { ...bounds, artOrigin: ART_ORIGIN, updatedAt: new Date().toISOString() });
    }, SAVE_THROTTLE_MS);
  }

  /** 把窗口拉回可见区（显示器增减 / 分辨率变化后调用）。 */
  function reclampIntoDisplays() {
    const bounds = captureBounds();
    if (!bounds) return;
    const { screen } = electron();
    const target = resolveInitialBounds({
      saved: bounds,
      size: bounds,
      displays: screen.getAllDisplays(),
      primaryArea: screen.getPrimaryDisplay().workArea,
    });
    if (target.x !== bounds.x || target.y !== bounds.y) {
      win.setPosition(target.x, target.y, false);
    }
  }

  /** 挂显示器变化监听：屏幕被拔掉时桌宠不能留在看不见的地方。 */
  function bindDisplayListeners() {
    if (displayListenersBound) return;
    displayListenersBound = true;
    try {
      const { screen } = electron();
      screen.on('display-removed', reclampIntoDisplays);
      screen.on('display-metrics-changed', reclampIntoDisplays);
    } catch (err) {
      console.warn(`[pet] 显示器监听注册失败: error=${(err && err.message) || err}`);
    }
  }

  /** 校验 IPC 来源：只认桌宠窗口自己。 */
  function isFromPet(event) {
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  }

  /** 取某个屏幕坐标所在显示器的工作区。 */
  function resolveWorkArea(point) {
    const { screen } = electron();
    const x = Number.isFinite(point && point.x) ? point.x : 0;
    const y = Number.isFinite(point && point.y) ? point.y : 0;
    return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  }

  /** 关闭并销毁窗口（退出时用）。 */
  function destroy() {
    clearIgnoreTimer();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    dragging = false;
    if (win && !win.isDestroyed()) {
      // close 事件里会落盘最后一次位置
      win.destroy();
    }
    win = null;
  }

  /** 隐藏窗口（保留实例，位置与渲染状态都在）。 */
  function hide() {
    if (!win || win.isDestroyed()) return;
    flushSave();
    win.hide();
    notifyVisibility();
  }

  /**
   * 创建（或复用）桌宠窗口。
   *
   * @returns BrowserWindow 实例
   */
  function create() {
    if (win && !win.isDestroyed()) return win;
    const { BrowserWindow, screen } = electron();
    bindDisplayListeners();

    const size = { width: PET_WIDTH, height: PET_HEIGHT };
    const initial = resolveInitialBounds({
      saved: readState(resolvedStatePath),
      size,
      displays: screen.getAllDisplays(),
      primaryArea: screen.getPrimaryDisplay().workArea,
    });

    const entry = resolveEntry();
    win = new BrowserWindow({
      x: initial.x,
      y: initial.y,
      width: initial.width,
      height: initial.height,
      // 一律透明无边框：留白必须真透，否则桌面上会多一块灰色方块
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // 桌宠的位置只由我们的拖拽逻辑决定，不让窗口管理器参与
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // 不进任务栏：桌宠不是「应用窗口」，alt-tab 里也不该出现
      skipTaskbar: true,
      alwaysOnTop: true,
      // 不抢焦点：用户正在别的应用里打字，点一下桌宠不该把光标夺走
      focusable: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'pet-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        // 与其它窗口保持一致：preload 需要 node 能力（读 ipcRenderer），渲染层本身仍是隔离的
        sandbox: false,
        // 桌宠永远在最前面，被判定「后台」后动画会掉帧；这里显式关掉节流
        backgroundThrottling: false,
      },
    });

    // 置顶层级要显式给：默认 floating 会被某些置顶应用压住
    win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
    // 一出现就是穿透的：空白区域绝不吃鼠标
    win.setIgnoreMouseEvents(true, { forward: true });
    ignoring = true;
    clearIgnoreTimer();

    // 桌宠窗口不该导航、不该开新窗（内容里将来可能混入模型资源）
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });

    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      // showInactive：桌宠永远不该抢焦点
      win.showInactive();
      notifyVisibility();
    });

    win.webContents.once('did-finish-load', () => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send('pet:command', {
        type: 'ready',
        clickThrough: ignoring,
        // 首帧就带上可见性：桌宠可能在"窗口已隐藏"的前提下被重新加载，
        // 渲染层据此直接进 off 档，而不是先按"可见"跑一轮动画再被纠正
        visible: win.isVisible(),
        size: { width: initial.width, height: initial.height },
      });
    });

    // 渲染层崩了不能把一个空黑框留在桌面上
    win.webContents.on('render-process-gone', () => {
      console.warn('[pet] 渲染进程退出，隐藏桌宠');
      hide();
    });

    win.on('show', notifyVisibility);
    win.on('hide', notifyVisibility);
    win.on('close', () => {
      // destroy 之前把最后位置记下来
      flushSave();
    });
    win.on('closed', () => {
      clearIgnoreTimer();
      dragging = false;
      win = null;
      notifyVisibility();
    });

    if (entry.kind === 'url') {
      win.loadURL(entry.value);
    } else {
      win.loadFile(entry.value);
    }
    return win;
  }

  /**
   * 显示桌宠（不存在就创建）。
   *
   * @returns BrowserWindow 实例
   */
  function show() {
    const created = create();
    if (!created) return null;
    if (created.isMinimized()) created.restore();
    created.showInactive();
    notifyVisibility();
    return created;
  }

  /** 显示 / 隐藏切换（托盘菜单用）。 */
  function toggle() {
    if (isVisible()) hide();
    else show();
  }

  // ---------------------------------------------------------------- IPC

  /** 渲染层：鼠标是否在命中区内 → 决定穿透还是可交互。 */
  ipcMain.on('pet:set-hit', (event, hit) => {
    if (!isFromPet(event)) return;
    applyIgnoreMouse(hit !== true);
  });

  /** 渲染层：按下左键，开始拖拽（记录光标相对窗口的偏移）。 */
  ipcMain.handle('pet:drag-start', (event, payload) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    if (!win || win.isDestroyed()) return { ok: false, error: '桌宠窗口不存在' };
    const bounds = win.getBounds();
    const pointerX = Number(payload && payload.cursorX);
    const pointerY = Number(payload && payload.cursorY);
    let originX = pointerX;
    let originY = pointerY;
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
      // 渲染层没给坐标（或给了脏值）时用系统光标位置兜底
      const cursor = electron().screen.getCursorScreenPoint();
      originX = cursor.x;
      originY = cursor.y;
    }
    dragOffset = { x: Math.round(originX) - bounds.x, y: Math.round(originY) - bounds.y };
    dragging = true;
    return { ok: true };
  });

  /**
   * 渲染层：拖拽过程中的位置上报。
   *
   * <p>用 `send` 而不是 `invoke`：拖拽是高频单向事件，等一轮 promise 往返会明显拖慢跟手感。</p>
   */
  ipcMain.on('pet:drag-move', (event, payload) => {
    if (!isFromPet(event)) return;
    if (!dragging || !win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    let cursorX = Number(payload && payload.cursorX);
    let cursorY = Number(payload && payload.cursorY);
    if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) {
      const cursor = electron().screen.getCursorScreenPoint();
      cursorX = cursor.x;
      cursorY = cursor.y;
    }
    const area = resolveWorkArea({ x: cursorX - dragOffset.x, y: cursorY - dragOffset.y });
    const target = clampRectToWorkArea({
      x: Math.round(cursorX) - dragOffset.x,
      y: Math.round(cursorY) - dragOffset.y,
      width: bounds.width,
      height: bounds.height,
    }, area);
    if (target.x !== bounds.x || target.y !== bounds.y) {
      win.setPosition(target.x, target.y, false);
      scheduleSave();
    }
  });

  /** 渲染层：松开左键，结束拖拽并立即落盘。 */
  ipcMain.handle('pet:drag-end', (event) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    dragging = false;
    flushSave();
    return { ok: true };
  });

  /** 渲染层：关掉桌宠（隐藏而不销毁：下次从托盘打开就在原地）。 */
  ipcMain.handle('pet:close', (event) => {
    if (!isFromPet(event)) return { ok: false, error: '来源未授权' };
    hide();
    return { ok: true };
  });

  /**
   * 渲染层：弹出原生右键菜单（M6-b 的 O3 + D-B2）。
   *
   * <p><b>为什么关闭入口收敛到这里：</b>以前有两套手势（双击立绘 + 悬停显形的 × 按钮），
   * 而"连点 3 下生气"也要用连点，于是双击必然先记一次 tap 再被关闭抢走语义。
   * 现在关闭/显隐只走原生菜单：DOM 侧不再有任何关闭元素，也不再有双击语义。</p>
   *
   * <p>用 `Menu.popup()` 而不是自绘菜单：原生菜单不占渲染层的合成预算，
   * 而且窗口本身是 `focusable: false`，自绘菜单会先要一次焦点、把用户的输入焦点抢走。</p>
   */
  ipcMain.on('pet:context-menu', (event) => {
    if (!isFromPet(event)) return;
    const { Menu } = electron();
    const menu = Menu.buildFromTemplate([
      {
        label: isVisible() ? '隐藏桌宠' : '显示桌宠',
        click: () => toggle(),
      },
      {
        // 显式给一个"关掉画面但留着入口"的中间档：桌宠是常驻件，误点退出代价太高
        label: '关闭桌宠（可从托盘恢复）',
        click: () => hide(),
      },
      { type: 'separator' },
      {
        label: '退出 LX',
        click: () => electron().app.quit(),
      },
    ]);
    menu.popup({ window: win || undefined });
  });

  return {
    create,
    show,
    hide,
    toggle,
    isVisible,
    destroy,
    /**
     * 订阅可见性变化（托盘用来刷新勾选状态）。
     *
     * @param listener 回调，参数为当前是否可见
     * @returns 取消订阅函数
     */
    onVisibilityChange(listener) {
      if (typeof listener !== 'function') return () => {};
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    /** 状态文件路径（排障用：用户报「位置记不住」时直接看这个文件）。 */
    statePath: resolvedStatePath,
  };
}

module.exports = {
  registerPetWindow,
  resolveDevEntryUrl,
  resolveEntrySpec,
  DEV_ENTRY_FALLBACK,
  PET_ENTRY_PAGE,
  normalizeDimension,
  intersectArea,
  clampRectToWorkArea,
  defaultRect,
  pickDisplay,
  resolveInitialBounds,
  readState,
  writeState,
  PET_WIDTH,
  PET_HEIGHT,
  ART_WIDTH,
  ART_HEIGHT,
  GLOW_PAD,
  BUBBLE_H,
  EDGE_MARGIN,
  STATE_FILE_NAME,
  MIN_VISIBLE_RATIO,
};
