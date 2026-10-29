/**
 * 视觉基线「完整性 oracle」。
 *
 * <p><b>解决什么问题（技术债 G-4）：</b>基线 PNG 全部落在 `.lingxi/tmp/visual/`，被 `/.lingxi/`
 * 整目录 gitignore，因此**不可能随仓库分发**。`compare.mjs` 的 `compareDirectories` 是以
 * 「基线目录里的文件」为遍历源的，于是基线被清掉一半后只剩几张图参与比对，`failed=0`
 * ⇒ 退出码 0 的**静默假绿**。这是最危险的一类门禁失效：门禁还在跑、结论是绿的、覆盖率已崩。</p>
 *
 * <p><b>为什么不是「把 PNG 入仓」：</b>像素结果与机器 / DPI / 字体 / 浏览器版本强绑定
 * （见 `scripts/visual/README.md` 第 4 条）。入仓会让「换个环境 clone 就一片红」，团队最终
 * 会开始无视这个门禁 —— 那比假绿更糟。所以这里采用另一个思路：<b>把「基线应该长什么样」固化
 * 成可入仓的 MD5 清单</b>（本文件），基线本体仍然只留在本机。清单是完整性 oracle，不是像素基线本体。</p>
 *
 * <p><b>三个 suite 各自锚在一个 baselineDir 上：</b>
 * <ul>
 *   <li>`settings` → `<repo>/.lingxi/tmp/visual/baseline`（capture.mjs）</li>
 *   <li>`components` → `<repo>/.lingxi/tmp/visual/components/baseline`（component-scenes.cjs）</li>
 *   <li>`hover` → `<repo>/.lingxi/tmp/visual/hover/baseline`（hover-states.cjs）</li>
 * </ul>
 * 清单里的 `path` 一律<b>相对该 suite 的 baselineDir</b>，从而消除旧扁平结构里
 * `baseline/dark/x.png` 这种跨 suite 有歧义的路径。</p>
 *
 * <p><b>两类失败必须都算红：</b>`missing`（清单有、磁盘无 ⇒ 基线被删/被清）与
 * `extra`（磁盘有、清单无 ⇒ 陈旧图混进来）。后者尤其隐蔽：多出来的图不参与比对不会报错，
 * 但它会让「这台机器的基线到底是哪一版」变得不可判定。</p>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 前端根目录（scripts/visual → ../..）。 */
export const FRONTEND_ROOT = path.resolve(HERE, '..', '..');

/** oracle 文件路径（入仓，随仓库分发）。 */
export const MANIFEST_PATH = path.join(FRONTEND_ROOT, 'scripts', 'theme-spec', 'visual-baseline-md5.json');

/** 已知的 suite 名单：写入时用于重算 counts 的全集。 */
export const SUITES = Object.freeze(['settings', 'components', 'hover']);

/** 各 suite 的用途说明（写进 $comment，供后来者一眼看懂谁在写这一节）。 */
const SUITE_OWNERS = Object.freeze({
  settings: 'capture.mjs（npm run visual:baseline，4 场景 × 明暗）',
  components: 'component-scenes.cjs（npm run visual:components:baseline，整页 + 各目标 ROI）',
  hover: 'hover-states.cjs（npm run visual:hover:baseline）',
});

/** 递减排序：所有路径 / 条目统一走这一份比较器，保证「同一份磁盘内容 → 同一份清单」。 */
function byPath(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 计算单个文件的 md5（小写 32 位）。
 *
 * @param {string} file 文件绝对路径。
 * @returns {string} 小写十六进制 md5。
 * @throws {Error} 文件不可读时抛出。
 */
export function md5File(file) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    throw new Error(`无法读取文件以计算 md5：${file}（${error && error.message ? error.message : String(error)}）`);
  }
}

/**
 * 读取 oracle 清单。
 *
 * <p>不存在或 JSON 损坏时<b>抛错而不是返回空</b>：返回空会让「清单丢了」伪装成
 * 「这次没有基线需要校验」，正是 G-4 要根治的那种静默。</p>
 *
 * @returns {{$comment?: string, generatedAt?: string, suites: Record<string, Array<{path: string, md5: string}>>, counts?: Record<string, number|null>}} 清单对象
 * @throws {Error} 文件缺失 / 解析失败 / 结构不合法时抛出。
 */
export function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `视觉基线 oracle 缺失：${MANIFEST_PATH}\n`
      + '该文件必须入仓（它是基线的完整性凭据）。若确实被删，请用 git 恢复后重试。',
    );
  }
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `视觉基线 oracle 不是合法 JSON：${MANIFEST_PATH}（${error && error.message ? error.message : String(error)}）`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`视觉基线 oracle 结构不合法（顶层应为对象）：${MANIFEST_PATH}`);
  }
  const suites = parsed.suites;
  if (!suites || typeof suites !== 'object' || Array.isArray(suites)) {
    throw new Error(
      `视觉基线 oracle 缺少 suites 分组（${MANIFEST_PATH}）。本文件已改为「按 suite 分组」结构，`
      + '旧的扁平 files 结构不再兼容；请用任一门禁脚本的 --mode baseline 重新生成它。',
    );
  }
  return parsed;
}

/**
 * 递归列出目录下的 `.png`（相对路径、`/` 分隔、字典序）。
 *
 * @param {string} baselineDir 基线目录（绝对路径）。
 * @returns {string[]} 相对路径列表；目录不存在时返回空数组（由调用方判定为「缺失」）。
 */
export function listBaselinePngs(baselineDir) {
  /** @type {string[]} */
  const out = [];
  const root = path.resolve(String(baselineDir));
  if (!fs.existsSync(root)) return out;
  /** @param {string} dir 当前目录 */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.png$/i.test(entry.name)) continue;
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort(byPath);
}

/**
 * 校验某个 suite 的基线目录是否与 oracle 记录完全一致。
 *
 * <p>四个判据缺一不可：missing（清单有磁盘无）、extra（磁盘有清单无）、mismatched（md5 不符）、
 * 以及 manifest 该 suite 为空/缺失（此时没有可校验的期望值，只能判失败并留一条哨兵说明）。</p>
 *
 * @param {{suite: string, baselineDir: string}} params suite 名与其基线目录。
 * @returns {{suite: string, baselineDir: string, ok: boolean, expected: number, actual: number, missing: string[], extra: string[], mismatched: Array<{path: string, expected: string, actual: string}>, sentinel: string|null}} 校验结果
 * @throws {Error} suite 名非法或 oracle 不可读时抛出（属于基础设施故障，由调用方转成 exit 2）。
 */
export function verifyBaseline({ suite, baselineDir }) {
  if (!SUITES.includes(suite)) {
    throw new Error(`未知的基线 suite：「${suite}」（只接受 ${SUITES.join(' / ')}）`);
  }
  const manifest = readManifest();
  const declared = manifest.suites ? manifest.suites[suite] : undefined;
  const onDisk = listBaselinePngs(baselineDir);
  const entries = Array.isArray(declared) ? declared : [];

  // 哨兵：清单里这一节为空/缺失 ⇒ 没有任何可校验的期望值，不能当成 ok。
  if (entries.length === 0) {
    const sentinel = `清单中 suite「${suite}」为空或不存在（${path.relative(FRONTEND_ROOT, MANIFEST_PATH).split(path.sep).join('/')}）：没有可校验的指纹，无法证明磁盘上的基线是完整的`;
    return {
      suite,
      baselineDir,
      ok: false,
      expected: 0,
      actual: onDisk.length,
      missing: [sentinel],
      extra: [],
      mismatched: [],
      sentinel,
    };
  }

  /** @type {Map<string, string>} manifest 里的 path → md5 */
  const expectedByPath = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.md5 !== 'string') continue;
    expectedByPath.set(String(entry.path), String(entry.md5).toLowerCase());
  }
  const actualSet = new Set(onDisk);

  /** @type {string[]} */
  const missing = [];
  /** @type {Array<{path: string, expected: string, actual: string}>} */
  const mismatched = [];
  for (const [relPath, expectedMd5] of expectedByPath) {
    if (!actualSet.has(relPath)) {
      missing.push(relPath);
      continue;
    }
    const actualMd5 = md5File(path.join(path.resolve(String(baselineDir)), relPath));
    if (actualMd5 !== expectedMd5) mismatched.push({ path: relPath, expected: expectedMd5, actual: actualMd5 });
  }
  missing.sort(byPath);
  mismatched.sort((a, b) => byPath(a.path, b.path));
  const extra = onDisk.filter((relPath) => !expectedByPath.has(relPath));

  return {
    suite,
    baselineDir,
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    expected: expectedByPath.size,
    actual: onDisk.length,
    missing,
    extra,
    mismatched,
    sentinel: null,
  };
}

/**
 * 把条目列表折叠成一行（>5 条时打印前 5 条 + 「等 N 个」）。
 *
 * @param {string[]} items 条目。
 * @returns {string} 折叠后的文本。
 */
function foldList(items) {
  if (items.length <= 5) return items.join('、');
  return `${items.slice(0, 5).join('、')} 等 ${items.length} 个`;
}

/**
 * 把校验失败结果渲染成人话（含可执行指引）。
 *
 * @param {ReturnType<typeof verifyBaseline>} result 校验结果。
 * @returns {string} 多行报错文本（不含颜色，直接给 console.error）。
 */
export function formatVerifyFailure(result) {
  const repoRoot = path.resolve(FRONTEND_ROOT, '..');
  const abs = String(result.baselineDir);
  const relToRepo = path.relative(repoRoot, abs);
  const shown = relToRepo.startsWith('..') ? abs : relToRepo.split(path.sep).join('/');
  const lines = [
    `[基线完整性校验失败] suite=${result.suite}  baselineDir=${shown}`,
    `  manifest 期望 ${result.expected} 张 / 磁盘实际 ${result.actual} 张`,
  ];
  if (result.sentinel) {
    lines.push(`  ✗ ${result.sentinel}`);
  }
  if (result.missing.length > 0 && !result.sentinel) {
    lines.push(`  ✗ 缺失（清单有、磁盘无）${result.missing.length} 张：${foldList(result.missing)}`);
  }
  if (result.extra.length > 0) {
    lines.push(`  ✗ 多余（磁盘有、清单无）${result.extra.length} 张：${foldList(result.extra)}`);
  }
  if (result.mismatched.length > 0) {
    const detail = result.mismatched
      .slice(0, 5)
      .map((item) => `${item.path}（期望 md5=${item.expected} 实际 md5=${item.actual}）`);
    const tail = result.mismatched.length > 5 ? [`等 ${result.mismatched.length} 个`] : [];
    lines.push(`  ✗ 指纹不符（md5 对不上）${result.mismatched.length} 张：${[...detail, ...tail].join('、')}`);
  }
  lines.push(
    '  ⇒ 基线不完整就是门禁失效（残缺基线会让 compare 只比剩下那几张图，failed=0 静默假绿）。',
    `  指引：确认 .lingxi/tmp 未被清理；如基线是本机重新抓的，请用全量 \`--mode baseline\` 重建`
    + `（重建会自动刷新 ${path.basename(MANIFEST_PATH)} 中 suite=${result.suite} 这一节）。`,
  );
  return lines.join('\n');
}

/**
 * 读取各 suite 的「形态」标记（G-5 新增，顶层 `forms`）。
 *
 * <p><b>为什么要单独一个顶层字段：</b>`writeBaselineSuite` 是对 manifest 做<b>原地增改</b>
 * （只重写 `suites[suite]` / `counts` / `generatedAt`），未知顶层键会被保留；而塞进
 * `entries[]` 每条记录里的字段会在重建时被 `pngs.map(...)` 整体覆盖丢掉。所以形态只能放顶层。</p>
 *
 * <p><b>消费方约定：</b>形态不匹配 ⇒ <b>exit 2</b>（代码与基线没配对，属基础设施问题），
 * 绝不落到 exit 1（那是真视觉回归）。缺失 `forms` 字段同样按「形态未知」处理 ⇒ exit 2。</p>
 *
 * @returns {Record<string, string>} 形如 `{ settings: 'legacy-3tab-v1', components: 'per-scene-v1' }`；
 *   oracle 没有 forms 字段时返回空对象（由调用方决定怎么处理「形态未知」）。
 * @throws {Error} oracle 缺失 / JSON 损坏时抛出（与 readManifest 同口径，不静默返回空）。
 */
export function readForms() {
  const manifest = readManifest();
  const forms = manifest.forms;
  if (!forms || typeof forms !== 'object' || Array.isArray(forms)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(forms)) {
    if (typeof value === 'string' && value.length > 0) out[name] = value;
  }
  return out;
}

/**
 * 用磁盘现状重算某个 suite 的指纹并写回 oracle。
 *
 * <p>三个不变量：① 只改自己这一节（其他 suite、`$comment` 与顶层 `forms` 原样保留，否则重建
 * settings 会把 components/hover 的指纹与形态抹掉）；② `counts` / `generatedAt` 由本函数统一
 * 重算，不手填；③ 目录下没有 PNG 时<b>拒绝写入</b> —— 空节等于「没有可校验的期望值」，
 * 写进去就是把门禁改成瞎子。</p>
 *
 * @param {{suite: string, baselineDir: string, form?: string}} params suite 名、基线目录、形态标记。
 * @returns {{suite: string, count: number, form: string|null, counts: Record<string, number|null>, manifestPath: string}} 写入结果
 * @throws {Error} suite 非法、目录无 PNG、oracle 不可写时抛出。
 */
export function writeBaselineSuite({ suite, baselineDir, form = null }) {
  if (!SUITES.includes(suite)) {
    throw new Error(`未知的基线 suite：「${suite}」（只接受 ${SUITES.join(' / ')}）`);
  }
  const root = path.resolve(String(baselineDir));
  const pngs = listBaselinePngs(root);
  if (pngs.length === 0) {
    throw new Error(
      `拒绝写入空的 suite「${suite}」：${root} 下没有任何 .png。`
      + '（先确认基线真的抓成功了；空指纹会让下一次 check 失去完整性凭据）',
    );
  }
  const entries = pngs.map((relPath) => ({ path: relPath, md5: md5File(path.join(root, relPath)) }));

  // oracle 可能尚不存在（首次接入）——此时用一个只含 $comment 的最小骨架起步。
  /** @type {any} */
  let manifest;
  if (fs.existsSync(MANIFEST_PATH)) {
    manifest = readManifest();
  } else {
    manifest = {
      $comment: '视觉基线完整性 oracle：记录本机基线的 MD5 指纹（基线 PNG 本身不入仓，见 scripts/visual/README.md 第 4 条）。',
      generatedAt: new Date().toISOString(),
      suites: {},
      counts: {},
    };
  }
  if (!manifest.suites || typeof manifest.suites !== 'object' || Array.isArray(manifest.suites)) manifest.suites = {};

  manifest.suites[suite] = entries;
  // 形态标记同样「原地增改」，只写自己这一节；不传 form 时保持既有值不变（部分重建不会抹掉形态）。
  if (typeof form === 'string' && form.length > 0) {
    if (!manifest.forms || typeof manifest.forms !== 'object' || Array.isArray(manifest.forms)) manifest.forms = {};
    manifest.forms[suite] = form;
  }

  // counts 一律从 suites 重算：settings / components / hover 各自条数 + total（任一节缺失则 total 为 null）。
  /** @type {Record<string, number|null>} */
  const counts = {};
  let allPresent = true;
  let total = 0;
  for (const name of SUITES) {
    const list = manifest.suites[name];
    if (Array.isArray(list) && list.length > 0) {
      counts[name] = list.length;
      total += list.length;
    } else {
      counts[name] = null;
      allPresent = false;
    }
  }
  counts.total = allPresent ? total : null;
  manifest.counts = counts;
  manifest.generatedAt = new Date().toISOString();

  // 顶层字段按固定顺序落盘（$comment → generatedAt → forms → suites → counts），
  // 便于人读与 diff；不认识的顶层键原样保留在末尾（前向兼容）。
  const known = new Set(['$comment', 'generatedAt', 'forms', 'suites', 'counts']);
  /** @type {Record<string, unknown>} */
  const ordered = {};
  if (typeof manifest.$comment === 'string') ordered.$comment = manifest.$comment;
  ordered.generatedAt = manifest.generatedAt;
  ordered.forms = manifest.forms && typeof manifest.forms === 'object' ? manifest.forms : {};
  ordered.suites = manifest.suites;
  ordered.counts = manifest.counts;
  for (const [name, value] of Object.entries(manifest)) {
    if (!known.has(name)) ordered[name] = value;
  }

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(ordered, null, 2)}\n`);

  const writtenForm = ordered.forms[suite] || null;
  return { suite, count: entries.length, form: typeof writtenForm === 'string' ? writtenForm : null, counts, manifestPath: MANIFEST_PATH };
}

/**
 * 打印各 suite 的归属说明（写 oracle 的 $comment 用；供调用方复用同一份文案）。
 *
 * @returns {string} 单行说明。
 */
export function describeSuites() {
  return SUITES.map((name) => `${name} ← ${SUITE_OWNERS[name]}`).join('；');
}
