#!/usr/bin/env node
/**
 * 产物级守卫：**安装包里不许有桌宠入口**（用户硬约束 #3）。
 *
 * <p><b>为什么光有运行时门禁不够：</b>`electron/pet-feature-gate.cjs` 保证"打包态不建桌宠窗口"，
 * 但它挡不住"产物里躺着一个能打开的 `pet.html`"。历史现状正是如此：
 * `vite.config.ts` 的 `build.rollupOptions.input` 里就有 `pet`，`package.json` 的 `build.files`
 * 又含 `dist/**\/*` ⇒ 装好的 LX 里 `dist/pet.html` 是一直存在的。谁哪天在 `main.cjs` 里
 * 手滑 `loadURL('pet.html')`，安装版就会冒出桌宠。所以这里对<b>产物与构建配置</b>做静态断言。</p>
 *
 * <p><b>四条判据（每条都必须能单独变红）：</b></p>
 * <ol>
 *   <li>`frontend/vite.config.ts` 的 `build.rollupOptions.input` 里<b>没有</b> `pet` 键，
 *       也没有任何 `*.html` 入口的文件名等于 `pet.html`（防止换个键名绕过去）；</li>
 *   <li>`frontend/package.json` 的 `build.files` 里<b>没有</b>桌宠数据/入口
 *       （`pet-geometry.json` / `pet-*.json` / `pet.html`）；</li>
 *   <li>`frontend/dist/pet.html` <b>不存在</b>；</li>
 *   <li>`frontend/dist` 下任何文本产物都<b>不含</b>桌宠指纹（`<div id="pet-root"` /
 *       `<meta name="lx-app" content="pet"`）。</li>
 *   <li>`public/live2d/pet-poses` 与 `dist/live2d/pet-poses` 里<b>没有 PNG</b>（母版只许留在
 *       `docs/assets/desktop-pet/`）；</li>
 *   <li>上述两处 pose 运行资产<b>合计 ≤ 8 MiB</b>（裁决 D-02：pose 资产留在包里，改设总量上限）。</li>
 * </ol>
 *
 * <p><b>dist 不存在时不算失败</b>（干净的开发树很正常），但会打印一条"请先跑 npm run build"的
 * 说明——"没检查"和"检查通过"必须是两句不同的话，否则这个守卫会退化成安慰剂。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/check-pet-not-shipped.mjs             # 静态判据 + dist 判据
 *   node scripts/check-pet-not-shipped.mjs --verbose    # 打印每条判据的实测值
 *   node scripts/check-pet-not-shipped.mjs --selftest    # 用内置坏样本自证扫描器能抓到硬编码
 * </pre>
 *
 * @module scripts/check-pet-not-shipped
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FRONTEND_ROOT, readJsonFile } from './build-pet-geometry.mjs';

/** 桌宠入口页文件名（与 `electron/pet-dev-endpoint.cjs` 的 `entryPage` 同值；此处不 import 以免耦合 dev 侧）。 */
export const PET_ENTRY_FILE = 'pet.html';

/** 产物里绝对不该出现的桌宠指纹（与 `pet.html` 的 `lx-app` meta / `#pet-root` 一一对应）。 */
export const PET_ARTIFACT_MARKERS = Object.freeze(['<div id="pet-root"', '<meta name="lx-app" content="pet"']);

/** `build.files` 里不允许出现的桌宠数据（安装版不展示桌宠，这些文件只服务桌宠）。 */
export const FORBIDDEN_BUILD_FILES = Object.freeze([
  'pet-geometry.json',
  'pet-assets.json',
  'pet-layers.json',
  'pet-face-tiles.json',
  'pet-motions.json',
  // pose 运行时清单（M2）：与其它桌宠清单同级对待，进包就等于给安装版留了桌宠数据
  'pet-poses.json',
  PET_ENTRY_FILE,
]);

/**
 * pose 运行资产的体积预算（裁决 D-02，8 MiB）。
 *
 * <p>D-02 否决了"把 pose 资产排除出安装包"的方案，改为<b>留在包里但设总量上限</b>：
 * 资产留在包里才能保证开发态与打包态走同一条 `lxa://` 路径；设上限是为了让"美术顺手塞
 * 一堆 @4x 母版"这种事故在门禁阶段就红，而不是等安装包膨胀到用户投诉。</p>
 */
export const POSE_RUNTIME_MAX_BYTES = 8 * 1024 * 1024;

/** pose 运行资产目录（相对 `frontend/`）：开发态 `public/live2d/pet-poses`，打包后 `dist/live2d/pet-poses`。 */
export const POSE_RUNTIME_DIR_SEGMENTS = Object.freeze(['live2d', 'pet-poses']);

/** 参与指纹扫描的文本产物扩展名（图片等二进制一律不读）。 */
export const SCANNED_SUFFIXES = Object.freeze(['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.svg']);

/** 单文件扫描上限（超过就当二进制跳过，避免把几百兆的 map 读进内存）。 */
export const MAX_SCANNED_BYTES = 12 * 1024 * 1024;

/**
 * 去掉源码里的注释（**保留字符串字面量**，行号不变）。
 *
 * <p>口径与 `tests/petDevEndpoint.test.cjs` 的 `stripComments` 一致：注释里提到 `pet`
 * 是说明（本文件头就写着 `pet.html`），代码里的字符串字面量才是硬编码。</p>
 *
 * @param {string} source 源码文本
 * @returns {string} 去掉注释后的文本
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  /** 当前所在的字符串引号；空串表示不在字符串里。 */
  let quote = '';
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '\n' && (quote === '"' || quote === "'")) quote = '';
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next === undefined ? '' : next;
        index += 2;
        continue;
      }
      if (ch === quote) quote = '';
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 解析 `vite.config.ts` 的 `build.rollupOptions.input`。
 *
 * <p>不 import 那个文件（它引 `vite` / `@vitejs/plugin-vue`，纯 node 跑不动），
 * 而是在去掉注释的文本里截出 `rollupOptions: { … }` 这一段再抓键名与 `*.html` 引用。
 * 只截这一段是关键：`server`、`proxy` 等段落里出现 `pet` 不算违规。</p>
 *
 * @param {string} source `vite.config.ts` 源码
 * @returns {{keys: string[], htmlFiles: string[], block: string}} 入口键名、引用的 html 文件名、截出的文本
 */
export function parseViteInput(source) {
  const code = stripComments(String(source ?? ''));
  const start = code.indexOf('rollupOptions');
  if (start < 0) return { keys: [], htmlFiles: [], block: '' };
  // 从 rollupOptions 起截到 `input: { ... }` 的右花括号（input 块里不会嵌套对象字面量之外的括号，
  // 用了嵌套也只影响截断位置，不影响"是否含 pet"这个判断——所以这里按第一个 `}` 收口即可）
  const inputIndex = code.indexOf('input', start);
  if (inputIndex < 0) return { keys: [], htmlFiles: [], block: code.slice(start) };
  const braceStart = code.indexOf('{', inputIndex);
  const braceEnd = code.indexOf('}', braceStart);
  const block = braceStart >= 0 && braceEnd > braceStart ? code.slice(braceStart, braceEnd + 1) : '';
  const keys = [];
  const keyPattern = /([A-Za-z_$][\w$]*)\s*:/g;
  let match = keyPattern.exec(block);
  while (match) {
    keys.push(match[1]);
    match = keyPattern.exec(block);
  }
  const htmlFiles = [];
  const htmlPattern = /['"`]([^'"`]*?\.html)['"`]/g;
  let htmlMatch = htmlPattern.exec(block);
  while (htmlMatch) {
    htmlFiles.push(htmlMatch[1].replace(/\\/g, '/'));
    htmlMatch = htmlPattern.exec(block);
  }
  return { keys, htmlFiles, block };
}

/**
 * 递归读取 dist 下的文本产物（按扩展名过滤，二进制跳过）。
 *
 * @param {string} distDir dist 目录
 * @returns {Array<{path: string, text: string, bytes: number}>} 文本文件清单
 */
export function readDistTexts(distDir) {
  const collected = [];
  if (!existsSync(distDir)) return collected;
  /** 深度优先遍历。 */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCANNED_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) continue;
      const info = statSync(absolute);
      if (info.size > MAX_SCANNED_BYTES) continue;
      collected.push({ path: absolute, text: readFileSync(absolute, 'utf8'), bytes: info.size });
    }
  };
  walk(distDir);
  return collected;
}

/**
 * 统计 pose 运行目录的体积与非法文件（D-02）。
 *
 * <p>只看文件系统事实，不读清单：清单可以被人为写小，磁盘上的字节不会说谎。
 * 目录不存在时返回 `exists: false`（切片 1 之前或干净检出都正常）。</p>
 *
 * @param {string} poseDir pose 运行目录绝对路径
 * @returns {{exists: boolean, bytes: number, files: number, webpFiles: number, pngFiles: string[], otherFiles: string[]}}
 *   统计结果
 */
export function scanPoseRuntimeDir(poseDir) {
  const result = {
    exists: false,
    bytes: 0,
    files: 0,
    webpFiles: 0,
    pngFiles: [],
    otherFiles: [],
  };
  if (!existsSync(poseDir)) return result;
  result.exists = true;
  /** 深度优先遍历。 */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      result.files += 1;
      result.bytes += statSync(absolute).size;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.webp')) {
        result.webpFiles += 1;
      } else if (lower.endsWith('.png')) {
        // 母版绝不能出现在运行目录：png 母版动辄 1.6 MB，且会让"@2x 就该是 2 倍宽"的口径失效
        result.pngFiles.push(absolute);
      } else {
        result.otherFiles.push(absolute);
      }
    }
  };
  walk(poseDir);
  return result;
}

/**
 * 执行全部产物级判据。
 *
 * @param {object} [options] 选项（测试可注入假路径）
 * @param {string} [options.frontendRoot] 前端根
 * @param {string} [options.distDir] dist 目录
 * @param {string} [options.viteConfigPath] vite 配置路径
 * @param {string} [options.packageJsonPath] package.json 路径
 * @param {boolean} [options.verbose] 打印每条判据的实测值
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {{ok: boolean, problems: string[], notes: string[], checks: Array<{id: string, ok: boolean, detail: string}>}}
 *   校验结果
 */
export function runNotShippedChecks(options = {}) {
  const root = options.frontendRoot ?? FRONTEND_ROOT;
  const distDir = options.distDir ?? resolve(root, 'dist');
  const viteConfigPath = options.viteConfigPath ?? resolve(root, 'vite.config.ts');
  const packageJsonPath = options.packageJsonPath ?? resolve(root, 'package.json');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const problems = [];
  const notes = [];
  const checks = [];

  const record = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    if (!ok) problems.push(`${id}：${detail}`);
    if (verbose) log(`[not-shipped] ${ok ? 'OK  ' : 'FAIL'} ${id} — ${detail}`);
  };

  // 判据 1：生产构建入口里没有 pet
  if (!existsSync(viteConfigPath)) {
    record('vite-input', false, `找不到 ${viteConfigPath}（守卫无法证明入口已移除）`);
  } else {
    const parsed = parseViteInput(readFileSync(viteConfigPath, 'utf8'));
    const hasPetKey = parsed.keys.includes('pet');
    const hasPetHtml = parsed.htmlFiles.some((file) => basename(file).toLowerCase() === PET_ENTRY_FILE);
    // 反向对照：连 main/notification 都解析不出来，说明解析口径已经失效（空转的守卫 = 没有守卫）
    const parsedEnough = parsed.keys.includes('main') && parsed.keys.includes('notification');
    if (!parsedEnough) {
      record(
        'vite-input',
        false,
        `解析 rollupOptions.input 失败（键=${parsed.keys.join(',') || '空'}），守卫无法生效，请同步本脚本`,
      );
    } else if (hasPetKey || hasPetHtml) {
      record(
        'vite-input',
        false,
        `生产构建入口里仍有桌宠入口（键 pet=${hasPetKey}，pet.html 引用=${hasPetHtml}）：` +
          `dist/${PET_ENTRY_FILE} 会被打进安装包，必须从 build.rollupOptions.input 移除`,
      );
    } else {
      record('vite-input', true, `rollupOptions.input 只有主应用入口（${parsed.keys.join(', ')}）`);
    }
  }

  // 判据 2：build.files 里没有桌宠数据
  if (!existsSync(packageJsonPath)) {
    record('build-files', false, `找不到 ${packageJsonPath}`);
  } else {
    let pkg = null;
    try {
      pkg = readJsonFile(packageJsonPath);
    } catch (err) {
      record('build-files', false, `package.json 不可读: ${(err && err.message) || err}`);
    }
    if (pkg) {
      const files = Array.isArray(pkg.build?.files) ? pkg.build.files.map((item) => String(item)) : [];
      const offending = files.filter(
        (item) => FORBIDDEN_BUILD_FILES.includes(item) || /^pet-.*\.json$/.test(item) || item === PET_ENTRY_FILE,
      );
      const hasDist = files.some((item) => item.startsWith('dist/'));
      if (!hasDist) {
        record('build-files', false, `build.files 里没有 dist 产物（解析口径可能已变，守卫无法生效）：${files.join(', ')}`);
      } else if (offending.length > 0) {
        record(
          'build-files',
          false,
          `build.files 里仍有桌宠数据：${offending.join(', ')}（安装版不展示桌宠，这些文件不该进包）`,
        );
      } else {
        record('build-files', true, `build.files 无桌宠数据（${files.join(', ')}）`);
      }
    }
  }

  // 判据 3 / 4：产物里没有入口页与指纹
  if (!existsSync(distDir)) {
    notes.push(`dist 不存在，已跳过产物级校验（请先跑 npm run build）: ${distDir}`);
    log(`[not-shipped] 注意：${notes[notes.length - 1]}`);
  } else {
    const entryPath = resolve(distDir, PET_ENTRY_FILE);
    if (existsSync(entryPath)) {
      record('dist-entry', false, `产物里存在桌宠入口 ${entryPath}（安装版会出现桌宠入口，必须从构建入口移除）`);
    } else {
      record('dist-entry', true, `dist 里没有 ${PET_ENTRY_FILE}`);
    }
    const texts = readDistTexts(distDir);
    const hits = [];
    for (const file of texts) {
      for (const marker of PET_ARTIFACT_MARKERS) {
        if (file.text.includes(marker)) hits.push(`${file.path} 含 ${marker}`);
      }
    }
    if (hits.length > 0) {
      record('dist-markers', false, `产物里发现桌宠指纹：${hits.join('; ')}`);
    } else {
      record('dist-markers', true, `扫描 ${texts.length} 个文本产物，无桌宠指纹`);
    }
  }

  // 判据 5 / 6：pose 运行资产（D-02 替代方案：留在包里，但禁 PNG 且总量 ≤ 8 MiB）
  // 清单存在 ⇒ 运行资产"应该有"，目录缺失就必须说出来；清单不存在（切片 1 之前 / 干净样本）⇒ 静默跳过。
  const poseManifestPath = resolve(root, 'pet-poses.json');
  const poseAssetsClaimed = existsSync(poseManifestPath);
  const poseDirs = [
    { id: 'public', dir: resolve(root, 'public', ...POSE_RUNTIME_DIR_SEGMENTS) },
    { id: 'dist', dir: resolve(distDir, ...POSE_RUNTIME_DIR_SEGMENTS) },
  ];
  let poseChecked = 0;
  for (const { id, dir } of poseDirs) {
    const stats = scanPoseRuntimeDir(dir);
    if (!stats.exists) {
      if (poseAssetsClaimed) notes.push(`pose 运行目录不存在，已跳过该项：${dir}`);
      continue;
    }
    poseChecked += 1;
    if (stats.pngFiles.length > 0) {
      record(
        'pose-png',
        false,
        `${id} 侧 pose 运行目录里出现 PNG（母版只许留在 docs/assets/desktop-pet）：${stats.pngFiles.join(', ')}`,
      );
    } else {
      record('pose-png', true, `${id} 侧 pose 运行目录无 PNG（${stats.webpFiles} 个 webp）`);
    }
    if (stats.bytes > POSE_RUNTIME_MAX_BYTES) {
      record(
        'pose-budget',
        false,
        `${id} 侧 pose 运行资产合计 ${(stats.bytes / 1024 / 1024).toFixed(2)} MiB > 预算 ` +
          `${(POSE_RUNTIME_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB（${stats.files} 个文件）`,
      );
    } else {
      record(
        'pose-budget',
        true,
        `${id} 侧 pose 运行资产 ${(stats.bytes / 1024).toFixed(1)} KiB ≤ ` +
          `${(POSE_RUNTIME_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB（${stats.files} 个文件）`,
      );
    }
  }
  if (poseChecked === 0 && poseAssetsClaimed) {
    notes.push('清单里声明了 pose 运行资产，但两处运行目录都不存在：体积与 PNG 判据本轮没有实测对象');
  }

  return { ok: problems.length === 0, problems, notes, checks };
}

/**
 * 自证扫描器本身有效（用内置坏样本跑一遍，必须红）。
 *
 * <p>没有这一步，"守卫永远绿"和"守卫坏了永远绿"看起来一模一样。</p>
 *
 * @returns {{ok: boolean, problems: string[]}} 自检结果
 */
export function selftest() {
  const problems = [];
  const badVite = `
    export default defineConfig({
      build: { rollupOptions: { input: {
        main: resolve(__dirname, 'index.html'),
        notification: resolve(__dirname, 'notification.html'),
        pet: resolve(__dirname, 'pet.html'),
      } } },
    })
  `;
  const parsedBad = parseViteInput(badVite);
  if (!parsedBad.keys.includes('pet')) problems.push('自检失败：解析器没抓到 input 里的 pet 键');
  if (!parsedBad.htmlFiles.some((file) => basename(file) === PET_ENTRY_FILE)) {
    problems.push('自检失败：解析器没抓到 pet.html 引用');
  }
  const goodVite = `
    // 注释里写 pet.html 不算违规
    export default defineConfig({
      build: { rollupOptions: { input: {
        main: resolve(__dirname, 'index.html'),
        notification: resolve(__dirname, 'notification.html'),
      } } },
    })
  `;
  const parsedGood = parseViteInput(goodVite);
  if (parsedGood.keys.includes('pet')) problems.push('自检失败：注释/正常配置被误判成含 pet');
  if (parsedGood.htmlFiles.some((file) => basename(file) === PET_ENTRY_FILE)) {
    problems.push('自检失败：注释里的 pet.html 被误判成入口引用');
  }

  // 体积/PNG 扫描器自证：造一个 9 MiB 假 webp + 一个 png，扫描必须认出二者
  const probeRoot = mkdtempSync(join(tmpdir(), 'lx-pose-scan-'));
  try {
    const nested = join(probeRoot, 'sit');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'fake@2x.webp'), Buffer.alloc(POSE_RUNTIME_MAX_BYTES + 4096, 0x00));
    writeFileSync(join(nested, 'master.png'), Buffer.alloc(16, 0x89));
    const stats = scanPoseRuntimeDir(probeRoot);
    if (!stats.exists) problems.push('自检失败：pose 扫描器没认出存在的目录');
    if (stats.pngFiles.length !== 1) problems.push('自检失败：pose 扫描器没抓到 PNG');
    if (stats.bytes <= POSE_RUNTIME_MAX_BYTES) problems.push('自检失败：pose 扫描器没算对体积（预算判据会空转）');
    const tiny = scanPoseRuntimeDir(join(probeRoot, 'not-there'));
    if (tiny.exists || tiny.bytes !== 0) problems.push('自检失败：pose 扫描器把不存在的目录当成存在');
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems };
}

/**
 * CLI 入口。
 *
 * @returns {number} 进程退出码（0 = 通过）
 */
export function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  if (args.includes('--selftest')) {
    const result = selftest();
    if (result.ok) {
      console.log('✅ check-pet-not-shipped 自检通过：解析器能抓到 pet 入口，也不会误报注释');
      return 0;
    }
    console.error('❌ check-pet-not-shipped 自检失败：');
    for (const problem of result.problems) console.error(`   - ${problem}`);
    return 1;
  }
  try {
    const result = runNotShippedChecks({ verbose, log: (message) => console.log(message) });
    if (result.ok) {
      console.log('✓ 桌宠入口未进入产物（构建入口无 pet / build.files 无桌宠数据 / dist 无 pet.html 与指纹）');
      return 0;
    }
    console.error('❌ check-pet-not-shipped 失败：安装包里会出现桌宠入口');
    for (const problem of result.problems) console.error(`   - ${problem}`);
    return 1;
  } catch (err) {
    console.error(`❌ check-pet-not-shipped 异常: ${(err && err.message) || err}`);
    return 1;
  }
}

/** 当前脚本是否为入口（被测试 import 时保持静默）。 */
export const IS_ENTRY = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (IS_ENTRY) {
  process.exit(main());
}