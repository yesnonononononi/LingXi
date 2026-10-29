/**
 * 视觉基线截图：自己起 / 自己停 Vite dev server，按「4 界面 × 明暗两态」截图。
 *
 * <p>设计要点：</p>
 * <ul>
 *   <li><b>不假设有人在跑 dev server</b>：本脚本用 node 直接拉起 {@code node_modules/vite/bin/vite.js}
 *       （绕开 npm 包一层进程，退出时可整棵杀掉），端口从 5180 起自动找空闲端口，
 *       退出（正常/异常/SIGINT）都保证收尸。</li>
 *   <li><b>每个场景一个全新页面</b>：设置弹窗会记住上次打开的页签，复用页面会让场景互相污染
 *       （曾出现 settings-general 实际拍到「模型」页的假基线）。</li>
 *   <li><b>场景自校验</b>：截完立刻断言场景标志文案，避免「白拍了一张空白也当基线」。</li>
 *   <li><b>主题</b>：导航前写入 {@code localStorage['lingxi-theme']}（值 dark / light），
 *       index.html 的内联引导脚本会在首帧前把 {@code dark} / {@code light} 类写到 {@code <html>}。</li>
 * </ul>
 *
 * 用法：
 *   node scripts/visual/capture.mjs --mode baseline   # 写基线
 *   node scripts/visual/capture.mjs --mode check      # 截图 + 与基线比对（有差异退出码 1）
 *   node scripts/visual/capture.mjs --mode baseline --scenes settings-agents,chat --themes dark
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, findFreePort, waitForHttp } from './cdp.mjs';
import { compareDirectories, DEFAULT_OPTIONS } from './compare.mjs';
// G-4：基线完整性 oracle。check 之前先证「基线是完整的」，否则残缺基线会让 compare 只比
// 剩下那几张图 → failed=0 → 静默假绿。baseline 之后要把本节指纹同步写回，否则下一个人 check 立刻红。
import { verifyBaseline, formatVerifyFailure, writeBaselineSuite } from './baseline-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 前端根目录（scripts/visual → ../..）。 */
const FRONTEND_ROOT = path.resolve(HERE, '..', '..');
/** 仓库根目录：基线等本机产物固定在 <repo>/.lingxi/tmp/visual 下（.lingxi 已被 gitignore）。 */
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
const VISUAL_ROOT = path.join(REPO_ROOT, '.lingxi', 'tmp', 'visual');
const BASELINE_DIR = path.join(VISUAL_ROOT, 'baseline');
const CURRENT_DIR = path.join(VISUAL_ROOT, 'current');
const DIFF_DIR = path.join(VISUAL_ROOT, 'diff');
const LOG_DIR = VISUAL_ROOT;

/** 视口尺寸：固定值，宽度取 1440 以覆盖桌面端主要布局断点。 */
const VIEWPORT = { width: 1440, height: 900 };

/** 4 个目标界面。`marker` 是「场景真的到位了」的文本证据。 */
const SCENES = [
  {
    name: 'settings-modal',
    description: '设置弹窗整体（显式停在「通用设置」页签：源码默认页签是 models，必须显式点）',
    marker: '后端服务地址',
    open: async page => { await clickTab(page, '通用设置'); },
  },
  {
    name: 'settings-models',
    description: '设置 · 模型页签（ModelsTab；也是弹窗的默认页签）',
    marker: '添加提供方',
    open: async page => { await clickTab(page, '模型'); },
  },
  {
    name: 'settings-agents',
    description: '设置 · 智能体页签（AgentsTab）',
    marker: '已分配工具',
    open: async page => { await clickTab(page, '智能体'); },
  },
  {
    name: 'settings-compaction',
    description: '设置 · 压缩模型配置子页（模型 → 压缩模型配置；无后端时只到骨架与说明）',
    marker: '高级设置',
    open: async page => {
      await clickTab(page, '模型');
      await clickTab(page, '压缩模型配置');
    },
  },
];

/**
 * 读取 `--key value` 参数。
 *
 * @param {string[]} args 参数数组。
 * @param {string} key 键名。
 * @param {string} fallback 默认值。
 * @returns {string} 值。
 */
function argOf(args, key, fallback) {
  const index = args.indexOf(`--${key}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

/**
 * 点开设置弹窗（侧边栏底部那个只有图标、靠 title 定位的按钮）。
 *
 * @param {import('./cdp.mjs').PageSession} page 页面会话。
 */
async function openSettings(page) {
  const clicked = await page.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('button[title]'))
      .find(node => node.getAttribute('title') === '系统设置');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) throw new Error('未找到设置入口按钮（title="系统设置"）');
  await sleep(600);
}

/**
 * 按可见文案点击设置弹窗的页签。
 *
 * @param {import('./cdp.mjs').PageSession} page 页面会话。
 * @param {string} label 页签文案。
 */
async function clickTab(page, label) {
  const clicked = await page.evaluate(`(() => {
    const target = ${JSON.stringify(label)};
    const el = Array.from(document.querySelectorAll('button'))
      .find(node => (node.innerText || '').trim() === target);
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`未找到设置页签「${label}」`);
  await sleep(900);
}

/**
 * @param {number} ms 毫秒。
 * @returns {Promise<void>} 定时器。
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 等待应用渲染完成的超时（毫秒）。
 *
 * <p><b>为什么可配：</b>冷启动（首次 vite 预构建 + 浏览器缓存为空）偶发超过 30 s，此时门禁会
 * 抛「等待应用渲染超时」并按基础设施故障 exit 3 —— 但那台机器其实只是慢，重跑就绿。
 * 把超时做成环境变量，慢机器上 `set "LX_VISUAL_READY_TIMEOUT_MS=60000"` 即可，
 * <b>默认值不变（30 s）</b>，语义（超时 = exit 3 基础设施故障，不是视觉回归 exit 1）也不变。</p>
 *
 * @type {number}
 */
const READY_TIMEOUT_MS = (() => {
  const raw = process.env.LX_VISUAL_READY_TIMEOUT_MS;
  const value = raw ? Number(raw) : NaN;
  if (!raw) return 30000;
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[warn] LX_VISUAL_READY_TIMEOUT_MS 不是正数（${raw}），回落默认 30000ms`);
    return 30000;
  }
  return value;
})();

/**
 * 等应用真正渲染完（冷启动 + 首批接口失败都算稳定态，只要 #app 有足够内容）。
 *
 * <p>超时抛错时**必须带上现场**：`#app` 当前长度（0 = 根本没挂载，5000 附近 = 卡在渲染中）
 * 与控制台错误数（> 0 通常是源码/依赖炸了）。没有这两个数字，报错就只剩「超时」三个字，
 * 排查得从头复现一遍。</p>
 *
 * @param {import('./cdp.mjs').PageSession} page 页面会话。
 * @param {number} [timeoutMs] 超时毫秒。
 */
async function waitForReady(page, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(`(() => {
      const app = document.querySelector('#app');
      return !!app && app.innerHTML.length > 5000
        && !!document.querySelector('textarea, [contenteditable="true"], input');
    })()`);
    if (ready) return;
    await sleep(250);
  }
  let appLength = 'unknown';
  try {
    appLength = await page.evaluate('(document.querySelector("#app") || {}).innerHTML ? document.querySelector("#app").innerHTML.length : 0');
  } catch (e) {
    appLength = `读取失败：${e && e.message ? e.message : e}`;
  }
  const errors = page.consoleErrors || [];
  const detail = errors.slice(0, 3).map((item) => String(item).slice(0, 200)).join('\n  - ');
  throw new Error(`等待应用渲染超时（${timeoutMs}ms 内 #app 内容始终不足 5000 字符）`
    + `\n  #app 长度：${appLength}`
    + `\n  控制台错误数：${errors.length}${errors.length ? `\n  - ${detail}` : ''}`
    + `\n  提示：冷启动较慢的机器可设 LX_VISUAL_READY_TIMEOUT_MS（例如 60000）后重跑。`);
}

/**
 * 起一个 Vite dev server：自动挑空闲端口，返回句柄与 URL。
 *
 * @returns {Promise<{url: string, stop: () => void, port: number}>} 服务句柄。
 */
export async function startDevServer() {
  const port = await findFreePort(5180);
  const viteBin = path.join(FRONTEND_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) throw new Error(`未找到 vite：${viteBin}（先在 frontend 目录执行 npm install）`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'dev-server.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: FRONTEND_ROOT,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  const stop = () => {
    if (!child.pid) return;
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  };
  // 任何退出路径都收尸，绝不留后台进程占端口。
  process.once('exit', stop);
  process.once('SIGINT', () => { stop(); process.exit(130); });
  process.once('SIGTERM', () => { stop(); process.exit(143); });

  const url = `http://127.0.0.1:${port}/`;
  const ready = await waitForHttp(url, 45000);
  if (!ready) {
    stop();
    throw new Error(`dev server 未就绪（端口 ${port}），日志见 ${logFile}`);
  }
  return { url, port, stop };
}

/**
 * 执行一轮截图。
 *
 * @param {{outDir: string, url: string, themes: string[], scenes: typeof SCENES}} options 参数。
 * @returns {Promise<object>} 截图报告。
 */
async function runCapture(options) {
  const browser = await launchBrowser();
  const openPages = [];
  const report = { url: options.url, outDir: options.outDir, viewport: VIEWPORT, theme: {}, scenes: [] };
  try {
    for (const theme of options.themes) {
      for (const scene of options.scenes) {
        // 每个场景一个全新页面：避免页签/弹窗状态互相污染。
        const page = await browser.newPage();
        openPages.push(page);
        await page.prepare(VIEWPORT);
        await page.addInitScript(`try { localStorage.setItem('lingxi-theme', ${JSON.stringify(theme)}); } catch (e) {}`);
        // 对齐 prefers-color-scheme，使原生控件（滚动条/表单控件）与主题一致。
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await page.navigate(options.url);
        await waitForReady(page);
        await sleep(600);

        let status = 'ok';
        let markerHit = false;
        try {
          if (scene.name.startsWith('settings-')) await openSettings(page);
          await scene.open(page);
          markerHit = scene.verify
            ? await scene.verify(page)
            : await page.evaluate(`(() => {
              const dialog = document.querySelector('[role="dialog"], .fixed.inset-0');
              const text = dialog ? dialog.innerText : document.body.innerText;
              return text.includes(${JSON.stringify(scene.marker)});
            })()`);
          if (!markerHit) status = 'scene-not-verified';
        } catch (error) {
          status = `prep-failed: ${error.message}`;
        }

        const themeState = await page.evaluate(`(() => ({
          htmlClass: document.documentElement.className,
          dataTheme: document.documentElement.dataset.theme || '',
          bodyBg: getComputedStyle(document.body).backgroundColor,
        }))()`);
        report.theme[theme] = themeState;

        const file = path.join(options.outDir, theme, `${scene.name}.png`);
        await page.screenshot(file);
        report.scenes.push({
          theme, scene: scene.name, file, status, markerHit,
          htmlClass: themeState.htmlClass,
          consoleErrors: page.consoleErrors.slice(0, 5),
          appHtmlLength: await page.evaluate('document.querySelector("#app").innerHTML.length'),
        });
        page.close();
      }
    }
  } finally {
    for (const page of openPages) page.close();
    browser.close();
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------
/**
 * 是否作为命令行脚本直接运行（被 import 时只暴露 startDevServer / SCENES，不执行截图）。
 */
const isCli = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('visual', 'capture.mjs'));

if (isCli) {
  const args = process.argv.slice(2);
  const mode = argOf(args, 'mode', 'baseline');
  if (!['baseline', 'check'].includes(mode)) {
    console.error(`--mode 只支持 baseline / check，收到 ${mode}`);
    process.exit(2);
  }
  const outDir = path.resolve(argOf(args, 'out', mode === 'baseline' ? BASELINE_DIR : CURRENT_DIR));
  const themes = argOf(args, 'themes', 'dark,light').split(',').map(item => item.trim()).filter(Boolean);
  const sceneFilter = argOf(args, 'scenes', '');
  const scenes = sceneFilter
    ? SCENES.filter(scene => sceneFilter.split(',').map(name => name.trim()).includes(scene.name))
    : SCENES;
  if (scenes.length === 0) {
    console.error(`--scenes 未匹配到任何场景；可用：${SCENES.map(scene => scene.name).join(', ')}`);
    process.exit(2);
  }

  let server = null;
  const summary = { mode, outDir, themes, scenes: scenes.map(scene => scene.name) };
  try {
    server = await startDevServer();
    summary.devServer = { url: server.url, port: server.port };
    const report = await runCapture({ outDir, url: server.url, themes, scenes });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'capture-report.json'), JSON.stringify(report, null, 2));
    summary.capture = {
      theme: report.theme,
      scenes: report.scenes.map(item => ({
        theme: item.theme, scene: item.scene, status: item.status,
        bytes: fs.existsSync(item.file) ? fs.statSync(item.file).size : 0,
        consoleErrors: item.consoleErrors.length,
      })),
    };
    const unverified = report.scenes.filter(item => item.status !== 'ok');
    if (unverified.length > 0) {
      summary.warnings = unverified.map(item => `${item.theme}/${item.scene}: ${item.status}`);
    }

    if (mode === 'baseline') {
      /**
       * 重建基线后同步 oracle 指纹。
       *
       * <p>只在「全量」时写：带 `--scenes` / `--themes` 过滤（或 `--out` 指到别处）时，目录里
       * 只是**子集**，把它当成整节写回会把 manifest 削成残缺 —— 下一个人跑全量 check 立刻假红，
       * 而真正的整节指纹已经丢了。所以宁可 skip 并出声。</p>
       */
      const fullThemes = themes.length === 2 && themes.includes('dark') && themes.includes('light');
      const isFullBaseline = sceneFilter === '' && scenes.length === SCENES.length && fullThemes
        && path.resolve(outDir) === path.resolve(BASELINE_DIR);
      if (isFullBaseline) {
        const written = writeBaselineSuite({ suite: 'settings', baselineDir: BASELINE_DIR });
        summary.baselineManifest = written;
        console.error(`[baseline] 已同步视觉基线 oracle：suite=settings ${written.count} 张，counts=${JSON.stringify(written.counts)}`);
      } else {
        summary.baselineManifest = { skipped: true, reason: '部分采集（--scenes/--themes/--out 过滤）不重写整节指纹' };
        console.error('[baseline] 警告：本次是部分采集（--scenes/--themes/--out 过滤），已跳过视觉基线 oracle 重写；'
          + '否则会把整节指纹削成残缺。需要同步指纹请跑一次全量 npm run visual:baseline。');
      }
    }

    if (mode === 'check') {
      if (!fs.existsSync(BASELINE_DIR)) {
        console.error(`基线目录不存在：${BASELINE_DIR}\n请先执行 npm run visual:baseline`);
        summary.exitCode = 2;
        // 不直接 process.exit：那样会跳过 finally 里的 server.stop()，留下一个孤儿 vite 进程。
        throw new Error(`基线目录不存在：${BASELINE_DIR}`);
      }
      // G-4：先验基线完整性再比对。残缺基线（少几张图）会让 compare 只比剩下那几张、
      // failed=0 → 静默假绿。凡不完整一律 exit 2（基础设施故障），与「基线不存在」同一口径。
      const integrity = verifyBaseline({ suite: 'settings', baselineDir: BASELINE_DIR });
      summary.integrity = { ok: integrity.ok, expected: integrity.expected, actual: integrity.actual };
      if (!integrity.ok) {
        console.error(formatVerifyFailure(integrity));
        summary.exitCode = 2;
        throw new Error('视觉基线完整性校验失败（suite=settings）');
      }
      const compare = compareDirectories({ baselineDir: BASELINE_DIR, currentDir: outDir, diffDir: DIFF_DIR, options: DEFAULT_OPTIONS });
      fs.writeFileSync(path.join(VISUAL_ROOT, 'compare-report.json'), JSON.stringify({ ...compare, options: DEFAULT_OPTIONS }, null, 2));
      // 与 component-scenes / hover-states 同一口径写出 diff-manifest.json：expect-inventory 的
      // collectDiffImages 靠扫该文件汇总「本轮真的变了」的失败图。capture.mjs（settings 三页签）
      // 此前不写，导致 settings 的失败图进不了清单（清单 27 vs 实际 30）。字段名与另两个 writer 完全一致，
      // 让 collectDiffImages 无需改逻辑即可汇总。diff 目录「有文件」≠「有变化」，只有 status!=='pass' 才是真变化。
      const captureFailures = compare.details.filter((d) => d.status !== 'pass');
      fs.writeFileSync(path.join(VISUAL_ROOT, 'diff-manifest.json'), `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        source: 'visual:check (capture.mjs)',
        imagesCompared: compare.images,
        failedCount: compare.failed,
        failures: captureFailures.map((d) => ({
          image: String(d.image).split(path.sep).join('/'),
          status: String(d.status),
          changedPixels: d.changedPixels,
          changedRatio: d.changedRatio,
          reasons: Array.isArray(d.reasons) ? d.reasons : [],
        })),
      }, null, 2)}\n`);
      summary.compare = { images: compare.images, failed: compare.failed, details: compare.details, failures: compare.failures };
    }
  } catch (error) {
    if (summary.exitCode) {
      // 已在上面显式判定过退出码（基线不存在 / 完整性失败 → 2）：详情已打印，保留该码，不降级成 3。
      summary.error = error && error.message ? error.message : String(error);
    } else {
      summary.error = error && error.stack ? error.stack : String(error);
      summary.exitCode = 3;
    }
  } finally {
    if (server) server.stop();
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.exitCode) process.exit(summary.exitCode);
  if (summary.compare && summary.compare.failed > 0) process.exit(1);
  process.exit(0);
}
