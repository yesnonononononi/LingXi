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

/** 打开 offscreen 窗口载入构建产物，等入口把 window.ready 置真。 */
async function openScene(workDir, { width = 780, height = 760 } = {}) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    width, height, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(workDir, 'dist', 'index.html'));
  const evaluate = (s) => win.webContents.executeJavaScript(s);
  for (let i = 0; i < 200; i++) {
    if (await evaluate('window.ready===true')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const ready = await evaluate('window.ready===true');
  if (!ready) {
    win.destroy();
    throw new Error(`场景入口未就绪：${path.join(workDir, 'dist/index.html')}`);
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
};
