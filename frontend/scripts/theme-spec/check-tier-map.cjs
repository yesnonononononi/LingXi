#!/usr/bin/env node
/**
 * 逐档映射校验器（`check-tier-map`）：灰阶统一迁移（`gray-N → zinc-N`）的**行级**守卫。
 *
 * <h3>为什么需要它（它在补哪一类盲区）</h3>
 * `gate:theme` 的判据是「明态集合等价 且 暗态集合等价」，配对按**值**匹配。这带来两个结构性盲区：
 * 1. **置换逃逸**：同一个 `prop|state` 桶里把两个本来都存在的档位对调（`gray-600`↔`gray-700`
 *    分别换成 `zinc-700`/`zinc-600`），值集合不变 ⇒ 门禁绿。集合级判据天生抓不到置换。
 * 2. **超长字面量盲区**：`SpecularButton.vue:276` 曾被 `LITERAL_RE` 的 400 上限整行漏掉
 *    （该盲区已在 `97d3e65` 修掉，但「不依赖产物解析」的守卫仍然有价值）。
 *
 * 本脚本不看产物、不看颜色值，只看 **diff 的字面文本**：机械替换（只改族名、不改档位）必然满足
 * 「hunk 内第 i 条 `-` 行与第 i 条 `+` 行的档位序列逐位相同」，这是可断言的**强不变量**。
 *
 * <h3>判定规则</h3>
 * 1. **行数守恒**：每个 hunk 内 `-` 行数必须等于 `+` 行数（机械替换不增删行）。
 *    不等 ⇒ FAIL（丢行/加行）。
 * 2. **档位序列逐位相同**：把每条行里的 `(gray|zinc)-N` 按出现顺序抽成档位序列（族名无关），
 *    第 i 条 `-` 行与第 i 条 `+` 行必须**逐位相等**。这一条同时抓住：
 *    `gray-600 → zinc-700`（错档）、`gray-600 → gray-700`（未换族改档）、两处互换（置换）、
 *    以及「本来还有 gray-200 却被顺手改成了别的档」。
 * 3. **灰色只减不增**：全量 diff 里 `+` 侧的 `gray-` 出现数不得多于 `-` 侧（本迁移方向 gray→zinc）。
 *    若这是**有意回退**（`git revert` 一档），加 `--allow-reverse` 显式声明，否则 FAIL。
 * 4. **禁止触碰 `tokens.css`**：一旦出现在 diff 里，立即 FAIL 并提示 N5（令牌文件禁改）。
 *
 * <h3>例外白名单（显式，且尽量窄）</h3>
 * - `frontend/scripts/theme-spec/token-renames.json`：**台账自身**。它是追加式 JSON（新增一行没有
 *   对应的 `-` 行），无法用行配对校验，故整文件跳过档位校验，只做「本批是否追加了台账」的提示。
 * - `frontend/src/theme/tokens.css`：**禁止改**。出现即 FAIL（N5）。
 * - `low-tier-baseline.json` / `token-value-spec.json` / `component-scenes.cjs` /
 *   `hover-states.cjs` / `mutation-selfcheck.cjs`：这些文件**允许**出现 `gray→zinc` 同档替换，
 *   但**不豁免**同档校验——它们与源码受同一套规则约束（规格书 §6.6「期望值随批同步」）。
 * - 其余任何文件：同样受全部规则约束（白名单不是「免检」，只是「预期会出现改写」）。
 *
 * <p>实现细节：默认模式用 `git diff HEAD`（工作树 vs HEAD，**含已暂存**）而不是裸 `git diff`
 * ——裸 `git diff` 比较的是「工作树 vs 索引」，一旦先 `git add` 再跑校验就什么都看不到，
 * 容易造成假绿/假红。</p>
 *
 * <h3>用法</h3>
 * ```
 * node scripts/theme-spec/check-tier-map.cjs                 # 默认 --worktree：工作树 vs HEAD
 * node scripts/theme-spec/check-tier-map.cjs --worktree
 * node scripts/theme-spec/check-tier-map.cjs --commit <sha>   # git show <sha> -U0
 * node scripts/theme-spec/check-tier-map.cjs --diff-file <p>  # 直接校验一份 diff 文本（自检/离线用）
 * node scripts/theme-spec/check-tier-map.cjs --allow-reverse  # 允许灰色增加（显式回退）
 * node scripts/theme-spec/check-tier-map.cjs --path frontend/ # 只看某个前缀下的文件
 * ```
 * 退出码：`0` = 全部逐位同档；`1` = 发现违规；`2` = 基础设施错误（git 失败/参数错误）。
 *
 * <h3>作用域（`--path`）</h3>
 * 灰阶迁移期间，工作树里常有别人正在改的 Java / 文档文件：它们的新增行 hunk 会被
 * 「行数守恒」判成违规（实测一次 4 条误报）。`--path <前缀>` 可多次给出，
 * 内部转成 `git diff HEAD -- <paths>`，只校验该前缀下的改动；不传则维持全仓语义（向后兼容）。
 * 为让 `--diff-file` 与其它模式行为一致，解析后还会按前缀再过滤一次文件（等价语义，不是放宽判定）。
 *
 * <p>脚本**只读**：不写任何文件、不改 git 状态。</p>
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 脚本目录：`frontend/scripts/theme-spec`。 */
const SCRIPT_DIR = __dirname;
/** 仓库根（向后三级：theme-spec → scripts → frontend → 仓库根）。 */
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

/** 台账文件（追加式 JSON，无法行配对 ⇒ 整文件跳过校验）。 */
const LEDGER_REL = 'frontend/scripts/theme-spec/token-renames.json';
/** 禁止修改的令牌文件（出现即 FAIL，N5）。 */
const FORBIDDEN_REL = 'frontend/src/theme/tokens.css';
/** 允许出现 `gray→zinc` 改写、但仍受同档校验的资产文件（规格书 §6.6）。 */
const SAME_TIER_ASSETS = new Set([
  'frontend/scripts/theme-spec/low-tier-baseline.json',
  'frontend/scripts/theme-spec/token-value-spec.json',
  'frontend/scripts/visual/component-scenes.cjs',
  'frontend/scripts/visual/hover-states.cjs',
  'frontend/scripts/visual/mutation-selfcheck.cjs',
]);

/** 色阶字面量（与门禁同口径：`\b` 边界 + 2~3 位档位）。 */
const TIER_RE = /\b(gray|zinc)-(\d{2,3})\b/g;

/**
 * 抽取一行里的色阶 token（按出现顺序）。
 *
 * @param {string} line diff 行原文（含前导 `-`/`+`）
 * @returns {Array<{family: string, tier: string}>} 出现序列
 */
function tiersOf(line) {
  const out = [];
  for (const m of String(line).matchAll(TIER_RE)) out.push({ family: m[1], tier: m[2] });
  return out;
}

/** 档位序列（族名无关）转成可比较的字符串。 */
const seqOf = (tokens) => tokens.map((t) => t.tier).join(',');

/** 某一族在序列里的档位列表。 */
const tiersOfFamily = (tokens, family) => tokens.filter((t) => t.family === family).map((t) => t.tier);

/**
 * 判断文件路径是否落在给定的前缀集合下。
 *
 * <p>前缀比对前先规范化成仓库相对、正斜杠形式：`git diff` 输出永远是正斜杠相对路径，
 * 而人手动传的可能是 `frontend\`（Windows 反斜杠）或以 `./` 开头。</p>
 *
 * @param {string} file 仓库相对路径（正斜杠）
 * @param {string[]} prefixes 前缀集合（空数组 = 不限制）
 * @returns {boolean} true = 该文件参与校验
 */
function inScope(file, prefixes) {
  if (prefixes.length === 0) return true;
  const norm = String(file).split(path.sep).join('/').replace(/^\.\//, '');
  return prefixes.some((p) => norm === p || norm.startsWith(p.endsWith('/') ? p : p + '/'));
}

/**
 * 取一段 diff 文本（`git diff --unified=0` / `git show -U0`）。
 *
 * @param {string[]} args 传给 git 的参数（不含可执行文件名）
 * @returns {string} diff 文本
 * @throws {Error} git 执行失败时抛出（由 main 转成退出码 2）
 */
function runGit(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * 解析 unified=0 diff，切成「文件 → hunk → 增删行」的结构。
 *
 * <p>只关心 `-` / `+` 内容行；`---` / `+++` 是文件头、`@@` 是 hunk 头，都要当作边界。</p>
 *
 * @param {string} text diff 全文
 * @returns {Array<{file: string, hunks: Array<{header: string, minus: string[], plus: string[]}>}>} 结构
 */
function parseDiff(text) {
  const files = [];
  let current = null;
  let hunk = null;
  const flushHunk = () => {
    if (current !== null && hunk !== null) current.hunks.push(hunk);
    hunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (current !== null) files.push(current);
    current = null;
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      // 兼容带空格的路径：只取 " b/" 之后的部分
      const idx = line.indexOf(' b/');
      current = { file: idx >= 0 ? line.slice(idx + 3) : line.slice('diff --git '.length), hunks: [] };
      continue;
    }
    if (line.startsWith('+++ ')) {
      // 以 `+++ b/<path>` 为准（改名/新增时更可靠）
      const p = line.slice(4).trim();
      const clean = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (current !== null) current.file = clean === null ? current.file : clean;
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      if (current !== null) hunk = { header: line, minus: [], plus: [] };
      continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')
      || line.startsWith('similarity index') || line.startsWith('rename ') || line.startsWith('old mode')
      || line.startsWith('new mode') || line.startsWith('--- ')) continue;
    if (hunk === null) continue;
    if (line.startsWith('-')) { hunk.minus.push(line.slice(1)); continue; }
    if (line.startsWith('+')) { hunk.plus.push(line.slice(1)); continue; }
    // 上下文行（unified=0 下通常没有）
  }
  flushFile();
  return files;
}

/**
 * 校验解析结果。
 *
 * @param {Array<{file: string, hunks: Array<{header: string, minus: string[], plus: string[]}>}>} files 解析后的 diff
 * @param {{allowReverse: boolean, paths: string[]}} options 选项
 * @returns {{problems: string[], pairs: number, skipped: string[], grayMinus: number, grayPlus: number, assetHits: string[]}} 结果
 */
function validate(files, options) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const assetHits = [];
  let pairs = 0;
  let grayMinus = 0;
  let grayPlus = 0;

  for (const entry of files) {
    const file = entry.file;
    // 作用域过滤：`--path` 之外的他人改动不参与判定（不是放宽判据，只是不看无关文件）
    if (!inScope(file, options.paths)) continue;
    if (file === FORBIDDEN_REL) {
      problems.push(`${file}: 禁止修改令牌文件（N5：tokens.css 一个字都不许动）`);
      continue;
    }
    if (file === LEDGER_REL) {
      const added = entry.hunks.reduce((n, h) => n + h.plus.length, 0);
      const removed = entry.hunks.reduce((n, h) => n + h.minus.length, 0);
      skipped.push(`${file}（台账自身：+${added}/-${removed} 行，追加式 JSON 不做行配对）`);
      continue;
    }
    if (SAME_TIER_ASSETS.has(file)) assetHits.push(file);
    for (const h of entry.hunks) {
      if (h.minus.length !== h.plus.length) {
        problems.push(`${file}: hunk 行数不守恒 -${h.minus.length}/+${h.plus.length}${h.header ? '  ' + h.header : ''}`
          + '（机械同档替换不增删行）');
        continue;
      }
      for (let i = 0; i < h.minus.length; i += 1) {
        const mTok = tiersOf(h.minus[i]);
        const pTok = tiersOf(h.plus[i]);
        grayMinus += mTok.filter((t) => t.family === 'gray').length;
        grayPlus += pTok.filter((t) => t.family === 'gray').length;
        if (mTok.length === 0 && pTok.length === 0) continue; // 无颜色 token 的行对，不计入「行对」数
        pairs += 1;
        const mSeq = seqOf(mTok);
        const pSeq = seqOf(pTok);
        if (mSeq === pSeq) continue;
        const g = tiersOfFamily(mTok, 'gray');
        const z = tiersOfFamily(pTok, 'zinc');
        const pg = tiersOfFamily(pTok, 'gray');
        let headline;
        if (g.length > 0 && z.length === 0 && pg.length > 0) {
          headline = `gray=[${g.join(',')}] ≠ gray=[${pg.join(',')}]（只改了档位、没换族名）`;
        } else {
          headline = `gray=[${g.join(',')}] ≠ zinc=[${z.join(',')}]`;
        }
        problems.push(
          `${file}: 第 ${pairs} 行对 ${headline}\n`
          + `      档位序列 -[${mSeq}] / +[${pSeq}]\n`
          + `      - ${h.minus[i].trim()}\n`
          + `      + ${h.plus[i].trim()}`
        );
      }
    }
  }

  if (!options.allowReverse && grayPlus > grayMinus) {
    problems.push(`灰色出现数增加：- 侧 ${grayMinus} 处 / + 侧 ${grayPlus} 处`
      + '（本迁移方向是 gray→zinc；若这是有意的回退，加 --allow-reverse 显式声明）');
  }
  return { problems, pairs, skipped, grayMinus, grayPlus, assetHits };
}

/** 打印用法。 */
function printUsage() {
  console.log([
    '用法：node scripts/theme-spec/check-tier-map.cjs [模式] [选项]',
    '',
    '  校验灰阶迁移 diff 是否「逐行同档映射」：每条 - 行与对应的 + 行，档位序列必须逐位相同。',
    '',
    '  --worktree         校验工作树相对 HEAD 的 diff（默认）',
    '  --commit <sha>     校验某个提交：git show <sha> --unified=0',
    '  --diff-file <路径> 直接校验一份 diff 文本（离线/自检用；相对仓库根或绝对路径）',
    '  --path <前缀>      只看该前缀下的文件（可多次；如 --path frontend/），不传 = 全仓',
    '  --allow-reverse    允许 + 侧灰色多于 - 侧（显式回退时使用）',
    '  --help             显示本帮助',
    '',
    '退出码：0 全对 / 1 有违规 / 2 基础设施错误',
  ].join('\n'));
}

/**
 * 主流程。
 *
 * @returns {number} 退出码
 */
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return 0;
  }
  const allowReverse = argv.includes('--allow-reverse');
  const commitIdx = argv.indexOf('--commit');
  const fileIdx = argv.indexOf('--diff-file');
  // `--path` 可重复：收集所有取值（每个都必须带非空、非选项的值）
  /** @type {string[]} */
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--path') continue;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) {
      console.error('[check-tier-map] --path 需要一个前缀参数（如 --path frontend/）');
      return 2;
    }
    // 统一成「正斜杠、去掉结尾多余斜杠」的形式，`inScope` 与 git 都用同一份
    paths.push(v.split('\\').join('/').replace(/\/+$/, '') + '/');
  }
  const modeCount = [commitIdx >= 0, fileIdx >= 0].filter(Boolean).length;
  if (modeCount > 1) {
    console.error('[check-tier-map] --commit 与 --diff-file 不能同时使用');
    return 2;
  }

  /** @type {string} */
  let diffText = '';
  /** @type {string} */
  let modeLabel = '';
  try {
    if (commitIdx >= 0) {
      const sha = argv[commitIdx + 1];
      if (!sha || sha.startsWith('--')) {
        console.error('[check-tier-map] --commit 需要一个提交 sha');
        return 2;
      }
      // `git show <sha> -- <paths>` 同样接受 pathspec，作用域语义与 --worktree 一致
      const scope = paths.length > 0 ? ['--', ...paths] : [];
      diffText = runGit(['show', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', '--format=', sha, ...scope]);
      modeLabel = `commit ${sha}${paths.length > 0 ? ' [path ' + paths.join(',') + ']' : ''}`;
    } else if (fileIdx >= 0) {
      const p = argv[fileIdx + 1];
      if (!p || p.startsWith('--')) {
        console.error('[check-tier-map] --diff-file 需要一个路径');
        return 2;
      }
      const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
      diffText = fs.readFileSync(abs, 'utf8');
      modeLabel = `diff-file ${path.basename(abs)}${paths.length > 0 ? ' [path ' + paths.join(',') + ']' : ''}`;
    } else {
      const scope = paths.length > 0 ? ['--', ...paths] : [];
      diffText = runGit(['diff', 'HEAD', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', ...scope]);
      modeLabel = `worktree (工作树 vs HEAD)${paths.length > 0 ? ' [path ' + paths.join(',') + ']' : ''}`;
    }
  } catch (err) {
    console.error(`[check-tier-map] 无法获取 diff：${err && err.message ? err.message : err}`);
    return 2;
  }

  const files = parseDiff(diffText);
  const result = validate(files, { allowReverse, paths });
  const scoped = paths.length > 0
    ? files.filter((f) => inScope(f.file, paths)).length
    : files.length;

  console.log(`[check-tier-map] 模式=${modeLabel}`);
  console.log(`  文件数=${scoped}${paths.length > 0 ? `（diff 内共 ${files.length}，其余 ${files.length - scoped} 个不在 --path 作用域）` : ''}  行对=${result.pairs}  gray: - ${result.grayMinus} / + ${result.grayPlus}`);
  if (result.skipped.length > 0) {
    console.log('  跳过（白名单）：');
    for (const s of result.skipped) console.log(`    · ${s}`);
  }
  if (result.assetHits.length > 0) {
    console.log('  受同档校验的资产文件（不豁免）：');
    for (const s of result.assetHits) console.log(`    · ${s}`);
  }

  if (result.pairs === 0) {
    console.error('FAIL: 没有任何 gray-N/zinc-N 行对被替换（无可校验内容）');
    return 1;
  }
  if (result.problems.length > 0) {
    console.error(`FAIL: 发现 ${result.problems.length} 处问题`);
    for (const p of result.problems) console.error('  - ' + p);
    return 1;
  }
  console.log(`OK 逐位同档映射 ${result.pairs} 行对`);
  return 0;
}

process.exit(main());
