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
 * <p><b>七条判据（每条都必须能单独变红）：</b></p>
 * <ol>
 *   <li>`frontend/vite.config.ts` 的 `build.rollupOptions.input` 里<b>没有</b> `pet` 键，
 *       也没有任何 `*.html` 入口的文件名等于 `pet.html`（防止换个键名绕过去）；</li>
 *   <li>`frontend/package.json` 的 `build.files` 里<b>没有</b>桌宠数据/入口
 *       （`pet-geometry.json` / `pet-*.json` / `pet.html`）；</li>
 *   <li>`frontend/dist/pet.html` <b>不存在</b>；</li>
 *   <li>`frontend/dist` 下任何文本产物都<b>不含</b>桌宠指纹（`<div id="pet-root"` /
 *       `<meta name="lx-app" content="pet"`）；</li>
 *   <li><b>生产产物里没有桌宠静态资产</b>（M2 线A任务 2，新增三条子判据）：
 *       ①`dist/live2d/` 下没有名为 `pet-*` 的目录；②`dist` 全树没有 `pet-poses/` / `pet-sequences/`
 *       路径段；③没有桌宠的 `.webp` 姿态资产（**按路径段/文件名前缀精确判定**：
 *       `live2d/hiyori/texture_00.webp` 这类非桌宠模型资产不在禁令内，一刀切禁 webp 会把它们打红）；</li>
 *   <li>`public/live2d/pet-poses` 与 `dist/live2d/pet-poses` 里<b>没有 PNG</b>（母版只许留在
 *       `docs/assets/desktop-pet/`）；</li>
 *   <li>上述两处 pose 运行资产<b>合计 ≤ 8 MiB</b>（裁决 D-02：pose 资产留在包里，改设总量上限）。</li>
 * </ol>
 *
 * <p><b>判据 5 与判据 6/7 的口径关系（不是放宽，是被替代）：</b>判据 6/7 原本对 `dist` 侧
 * `live2d/pet-poses` 也做 PNG 与体积检查。引入资产隔离之后 `dist` 侧那个目录**必须不存在**，
 * 于是"检查它里面的 PNG/体积"这件事没有对象了。替代它的是一条**更严**的判据 5：
 * 目录本身不许存在。`public` 侧的 PNG/体积判据**一字未改、照旧执行**（开发态资产仍受 D-02 约束）。
 * `dist` 侧目录不存在时打一条 note 说明"这是期望状态"，而不是"跳过检查"。</p>
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
// 桌宠静态资产隔离的判定真源（目录名前缀）：本脚本与 `vite.config.ts` 的构建期裁剪**共用一份**判定，
// 避免"构建按名单删、守卫按前缀查"这种两边口径分裂（漏删的那一版永远绿）。
import { LIVE2D_DIR_NAME, PET_ASSET_DIR_PREFIX, isPetAssetDirName } from './pet-asset-isolation.mjs';
// pose 运行资产的体积上限**只有一个真源**：`scripts/pet-budget.mjs`（裁决 D-02，8 MiB）。
// D-02 否决了"把 pose 资产排除出安装包"的方案，改为 **留在包里但设总量上限**：
// 资产留在包里才能保证开发态与打包态走同一条 `lxa://` 路径；设上限是为了让"美术顺手塞
// 一堆 @4x 母版"这种事故在门禁阶段就红，而不是等安装包膨胀到用户投诉。
import { POSE_TOTAL_MAX_BYTES } from './pet-budget.mjs';

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
 * 扫描 `dist` 里是否存在**桌宠静态资产**（M2 线A任务 2 的核心判据）。
 *
 * <p>只看文件系统事实。三条子判据各自收集命中清单，由调用方逐条 record，
 * 这样报错能点名到具体路径（"产物里有 pet-poses"比"有桌宠资产"可执行得多）。</p>
 *
 * <p><b>为什么按"路径段前缀 + 文件名前缀"判定、不一刀切禁 webp：</b>
 * `dist/live2d/` 会是**非桌宠 Live2D 模型**的合法安放处（`lxa://` 协议的内置根），
 * 那些模型自己带 `texture_00.webp`。禁掉所有 webp 会把无关资产打红，进而逼人放宽守卫。
 * 所以规则是：路径里任一段以 `pet-` 开头、或文件名以 `pet-` 开头，才算桌宠资产。</p>
 *
 * @param {string} distDir dist 目录绝对路径
 * @returns {{exists: boolean, petDirs: string[], petPathSegments: string[], petMedia: string[],
 *   petFiles: number, petBytes: number}} 扫描结果（路径均相对 dist）
 */
export function scanDistPetAssets(distDir) {
  const result = {
    exists: false,
    petDirs: [],
    petPathSegments: [],
    petMedia: [],
    petFiles: 0,
    petBytes: 0,
  };
  if (!existsSync(distDir)) return result;
  result.exists = true;

  /** 桌宠资产专属的路径段（与 {@link POSE_RUNTIME_DIR_SEGMENTS} 同源的前缀口径）。 */
  const PET_SEGMENTS = Object.freeze([`${PET_ASSET_DIR_PREFIX}poses`, `${PET_ASSET_DIR_PREFIX}sequences`]);

  /**
   * 相对路径是否含桌宠路径段。
   *
   * @param {string} relative 相对 dist 的路径
   * @returns {boolean} 是否命中
   */
  const hasPetSegment = (relative) =>
    relative.split(/[\\/]+/).some((segment) => PET_SEGMENTS.includes(segment));

  /** 深度优先遍历（携带"是否已在桌宠目录内"标记，避免整棵子树被跳过而漏记文件）。 */
  const walk = (dir, relativeRoot, insidePetDir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = relativeRoot === '' ? entry.name : `${relativeRoot}/${entry.name}`;
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        const isPetDir = isPetAssetDirName(entry.name);
        if (isPetDir) result.petDirs.push(relative);
        walk(absolute, relative, insidePetDir || isPetDir);
        continue;
      }
      if (!entry.isFile()) continue;
      const isPetFile = insidePetDir || isPetAssetDirName(entry.name) || hasPetSegment(relative);
      if (!isPetFile) continue;
      // 桌宠路径段 / 桌宠文件名 / 桌宠目录内的文件：统一进"路径段"命中清单
      result.petPathSegments.push(relative);
      result.petFiles += 1;
      result.petBytes += statSync(absolute).size;
      // 姿态资产（媒体）：只在"桌宠目录内 / 桌宠文件名"下才算违规——
      // 非桌宠 Live2D 模型的 webp（`live2d/hiyori/texture_00.webp`）不在禁令内。
      if (entry.name.toLowerCase().endsWith('.webp') && (insidePetDir || isPetAssetDirName(entry.name))) {
        result.petMedia.push(relative);
      }
    }
  };
  walk(distDir, '', false);
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

    // 判据 5：**生产产物里不许有桌宠静态资产**（M2 线A任务 2）。
    // 三条子判据分开记，报错才能点名到具体路径；任何一条命中都是一条 FAIL。
    const petAssets = scanDistPetAssets(distDir);
    if (petAssets.petDirs.length > 0) {
      record(
        'dist-pet-static-dirs',
        false,
        `产物里出现桌宠静态资产目录（${petAssets.petFiles} 个文件 / ` +
          `${(petAssets.petBytes / 1024 / 1024).toFixed(2)} MiB）：${petAssets.petDirs.join(', ')}` +
          '。安装版不展示桌宠，这些字节纯属包体浪费；vite.config.ts 的 petAssetIsolation 插件必须在构建尾把它们裁掉',
      );
    } else {
      record(
        'dist-pet-static-dirs',
        true,
        `dist/${LIVE2D_DIR_NAME} 下没有 ${PET_ASSET_DIR_PREFIX}* 目录（桌宠静态资产已隔离）`,
      );
    }
    if (petAssets.petPathSegments.length > 0) {
      record(
        'dist-pet-static-paths',
        false,
        `产物里出现桌宠路径段（pet-poses/ pet-sequences/ 或 pet-* 文件名）：` +
          `${petAssets.petPathSegments.slice(0, 10).join(', ')}` +
          `${petAssets.petPathSegments.length > 10 ? ` 等 ${petAssets.petPathSegments.length} 处` : ''}`,
      );
    } else {
      record('dist-pet-static-paths', true, '产物全树没有 pet-poses/ 或 pet-sequences/ 路径，也没有 pet-* 文件名');
    }
    if (petAssets.petMedia.length > 0) {
      record(
        'dist-pet-static-media',
        false,
        `产物里出现桌宠姿态的 webp 资产：${petAssets.petMedia.slice(0, 10).join(', ')}` +
          `${petAssets.petMedia.length > 10 ? ` 等 ${petAssets.petMedia.length} 个` : ''}`,
      );
    } else {
      record(
        'dist-pet-static-media',
        true,
        '产物里没有桌宠姿态的 webp（非桌宠 Live2D 模型的 webp 不在禁令内）',
      );
    }
  }

  // 判据 6 / 7：pose 运行资产（D-02：留在包里，但禁 PNG 且总量 ≤ 8 MiB）
  // 清单存在 ⇒ 运行资产"应该有"，目录缺失就必须说出来；清单不存在（切片 1 之前 / 干净样本）⇒ 静默跳过。
  //
  // 口径变化（M2 线A任务 2，**不是放宽**）：生产构建已隔离桌宠静态资产 ⇒ `dist` 侧这个目录
  // **本来就该不存在**，于是"检查它里面的 PNG/体积"没有对象了。替代它的是一条更严的判据
  // （上面的 `dist-pet-static-*`：目录本身不许存在）。`public` 侧的 PNG/体积判据一字未改。
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
      if (!poseAssetsClaimed) continue;
      notes.push(
        id === 'dist'
          ? `dist 侧 pose 运行目录不存在 —— 这是**期望状态**（生产构建已隔离桌宠静态资产，见 dist-pet-static-* 判据），` +
            `本项 PNG/体积判据因此无实测对象：${dir}`
          : `public 侧 pose 运行目录不存在，已跳过该项（请先跑 npm run build:pet-poses）：${dir}`,
      );
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
    if (stats.bytes > POSE_TOTAL_MAX_BYTES) {
      record(
        'pose-budget',
        false,
        `${id} 侧 pose 运行资产合计 ${(stats.bytes / 1024 / 1024).toFixed(2)} MiB > 预算 ` +
          `${(POSE_TOTAL_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB（${stats.files} 个文件）`,
      );
    } else {
      record(
        'pose-budget',
        true,
        `${id} 侧 pose 运行资产 ${(stats.bytes / 1024).toFixed(1)} KiB ≤ ` +
          `${(POSE_TOTAL_MAX_BYTES / 1024 / 1024).toFixed(0)} MiB（${stats.files} 个文件）`,
      );
    }
  }
  if (poseChecked === 0 && poseAssetsClaimed) {
    notes.push(
      '清单里声明了 pose 运行资产，但 public 侧运行目录也不存在：体积与 PNG 判据本轮没有实测对象' +
        '（dist 侧不存在是期望状态，不算缺口）',
    );
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
    writeFileSync(join(nested, 'fake@2x.webp'), Buffer.alloc(POSE_TOTAL_MAX_BYTES + 4096, 0x00));
    writeFileSync(join(nested, 'master.png'), Buffer.alloc(16, 0x89));
    const stats = scanPoseRuntimeDir(probeRoot);
    if (!stats.exists) problems.push('自检失败：pose 扫描器没认出存在的目录');
    if (stats.pngFiles.length !== 1) problems.push('自检失败：pose 扫描器没抓到 PNG');
    if (stats.bytes <= POSE_TOTAL_MAX_BYTES) problems.push('自检失败：pose 扫描器没算对体积（预算判据会空转）');
    const tiny = scanPoseRuntimeDir(join(probeRoot, 'not-there'));
    if (tiny.exists || tiny.bytes !== 0) problems.push('自检失败：pose 扫描器把不存在的目录当成存在');
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }

  // dist 桌宠静态资产扫描器自证（M2 线A任务 2）：必须同时证明"抓得到桌宠资产"与
  // "不会误伤非桌宠的 Live2D 模型 webp"——只证前者会让守卫退化成"禁所有 webp"。
  const distProbe = mkdtempSync(join(tmpdir(), 'lx-pet-asset-scan-'));
  try {
    const petPosesDir = join(distProbe, LIVE2D_DIR_NAME, 'pet-poses', 'sit');
    mkdirSync(petPosesDir, { recursive: true });
    writeFileSync(join(petPosesDir, 'sit_neutral@1x.webp'), Buffer.alloc(8, 0x52));
    // 非桌宠模型资产：必须**不放行**判据（不是违规）
    const modelDir = join(distProbe, LIVE2D_DIR_NAME, 'hiyori');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'texture_00.webp'), Buffer.alloc(8, 0x52));
    /** 被测扫描结果。 */
    const scanned = scanDistPetAssets(distProbe);
    if (!scanned.exists) problems.push('自检失败：dist 扫描器没认出存在的目录');
    if (!scanned.petDirs.some((item) => item.includes('pet-poses'))) {
      problems.push('自检失败：dist 扫描器没抓到 pet-poses 目录（隔离判据会空转）');
    }
    if (!scanned.petMedia.some((item) => item.includes('sit_neutral@1x.webp'))) {
      problems.push('自检失败：dist 扫描器没抓到桌宠姿态 webp');
    }
    if (scanned.petMedia.some((item) => item.includes('texture_00.webp'))) {
      problems.push('自检失败：dist 扫描器把非桌宠 Live2D 模型 webp 误判成桌宠资产（守卫会被迫放宽）');
    }
    /** 干净产物：任何一条都不许命中。 */
    const cleanProbe = mkdtempSync(join(tmpdir(), 'lx-pet-asset-clean-'));
    try {
      const cleanModel = join(cleanProbe, LIVE2D_DIR_NAME, 'hiyori');
      mkdirSync(cleanModel, { recursive: true });
      writeFileSync(join(cleanModel, 'texture_00.webp'), Buffer.alloc(8, 0x52));
      const clean = scanDistPetAssets(cleanProbe);
      if (clean.petDirs.length || clean.petPathSegments.length || clean.petMedia.length) {
        problems.push('自检失败：干净产物被 dist 扫描器误判成含桌宠资产');
      }
    } finally {
      rmSync(cleanProbe, { recursive: true, force: true });
    }
    const missing = scanDistPetAssets(join(distProbe, 'not-there'));
    if (missing.exists) problems.push('自检失败：dist 扫描器把不存在的目录当成存在');
  } finally {
    rmSync(distProbe, { recursive: true, force: true });
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