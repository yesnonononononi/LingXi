'use strict';

/**
 * 桌宠脸层**画面守卫**（设计文档 §11.2 层 2：Electron offscreen 真渲染像素守卫 P1–P6）。
 *
 * <p><b>这个脚本存在的理由：</b>M1 之前唯一的表情断言是「指令交给了 fallback」——
 * 它证明的是**指令流**，与「用户是否看见」无关（layered 模式下 `.pet-art-frame` 是
 * `opacity:0`，再多的 fallback 记录也一个像素都不显示）。所以这里必须升级成
 * **真实层可见性 + 面部像素变化**双证，并且入口只能是真实指针链路。</p>
 *
 * <p><b>三条不能破的纪律：</b></p>
 * <ol>
 *   <li><b>禁止 `petDebug.forceState()`</b>。所有档位一律走 `sendInputEvent`
 *       （mouseMove/mouseDown/mouseUp）+ 真实闲置时间；调试后门在本脚本里出现一次就算缺陷。</li>
 *   <li><b>断言必须是「像素变化 + 来源对照」</b>：脸区 ROI 相对 `neutral` 的变化比例，
 *       加上「运行中注入 `[data-layer='face']{opacity:0}` 后变化消失」的来源证明（P5），
 *       再加 `.pet-art-frame` `opacity=0` / face `opacity=1` / `getClientRects()>0`（P6）。</li>
 *   <li><b>虚拟时钟只压时间，不改状态机</b>：闲置 60s/90s 用预注入的 ×60 时钟让它在
 *       1.0–1.5s 内**真实发生**，行为层一行不改（报告里显式标注 `timeScale=60`）。</li>
 * </ol>
 *
 * <p><b>像素可复现的两个手法（都在测量侧，不碰产品代码）：</b></p>
 * <ul>
 *   <li>截图走 CDP `Page.captureScreenshot({clip})`，**不用** `webContents.capturePage()`
 *       （本机 offscreen 下高度被夹 1032、小矩形还会抛 `UnknownVizError`）；</li>
 *   <li>ROI 矩形由 `pet-layers.json` 的 `face.rect` + `pet-geometry.json` 独立算出，
 *       **不读 DOM** —— 否则「把 face.rect 挪 20px」的变异体会把 ROI 一起挪走，
 *       像素差就永远为 0（M3 变异体正是靠这一点被抓住）。</li>
 *   <li>渲染动画（呼吸/摇摆/动作动画）在测量期用一条守卫自己的样式表停掉：
 *       它只影响"抖动"，不影响表情贴片本身；停掉之后**同一状态两次截图必须逐字节相同**，
 *       脚本自己会先跑这条「测量稳定性自证」，不成立直接判失败（防止拿噪声当信号）。</li>
 * </ul>
 *
 * <p><b>用法：</b></p>
 * <pre>
 *   npm run guard:pet:face                       # 全档
 *   npm run guard:pet:face -- --only=E05,E02     # 只跑指定档（排障）
 *   npm run guard:pet:face -- --no-window-shot   # 只落 ROI 图
 *   npm run guard:pet:face -- --out &lt;dir&gt;        # 换截图目录
 * </pre>
 *
 * <p>截图默认落 `&lt;repo&gt;/.lingxi/tmp/pet-face-guard/&lt;commit&gt;/&lt;expression&gt;.png`（不入库），
 * 同目录另有 `report.txt` / `report.json` 留档。</p>
 *
 * <p>退出码：0 全档 PASS；1 有档 FAIL（或测量不稳定）；2 环境不满足（dev server 起不来）。</p>
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const FRONTEND_ROOT = path.resolve(__dirname, '..');

const { buildDevOrigin, DEV_ENDPOINT } = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-endpoint.cjs'));
const { probePetDevServer } = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-probe.cjs'));
const { registerLxSchemePrivileges, registerLxProtocol } = require(path.join(FRONTEND_ROOT, 'electron', 'lx-protocol.cjs'));

/**
 * 树身份判据模块的 URL（`electron/pet-tree-fingerprint.mjs`）。
 *
 * <p><b>为什么这里不能 `require`：</b>同一个判据模块被 `vite.pet.config.ts` 使用，
 * 而 Vite 会用 esbuild 把 config 打成 **ESM** 再执行——被内联的 CJS 模块里
 * `require('node:crypto')` 会变成动态 require 垫片并直接抛
 * `Error: Dynamic require of "node:crypto" is not supported`（实测踩过）。
 * 所以判据模块只能是 ESM，本脚本（CJS）用动态 `import()` 载入。</p>
 *
 * <p><b>为什么不写两份判据：</b>守卫与自检对"这是不是本地这棵树"必须给同一结论，
 * 两套实现迟早漂移，而"两个守卫对同一件事得出不同答案"是最难查的形态。</p>
 *
 * @type {string}
 */
const TREE_FINGERPRINT_URL = require('node:url').pathToFileURL(
  path.join(FRONTEND_ROOT, 'electron', 'pet-tree-fingerprint.mjs'),
).href;

/** 判据模块的载入 Promise（进程内只载入一次，避免每个档位都重新解析模块）。 */
let treeFingerprintPromise = null;

/**
 * 载入树指纹判据模块。
 *
 * @returns {Promise<{verifyOwnTree: Function, TREE_IDENTITY: object, TREE_META_NAME: string}>} 模块命名空间
 */
function loadTreeFingerprint() {
  if (treeFingerprintPromise === null) treeFingerprintPromise = import(TREE_FINGERPRINT_URL);
  return treeFingerprintPromise;
}


const LAYERS = require(path.join(FRONTEND_ROOT, 'pet-layers.json'));
const GEOMETRY = require(path.join(FRONTEND_ROOT, 'pet-geometry.json'));
const FACE_TILES_MANIFEST = require(path.join(FRONTEND_ROOT, 'pet-face-tiles.json'));
// Electron 运行时（本脚本由 `electron` 执行，`require('electron')` 拿到的是主进程 API）
const { app } = require('electron');

// ---------------------------------------------------------------- 视口 / ROI（单一真源复算）

/** 脸层契约（`pet-layers.json` 里 `layerId === 'face'` 的那一层）。 */
const FACE_LAYER = LAYERS.layers.find((layer) => layer.layerId === 'face');

/** 立绘箱在窗口内的原点（与 `src/pet/layout.ts` 的 `ART_ORIGIN` 同一条派生链）。 */
const ART_ORIGIN = {
  x: GEOMETRY.effectMargin.left,
  y: GEOMETRY.effectMargin.top + GEOMETRY.bubbleHeight,
};

/** 窗口逻辑尺寸（CSS px）＝ 立绘箱 + 四边特效边距 + 顶部气泡。 */
const WINDOW_SIZE = {
  width: GEOMETRY.artWidth + GEOMETRY.effectMargin.left + GEOMETRY.effectMargin.right,
  height: GEOMETRY.artHeight + GEOMETRY.effectMargin.top + GEOMETRY.effectMargin.bottom + GEOMETRY.bubbleHeight,
};

/**
 * 脸区 ROI（窗口视口坐标，CSS px）。
 *
 * <p><b>为什么从契约算而不是从 DOM 量：</b>从 DOM 量等于"跟着被测对象走"——
 * `pet-layers.json` 的 `face.rect` 一旦被改错，DOM 矩形也跟着错，ROI 里永远是"正确"的贴片，
 * 像素差恒为 0。这里用母版矩形 + 几何真源独立复算，才能把 M3（锚点/矩形错位）抓住。</p>
 */
const ROI = {
  x: ART_ORIGIN.x + (GEOMETRY.artWidth * FACE_LAYER.rect.x) / LAYERS.canvas.width,
  y: ART_ORIGIN.y + (GEOMETRY.artHeight * FACE_LAYER.rect.y) / LAYERS.canvas.height,
  width: (GEOMETRY.artWidth * FACE_LAYER.rect.width) / LAYERS.canvas.width,
  height: (GEOMETRY.artHeight * FACE_LAYER.rect.height) / LAYERS.canvas.height,
};

/** 头部点击点：脸区矩形中心（`classifyProfile` 判 `head`）。 */
const HEAD_POINT = { x: Math.round(ROI.x + ROI.width / 2), y: Math.round(ROI.y + ROI.height / 2) };

/** 身体点击点：立绘箱 (0.5, 0.8)（脸区外扩框之外，`classifyProfile` 判 `body`）。 */
const BODY_POINT = {
  x: Math.round(ART_ORIGIN.x + GEOMETRY.artWidth * 0.5),
  y: Math.round(ART_ORIGIN.y + GEOMETRY.artHeight * 0.8),
};

/** 闲置档的虚拟时钟倍率（60s 闲置 → 1.0s 真实等待）。 */
const IDLE_TIME_SCALE = 60;

/** 像素差容差（每通道）：小于它的差异视为同色（webp 有损噪声 / 合成舍入）。 */
const CHANNEL_TOLERANCE = 6;

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);

/**
 * 取 `--key value` 或 `--key=value`。
 *
 * @param {string} key 参数名（不含 `--`）
 * @param {string|null} fallback 缺省值
 * @returns {string|null} 值
 */
function argOf(key, fallback = null) {
  const eq = argv.find((token) => token.startsWith(`--${key}=`));
  if (eq) return eq.slice(key.length + 3);
  const index = argv.indexOf(`--${key}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return fallback;
}

/**
 * 是否有布尔开关。
 *
 * @param {string} key 参数名（不含 `--`）
 * @returns {boolean} 是否出现
 */
function hasFlag(key) {
  return argv.includes(`--${key}`);
}

/** 只跑指定档（逗号分隔的档位 id，如 `E05,E02`）；空表示全跑。 */
const ONLY = (argOf('only', '') || '')
  .split(',')
  .map((item) => item.trim().toUpperCase())
  .filter((item) => item.length > 0);

/**
 * 某档是否需要跑。
 *
 * @param {string} id 档位 id（如 `E05`）
 * @returns {boolean} 是否跑
 */
function wanted(id) {
  return ONLY.length === 0 || ONLY.includes(id.toUpperCase());
}

// ---------------------------------------------------------------- 日志

/**
 * 带前缀的日志。
 *
 * @param {string} level `info` / `warn` / `error`
 * @param {string} message 消息
 * @returns {void}
 */
function log(level, message) {
  const line = `[pet-guard] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** 睡眠若干毫秒。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 截图落盘位置

/**
 * 被测提交号（默认取 git HEAD 短 sha）。
 *
 * @returns {string} 提交号
 */
function resolveCommit() {
  const explicit = argOf('commit');
  if (explicit) return explicit;
  const env = process.env.PET_GUARD_COMMIT;
  if (env) return env;
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: FRONTEND_ROOT, encoding: 'utf8' });
  const sha = (result.stdout || '').trim();
  return sha.length > 0 ? sha : 'unknown';
}

/**
 * 产物目录：`&lt;repo&gt;/.lingxi/tmp/pet-face-guard/&lt;commit&gt;/`（`--out` 可覆盖）。
 *
 * @param {string} commit 提交号
 * @returns {string} 目录绝对路径
 */
function resolveOutDir(commit) {
  // frontend → desktop-pet-visual → work → .lingxi → tmp
  const lingxiDir = path.resolve(FRONTEND_ROOT, '..', '..', '..');
  const guardRoot = path.join(lingxiDir, 'tmp', 'pet-face-guard');
  const explicit = argOf('out');
  // 相对路径一律落在 `.lingxi/tmp/pet-face-guard/` 下：以前按 CWD 解析，
  // `--out final2` 会在 `frontend/` 里建目录，把运行产物写进源码树（实测踩过）。
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(guardRoot, explicit);
  return path.join(guardRoot, commit);
}

// ---------------------------------------------------------------- dev server

/**
 * 本次守卫要验的 dev server 源（默认取单一真源；`--origin` 仅供排障/实验）。
 *
 * @returns {string} 形如 `http://127.0.0.1:5275`
 */
function resolveOrigin() {
  const explicit = argOf('origin');
  if (explicit) {
    if (!/^https?:\/\/[^/]+$/.test(explicit)) throw new Error(`--origin 非法（应为 http://host:port）：${explicit}`);
    return explicit.replace(/\/+$/, '');
  }
  return buildDevOrigin();
}

/**
 * 证明这个 dev server 服务的是**本地这棵树**；证明不了就不许继续。
 *
 * <p><b>为什么必须有这一步：</b>两个工作树共用同一个端口真源，复用端口上"已在跑"的实例时，
 * 它可能是**另一个工作树**拉起的。内容指纹（`#pet-root` + `lx-app`）只能证明"是桌宠页面"，
 * 证明不了"是本地的桌宠页面"——实测 5275 上跑着另一个工作树，两条指纹全中，
 * 守卫照旧跑出 18/18 PASS，那 18 个 PASS 验的是别人的代码。</p>
 *
 * <p>三种结论的处置（都不允许当成 PASS）：</p>
 * <ul>
 *   <li>`own`：继续测量；弱证据（清单字节一致但没有注入指纹）会打 warn 提醒重启 dev server。</li>
 *   <li>`foreign`：**明确失败**（退出码 2），打印"端口上跑的是另一棵树，请停掉后重跑"。</li>
 *   <li>`undecidable`：**SKIP**（退出码 2），打印"为什么无法判定 + 怎么修"。守卫不产生任何 PASS 结论。</li>
 * </ul>
 *
 * @param {string} origin dev server 源
 * @returns {Promise<void>} 通过时 resolve
 * @throws {Error} 另一棵树 / 无法判定时抛出（由引导层转成退出码 2）
 */
async function assertOwnTree(origin) {
  const { verifyOwnTree, TREE_IDENTITY } = await loadTreeFingerprint();
  const identity = await verifyOwnTree({
    origin,
    entryPage: DEV_ENDPOINT.entryPage,
    frontendRoot: FRONTEND_ROOT,
  });
  if (identity.status === TREE_IDENTITY.OWN) {
    log(identity.weak ? 'warn' : 'info', `树身份：${identity.message}`);
    if (identity.hint) log('warn', `  ${identity.hint}`);
    return;
  }
  if (identity.status === TREE_IDENTITY.FOREIGN) {
    log('error', `IDENTITY-FOREIGN 端口上跑的是另一棵树（${origin}），本次守卫拒绝给出任何 PASS 结论`);
    log('error', `  判定依据：${identity.message}`);
    if (identity.local) log('error', `  本地树指纹：${identity.local.digest.slice(0, 16)}（${identity.local.files.length} 个文件）`);
    log('error', `  修法：${identity.hint}`);
    throw new Error(`端口 ${origin} 上跑的是另一棵树，守卫无法证明自己验的是本地代码（已停止，不是 PASS）`);
  }
  log('error', `IDENTITY-SKIP 无法证明端口上的 dev server 是本地这棵树（${origin}）`);
  log('error', `  为什么无法判定：${identity.message}`);
  log('error', `  怎么修：${identity.hint}`);
  throw new Error(`无法判定 ${origin} 上的 dev server 属于哪棵树（已 SKIP，不产生 PASS 结论）`);
}

/**
 * 确保桌宠 dev server 就绪；没起就自己拉一个（不改端口真源、不碰别人已在跑的实例）。
 *
 * <p>无论复用还是自己拉起，都必须先通过 {@link assertOwnTree} —— 复用到的可能是别人的树。</p>
 *
 * @returns {Promise<{url: string, started: boolean}>} 入口 URL 与是否由本脚本拉起
 */
async function ensureDevServer() {
  const origin = resolveOrigin();
  const url = `${origin}/${DEV_ENDPOINT.entryPage}`;
  const first = await probePetDevServer({ url });
  if (first.ok) {
    await assertOwnTree(origin);
    return { url, started: false };
  }
  if (first.reason !== 'no-service') {
    throw new Error(`端口 ${DEV_ENDPOINT.port} 上的服务不是桌宠（${first.reason}）：${first.message}`);
  }
  log('warn', `dev server 未运行，按 package.json 的 dev:pet 拉起（端口 ${DEV_ENDPOINT.port}）`);
  const logPath = path.join(require('node:os').tmpdir(), 'lx-pet-face-guard-vite.log');
  const descriptor = fs.openSync(logPath, 'a');
  const child = spawn(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm',
    process.platform === 'win32' ? ['/d', '/c', 'npm', 'run', 'dev:pet'] : ['run', 'dev:pet'],
    { cwd: FRONTEND_ROOT, detached: true, windowsHide: true, stdio: ['ignore', descriptor, descriptor] });
  child.unref();
  fs.closeSync(descriptor);
  const ready = await probePetDevServer({ url, waitMs: 60000, timeoutMs: 2000 });
  if (!ready.ok) throw new Error(`dev server 60s 内未就绪：${ready.message}（日志 ${logPath}）`);
  // 自己拉起来的也必须验：端口可能在 spawn 与 ready 之间被别的树抢走
  await assertOwnTree(origin);
  return { url, started: true };
}

// ---------------------------------------------------------------- 像素工具

/**
 * 从 nativeImage 里裁出 ROI 并转成可比较的位图。
 *
 * @param {object} image nativeImage（整窗截图）
 * @param {{x: number, y: number, width: number, height: number}} rect ROI（CSS px）
 * @param {number} ratio 图片像素 / CSS 像素
 * @returns {{buffer: Buffer, hash: string, width: number, height: number, image: object}} ROI 视图
 */
function cropRoi(image, rect, ratio) {
  const size = image.getSize();
  const x = Math.max(0, Math.round(rect.x * ratio));
  const y = Math.max(0, Math.round(rect.y * ratio));
  const width = Math.min(Math.max(1, Math.round(rect.width * ratio)), size.width - x);
  const height = Math.min(Math.max(1, Math.round(rect.height * ratio)), size.height - y);
  if (width < 2 || height < 2) throw new Error(`ROI 越界：${JSON.stringify({ x, y, width, height, size })}`);
  const cropped = image.crop({ x, y, width, height });
  const buffer = Buffer.from(cropped.toBitmap());
  return {
    image: cropped,
    buffer,
    width,
    height,
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

/**
 * 两张同尺寸位图的差异像素比例（每通道容差 {@link CHANNEL_TOLERANCE}）。
 *
 * @param {Buffer} a 位图 A（BGRA）
 * @param {Buffer} b 位图 B（BGRA）
 * @returns {number} 差异像素 / 总像素（0..1）
 */
function deltaRatio(a, b) {
  if (a.length !== b.length) return 1;
  const pixels = a.length / 4;
  let diff = 0;
  for (let offset = 0; offset < a.length; offset += 4) {
    if (Math.abs(a[offset] - b[offset]) > CHANNEL_TOLERANCE
      || Math.abs(a[offset + 1] - b[offset + 1]) > CHANNEL_TOLERANCE
      || Math.abs(a[offset + 2] - b[offset + 2]) > CHANNEL_TOLERANCE
      || Math.abs(a[offset + 3] - b[offset + 3]) > CHANNEL_TOLERANCE) {
      diff += 1;
    }
  }
  return diff / pixels;
}

/**
 * 百分比格式化（两位小数）。
 *
 * @param {number} value 0..1
 * @returns {string} 形如 `1.82%`
 */
const pct = (value) => `${(value * 100).toFixed(2)}%`;

// ---------------------------------------------------------------- 虚拟时钟（预注入）

/**
 * 虚拟时钟的注入源码（`Page.addScriptToEvaluateOnNewDocument`，**页面脚本之前**生效）。
 *
 * <p>只缩放 `Date.now()`，不碰 `setTimeout` / `setInterval` 的间隔：行为状态机的闲置判定
 * 读的是 `Date`（`{ now: () => Date.now() }` 注入），而眨眼/淡入这类**视觉节拍必须保持真实**，
 * 否则 100ms 的闭眼会被压成 1.7ms，像素根本抓不到。</p>
 *
 * <p>累积式而不是乘法式：`scale` 中途改小时（P3 唤醒前要调回 1，否则 20ms 的点击会被算成
 * 1200ms 长拖），累积式能保证时间**永不倒流**。</p>
 *
 * @param {number} scale 初始倍率
 * @returns {string} 注入源码
 */
function clockSource(scale) {
  return `(() => {
  const state = { scale: ${Number(scale) || 1} };
  const realNow = Date.now.bind(Date);
  let lastReal = realNow();
  let virtualNow = lastReal;
  const advance = () => {
    const r = realNow();
    if (r > lastReal) { virtualNow += (r - lastReal) * state.scale; lastReal = r; }
  };
  Date.now = function () { advance(); return virtualNow; };
  window.__LX_PET_GUARD_CLOCK__ = {
    get scale() { return state.scale; },
    set scale(value) { advance(); const next = Number(value); state.scale = Number.isFinite(next) && next > 0 ? next : 1; },
    now() { advance(); return virtualNow; },
    // 直接把虚拟时间往前推（单调递增，永不回拨）：用于"闲置 60s/90s"这类档位，
    // 与 ×60 缩放等价——状态机看到的就是"真的过了 90 秒"，行为层一行未改。
    advance(ms) { advance(); const step = Number(ms); if (Number.isFinite(step) && step > 0) { virtualNow += step; } return virtualNow; },
  };
})();`;
}

/** 测量期停掉渲染动画（只影响抖动，不影响贴片本身；停掉后同状态截图必须逐字节相同）。 */
const FREEZE_CSS = '#pet-root *, #pet-root *::before, #pet-root *::after { animation: none !important; transition: none !important; }';

/** 来源对照用的样式：把脸层整体隐藏（P5）。 */
const FACE_HIDDEN_CSS = "#pet-root .pet-layer[data-layer='face'] { opacity: 0 !important; }";

// ---------------------------------------------------------------- 页面 / 窗口

/** 读页面状态（表达式 / 层可见性 / 命中元素）。 */
const STATE_JS = `(() => {
  const root = document.getElementById('pet-root');
  const face = document.querySelector("#pet-root .pet-layer[data-layer='face']");
  const frames = Array.from(document.querySelectorAll('#pet-root .pet-art-frame'));
  const opacity = (el) => (el ? getComputedStyle(el).opacity : null);
  return {
    expression: root ? (root.dataset.expression || '') : '',
    motion: root ? (root.dataset.motion || '') : '',
    compositeMode: root ? (root.dataset.compositeMode || '') : '',
    layerCount: root ? Number(root.dataset.layers || 0) : 0,
    faceSrc: face ? String(face.currentSrc || face.src || '') : '',
    faceExpression: face ? (face.dataset.expression || '') : '',
    faceVisibleFlag: face ? (face.dataset.visible || '') : '',
    faceOpacity: opacity(face),
    faceRects: face ? face.getClientRects().length : 0,
    frameOpacity: frames.map((frame) => opacity(frame)),
    artOpacity: opacity(document.querySelector('#pet-root .pet-action')),
  };
})()`;

/**
 * 就绪判定：层全挂上、贴片全部解码完成。
 *
 * @param {number} x 脸区中心的 x（CSS px）
 * @param {number} y 脸区中心的 y（CSS px）
 * @returns {string} 求值表达式
 */
function readySource(x, y) {
  return `(() => {
  const root = document.getElementById('pet-root');
  if (!root) return { ready: false, reason: 'no-root' };
  const images = Array.from(root.querySelectorAll('img'));
  // 只统计"真的有 src"的图：压平帧（.pet-art-frame）在 layered 下是 hidden 且没有 src，
  // 把它们算进 pending 会让就绪判定永远等不到（naturalWidth 恒为 0）
  // 注意：本段是模板串的一部分，注释里不能再出现反引号（会提前截断字符串）
  const loaded = images.filter((img) => String(img.currentSrc || img.getAttribute('src') || '').length > 0);
  const pending = loaded.filter((img) => !img.complete || img.naturalWidth === 0);
  const face = root.querySelector(".pet-layer[data-layer='face']");
  const hit = document.elementFromPoint(${x}, ${y});
  return {
    ready: loaded.length > 0 && pending.length === 0 && !!face && Number(root.dataset.layers || 0) === 10,
    reason: pending.length > 0 ? 'images-pending' : (face ? 'ok' : 'no-face'),
    imageCount: loaded.length,
    pendingCount: pending.length,
    pendingList: pending.map((img) => String(img.currentSrc || img.getAttribute('src') || '').slice(-40)),
    layerCount: Number(root.dataset.layers || 0),
    expression: root.dataset.expression || '',
    hitLayer: hit ? (hit.dataset && hit.dataset.layer) || (hit.className || hit.tagName) : null,
  };
})()`;
}

/** 复用的 offscreen 页面句柄（全流程只开一个窗口）。 */
let POOLED_PAGE = null;
/** true 时才真正销毁窗口（组结束的 `destroy()` 是软复位，不是真关窗）。 */
let HARD_CLOSE = false;

/**
 * 创建 offscreen 窗口并挂上 CDP。
 *
 * @param {string} url 入口 URL
 * @param {number} timeScale 初始虚拟时钟倍率
 * @returns {Promise<object>} 句柄
 */
async function openPetPage(url, timeScale) {
  const { BrowserWindow } = require('electron');
  // **同一个 offscreen 窗口全程复用。**实测：销毁第一个 offscreen 窗口后再建第二个，
  // 进程会偶发无声退出（日志戛然而止、退出码 0），把整份报告带走。复用窗口 + reload
  // 既避开这个平台坑，也让"每组从干净状态机开始"这件事由 reload 保证。
  if (POOLED_PAGE) {
    log('info', `复用 offscreen 窗口，reload 重置状态（请求 timeScale=${timeScale}，实际用 advance 推进时钟）`);
    const reloaded = POOLED_PAGE.__waitLoad(30000);
    void POOLED_PAGE.send('Page.reload', { ignoreCache: false }).catch((err) => log('warn', `reload 失败：${(err && err.message) || err}`));
    await reloaded;
    return POOLED_PAGE;
  }
  log('info', `打开 offscreen 页面（${WINDOW_SIZE.width}×${WINDOW_SIZE.height}，timeScale=${timeScale}）：${url}`);
  const win = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });

  /**
   * 等一次导航结束（`did-finish-load` / `did-fail-load` / 硬超时三选一）。
   *
   * @param {number} timeoutMs 硬超时
   * @returns {Promise<string>} 结果标记
   */
  const waitLoad = (timeoutMs) => new Promise((resolve) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      win.webContents.off('did-finish-load', onFinish);
      win.webContents.off('did-fail-load', onFail);
    };
    const onFinish = () => { cleanup(); resolve('did-finish-load'); };
    const onFail = (_event, code, description) => { cleanup(); resolve(`did-fail-load:${code}:${description}`); };
    timer = setTimeout(() => { cleanup(); resolve('timeout'); }, timeoutMs);
    win.webContents.once('did-finish-load', onFinish);
    win.webContents.once('did-fail-load', onFail);
  });

  // **为什么要导航两次：**实测 offscreen 窗口在"还没有任何文档"时，CDP 的 `Page.enable` /
  // `Runtime.enable` 永不回应（8s 超时，见本脚本的 diag 记录），于是"先注入时钟再导航"
  // 这条路走不通。顺序改成：先让页面跑起来 → 挂调试器 → 用
  // `Page.addScriptToEvaluateOnNewDocument` 预注入时钟 → `Page.reload` 让注入对**新文档**生效。
  // 时钟仍然是"在页面脚本之前"装好的，行为层一行未改。
  const firstLoad = waitLoad(30000);
  void win.loadURL(url).catch((err) => log('warn', `首次 loadURL 拒绝：${(err && err.message) || err}`));
  let firstOutcome = await firstLoad;
  // offscreen 首次导航偶发 ERR_FAILED（多窗口连续开关时最容易撞上）：重试而不是判死
  for (let attempt = 1; attempt <= 3 && firstOutcome !== 'did-finish-load'; attempt += 1) {
    log('warn', `首次导航失败（${firstOutcome}），第 ${attempt} 次重试`);
    await sleep(600);
    const retry = waitLoad(30000);
    void win.loadURL(url).catch((err) => log('warn', `重试 loadURL 拒绝：${(err && err.message) || err}`));
    firstOutcome = await retry;
  }
  log(firstOutcome === 'did-finish-load' ? 'info' : 'warn', `首次导航：${firstOutcome}`);

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const send = (method, params) => dbg.sendCommand(method, params);
  await send('Page.enable');
  await send('Runtime.enable');
  // 页面侧异常必须被看见：`executeJavaScript` 只会把消息透出来，栈在页面里。
  // 这条监听是"守卫无声失败"的排障入口，长期保留。
  dbg.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const details = params && params.exceptionDetails ? params.exceptionDetails : {};
      const description = (details.exception && details.exception.description) || details.text || '';
      log('warn', `页面异常：${String(description).split('\n').slice(0, 4).join(' | ')}`);
    }
  });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: clockSource(timeScale) });
  log('info', 'CDP 已就绪，注入虚拟时钟后 reload');

  const secondLoad = waitLoad(30000);
  await send('Page.reload', { ignoreCache: false });
  const secondOutcome = await secondLoad;
  log(secondOutcome === 'did-finish-load' ? 'info' : 'warn', `二次导航（时钟生效）：${secondOutcome}`);
  const evaluate = (expression) => win.webContents.executeJavaScript(expression, true);
  // 关窗前先解挂调试器：多窗口连续开关时，留着 attach 的会话会让下一次导航更容易 ERR_FAILED
  const originalDestroy = win.destroy.bind(win);
  win.destroy = () => {
    if (!HARD_CLOSE) {
      log('info', '组结束：保留 offscreen 窗口（下一组 reload 复用，避免重建窗口触发平台崩溃）');
      return;
    }
    try { if (dbg.isAttached()) dbg.detach(); } catch { /* 已分离则忽略 */ }
    originalDestroy();
    POOLED_PAGE = null;
  };
  const page = { win, dbg, send, evaluate, __waitLoad: waitLoad };
  POOLED_PAGE = page;
  return page;
}

/**
 * 等页面就绪（层挂满 + 贴片解码 + 表达式已下发）。
 *
 * @param {object} page 页面句柄
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<object>} 就绪时的状态
 */
async function waitForReady(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(readySource(HEAD_POINT.x, HEAD_POINT.y));
    if (last.ready) {
      // 字体与首帧：字体没就绪时文字宽度会跳，像素比对会抖
      await page.evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
      await page.evaluate(`(() => {
        const style = document.createElement('style');
        style.id = 'lx-pet-guard-freeze';
        style.textContent = ${JSON.stringify(FREEZE_CSS)};
        document.head.appendChild(style);
        return true;
      })()`);
      return last;
    }
    await sleep(50);
  }
  throw new Error(`页面 ${timeoutMs}ms 内未就绪：${JSON.stringify(last)}`);
}

/**
 * 整窗截图（CDP clip，`scale:1`）。
 *
 * @param {object} page 页面句柄
 * @returns {Promise<object>} nativeImage
 */
async function captureWindow(page) {
  const { nativeImage } = require('electron');
  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: WINDOW_SIZE.width, height: WINDOW_SIZE.height, scale: 1 },
  });
  return nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
}

/**
 * 截一张脸区 ROI。
 *
 * @param {object} page 页面句柄
 * @returns {Promise<object>} ROI 视图（含 buffer / hash / image）
 */
async function captureRoi(page) {
  const image = await captureWindow(page);
  const size = image.getSize();
  const ratio = size.width / WINDOW_SIZE.width;
  return cropRoi(image, ROI, ratio);
}

/**
 * 派发一次真实指针点击（mouseMove → mouseDown → [hold] → mouseUp）。
 *
 * @param {object} page 页面句柄
 * @param {{x: number, y: number}} point 视口坐标
 * @param {{holdMs?: number}} [options] 按住时长
 * @returns {Promise<void>} 完成即返回
 */
async function click(page, point, options = {}) {
  const web = page.win.webContents;
  const holdMs = options.holdMs ?? 12;
  web.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  await sleep(20);
  web.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(holdMs);
  web.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

/**
 * 派发一次真实拖拽（超过拖拽阈值 → 进入 drag），可指定按住的真实时长。
 *
 * @param {object} page 页面句柄
 * @param {{x: number, y: number}} from 起点
 * @param {{holdMs: number, dx?: number, dy?: number}} options 按住时长与位移
 * @returns {Promise<void>} 完成即返回
 */
async function drag(page, from, options) {
  const web = page.win.webContents;
  const dx = options.dx ?? 0;
  const dy = options.dy ?? -18;
  web.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
  await sleep(20);
  web.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) {
    await sleep(16);
    // **必须带 leftButtonDown**：Chromium 用 modifiers 推导 DOM 事件的 `buttons` 位掩码，
    // 少了它页面看到的 `event.buttons === 0`，手势层就不会判成拖拽（实测：只有 mouseDown 不动）
    web.sendInputEvent({
      type: 'mouseMove',
      x: from.x + Math.round((dx * step) / steps),
      y: from.y + Math.round((dy * step) / steps),
      button: 'left',
      modifiers: ['leftButtonDown'],
    });
  }
  await sleep(Math.max(0, options.holdMs));
  web.sendInputEvent({ type: 'mouseUp', x: from.x + dx, y: from.y + dy, button: 'left', clickCount: 1 });
}

/**
 * 轮询到指定表达式出现，出现即抓 ROI（抓完再确认一次，失败重试）。
 *
 * @param {object} page 页面句柄
 * @param {string} expression 目标表情 id
 * @param {{timeoutMs?: number, pollMs?: number}} [options] 轮询参数
 * @returns {Promise<{roi: object, window: object, state: object, waitedMs: number}>} 采样结果
 */
async function sampleWhen(page, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const pollMs = options.pollMs ?? 15;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(STATE_JS);
    if (state.expression === expression) {
      const windowImage = await captureWindow(page);
      const size = windowImage.getSize();
      const roi = cropRoi(windowImage, ROI, size.width / WINDOW_SIZE.width);
      const after = await page.evaluate(STATE_JS);
      if (after.expression === expression) {
        return { roi, window: windowImage, state: after, waitedMs: Date.now() - started };
      }
    }
    await sleep(pollMs);
  }
  const finalState = await page.evaluate(STATE_JS);
  throw new Error(`等待表情 ${expression} 超时（${timeoutMs}ms）；当前 ${JSON.stringify(finalState)}`);
}

/**
 * 等虚拟闲置时长达到阈值后采样（用于 60s / 90s 两档）。
 *
 * @param {object} page 页面句柄
 * @param {number} idleMs 目标虚拟闲置毫秒
 * @param {{timeoutMs?: number}} [options] 真实超时
 * @returns {Promise<{roi: object, window: object, state: object, virtualIdleMs: number}>} 采样结果
 */
async function sampleAtVirtualIdle(page, idleMs, options = {}) {
  const startedVirtual = await page.evaluate('window.__LX_PET_GUARD_CLOCK__.now()');
  const timeoutMs = options.timeoutMs ?? 15000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const virtualNow = await page.evaluate('window.__LX_PET_GUARD_CLOCK__.now()');
    if (virtualNow - startedVirtual >= idleMs) {
      const windowImage = await captureWindow(page);
      const size = windowImage.getSize();
      const roi = cropRoi(windowImage, ROI, size.width / WINDOW_SIZE.width);
      const state = await page.evaluate(STATE_JS);
      return { roi, window: windowImage, state, virtualIdleMs: virtualNow - startedVirtual };
    }
    await sleep(20);
  }
  throw new Error(`虚拟闲置 ${idleMs}ms 未达成（真实 ${timeoutMs}ms 超时）`);
}

// ---------------------------------------------------------------- 逐档判定

/**
 * 判定一档并产出一行报告（同时落截图）。
 *
 * @param {object} page 页面句柄
 * @param {object} spec 档位定义（`shotName` 可覆盖截图文件名，缺省按表情 id 命名）
 * @param {object} sample 采样结果
 * @param {object|null} baseline `neutral` 基线（null 表示本档就是基线）
 * @param {string} outDir 截图目录
 * @returns {Promise<object>} 行记录
 */
async function judgeStage(page, spec, sample, baseline, outDir) {
  const state = sample.state;
  const problems = [];
  const delta = baseline ? deltaRatio(sample.roi.buffer, baseline.roi.buffer) : 0;

  if (state.expression !== spec.expect) problems.push(`expr=${state.expression || '(空)'}≠${spec.expect}`);
  if (spec.minDelta !== undefined && delta < spec.minDelta) {
    problems.push(`roiDelta=${pct(delta)}<${pct(spec.minDelta)}`);
  }
  if (spec.maxDelta !== undefined && delta > spec.maxDelta) {
    problems.push(`roiDelta=${pct(delta)}>${pct(spec.maxDelta)}`);
  }
  // P6：可见性硬证（三条缺一不可）
  if (state.compositeMode !== 'layered') problems.push(`compositeMode=${state.compositeMode || '(空)'}`);
  const expectedFaceOpacity = spec.expectFaceOpacity ?? '1';
  if (state.faceOpacity !== expectedFaceOpacity) problems.push(`faceOpacity=${state.faceOpacity}≠${expectedFaceOpacity}`);
  if (!(state.faceRects > 0)) problems.push('faceRects=0');
  const frameOps = state.frameOpacity.join('/');
  if (state.frameOpacity.some((value) => value !== '0')) problems.push(`frameOpacity=${frameOps}`);
  // 资源自洽：脸层贴片确实换成了该档（不是"别的表情凑巧动了"）
  if (!String(state.faceSrc).includes(`face/${spec.expect}@`)) {
    problems.push(`faceSrc=${String(state.faceSrc).split('/').pop() || '(空)'}`);
  }
  if (state.faceExpression !== spec.expect) problems.push(`face.expression=${state.faceExpression || '(空)'}`);
  // P6 的命中面：脸区中心必须落在立绘层栈里（点得到的是自己，不是调试元素/空白）
  // 注意：这里刻意用 function + var + 单行拼接，避免模板串里嵌套引号/箭头带来的歧义
  const hit = await page.evaluate(
    '(function () {'
    + ` var el = document.elementFromPoint(${HEAD_POINT.x}, ${HEAD_POINT.y});`
    + ' if (!el) return "null";'
    + ' var node = document.querySelector("#pet-root .pet-art");'
    + ' if (!node || !node.contains(el)) return "outside:" + el.tagName;'
    + ' return (el.dataset && el.dataset.layer) || el.className || el.tagName;'
    + ' })()',
  );
  if (String(hit).startsWith('outside:') || hit === 'null') problems.push(`elementFromPoint=${hit}`);

  const pass = problems.length === 0;
  const suffix = spec.control ? `  (${spec.control})` : '';
  const line = [
    `${spec.id.padEnd(5)}${spec.name.padEnd(11)}`,
    `entry=${spec.entry.padEnd(20)}`,
    `expr=${(state.expression || '-').padEnd(10)}`,
    `roiDelta=${pct(delta).padEnd(7)}`,
    `faceOpacity=${state.faceOpacity ?? '-'} frameOpacity=${frameOps}`,
    `${pass ? 'PASS' : `FAIL(${problems.join('; ')})`}`,
  ].join('  ') + suffix;

  const baseName = spec.shotName
    || (spec.control ? `${spec.expect}-${spec.control.replace(/[^a-z0-9]+/gi, '-')}` : spec.expect);
  const roiPath = path.join(outDir, `${baseName}.png`);
  fs.writeFileSync(roiPath, sample.roi.image.toPNG());
  let windowPath = null;
  if (!hasFlag('no-window-shot') && sample.window) {
    windowPath = path.join(outDir, `${baseName}-window.png`);
    fs.writeFileSync(windowPath, sample.window.toPNG());
  }

  return {
    id: spec.id,
    name: spec.name,
    entry: spec.entry,
    expression: state.expression,
    roiDelta: delta,
    minDelta: spec.minDelta ?? null,
    faceOpacity: state.faceOpacity,
    frameOpacity: frameOps,
    compositeMode: state.compositeMode,
    faceSrc: state.faceSrc,
    motion: state.motion,
    hitLayer: hit,
    waitedMs: sample.waitedMs ?? null,
    virtualIdleMs: sample.virtualIdleMs ?? null,
    pass,
    problems,
    shot: roiPath,
    windowShot: windowPath,
    line,
  };
}

// ---------------------------------------------------------------- 场景：真实指针组

/**
 * 组 1（真实时钟 + 真实指针）：E01 基线 / E07 happy / E05 angry / E06 shy / E02 wink / 生理 blink 对照。
 *
 * @param {string} url 入口 URL
 * @param {string} outDir 截图目录
 * @param {object[]} rows 结果收集器
 * @returns {Promise<void>} 完成即返回
 */
async function runPointerGroup(url, outDir, rows) {
  const page = await openPetPage(url, 1);
  try {
    await waitForReady(page);

    // ---- 测量稳定性自证：同一状态两次截图必须逐字节相同（禁止拿动画抖动当信号）
    const first = await captureRoi(page);
    await sleep(140);
    const second = await captureRoi(page);
    const secondState = await page.evaluate(STATE_JS);
    const jitter = deltaRatio(first.buffer, second.buffer);
    if (jitter !== 0 || first.hash !== second.hash) {
      rows.push({
        id: 'S0', name: 'stability', entry: 'two-frames', expression: '-', roiDelta: jitter, pass: false,
        problems: [`同一状态两次截图不一致（jitter=${pct(jitter)}）`], shot: null, windowShot: null,
        line: 'S0   stability   entry=two-frames  expr=-  roiDelta=' + pct(jitter) + '  FAIL(测量不稳定)',
      });
      return;
    }
    rows.push({
      id: 'S0', name: 'stability', entry: 'two-frames', expression: secondState.expression, roiDelta: 0,
      pass: true, problems: [], shot: null, windowShot: null,
      line: 'S0   stability   entry=two-frames  expr=' + (secondState.expression || '-')
        + '  roiDelta=0.00%  PASS(同状态两次截图逐字节一致)',
    });

    const baseline = { roi: second, state: secondState };
    const expression0 = secondState.expression;

    // ---- E01 neutral（基线）
    rows.push(await judgeStage(page, {
      id: 'E01', name: 'neutral', entry: 'boot', expect: expression0,
    }, { roi: second, state: secondState }, null, outDir));

    // ---- E07 happy：身体单击
    await click(page, BODY_POINT);
    const happy = await sampleWhen(page, 'happy', { timeoutMs: 3000 });
    rows.push(await judgeStage(page, {
      id: 'E07', name: 'happy', entry: 'body-tap×1', expect: 'happy', minDelta: 0.006,
    }, happy, baseline, outDir));
    await sleep(800);

    // ---- E05 angry：身体连点（相邻间隔 220ms）——**每点一下立刻采样**。
    // 生气只维持 ~1200ms，而且第 3 下会把生气覆盖成 happy（连点计数已在生气时清零），
    // 所以"点完 3 下再采样"必然错过（实测 trace：第 2 下 angry，第 3 下 happy）。
    let angry = null;
    for (let index = 0; index < 4 && !angry; index += 1) {
      await click(page, BODY_POINT);
      if (hasFlag('trace')) {
        const traced = await page.evaluate(STATE_JS);
        log('info', `trace 身体点击 #${index + 1} → expr=${traced.expression} motion=${traced.motion}`);
      }
      try {
        angry = await sampleWhen(page, 'angry', { timeoutMs: 260 });
      } catch {
        await sleep(220);
      }
    }
    if (!angry) throw new Error('连点 4 下仍未出现 angry');
    rows.push(await judgeStage(page, {
      id: 'E05', name: 'angry', entry: 'body-tap×3', expect: 'angry', minDelta: 0.006,
    }, angry, baseline, outDir));
    await sleep(1500);

    // ---- E06 shy：头部连点 2 下（间隔 300ms）
    await click(page, HEAD_POINT);
    await sleep(300);
    await click(page, HEAD_POINT);
    const shy = await sampleWhen(page, 'shy', { timeoutMs: 3000 });
    rows.push(await judgeStage(page, {
      id: 'E06', name: 'shy', entry: 'head-tap×2', expect: 'shy', minDelta: 0.010,
    }, shy, baseline, outDir));

    // ---- E02 wink：抚摸结束的回礼（shy 900ms 之后）
    const wink = await sampleWhen(page, 'wink', { timeoutMs: 4000 });
    rows.push(await judgeStage(page, {
      id: 'E02', name: 'wink', entry: 'head-tap×2+idle', expect: 'wink', minDelta: 0.010,
    }, wink, baseline, outDir));

    // ---- 回到 neutral（一次性状态必须自己收场）
    const backDeadline = Date.now() + 4000;
    let back = null;
    while (Date.now() < backDeadline) {
      const state = await page.evaluate(STATE_JS);
      if (state.expression === expression0) { back = await captureRoi(page); break; }
      await sleep(50);
    }
    if (!back) throw new Error('wink 之后 4s 内没有回到初始表情');
    const backJitter = deltaRatio(back.buffer, baseline.roi.buffer);
    rows.push({
      id: 'E01', name: 'neutral-return', entry: 'wink+idle', expression: expression0, roiDelta: backJitter,
      pass: backJitter === 0,
      problems: backJitter === 0 ? [] : [`回到初始表情后像素仍有差异（${pct(backJitter)}）`],
      shot: null, windowShot: null,
      line: 'E01  neutral-return  entry=wink+idle  expr=' + expression0 + '  roiDelta=' + pct(backJitter)
        + (backJitter === 0 ? '  PASS' : '  FAIL'),
    });

    // ---- 生理 blink 对照：wink ≠ 双眼闭（抓一次自然眨眼）
    let blink = null;
    try {
      blink = await sampleWhen(page, 'blink', { timeoutMs: 25000, pollMs: 12 });
    } catch (err) {
      rows.push({
        id: 'E02', name: 'blink-compare', entry: 'random-blink', expression: '-', roiDelta: 1, pass: false,
        problems: [String((err && err.message) || err)], shot: null, windowShot: null,
        line: 'E02  blink-compare  entry=random-blink  expr=-  roiDelta=100.00%  FAIL(25s 内没抓到自然眨眼)',
      });
    }
    if (blink) {
      const winkVsBlink = deltaRatio(wink.roi.buffer, blink.roi.buffer);
      const differs = winkVsBlink >= 0.005;
      fs.writeFileSync(path.join(outDir, 'blink.png'), blink.roi.image.toPNG());
      rows.push({
        id: 'E02', name: 'wink-vs-blink', entry: 'random-blink', expression: blink.state.expression,
        roiDelta: winkVsBlink, pass: differs,
        problems: differs ? [] : ['wink 与 blink 的 ROI 像素一致：wink 被双眼闭顶替了'],
        shot: path.join(outDir, 'blink.png'), windowShot: null,
        line: 'E02  wink-vs-blink  entry=random-blink  expr=blink  winkVsBlink=' + (differs ? 'differs' : 'same')
          + '(' + pct(winkVsBlink) + ')  ' + (differs ? 'PASS' : 'FAIL'),
      });
    }

    // ---- P5 来源对照：隐藏 face 层后，同样的真实入口必须**不产生** ROI 变化。
    // 对照的基线必须是"同样隐藏 face 的 neutral"，不能拿"face 可见的 neutral"当基线——
    // 那样量到的是"藏起脸"本身的差异（实测 47%），与"生气有没有改变画面"无关。
    await page.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'lx-pet-guard-face-hidden';
      style.textContent = ${JSON.stringify(FACE_HIDDEN_CSS)};
      document.head.appendChild(style);
      return true;
    })()`);
    let angryHidden = null;
    // 先在"同样隐藏 face"的状态下取一张基线（此时应已回到 neutral）
    const hiddenBaselineWait = Date.now() + 4000;
    let hiddenNeutral = null;
    while (Date.now() < hiddenBaselineWait) {
      const state = await page.evaluate(STATE_JS);
      if (state.expression === expression0) { hiddenNeutral = await captureRoi(page); break; }
      await sleep(50);
    }
    if (!hiddenNeutral) throw new Error('隐藏 face 层后 4s 内没有回到初始表情，无法取对照基线');
    for (let index = 0; index < 4 && !angryHidden; index += 1) {
      await click(page, BODY_POINT);
      try {
        angryHidden = await sampleWhen(page, 'angry', { timeoutMs: 260 });
      } catch {
        await sleep(220);
      }
    }
    if (!angryHidden) throw new Error('隐藏 face 层后连点 4 下仍未出现 angry 指令');
    rows.push(await judgeStage(page, {
      id: 'E05', name: 'angry', entry: 'body-tap×3+face-hidden', expect: 'angry',
      maxDelta: 0.0005, control: 'face-hidden control', expectFaceOpacity: '0',
    }, angryHidden, { roi: hiddenNeutral, state: { expression: expression0 } }, outDir));
  } finally {
    page.win.destroy();
  }
}

// ---------------------------------------------------------------- 场景：对抗组（抚摸优先 vs 连点生气）

/**
 * 组 4（对抗组）：把「同一头部区域连点」与「身体连点」并排验证。
 *
 * <p><b>为什么要单独一组：</b>主理人手工点击时"点了 angry 没反应"，需要一条确定结论——
 * 是调试按钮没命中，还是"抚摸优先"把生气吞掉了。状态机的口径是：头部第 2 下进 `pet`
 * 并清零 `tapStreak`（抚摸优先），身体连点第 2 下进 `angry`。本组用 Electron offscreen +
 * 真实指针（`sendInputEvent`）在**同一份渲染环境**里把两条路径跑出来，每次点击后立刻读
 * 状态（生气只维持 ~1200ms，点完再采样必错过）。</p>
 *
 * <p>判定口径：</p>
 * <ul>
 *   <li>Q1 头部连点 3 下：逐次表情序列<b>不得出现 angry</b>，且必须出现 `shy`（抚摸生效）；</li>
 *   <li>Q2 身体连点 3 下：逐次表情序列<b>必须出现 angry</b>（身体连点仍然能生气）。</li>
 * </ul>
 *
 * @param {string} url 入口 URL
 * @param {string} outDir 截图目录
 * @param {object[]} rows 结果收集器
 * @returns {Promise<void>} 完成即返回
 */
async function runComboGroup(url, outDir, rows) {
  const page = await openPetPage(url, 1);
  try {
    await waitForReady(page);
    const baseline = await captureRoi(page);
    const baseState = await page.evaluate(STATE_JS);

    // ---- Q1：同一头部区域连点 3 下（间隔 250ms），每点一下立刻采样
    // 注意：shy 只维持约 900ms，第 3 下会把它覆盖成 happy（实测 happy→shy→happy），
    // 所以 shy 的 ROI 必须在第 2 下之后立刻抓，不能等 3 下点完再抓（那会假红）。
    const headSeq = [];
    const recordHead = async (index) => {
      const state = await page.evaluate(STATE_JS);
      headSeq.push(state.expression || '-');
      if (hasFlag('trace')) log('info', `trace 头部点击 #${index} → expr=${state.expression} motion=${state.motion}`);
    };
    await click(page, HEAD_POINT);
    await recordHead(1);
    await sleep(250);
    await click(page, HEAD_POINT);
    await recordHead(2);
    let shy = null;
    try {
      shy = await sampleWhen(page, 'shy', { timeoutMs: 800 });
    } catch {
      shy = null;
    }
    await sleep(120);
    await click(page, HEAD_POINT);
    await recordHead(3);
    let q1Delta = 0;
    if (shy) {
      q1Delta = deltaRatio(shy.roi.buffer, baseline.buffer);
      fs.writeFileSync(path.join(outDir, 'combo-head3-shy.png'), shy.roi.image.toPNG());
      if (!hasFlag('no-window-shot') && shy.window) {
        fs.writeFileSync(path.join(outDir, 'combo-head3-shy-window.png'), shy.window.toPNG());
      }
    }
    const q1Problems = [];
    if (headSeq.includes('angry')) q1Problems.push(`头部连点 3 下出现了 angry：${headSeq.join('→')}`);
    if (!headSeq.includes('shy')) q1Problems.push(`头部连点 3 下没有进入 shy：${headSeq.join('→')}`);
    if (shy && q1Delta < 0.01) q1Problems.push(`shy 脸区 ROI 变化仅 ${pct(q1Delta)}`);
    rows.push({
      id: 'Q1',
      name: 'head-tap×3',
      entry: 'head-tap×3(250ms)',
      expression: headSeq[headSeq.length - 1] || '-',
      roiDelta: q1Delta,
      pass: q1Problems.length === 0,
      problems: q1Problems,
      shot: shy ? path.join(outDir, 'combo-head3-shy.png') : null,
      windowShot: null,
      line: 'Q1   head-tap×3   entry=head-tap×3(250ms)  expr=' + headSeq.join('→') + '  shyROI='
        + pct(q1Delta) + '  '
        + (q1Problems.length === 0 ? 'PASS(抚摸优先，全程无 angry)' : `FAIL(${q1Problems.join('; ')})`),
    });

    // 等抚摸/回礼收场，回到基线表情再打身体
    const settleDeadline = Date.now() + 5000;
    while (Date.now() < settleDeadline) {
      const state = await page.evaluate(STATE_JS);
      if (state.expression === baseState.expression) break;
      await sleep(80);
    }

    // ---- Q2：身体连点 3 下，同样每点一下立刻采样
    const bodySeq = [];
    for (let index = 0; index < 3; index += 1) {
      await click(page, BODY_POINT);
      const state = await page.evaluate(STATE_JS);
      bodySeq.push(state.expression || '-');
      if (hasFlag('trace')) log('info', `trace 身体点击 #${index + 1} → expr=${state.expression} motion=${state.motion}`);
      await sleep(250);
    }
    const q2Problems = [];
    if (!bodySeq.includes('angry')) q2Problems.push(`身体连点 3 下没有出现 angry：${bodySeq.join('→')}`);
    rows.push({
      id: 'Q2',
      name: 'body-tap×3',
      entry: 'body-tap×3(250ms)',
      expression: bodySeq[bodySeq.length - 1] || '-',
      roiDelta: 0,
      pass: q2Problems.length === 0,
      problems: q2Problems,
      shot: null,
      windowShot: null,
      line: 'Q2   body-tap×3   entry=body-tap×3(250ms)  expr=' + bodySeq.join('→') + '  '
        + (q2Problems.length === 0 ? 'PASS(身体连点仍能生气)' : `FAIL(${q2Problems.join('; ')})`),
    });
  } finally {
    page.win.destroy();
  }
}

/**
 * 统计一段时间内的**眨眼次数**（真实时钟）。
 *
 * <p><b>为什么要这个判别器：</b>E08 的两档现在画面已经不同（60s 困倦=`sleepy` 半闭，
 * 90s 真睡=`blink` 双眼闭合），但"睡得沉不沉"还有一条时间维度证据：
 * 「困倦仍会眨眼，真睡抑制眨眼」（`state-machine.ts` / `blink-driver.ts`）。
 * 同样 10s 内，困倦档应出现眨眼，真睡档必须为 0。</p>
 *
 * <p><b>为什么不能直接数"表达式是否等于 blink"（这一条踩过）：</b>真睡的基础表情**就是**
 * 闭眼贴片 `blink`（E08 判据要求两档不同形）。按"当前表达式是不是 blink"计数，
 * 真睡档从第一个采样点起就一直"在眨眼"，会被数成 1 次——把正确的实现判成缺陷。
 * 所以这里数的是**一次完整的眨眼过程**（睁→闭或闭→睁的边沿），并额外要求"先见过睁眼"，
 * 从而把"常驻闭眼"（睡着这张脸）与"眨一下"（动作）彻底分开。</p>
 *
 * @param {object} page 页面句柄
 * @param {number} windowMs 观察时长（真实毫秒）
 * @returns {Promise<number>} 观察到的眨眼次数（按完整的睁/闭边沿计数）
 */
async function countBlinks(page, windowMs) {
  const deadline = Date.now() + windowMs;
  let count = 0;
  let inBlink = false;
  /** 是否已经观察过"睁眼"样本：没见过的常驻闭眼不算眨眼。 */
  let sawOpen = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(STATE_JS);
    const blinking = state.expression === 'blink' || /\/face\/blink@/.test(state.faceSrc);
    if (!blinking) {
      if (inBlink) count += 1; // 闭→睁：这一轮眨眼完整结束
      sawOpen = true;
    } else if (!inBlink && sawOpen) {
      count += 1; // 睁→闭：确实睁着眼时才眨的
    }
    inBlink = blinking;
    await sleep(10);
  }
  return count;
}

// ---------------------------------------------------------------- 场景：闲置组 / 拖拽组

/**
 * 组 2（虚拟时钟 ×60）：E08 sleepy（60s 闲置）/ sleeping（90s 闲置）/ E03 surprised（点醒）。
 *
 * @param {string} url 入口 URL
 * @param {string} outDir 截图目录
 * @param {object[]} rows 结果收集器
 * @returns {Promise<void>} 完成即返回
 */
async function runIdleGroup(url, outDir, rows) {
  const page = await openPetPage(url, IDLE_TIME_SCALE);
  try {
    await waitForReady(page);
    const baseline = { roi: await captureRoi(page), state: await page.evaluate(STATE_JS) };

    // ---- E08 sleepy：把虚拟时钟往前推 61s（等价于 ×60 等待，但不必真的等）
    await page.evaluate('window.__LX_PET_GUARD_CLOCK__.advance(61000); true');
    const sleepy = await sampleWhen(page, 'sleepy', { timeoutMs: 6000 });
    rows.push(await judgeStage(page, {
      id: 'E08', name: 'sleepy', entry: 'idle-60s(×60)', expect: 'sleepy', minDelta: 0.008,
    }, sleepy, baseline, outDir));

    // ---- 时间维度判别：困倦档仍然会眨眼（设计口径：只有真睡才抑制眨眼）
    // 观察期把倍率调回 1，否则 10s 真实等待会被算成 600s 虚拟闲置、直接跳进 sleeping。
    await page.evaluate('window.__LX_PET_GUARD_CLOCK__.scale = 1; true');
    const sleepyBlinks = await countBlinks(page, 10000);
    await page.evaluate('window.__LX_PET_GUARD_CLOCK__.scale = 60; true');

    // ---- 90s 档：再推 31s（累计 92s 闲置）后必须进入 sleeping
    await page.evaluate('window.__LX_PET_GUARD_CLOCK__.advance(31000); true');
    await sleep(600);
    const sleepingWindow = await captureWindow(page);
    const sleeping = {
      roi: cropRoi(sleepingWindow, ROI, sleepingWindow.getSize().width / WINDOW_SIZE.width),
      window: sleepingWindow,
      state: await page.evaluate(STATE_JS),
    };
    const sleepyVsSleeping = deltaRatio(sleepy.roi.buffer, sleeping.roi.buffer);
    const distinguishable = sleepyVsSleeping >= 0.005;
    rows.push(await judgeStage(page, {
      id: 'E08', name: 'sleeping', entry: 'idle-90s(×60)', expect: sleeping.state.expression,
      // 真睡的表情 id 是 `blink`，与"生理眨眼"同名：按表情 id 命名会覆盖组 1 的 blink.png 证据，
      // 所以这一档按**档位**落盘（sleeping.png / sleeping-window.png）。
      shotName: 'sleeping',
    }, sleeping, baseline, outDir));
    // 两档贴片更名前的旧实现里 60s/90s 表情 id 同为 sleepy、后写会覆盖先写；
    // 现在两档 id 已不同（sleepy / blink），这里仍按**档位**显式落盘，保证证据文件名稳定。
    fs.writeFileSync(path.join(outDir, 'sleepy.png'), sleepy.roi.image.toPNG());
    if (sleepy.window) fs.writeFileSync(path.join(outDir, 'sleepy-window.png'), sleepy.window.toPNG());
    const sleepingShot = path.join(outDir, 'sleeping.png');
    fs.writeFileSync(sleepingShot, sleeping.roi.image.toPNG());
    if (sleeping.window) fs.writeFileSync(path.join(outDir, 'sleeping-window.png'), sleeping.window.toPNG());
    rows.push({
      id: 'E08', name: 'sleepy-vs-sleeping', entry: 'idle-60s/90s', expression: sleeping.state.expression,
      roiDelta: sleepyVsSleeping, pass: distinguishable,
      problems: distinguishable
        ? []
        : ['60s 档与 90s 档画面逐像素一致：困倦与真睡在画面上无法区分（§11.2 P4 要求两档 ROI 不一致）'],
      shot: sleepingShot, windowShot: null,
      line: 'E08  sleepy-vs-sleeping  entry=idle-60s/90s  expr=' + (sleeping.state.expression || '-')
        + '  roiDelta=' + pct(sleepyVsSleeping) + '  ' + (distinguishable ? 'PASS' : 'FAIL(两档同形)'),
    });

    // ---- 真睡档：同样观察 10s，眨眼必须被抑制（这是两档唯一的可区分依据）
    await page.evaluate('window.__LX_PET_GUARD_CLOCK__.scale = 1; true');
    const sleepingBlinks = await countBlinks(page, 10000);
    const blinkSuppressed = sleepyBlinks > 0 && sleepingBlinks === 0;
    rows.push({
      id: 'E08', name: 'blink-activity', entry: 'idle-60s vs 90s', expression: sleeping.state.expression,
      roiDelta: 0, pass: blinkSuppressed,
      problems: blinkSuppressed
        ? []
        : [`眨眼活动量不符合设计：困倦档 ${sleepyBlinks} 次 / 真睡档 ${sleepingBlinks} 次（要求 >0 / =0）`],
      shot: null, windowShot: null,
      line: 'E08  blink-activity  entry=idle-60s vs 90s  10s内眨眼 困倦=' + sleepyBlinks + ' 真睡=' + sleepingBlinks
        + '  ' + (blinkSuppressed ? 'PASS(真睡抑制眨眼)' : 'FAIL(眨眼抑制不成立)'),
    });

    // ---- E03 surprised：把时钟调回真实时间再点醒（否则 20ms 点击会被算成 1.2s 长拖）
    await page.evaluate('window.__LX_PET_GUARD_CLOCK__.scale = 1; true');
    await click(page, BODY_POINT);
    const surprised = await sampleWhen(page, 'surprised', { timeoutMs: 3000 });

    rows.push(await judgeStage(page, {
      id: 'E03', name: 'surprised', entry: 'wake(body-tap)', expect: 'surprised', minDelta: 0.010,
    }, surprised, baseline, outDir));

    // ---- 唤醒收场：700ms 后回 neutral，且与基线逐字节一致
    const deadline = Date.now() + 5000;
    let settled = null;
    while (Date.now() < deadline) {
      const state = await page.evaluate(STATE_JS);
      if (state.expression === baseline.state.expression) { settled = await captureRoi(page); break; }
      await sleep(50);
    }
    if (!settled) throw new Error('唤醒后 5s 内没有回到初始表情');
    const settleJitter = deltaRatio(settled.buffer, baseline.roi.buffer);
    rows.push({
      id: 'E03', name: 'neutral-return', entry: 'wake+700ms', expression: baseline.state.expression,
      roiDelta: settleJitter, pass: settleJitter === 0,
      problems: settleJitter === 0 ? [] : [`唤醒收场后像素仍有差异（${pct(settleJitter)}）`],
      shot: null, windowShot: null,
      line: 'E03  neutral-return  entry=wake+700ms  expr=' + baseline.state.expression
        + '  roiDelta=' + pct(settleJitter) + (settleJitter === 0 ? '  PASS' : '  FAIL'),
    });
  } finally {
    page.win.destroy();
  }
}

/**
 * 组 3（真实时钟）：E04 sad（长拖拽 ≥1200ms 松手）。
 *
 * @param {string} url 入口 URL
 * @param {string} outDir 截图目录
 * @param {object[]} rows 结果收集器
 * @returns {Promise<void>} 完成即返回
 */
async function runDragGroup(url, outDir, rows) {
  const page = await openPetPage(url, 1);
  try {
    await waitForReady(page);
    const baseline = { roi: await captureRoi(page), state: await page.evaluate(STATE_JS) };
    await drag(page, BODY_POINT, { holdMs: 1300, dx: 0, dy: -30 });
    const sad = await sampleWhen(page, 'sad', { timeoutMs: 5000 });
    rows.push(await judgeStage(page, {
      id: 'E04', name: 'sad', entry: 'long-drag≥1200ms', expect: 'sad', minDelta: 0.008,
    }, sad, baseline, outDir));
  } finally {
    page.win.destroy();
  }
}

// ---------------------------------------------------------------- 持久化（防止中途退出丢报告）

/** 本次运行的行记录（`process.on('exit')` 也用它落盘，避免中途退出丢证据）。 */
let CURRENT_ROWS = [];
/** 报告元信息。 */
let CURRENT_META = { commit: 'unknown', url: '' };
/** 产物目录（空表示还没定）。 */
let CURRENT_OUT_DIR = '';

/**
 * 把当前结果落盘（幂等，任何时刻都可调用）。
 *
 * @returns {void}
 */
function persistReport() {
  if (!CURRENT_OUT_DIR || CURRENT_ROWS.length === 0) return;
  try {
    fs.mkdirSync(CURRENT_OUT_DIR, { recursive: true });
    const text = formatReport(CURRENT_META, CURRENT_ROWS);
    fs.writeFileSync(path.join(CURRENT_OUT_DIR, 'report.txt'), text, 'utf8');
    fs.writeFileSync(path.join(CURRENT_OUT_DIR, 'report.json'), JSON.stringify({ ...CURRENT_META, rows: CURRENT_ROWS }, null, 2), 'utf8');
  } catch (err) {
    log('warn', `报告落盘失败：${(err && err.message) || err}`);
  }
}

process.on('exit', persistReport);

// ---------------------------------------------------------------- 主流程

/**
 * 生成报告文本。
 *
 * @param {{commit: string, url: string}} meta 元信息
 * @param {object[]} rows 行记录
 * @returns {string} 报告文本
 */
function formatReport(meta, rows) {
  const lines = [];  lines.push('# 桌宠脸层画面守卫（§11.2 P1–P6，Electron offscreen 真渲染）');
  lines.push(`commit=${meta.commit}`);
  lines.push(`entry=${meta.url}`);
  lines.push(`timeScale(E08/E03)=${IDLE_TIME_SCALE}（虚拟时钟，行为状态机一行未改）`);
  lines.push(`window=${WINDOW_SIZE.width}×${WINDOW_SIZE.height}CSS  roi=${ROI.x.toFixed(2)},${ROI.y.toFixed(2)},${ROI.width.toFixed(2)},${ROI.height.toFixed(2)}`);
  lines.push(`head=${HEAD_POINT.x},${HEAD_POINT.y}  body=${BODY_POINT.x},${BODY_POINT.y}`);
  lines.push('');
  for (const row of rows) lines.push(row.line);
  const failed = rows.filter((row) => !row.pass);
  lines.push('');
  lines.push(`# 汇总：${rows.length - failed.length}/${rows.length} PASS，${failed.length} FAIL`);
  return lines.join('\n');
}

/**
 * 主流程：起 dev server → 三组场景 → 落报告。
 *
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const commit = resolveCommit();
  const outDir = resolveOutDir(commit);
  fs.mkdirSync(outDir, { recursive: true });

  const { url, started } = await ensureDevServer();
  log('info', `dev server ${started ? '由守卫拉起' : '复用已在跑的实例'}：${url}`);
  log('info', `截图目录：${outDir}`);

  const rows = [];
  CURRENT_ROWS = rows;
  CURRENT_META = { commit, url };
  CURRENT_OUT_DIR = outDir;
  const groups = [
    { id: 'pointer', run: runPointerGroup, needed: ['E01', 'E07', 'E05', 'E06', 'E02'] },
    { id: 'idle', run: runIdleGroup, needed: ['E08', 'E03'] },
    { id: 'drag', run: runDragGroup, needed: ['E04'] },
    { id: 'combo', run: runComboGroup, needed: ['Q1', 'Q2'] },
  ];

  for (const group of groups) {
    if (!group.needed.some(wanted)) continue;
    try {
      await group.run(url, outDir, rows);
    } catch (err) {
      const message = String((err && err.stack) || err);
      log('error', `组 ${group.id} 失败：${message}`);
      rows.push({
        id: group.id, name: 'group', entry: 'n/a', expression: '-', roiDelta: 1, pass: false,
        problems: [message], shot: null, windowShot: null,
        line: `${group.id.toUpperCase()}  GROUP-FAIL  ${message}`,
      });
    }
    // 组间留一点间隔：连续开关 offscreen 窗口时 Chromium 侧偶尔还没收拾完
    persistReport();
    await sleep(600);
  }

  const report = formatReport({ commit, url }, rows);
  HARD_CLOSE = true;
  if (POOLED_PAGE) {
    try { POOLED_PAGE.win.destroy(); } catch (err) { log('warn', `关窗失败：${(err && err.message) || err}`); }
  }
  fs.writeFileSync(path.join(outDir, 'report.txt'), report, 'utf8');
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ commit, url, rows }, null, 2), 'utf8');
  // 用同步写 fd 1 输出报告：`app.exit()` 会丢掉还没刷出的 stdout（实测最后一段整段消失）
  try { fs.writeSync(1, `\n${report}\n`); } catch { console.log(report); }
  const failed = rows.filter((row) => !row.pass).length;
  log(failed === 0 ? 'info' : 'error', `画面守卫结束：${rows.length - failed}/${rows.length} PASS`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 引导

// `lxa://` 的特权必须在 app ready 之前登记（之后登记不生效）
registerLxSchemePrivileges();

// **必须给守卫一个独立的 userData 目录**：未打包的 Electron 默认共用 `%APPDATA%\Electron`，
// 而用户正在跑的桌宠实例（npx electron pet-launcher.cjs）用的是同一份 profile。
// 两个 Chromium 抢同一个 profile 会偶发（不是必现）无声崩溃——现象正是"日志戛然而止、退出码 0"。
const GUARD_USER_DATA_DIR = process.env.PET_GUARD_USER_DATA
  || path.join(require('node:os').tmpdir(), 'lx-pet-face-guard-userdata');
/** 默认目录是守卫自己建的临时目录 ⇒ 用完必须自己清；用户显式指定的目录不许删。 */
const GUARD_OWNS_USER_DATA = !process.env.PET_GUARD_USER_DATA;
app.setPath('userData', GUARD_USER_DATA_DIR);

/**
 * 删掉守卫自己的 userData 目录（Chromium profile）。
 *
 * <p>为什么要清：它在 `%TEMP%` 下，每次运行都会留下几十个 profile 文件（实测积过
 * `%TEMP%\lx-pet-face-guard-userdata`）。Chromium 退出时不会删自己的 profile。</p>
 *
 * <p>为什么放在 `exit` 而不是 `app.exit()` 之前：`app.exit()` 返回时 Chromium 可能还握着
 * 文件句柄（Windows 上删不掉），`exit` 事件触发时它已经收尾完。</p>
 *
 * <p><b>为什么还要挂一个脱离进程兜底（实测过的坑）：</b>主进程 `exit` 时 Chromium 的
 * GPU / utility / crashpad 子进程往往还活着并攥着 profile 里的句柄，同步 `rmSync` 会抛
 * `EPERM, Permission denied`（实测残留一个 60 项的空壳目录）。所以同步删失败后，再起一个
 * `ELECTRON_RUN_AS_NODE` 的助手进程：它在本进程退出之后反复重试删除，最多约 5s，
 * 之后自己退出。助手与本进程完全脱离（`detached + unref`），不影响守卫的退出码。</p>
 *
 * @returns {void}
 */
function cleanupGuardUserData() {
  if (!GUARD_OWNS_USER_DATA) return;
  try {
    fs.rmSync(GUARD_USER_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    log('warn', `守卫 userData 同步清理失败，改用助手进程重试：${(err && err.message) || err}`);
  }
  if (!fs.existsSync(GUARD_USER_DATA_DIR)) return;
  /** 助手进程的脚本：每 250ms 试一次，最多 20 次。 */
  const helper = [
    'const fs=require("node:fs");',
    `const dir=${JSON.stringify(GUARD_USER_DATA_DIR)};`,
    'let left=20;',
    'const tick=()=>{try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch(err){}',
    'if(fs.existsSync(dir)&&left-->0)setTimeout(tick,250);};',
    'tick();',
  ].join('');
  try {
    spawn(process.execPath, ['-e', helper], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      // `ELECTRON_RUN_AS_NODE`：process.execPath 是 electron.exe，靠它当 node 用
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref();
  } catch (err) {
    log('warn', `守卫 userData 清理助手启动失败（可手工删 ${GUARD_USER_DATA_DIR}）：${(err && err.message) || err}`);
  }
}
process.on('exit', cleanupGuardUserData);

// 未捕获的 Promise 拒绝在 Electron 下默认会**直接结束进程**（日志都来不及刷），
// 这里接住并打全栈，避免"守卫无声退出、报告没落盘"这种最难查的形态。
process.on('unhandledRejection', (reason) => {
  log('error', `未捕获的 Promise 拒绝：${(reason && reason.stack) || reason}`);
});
process.on('uncaughtException', (err) => {
  log('error', `未捕获异常：${(err && err.stack) || err}`);
});

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  // 自定义协议：开发态把 `public/live2d` 挂进来（层与脸贴片都走 lxa://）
  registerLxProtocol({
    userDataDir: app.getPath('userData'),
    appRoot: FRONTEND_ROOT,
    extraBases: [path.join(FRONTEND_ROOT, 'public', 'live2d')],
  });
  let code = 1;
  try {
    code = await main();
  } catch (err) {
    log('error', `未捕获异常：${(err && err.stack) || err}`);
    code = 2;
  }
  app.exit(code);
}).catch((err) => {
  log('error', `启动失败：${(err && err.stack) || err}`);
  app.exit(2);
});
