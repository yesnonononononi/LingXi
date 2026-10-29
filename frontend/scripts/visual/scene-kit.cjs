/**
 * 组件级视觉/状态验证的公共骨架。
 *
 * 为什么存在：`component-scenes.cjs`（静态态）与 `hover-states.cjs`（交互态）都要做
 * 「vite 构建迷你 App → Electron offscreen 载入 → 应用主题 → 采集 computed style」，
 * 复制两份 bootstrap 就是留技术债：主题语义一改（例如 data-theme 的写法）就得改两处，
 * 漏改一处就会产生「假基线」——图拍出来了、颜色其实没跟着主题走。
 * 因此主题相关的一切（令牌解析、主题断言）只在这里实现一次，供多套 suite 共用。
 *
 * 关键约束（都踩过坑）：
 *  - tokens.css 是「:root 即暗色默认，html.light / html[data-theme=light] 覆盖为亮色」，
 *    **只加 .dark 类不会得到暗色**，必须写 data-theme；写错就会拿亮色当暗色基线。
 *  - 主题是否真的翻转不能只靠「两态都拍了图」，必须断言：根节点标记位 + 令牌变量值 +
 *    Tailwind 映射后的 computed color 三者同时到位（assertThemeApplied）。
 */

const path = require('node:path');
const fsp = require('node:fs/promises');

const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
/** 运行时产物统一落在 .lingxi/tmp（不进 git、不进源码树）。 */
const ARTIFACT_ROOT = path.join(REPO_ROOT, '.lingxi', 'tmp', 'visual');
/** vite 构建迷你 App 的工作区，放在 node_modules 下避免污染源码树。 */
const SCENE_ROOT = path.join(FRONTEND_ROOT, 'node_modules', '.tmp', 'scenes');

const INDEX_HTML = '<!doctype html><html><head><meta charset="utf-8"></head>'
  + '<body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>';

/** 每个 suite 一个独立工作区，互不覆盖构建产物。 */
function sceneDir(id) {
  return path.join(SCENE_ROOT, id);
}

/**
 * 构建迷你 App：把 suite 提供的 App.vue / entry.js 写进工作区并用 vite 打包。
 * @param {{id: string, appVue: string, entryJs: string}} suite
 * @returns {Promise<string>} 工作区路径（dist/index.html 就在其下）
 */
async function buildMiniApp({ id, appVue, entryJs }) {
  const workDir = sceneDir(id);
  await fsp.mkdir(workDir, { recursive: true });
  await fsp.writeFile(path.join(workDir, 'App.vue'), appVue);
  await fsp.writeFile(path.join(workDir, 'entry.js'), entryJs);
  await fsp.writeFile(path.join(workDir, 'index.html'), INDEX_HTML);
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({
    configFile: false, root: workDir, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(workDir, 'dist'), emptyOutDir: true },
  });
  return workDir;
}

/** 相对工作区的 import 说明符（Windows 反斜杠转正斜杠）。 */
function relFrom(workDir, absPath) {
  return path.relative(workDir, absPath).split(String.fromCharCode(92)).join('/');
}

/**
 * 打开 offscreen 窗口载入构建产物，等入口把 window.ready 置真。
 *
 * <p><b>G-5 起支持 `query`：</b>每个场景一个独立 page（一页只挂一个场景容器），
 * 场景选择通过 URL query 传给迷你 App（`?scene=card-header`）。这样只构建一次，
 * 却能按场景开出互不影响的页面 —— 新增场景不再改动任何既有场景的文档高度与裁切源。</p>
 *
 * @param {string} workDir 构建工作区（`dist/index.html` 在其下）
 * @param {{width?: number, height?: number, query?: Record<string, string>, readyTimeoutMs?: number}} [options] 视口与场景参数
 * @returns {Promise<{win: object, evaluate: Function, close: Function}>} 页面句柄
 */
async function openScene(workDir, { width = 780, height = 760, query = null, readyTimeoutMs = 15000 } = {}) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    width, height, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  const indexFile = path.join(workDir, 'dist', 'index.html');
  if (query) await win.loadFile(indexFile, { query });
  else await win.loadFile(indexFile);
  const evaluate = (s) => win.webContents.executeJavaScript(s);
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await evaluate('window.ready===true');
    if (ready) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) {
    win.destroy();
    throw new Error(`场景入口未就绪：${indexFile}（${readyTimeoutMs}ms 内 window.ready 未置真）`);
  }
  return { win, evaluate, close: () => win.destroy() };
}


/** 解析 tokens.css：返回 { dark: {--lx-*: raw}, light: {...} }。 */
function readTokenValues() {
  const css = require('node:fs').readFileSync(path.join(FRONTEND_ROOT, 'src', 'theme', 'tokens.css'), 'utf8');
  // 注意：文件头注释里也出现了 `:root` 与 `html[data-theme="light"]` 字样，
  // 所以不能用 indexOf 找字符串（会把注释当块首）。这里按「行首选择器 + {」逐行匹配，
  // 顺带避开在模板里反复转义方括号这种高摩擦写法。
  const lines = css.split(/\r?\n/);
  const block = (selector) => {
    const start = lines.findIndex((l) => l.trim().startsWith(selector) && l.includes('{'));
    if (start < 0) throw new Error(`tokens.css 缺少块：${selector}`);
    const out = {};
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].includes('}')) break;
      const kv = lines[i].match(/(--lx-[a-z0-9-]+)\s*:\s*([^;]+);/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  };
  return {
    dark: block(':root'),
    light: block('html[data-theme="light"]'),
  };
}

/** '#e4e4e7' / 'rgba(...)' → 'rgb(228, 228, 231)'，用于和 computed style 比对。 */
function toCssRgb(raw) {
  const hex = raw.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  return raw.trim();
}

/** 主题探针：同时验证「令牌变量」与「Tailwind 映射后」两层的取值。 */
const PROBE_JS = `(() => {
  let host = document.getElementById('lx-theme-probe');
  if (!host) {
    host = document.createElement('div');
    host.id = 'lx-theme-probe';
    host.style.position = 'fixed';
    host.style.left = '-9999px';
    host.style.top = '0';
    host.innerHTML = '<span data-probe="utility-secondary" class="text-lx-secondary">x</span>'
      + '<span data-probe="utility-primary" class="text-lx-primary">x</span>'
      + '<span data-probe="var-secondary" style="color: var(--lx-text-secondary)">x</span>';
    document.body.appendChild(host);
  }
  const read = (n) => {
    const el = host.querySelector('[data-probe="' + n + '"]');
    return el ? getComputedStyle(el).color : null;
  };
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    hasLightClass: document.documentElement.classList.contains('light'),
    hasDarkClass: document.documentElement.classList.contains('dark'),
    varSecondary: getComputedStyle(document.documentElement).getPropertyValue('--lx-text-secondary').trim(),
    utilitySecondary: read('utility-secondary'),
    utilityPrimary: read('utility-primary'),
    varColor: read('var-secondary'),
  };
})()`;

/**
 * 断言「当前渲染确实处于 theme 主题」——这是防止假基线的核心护栏。
 * 四路同时校验：根节点标记位、令牌变量原文、Tailwind 映射后的 computed color、
 * 直接 var() 引用后的 computed color。任何一路没翻转都抛错。
 */
async function assertThemeApplied(evaluate, theme, tokens) {
  const expected = tokens[theme];
  if (!expected) throw new Error(`未知主题：${theme}`);
  const probe = await evaluate(PROBE_JS);
  const problems = [];
  if (probe.theme !== theme) problems.push(`根节点 data-theme=${probe.theme}，期望 ${theme}`);
  const wantLight = theme === 'light';
  if (wantLight && (!probe.hasLightClass || probe.hasDarkClass)) {
    problems.push(`根节点 class 未切到 light（light=${probe.hasLightClass}, dark=${probe.hasDarkClass}）`);
  }
  if (!wantLight && probe.hasLightClass) problems.push('暗色下根节点仍带 light 类');
  const wantVar = expected['--lx-text-secondary'];
  if (toCssRgb(probe.varSecondary) !== toCssRgb(wantVar)) {
    problems.push(`--lx-text-secondary=${probe.varSecondary}，期望 ${wantVar}`);
  }
  const wantColor = toCssRgb(wantVar);
  if (probe.utilitySecondary !== wantColor) {
    problems.push(`text-lx-secondary 计算色=${probe.utilitySecondary}，期望 ${wantColor}（Tailwind 映射未跟随主题）`);
  }
  if (probe.varColor !== wantColor) {
    problems.push(`var(--lx-text-secondary) 计算色=${probe.varColor}，期望 ${wantColor}`);
  }
  const wantPrimary = toCssRgb(expected['--lx-text-primary']);
  if (probe.utilityPrimary !== wantPrimary) {
    problems.push(`text-lx-primary 计算色=${probe.utilityPrimary}，期望 ${wantPrimary}`);
  }
  if (problems.length) {
    throw new Error(`[${theme}] 主题未真正生效（假基线风险）：\n  - ${problems.join('\n  - ')}`);
  }
  return probe;
}

/** 明暗两态的令牌计算值必须互不相同，避免「两态其实一样」也判绿。 */
function assertThemesDiffer(lightProbe, darkProbe) {
  const differ = lightProbe.utilitySecondary !== darkProbe.utilitySecondary
    || lightProbe.utilityPrimary !== darkProbe.utilityPrimary;
  if (!differ) {
    throw new Error('明暗两态 computed color 完全相同：主题翻转没有产生任何样式差异');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G-5：截图原语与命名（两套 harness 共用，命名只写一份，避免「两套各起一套名字」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 某场景的容器图文件名。
 *
 * <p>前缀 `scene-` 与元素 ROI 的 `<key>-roi.png` 形成两族，永不撞名；
 * 主题只体现在目录（`<theme>/scene-x.png`），文件名里不带主题，
 * 这样「同一场景两态」在同一个目录里按主题分层，人一眼能对上（旧的扁平
 * `<theme>-<key>.png` 排序后两态混在一起）。</p>
 *
 * @param {string} sceneKey 场景键（= `data-scene` 值）
 * @returns {string} 形如 `scene-card-header.png`
 */
function sceneImageName(sceneKey) {
  return `scene-${sceneKey}.png`;
}

/**
 * 元素级 ROI 的文件名（<b>路径与 G-5 之前完全一致</b>）。
 *
 * <p>不改名的理由：它是 G-4 oracle 的 `path` 键，改名等于把 42 条条目全部作废，
 * 白白丢掉「哪张 ROI 上次变过」的历史可比性；ROI 的语义也没变，只是裁切来源变了。</p>
 *
 * @param {string} key 目标键
 * @returns {string} 形如 `cardHeaderTitle-roi.png`
 */
function roiImageName(key) {
  return `${key}-roi.png`;
}

/**
 * hover 目标的截图文件名（G-5 起改分层：`<theme>/<key>.png`）。
 *
 * @param {'light'|'dark'} theme 主题
 * @param {string} key 目标键
 * @returns {string} 形如 `light/chat-copy.png`（`/` 分隔的相对路径）
 */
function hoverImageName(theme, key) {
  return `${theme}/${key}.png`;
}

/**
 * 把「主题子目录 + 文件名」拼成绝对路径，并保证目录存在。
 *
 * @param {string} dir 套件产物根目录（baseline / current）
 * @param {'light'|'dark'} theme 主题
 * @param {string} fileName 文件名
 * @returns {Promise<string>} 可写的绝对路径
 */
async function themeImagePath(dir, theme, fileName) {
  const themeDir = path.join(dir, theme);
  await fsp.mkdir(themeDir, { recursive: true });
  return path.join(themeDir, fileName);
}

/**
 * 每页截图器：把 CDP 的 attach / Page.enable 收在一处，避免每个场景反复 attach。
 *
 * <p><b>为什么容器图必须走 CDP clip 而不是 `capturePage()`：</b>实测本机 offscreen 下
 * `webContents.capturePage()` 的返回高度被宿主显示器工作区高度夹在 <b>1032 px</b>
 * （请求 1100/1400/2100/3100 一律回 1032），且请求小尺寸（h=360）会抛 `UnknownVizError`。
 * `Page.captureScreenshot({clip})` 实测 6/6 成功（含 360），因此容器图走 clip。</p>
 *
 * <p><b>为什么 ROI 仍走 `capturePage()`（视口图）：</b>ROI 要沿用旧基线字节
 * （G-5 的硬指标之一：42 张 ROI 必须逐字节不变），而旧基线是从 `capturePage()` 的视口图裁出来的。
 * 两条路径对同一区域产出的 PNG 字节不同（已实测），所以 ROI 不能改用 clip 图作裁切源。</p>
 *
 * @param {object} win Electron BrowserWindow
 * @returns {{ensure: Function, send: Function, viewport: Function, clip: Function, detach: Function}} 截图器
 */
function createCapturer(win) {
  const dbg = win.webContents.debugger;
  let attached = false;
  let pageEnabled = false;
  const ensure = async () => {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      attached = true;
    }
    if (!pageEnabled) {
      await dbg.sendCommand('Page.enable');
      pageEnabled = true;
    }
  };
  return {
    ensure,
    /** 直通 sendCommand（hover 的 CSS.forcePseudoState / DOM.querySelector 也走这条通道）。 */
    send: async (method, params) => {
      await ensure();
      return dbg.sendCommand(method, params);
    },
    /** 视口截图（与旧基线同一原语）。 */
    viewport: async () => win.webContents.capturePage(),
    /**
     * 整页截图（`captureBeyondViewport: true`）：ROI 的唯一裁切源。
     *
     * <p><b>为什么 ROI 必须裁整页图而不是视口图：</b>`capturePage()`（视口图）在本机 offscreen 下
     * 恒为 800×1032，页面下方的内容根本不在图里；拿它当 ROI 裁切源，一旦目标落到 1032 以下
     * 就会裁出一张「越界后的空白/局部」，而比对仍然全绿 —— 这就是旧实现里
     * 「有场景没覆盖」的假绿成因。整页图没有这个上限，元素画在哪都在图里。</p>
     */
    fullPage: async () => {
      await ensure();
      const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
      const content = metrics.cssContentSize || metrics.contentSize;
      const result = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height), scale: 1 },
      });
      const { nativeImage } = require('electron');
      return nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
    },
    /**
     * 按 CSS 像素矩形截一张图（`scale:1`，输出尺寸 = 传入矩形取整后的 CSS 尺寸）。
     *
     * @param {{x: number, y: number, width: number, height: number}} rect 页面坐标
     * @returns {Promise<object>} nativeImage
     */
    clip: async (rect) => {
      await ensure();
      const width = Math.max(1, Math.ceil(rect.width));
      const height = Math.max(1, Math.ceil(rect.height));
      const result = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width, height, scale: 1 },
      });
      const { nativeImage } = require('electron');
      return nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
    },
    detach: () => {
      if (attached || dbg.isAttached()) {
        try { dbg.detach(); } catch { /* 已分离则忽略 */ }
      }
      attached = false;
      pageEnabled = false;
    },
  };
}

/**
 * 从一张图里裁出元素矩形（图片像素坐标），并 clamp 到图内。
 *
 * <p>越界 crop 会返回空白或抛错，是「ROI 图全是空白」这一类事故的根因，
 * 所以这里统一做二次 clamp；clamp 后宽高不足 1 px 时返回 null，由调用方决定是否跳过。</p>
 *
 * @param {object} image nativeImage 源图
 * @param {{x: number, y: number, width: number, height: number}} rect CSS 像素矩形（页面坐标）
 * @param {number} ratio 图片像素 / CSS 像素
 * @returns {{image: object, rect: {x: number, y: number, width: number, height: number}}|null} 裁切结果
 */
function cropImage(image, rect, ratio) {
  const size = image.getSize();
  const x = Math.max(0, Math.round(rect.x * ratio));
  const y = Math.max(0, Math.round(rect.y * ratio));
  const width = Math.min(Math.max(1, Math.round(rect.width * ratio)), size.width - x);
  const height = Math.min(Math.max(1, Math.round(rect.height * ratio)), size.height - y);
  if (width < 1 || height < 1) return null;
  return { image: image.crop({ x, y, width, height }), rect: { x, y, width, height } };
}

/**
 * 图片像素与 CSS 像素的换算比（整页图按 devicePixelRatio 缩放，crop 用的是图片像素）。
 *
 * @param {object} image nativeImage
 * @param {number} pageWidth 页面宽度（CSS 像素，通常 `documentElement.scrollWidth`）
 * @returns {number} 换算比（pageWidth 非法时回落 1）
 */
function imageRatio(image, pageWidth) {
  const width = image.getSize().width;
  return pageWidth > 0 ? width / pageWidth : 1;
}

module.exports = {
  FRONTEND_ROOT,
  REPO_ROOT,
  ARTIFACT_ROOT,
  INDEX_HTML,
  sceneDir,
  buildMiniApp,
  relFrom,
  openScene,
  readTokenValues,
  toCssRgb,
  PROBE_JS,
  assertThemeApplied,
  assertThemesDiffer,
  sceneImageName,
  roiImageName,
  hoverImageName,
  themeImagePath,
  createCapturer,
  cropImage,
  imageRatio,
};
