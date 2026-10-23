/**
 * 组件级视觉验证：真实组件 + 生产样式 + Electron offscreen 渲染，
 * 为「设置页之外」的被改组件（CardHeader / RequireChoiceCard / DropUpSelect）建立
 * 明暗两态的可比对基线，并在截图前断言目标元素存在/可见/状态正确 + 记录 computed style。
 *
 * 设计要点：
 *  - 沿用 tests/choiceQuestionGroup.smoke.cjs 的 bootstrap（vite build 迷你 App + Electron offscreen）；
 *  - 只挂三个目标组件，确定性数据，避免整应用路由/会话状态依赖；
 *  - 每个主题：先断言再截图，避免「白拍一张空图当基线」；
 *  - 记录目标元素 computed style，作为面积无关的强信号（小面积文字色变化不会被整图阈值放过）；
 *  - --selfcheck：对标题注入一个非法色，证明「比对确实会红」（防验证本身是瞎子）。
 *
 * 用法（在 frontend 目录）：
 *   node scripts/visual/component-scenes.cjs --mode baseline
 *   node scripts/visual/component-scenes.cjs --mode check
 *   node scripts/visual/component-scenes.cjs --selfcheck
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
const COMP_ROOT = path.join(REPO_ROOT, '.lingxi', 'tmp', 'visual', 'components');
const BASE_DIR = path.join(COMP_ROOT, 'baseline');
const CUR_DIR = path.join(COMP_ROOT, 'current');
const DIFF_DIR = path.join(COMP_ROOT, 'diff');
const WORK = path.join(FRONTEND_ROOT, 'node_modules', '.tmp', 'component-scenes');

const argv = process.argv.slice(2);
const argOf = (key, fb) => { const i = argv.indexOf(`--${key}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fb; };
const MODE = argOf('mode', 'baseline'); // baseline | check
const SELFCHECK = argv.includes('--selfcheck');

/** 三个目标场景的 computed-style 采集选择器（函数体在渲染器里执行）。 */
const TARGETS = [
  { key: 'cardHeaderTitle', desc: 'CardHeader 标题文字（折 text-lx-primary-soft 目标）',
    sel: `document.querySelector('[data-scene="card-header"] span[title]')` },
  { key: 'choiceCustomInput', desc: 'RequireChoiceCard 自定义输入框（折 text-lx-primary-soft 目标）',
    sel: `document.querySelector('[data-scene="choice"] input[type="text"]')` },
  { key: 'dropdownMenuTitle', desc: 'DropUpSelect 展开后菜单标题（折 text-faint 目标）',
    sel: `(()=>{const p=document.querySelector('[role="listbox"]');if(!p)return null;return [...p.querySelectorAll('div')].find(el=>el.textContent.trim()==='下拉菜单标题')||null;})()` },
];

const STYLE_PROPS = ['color', 'backgroundColor', 'borderTopColor', 'outlineColor', 'textShadow', 'opacity', 'fontSize', 'fontWeight'];

const APP_VUE = `<script setup>
import {ref} from 'vue';
import CardHeader from '${path.relative(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/CardHeader.vue')).split(String.fromCharCode(92)).join('/')}';
import RequireChoiceCard from '${path.relative(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/RequireChoiceCard.vue')).split(String.fromCharCode(92)).join('/')}';
import DropUpSelect from '${path.relative(WORK, path.join(FRONTEND_ROOT, 'src/components/common/DropUpSelect.vue')).split(String.fromCharCode(92)).join('/')}';
import '${path.relative(WORK, path.join(FRONTEND_ROOT, 'src/style.css')).split(String.fromCharCode(92)).join('/')}';
const dark=ref(false);
const choiceCard={kind:'CHOICE',toolCallId:'choice-0',conversationId:'42',title:'选择交付方式？',content:'选择交付方式？',options:['源码','安装包','Docker 镜像'],status:'pending',pending:true,version:'2',allowedActions:['ANSWER']};
const sel=ref('a');
const opts=[{value:'a',label:'选项一'},{value:'b',label:'选项二'},{value:'c',label:'选项三'}];
window.setDark=value=>{dark.value=value;const el=document.documentElement;el.classList.toggle('dark',value);el.classList.toggle('light',!value);el.setAttribute('data-theme',value?'dark':'light');document.body.style.background=value?'#18181b':'#ffffff';};
window.openDropdown=()=>{const trigger=document.querySelector('[data-scene="dropdown"] button');if(trigger&&trigger.getAttribute('aria-expanded')!=='true')trigger.click();};
window.showCustomInput=()=>{};
window.focusCustomInput=()=>{const input=document.querySelector('[data-scene="choice"] input[type="text"]');if(input)input.focus();};
</script>
<template>
  <main style="width:720px;margin:0 auto;padding:20px;font-family:system-ui,sans-serif" :class="dark?'text-gray-100':'text-gray-900'">
    <section data-scene="card-header" style="padding:10px 8px">
      <CardHeader tone="pending" type-label="计划" title="卡片标题可见性探针" :is-dark="dark" />
    </section>
    <section data-scene="choice" style="padding:10px 8px">
      <RequireChoiceCard :prompt-card="choiceCard" :is-dark="dark" />
    </section>
    <section data-scene="dropdown" style="padding:10px 8px;min-height:260px">
      <DropUpSelect v-model="sel" :options="opts" :is-dark="dark" menu-title="下拉菜单标题" />
    </section>
  </main>
</template>`;

const ENTRY_JS = `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');
window.flush=async()=>{await nextTick();await new Promise(r=>setTimeout(r,120));};
const {default:App}=await import('./App.vue');
createApp(App).mount('#app');
window.ready=true;`;

async function buildApp() {
  await fsp.mkdir(WORK, { recursive: true });
  await fsp.writeFile(path.join(WORK, 'App.vue'), APP_VUE);
  await fsp.writeFile(path.join(WORK, 'entry.js'), ENTRY_JS);
  await fsp.writeFile(path.join(WORK, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: WORK, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(WORK, 'dist'), emptyOutDir: true } });
}

/** 在渲染器里读取某选择器目标的 computed style 与可见性。 */
function readStylesExpr() {
  return `(() => {
    const props = ${JSON.stringify(STYLE_PROPS)};
    const out = {};
    const defs = ${JSON.stringify(TARGETS.map(t => ({ key: t.key, sel: t.sel })))};
    for (const d of defs) {
      const el = eval(d.sel);
      if (!el) { out[d.key] = { found: false }; continue; }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const style = {};
      for (const p of props) style[p] = cs[p];
      out[d.key] = { found: true, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', rect: [Math.round(r.width), Math.round(r.height)], text: (el.textContent || '').trim().slice(0, 40), style };
    }
    return out;
  })()`;
}

async function captureTheme(win, theme, outDir, mutate) {
  const evaluate = s => win.webContents.executeJavaScript(s);
  await evaluate(`window.setDark(${theme === 'dark'})`);
  await evaluate('window.flush()');
  // 先开下拉（点按钮会 blur），再聚焦自定义输入框，最后统一等待过渡完成。
  await evaluate('window.openDropdown()');
  await evaluate('window.flush()');
  await new Promise(r => setTimeout(r, 400));
  await evaluate('window.focusCustomInput()');
  await evaluate('window.flush()');
  await new Promise(r => setTimeout(r, 120));

  if (mutate) {
    // 只改「标题」颜色，制造一个极小面积差异，验证比对/样式采集不会漏。
    await evaluate(`(() => { const el = document.querySelector('[data-scene="card-header"] span[title]'); if (el) el.style.setProperty('color', 'rgb(255, 0, 255)', 'important'); })()`);
    await evaluate('window.flush()');
  }

  const styles = await evaluate(readStylesExpr());
  // 断言：目标都在、都可见、输入框确实获得焦点、下拉菜单标题已展开。
  const problems = [];
  for (const t of TARGETS) {
    const s = styles[t.key];
    if (!s || !s.found) problems.push(`${t.key}: 目标不存在（${t.desc}）`);
    else if (!s.visible) problems.push(`${t.key}: 目标不可见`);
  }
  const inputFocused = await evaluate(`document.activeElement === document.querySelector('[data-scene="choice"] input[type="text"]')`);
  if (!inputFocused) problems.push('choiceCustomInput: 未获得焦点');
  if (problems.length) throw new Error(`[${theme}] 场景断言失败：\n  - ${problems.join('\n  - ')}`);

  await fsp.mkdir(outDir, { recursive: true });
  const png = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, `${theme}.png`), png.toPNG());
  return styles;
}

async function runCapture(outDir, mutate = false) {
  const win = new BrowserWindow({ width: 780, height: 760, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(WORK, 'dist/index.html'));
  const evaluate = s => win.webContents.executeJavaScript(s);
  for (let i = 0; i < 200; i++) { if (await evaluate('window.ready===true')) break; await new Promise(r => setTimeout(r, 50)); }
  const styles = {};
  try {
    for (const theme of ['light', 'dark']) {
      styles[theme] = await captureTheme(win, theme, outDir, mutate);
    }
  } finally {
    win.destroy();
  }
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, 'styles.json'), JSON.stringify(styles, null, 2));
  return styles;
}

/** 样式等价比对：每个目标每个属性的 computed style 必须逐字相等。 */
function diffStyles(a, b) {
  const diffs = [];
  for (const theme of Object.keys(a)) {
    for (const key of Object.keys(a[theme] || {})) {
      const sa = a[theme][key], sb = (b[theme] || {})[key];
      if (!sb) { diffs.push(`${theme}/${key}: 新采集缺失`); continue; }
      if (sa.found !== sb.found) { diffs.push(`${theme}/${key}: found ${sa.found}->${sb.found}`); continue; }
      if (!sa.found) continue;
      for (const p of STYLE_PROPS) {
        if (sa.style[p] !== sb.style[p]) diffs.push(`${theme}/${key}.${p}: ${sa.style[p]} -> ${sb.style[p]}`);
      }
    }
  }
  return diffs;
}

async function main() {
  await buildApp();

  if (SELFCHECK) {
    const tmpA = path.join(COMP_ROOT, '_selfcheck');
    const stylesA = await runCapture(path.join(tmpA, 'before'), false);
    const stylesB = await runCapture(path.join(tmpA, 'after'), true);
    const styleDiffs = diffStyles(stylesA, stylesB);
    const { compareImagePair, decodePng } = await import('./compare.mjs');
    const fsx = require('node:fs');
    const imgA = decodePng(fsx.readFileSync(path.join(tmpA, 'before', 'light.png')));
    const imgB = decodePng(fsx.readFileSync(path.join(tmpA, 'after', 'light.png')));
    const cmp = compareImagePair(imgA, imgB);
    const detected = styleDiffs.length > 0 || cmp.failed === true;
    console.log(JSON.stringify({ selfcheck: detected ? 'PASS' : 'BLIND', styleDiffs, pixelFailed: cmp.failed, changedPixels: cmp.changedPixels, maxChannelDelta: cmp.maxChannelDelta, strongPixels: cmp.strongPixels }, null, 2));
    app.exit(detected ? 0 : 1);
    return;
  }

  if (MODE === 'baseline') {
    const styles = await runCapture(BASE_DIR, false);
    console.log(JSON.stringify({ mode: 'baseline', outDir: BASE_DIR, styles }, null, 2));
    app.exit(0);
    return;
  }

  // check：先采当前，再与基线做像素 + 样式双比对。
  const styles = await runCapture(CUR_DIR, false);
  const baseStylesPath = path.join(BASE_DIR, 'styles.json');
  if (!fs.existsSync(baseStylesPath)) { console.error(`基线不存在：${baseStylesPath}（先跑 --mode baseline）`); app.exit(2); return; }
  const baseStyles = JSON.parse(fs.readFileSync(baseStylesPath, 'utf8'));
  const styleDiffs = diffStyles(baseStyles, styles);

  const { compareDirectories, DEFAULT_OPTIONS } = await import('./compare.mjs');
  // 组件场景图很小，收紧阈值，避免小面积文字色变化被整图比例吞掉。
  const options = { ...DEFAULT_OPTIONS, threshold: 0.0002, strongPixels: 12 };
  const px = compareDirectories({ baselineDir: BASE_DIR, currentDir: CUR_DIR, diffDir: DIFF_DIR, options });
  const failed = styleDiffs.length > 0 || px.failed > 0;
  console.log(JSON.stringify({ mode: 'check', styleDiffs, pixel: { images: px.images, failed: px.failed, details: px.details, failures: px.failures } }, null, 2));
  app.exit(failed ? 1 : 0);
}

app.setPath('userData', path.join(WORK, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('组件视觉验证超时'); app.exit(1); }, 180000);
app.whenReady().then(async () => {
  try { await main(); } catch (e) { console.error(e && e.stack ? e.stack : e); app.exit(1); } finally { clearTimeout(deadline); }
}).catch(e => { console.error(e); app.exit(1); });
