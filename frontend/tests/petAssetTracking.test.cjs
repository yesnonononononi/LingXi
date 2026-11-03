'use strict';
/**
 * 桌宠美术资产的**入库守卫**（纯 Node，零依赖，离线可跑）。
 *
 * <p><b>它守的是什么缺陷：</b>`.gitignore` 曾经整目录忽略 `docs/`，而桌宠全部美术资产住在
 * `docs/assets/desktop-pet/`。历史批次靠人工 `git add -f` 一个个塞进索引，于是出现
 * "交付了但不可复现"——`companion/v1/tools/` 的三个脚本在磁盘上存在，
 * `git ls-files` 与 `git status --untracked-files=all` 都**看不见**它们。
 * M2 还有 9 个批次（lie/sleep/walk/run/jump/play/edge/side/mini），每批都会重赌一次。</p>
 *
 * <p><b>为什么用 `git check-ignore --no-index`：</b>不带 `--no-index` 时 git 会先查索引，
 * 已跟踪文件永远"不被忽略"，于是"把 .gitignore 改回 docs/"这种回退**测不出来**。
 * 加 `--no-index` 后判定只看规则本身，新批次文件与已入库文件走同一条路径，
 * 回退会立刻变红（变异体 `gitignore-desktop-pet-exception-removed` 验证过）。</p>
 *
 * <p><b>索引断言为什么逐文件：</b>只查"批次目录里有一件入库"会漏掉"某几个文件被
 * `git rm --cached` 掉"。逐文件比对（磁盘 vs `git ls-files`）才能抓住这种静默缺失，
 * 例外只能来自 {@link TRACKING_WHITELIST}，且必须写明理由。</p>
 *
 * <p><b>为什么"磁盘有、索引无"必须按来源拆开（本文件的核心判据）：</b>同一句"磁盘有、索引无"
 * 其实是两件性质完全不同的事，混成一条就只能靠"批次在不在 {@link DELIVERED_PREFIXES}"来开关，
 * 粒度不对：</p>
 * <ul>
 *   <li><b>文件在 HEAD 树里、但不在索引里 ⇒ 真丢文件，硬失败</b>。这类正是
 *       `git rm --cached` / 错误 checkout / 坏 merge 的形态：文件曾经入库过，换台机器就没了。
 *       判据用 `git ls-tree -r HEAD`——客观记录，不依赖任何手工清单，浅克隆下同样可用
 *       （`git log -- <path>` 在 depth=1 的 checkout 上查不到历史）。</li>
 *   <li><b>磁盘有、索引无、HEAD 里也没有 ⇒ 在产新帧，仅警告</b>。这是美术刚画出来、
 *       还没 `git add` 的正常施工态（M2 每开一批都会发生）。打印
 *       `[pet-asset] 在产新帧（未入库，未计入通过）：…` 并<b>不计入通过</b>；
 *       置 `LX_PET_TRACKING_STRICT=1` 时仍然硬失败（CI 是干净 checkout，
 *       两种模式结论一致，交付验收建议用严格模式）。</li>
 * </ul>
 * <p>两条互不干扰：已交付批次里冒出新帧（美术给 `poses/sleep/` 补呼吸帧）只警告，
 * 而任何"曾经入库、现在索引里没有"的文件都必红——不会因为清单漏维护而失明。</p>
 * <p>注意：真正"交付了但不可复现"的原始缺陷（被 `.gitignore` 吞掉）走的是上面那条
 * `check-ignore --no-index` 断言，**不受任何白名单或模式影响**，永远硬失败。</p>
 *
 * <p><b>为什么还要一条"历史"断言：</b>{@link DELIVERED_PREFIXES} 是手工清单，M2 还有 9 个批次，
 * 每漏加一条，该批次的"整批清空"就会降级成一行 `console.log`——在几百行测试输出里没人看得见。
 * 所以再加一条：磁盘上有文件、索引里整批为空、**但 git 历史里出现过该路径** ⇒ 硬失败
 * （历史出现过 = 确实交付过，索引为空只可能是被清空或前缀漏加）。历史为空的新批次仍然只警告，
 * 不会误伤美术在产的新批次。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 前端根目录（本文件位于 `frontend/tests/`）。 */
const FRONTEND_ROOT = path.resolve(__dirname, '..');
/** 仓库根目录（git 命令在这里执行，路径一律相对它）。 */
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
/** 桌宠资产在仓库里的相对路径（gitignore 规则的锚点）。 */
const ASSET_ROOT_REL = 'docs/assets/desktop-pet';
/** 桌宠资产的磁盘绝对路径。 */
const ASSET_ROOT_ABS = path.join(REPO_ROOT, 'docs', 'assets', 'desktop-pet');
/** `git` 调用的超时（毫秒）：守卫不该在网上或不响应的仓库上挂死。 */
const GIT_TIMEOUT_MS = 60000;
/** 一次 `check-ignore --stdin` 最多喂多少条路径（防止参数/输入过大）。 */
const CHECK_IGNORE_CHUNK = 200;

/**
 * 允许"磁盘有、索引无"的真实例外（**数据驱动的显式清单**，不是"检测到未跟踪就跳过"）。
 *
 * <p>每条必须同时给：`pattern`（相对 {@link ASSET_ROOT_REL} 的匹配正则）、`status`、
 * `reason`（为什么它可以暂不入库）、`until`（解除条件）。</p>
 *
 * <p><b>当前为空</b>：companion（云灵）曾以 `pending-delivery` 暂挂在白名单里，美术定稿
 * （分支 `e463ea91`，main 侧入库 `613ba7c8`）后已按约定摘掉——这正是白名单该有的生命周期：
 * 未交付时显式豁免，交付后必须删除，不能长期放水。</p>
 *
 * <p><b>为什么不能写成自动跳过：</b>如果"未跟踪就跳过"，那么把 `.gitignore` 退回 `docs/`
 * 之后（变异体 `gitignore-desktop-pet-exception-removed`）所有文件都"未跟踪"，
 * 测试会集体静默放行，M1 就杀不死了。显式清单 + 下文的"已交付路径不得豁免"断言
 * 把放水面锁死在一处，且过期必须摘掉。</p>
 *
 * @type {Array<{pattern: RegExp, status: string, reason: string, until: string}>}
 */
const TRACKING_WHITELIST = [];

/**
 * **已交付**的批次前缀：这些路径不允许出现在白名单里。
 *
 * <p>白名单只用于"还没交付"的东西。已交付批次若被豁免，等于把"必须可复现"的承诺作废，
 * 所以这里单独断言一层。</p>
 *
 * <p><b>清单与历史断言的分工（重要，别把主次搞反）：</b></p>
 * <ul>
 *   <li><b>历史断言（{@link lastCommitTouching}）= 主力防线</b>：抓「曾交付过、现在整批不见了」。
 *       它查的是 `git log -1 --format=%H -- <批次路径>`——客观事实，<b>不依赖本清单</b>，
 *       所以新批次即使没被加进来，"整批清空"也照样会红。</li>
 *   <li><b>{@link DELIVERED_PREFIXES} = 兜底</b>：用来覆盖 (a) 历史不可用的环境
 *       （例如浅克隆、`--depth 1` 的 CI checkout，`git log -- <path>` 查不到），
 *       以及 (b) 已知必交付的批次（把"必须可复现"写死成事实，而不是靠推断）。</li>
 * </ul>
 * <p>因此<b>不再要求每交付一批就手工加一条</b>：忘了加只是失去兜底，主防线仍在
 * （漏加本身也会被历史断言以"曾交付过但索引为空"的形式点出来）。
 * 但 M2 批次陆续交付时，顺手补上仍然是对的——它让保护不依赖 checkout 的深浅。</p>
 *
 * <p><b>为什么是"逐批次"而不是"按类别"：</b>M2 会在 `poses/` 下陆续新增
 * lie/sleep/walk/run/jump/play/edge/side/mini。写成 `poses/` 会把**在产**的新批次
 * 也算成"已交付"，于是"已交付不得豁免"这条断言会把整个 `poses/` 类别的豁免都禁掉——
 * 而"在产批次"恰恰是最需要显式豁免的东西。所以粒度必须落到批次一级。</p>
 *
 * <p><b>M2 批次登记进度</b>（任务书顺序：lie → sleep → walk → run → jump → play → edge → side → mini）：</p>
 * <ul>
 *   <li>已交付并登记：`poses/sit/`（M2 首批）、`poses/lie/`（`dbd1d524`，28 文件）。</li>
 *   <li>尚未交付、<b>故意不预先登记</b>：sleep / walk / run / jump / play / edge / side / mini。
 *       预先加进来的坏处是：这些批次"历史为空 + 0 tracked"会被"已交付批次整批缺失"判成失败，
 *       把一个正常在产状态误报成缺陷。交付后再加，逐批补。</li>
 * </ul>
 *
 * @type {string[]}
 */
const DELIVERED_PREFIXES = ['v1/', 'v2/', 'v3/', 'v4/', 'p1/', 'poses/sit/', 'poses/lie/', 'poses/sleep/', 'companion/'];

/**
 * 是否把"在产批次（整批未入库）"的警告升级为失败。
 *
 * <p>默认只警告：仓库里同时有美术在产的新批次时，"磁盘有、索引无"是**正常中间态**，
 * 硬失败会让所有人的 `test:pet` 在美术工作期间长期飘红，反而逼着人去删断言。
 * 交付验收/CI 时置 `LX_PET_TRACKING_STRICT=1` 即可让它在产状态也变红
 * （CI 是干净 checkout，没有未跟踪文件，两种模式下结论一致）。</p>
 */
const STRICT_IN_FLIGHT = process.env.LX_PET_TRACKING_STRICT === '1';

/**
 * 取一个资产所属的批次（`v3` / `poses/sit` / `companion/v1`；顶层散文件返回空串）。
 *
 * @param {string} relPath 仓库相对路径（正斜杠）
 * @returns {string} 批次标识
 */
function batchOf(relPath) {
  const inner = relPath.startsWith(`${ASSET_ROOT_REL}/`) ? relPath.slice(ASSET_ROOT_REL.length + 1) : relPath;
  const parts = inner.split('/');
  if (parts.length < 2) return '';
  if (parts[0] === 'poses' || parts[0] === 'companion') {
    return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return parts[0];
}

/**
 * 判断某个批次是否已交付。
 *
 * @param {string} batch {@link batchOf} 的返回值
 * @returns {boolean} 已交付为 true
 */
function isDeliveredBatch(batch) {
  if (batch === '') return false;
  return DELIVERED_PREFIXES.some((prefix) => `${batch}/`.startsWith(prefix));
}

/**
 * 查一个路径在 **git 历史** 里出现过没有（出现过 = 这个批次确实交付过）。
 *
 * <p><b>为什么必须查历史：</b>{@link DELIVERED_PREFIXES} 是手工清单，M2 还有 9 个批次，
 * 每漏加一条，该批次的"整批清空"就从硬失败降级成一行 `console.log`——在几百行测试输出里
 * 没人看得见，而"漏加"本身完全无声。历史是**客观事实**：只要提交过，索引为空就只可能是
 * 被清空（`git rm -r --cached`）或前缀漏加，两者都该红。</p>
 *
 * <p><b>为什么不会误报在产批次：</b>全新批次从未提交过，历史查询返回空串 ⇒ 走"仅警告"分支。
 * 这是硬要求：美术在产的新批次不许被判失败。</p>
 *
 * @param {string} relPath 仓库相对路径（正斜杠），通常是批次目录
 * @returns {string} 最近一次涉及该路径的提交号；历史里没有则返回空串
 */
function lastCommitTouching(relPath) {
  // `git log -1 -- <path>`：路径没历史时退出码仍是 0、输出为空，所以只需判空串
  const { code, stdout } = runGit(['log', '-1', '--format=%H', '--', relPath], { allowExit: [0, 128] });
  if (code !== 0) return '';
  return stdout.trim();
}

/**
 * 会被"外部一次性索引"污染的 git 环境变量（见 {@link runGit} 的 `scrubGitEnv`）。
 *
 * <p>变异自检会用 `GIT_INDEX_FILE` 把子进程的索引指到一次性副本上（这是"不许动真实索引"
 * 的实现方式），所以本文件**必须**尊重继承来的 `GIT_INDEX_FILE`——否则那类变异体永远测不出来。
 * 但"在临时仓库里跑 git"的用例恰恰相反：继承来的 `GIT_DIR`/`GIT_INDEX_FILE` 会把它指到
 * 别的仓库去，必须清掉。</p>
 *
 * @type {string[]}
 */
const GIT_ENV_SCRUB = ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

/**
 * 执行一条 git 命令。
 *
 * @param {string[]} args git 参数（不含 `git` 本身与 `-C`）
 * @param {{input?: string, allowExit?: number[], cwd?: string, scrubGitEnv?: boolean}} [options]
 *   输入、允许的退出码、工作仓库（`cwd` 默认 {@link REPO_ROOT}）、是否清掉继承来的 GIT_* 指向
 * @returns {{code: number, stdout: string, stderr: string}} 执行结果
 * @throws {Error} 退出码既不在允许集合内、也不为 0 时抛出
 */
function runGit(args, options) {
  const opts = options || {};
  const allowExit = Array.isArray(opts.allowExit) ? opts.allowExit : [];
  const repoDir = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : REPO_ROOT;
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env };
  if (opts.scrubGitEnv === true) {
    for (const key of GIT_ENV_SCRUB) delete env[key];
  }
  const proc = spawnSync('git', ['-C', repoDir].concat(args), {
    env,
    input: typeof opts.input === 'string' ? opts.input : undefined,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  if (proc.error) throw new Error(`git ${args.join(' ')} 执行失败：${proc.error.message}`);
  const code = typeof proc.status === 'number' ? proc.status : 1;
  if (code !== 0 && !allowExit.includes(code)) {
    throw new Error(`git ${args.join(' ')} 退出码 ${code}：${(proc.stderr || '').trim()}`);
  }
  return { code, stdout: proc.stdout || '', stderr: proc.stderr || '' };
}

/**
 * 递归列出某个目录下的全部文件（相对仓库根、正斜杠）。
 *
 * @param {string} absDir 目录绝对路径
 * @returns {string[]} 按字典序排序的相对路径
 */
function listFilesRecursive(absDir) {
  /** @type {string[]} */
  const collected = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        collected.push(path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(absDir);
  return collected.sort();
}

/**
 * 用 `git check-ignore --no-index -v -z --stdin` 判定一组路径**按规则**是否被忽略。
 *
 * <p>`-z` 的输出是 4 字段一组：`来源 \0 行号 \0 规则 \0 路径 \0`，没有命中的路径不出现。</p>
 *
 * @param {string[]} relPaths 相对仓库根的路径
 * @returns {Map<string, {source: string, line: string, pattern: string}>} 命中的路径 → 规则详情
 */
function checkIgnoredByRules(relPaths) {
  /** @type {Map<string, {source: string, line: string, pattern: string}>} */
  const ignored = new Map();
  for (let offset = 0; offset < relPaths.length; offset += CHECK_IGNORE_CHUNK) {
    const chunk = relPaths.slice(offset, offset + CHECK_IGNORE_CHUNK);
    const { stdout } = runGit(['check-ignore', '--no-index', '-v', '-z', '--stdin'], {
      input: `${chunk.join('\0')}\0`,
      allowExit: [1],
    });
    const fields = stdout.split('\0');
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const target = fields[i + 3];
      if (target) ignored.set(target, { source: fields[i], line: fields[i + 1], pattern: fields[i + 2] });
    }
  }
  return ignored;
}

/**
 * 读取索引里已跟踪的桌宠资产（相对仓库根）。
 *
 * @returns {Set<string>} 已跟踪路径集合
 */
function listTrackedAssets() {
  const { stdout } = runGit(['ls-files', '-z', '--', ASSET_ROOT_REL]);
  return new Set(stdout.split('\0').filter(Boolean));
}

/**
 * 读取 **HEAD 树**里的桌宠资产（相对仓库根）。
 *
 * <p><b>为什么用 HEAD 树而不是 `git log`：</b>HEAD 树是"这个仓库当前这一版到底有哪些文件"的
 * 客观记录，一次 `ls-tree` 就拿到全量清单；而 `git log -- <path>` 只回答"有没有提交碰过它"，
 * 且<b>依赖完整历史</b>（`--depth 1` 的 CI checkout 上查不到）。判"真丢文件"要的正是前者。</p>
 *
 * <p><b>HEAD 不存在怎么办（空仓库 / 首次提交）：</b>返回 `null`，调用方把所有"磁盘有、索引无"
 * 的文件一律当成**在产新帧**（只警告）。这里绝不能抛异常：新克隆一个还没有提交的仓库时，
 * 守卫必须仍然可跑。</p>
 *
 * @param {string} [repoRoot] 仓库根（默认 {@link REPO_ROOT}；只有"空仓库退化"用例传别的）
 * @returns {Set<string>|null} 相对路径集合；HEAD 树不存在时返回 `null`
 */
function listHeadAssets(repoRoot) {
  const root = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : REPO_ROOT;
  // HEAD 不存在时 git 退出码 128（fatal: Not a valid object name HEAD），这是我们要退化的情形。
  // `ls-tree` 只读 HEAD 树、不读索引，所以顺手清掉继承来的 GIT_* 指向，避免被外部环境带跑。
  const { code, stdout } = runGit(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ASSET_ROOT_REL], {
    cwd: root,
    allowExit: [0, 128],
    scrubGitEnv: true,
  });
  if (code !== 0) return null;
  return new Set(stdout.split('\0').filter(Boolean));
}

/**
 * 判断一个资产是否被白名单豁免。
 *
 * @param {string} relPath 仓库相对路径（正斜杠）
 * @returns {{pattern: RegExp, reason: string}|null} 命中的白名单条目
 */
function findWhitelistEntry(relPath) {
  const inner = relPath.startsWith(`${ASSET_ROOT_REL}/`) ? relPath.slice(ASSET_ROOT_REL.length + 1) : relPath;
  for (const entry of TRACKING_WHITELIST) {
    if (entry.pattern.test(inner)) return entry;
  }
  return null;
}

/**
 * 把命中的规则渲染成可读的行（失败时贴给人看，别只说"有 N 条被忽略"）。
 *
 * @param {Map<string, {source: string, line: string, pattern: string}>} ignored 命中集合
 * @param {number} [limit] 最多列几条
 * @returns {string} 可读文本
 */
function renderIgnored(ignored, limit) {
  const max = typeof limit === 'number' ? limit : 10;
  const lines = [];
  let index = 0;
  for (const [target, rule] of ignored) {
    if (index >= max) {
      lines.push(`  …… 其余 ${ignored.size - max} 条省略`);
      break;
    }
    lines.push(`  ${target}  ← ${rule.source}:${rule.line} ${rule.pattern}`);
    index += 1;
  }
  return lines.join('\n');
}

test('守卫自检：桌宠资产目录存在且非空（否则后面的断言都是真空过）', () => {
  assert.equal(fs.existsSync(ASSET_ROOT_ABS), true, `资产目录不存在：${ASSET_ROOT_ABS}`);
  const files = listFilesRecursive(ASSET_ROOT_ABS);
  assert.ok(files.length >= 100, `资产目录里只有 ${files.length} 个文件，明显不是完整交付，拒绝空跑`);
});

test('守卫自检：判定器确实能识别被忽略的路径（防止检测逻辑退化成恒真）', () => {
  const probe = ['docs/qa/__pet_tracking_probe__.md', `${ASSET_ROOT_REL}/__probe__/x.png`];
  const ignored = checkIgnoredByRules(probe);
  assert.equal(ignored.get(probe[0])?.pattern, '/docs/*', '探测器失灵：docs 下的普通 md 没被判成忽略');
  assert.equal(ignored.has(probe[1]), false, `探测器失灵：${probe[1]} 不该被忽略（规则应已逐级放行 desktop-pet）`);
});

test('规则：desktop-pet 下每个磁盘文件都未被 ignore 命中（新批次不会静默消失）', () => {
  const files = listFilesRecursive(ASSET_ROOT_ABS);
  const ignored = checkIgnoredByRules(files);
  assert.equal(
    ignored.size,
    0,
    `有 ${ignored.size} 个资产被 .gitignore 吞掉（新批次会"交付了但不可复现"）：\n${renderIgnored(ignored)}`,
  );
});

test('规则：docs 下非 desktop-pet 的内容仍被忽略（不许用放宽 docs/ 的办法过测试）', () => {
  const mustIgnore = [
    'docs/qa/sandbox.md',
    'docs/notes/m2-draft.md',
    'docs/assets/m2-future/readme.md',
    'docs/assets/desktop-pet-legacy/x.png',
  ];
  const ignored = checkIgnoredByRules(mustIgnore);
  const leaked = mustIgnore.filter((item) => !ignored.has(item));
  assert.equal(leaked.length, 0, `这些路径没有被忽略，docs/ 的忽略规则被放宽了：${leaked.join('、')}`);
});

test('索引：按来源拆开——HEAD 树里有但索引没有 ⇒ 真丢文件必红；在产新帧只警告', () => {
  const files = listFilesRecursive(ASSET_ROOT_ABS);
  const tracked = listTrackedAssets();
  const head = listHeadAssets();
  assert.ok(tracked.size >= 100, `索引里只有 ${tracked.size} 个桌宠资产，守卫等于空跑`);
  /** 磁盘有、索引无、且未被白名单豁免 —— 先按来源分成两堆，再分别判定。@type {Map<string, string[]>} */
  const lostByBatch = new Map();
  /** @type {Map<string, string[]>} */
  const newFrameByBatch = new Map();
  for (const item of files) {
    if (tracked.has(item)) continue;
    if (findWhitelistEntry(item) !== null) continue;
    // 判据只有这一条：HEAD 树里有 ⇒ 曾经入库过 ⇒ 现在索引里没有就是真丢文件
    const inHeadTree = head !== null && head.has(item);
    const bucket = inHeadTree ? lostByBatch : newFrameByBatch;
    const batch = batchOf(item);
    const list = bucket.get(batch) || [];
    list.push(item);
    bucket.set(batch, list);
  }
  /**
   * 把一批"磁盘有、索引无"的文件渲染成可读的多行文本。
   *
   * @param {Map<string, string[]>} byBatch 批次 → 文件
   * @returns {string} 多行文本
   */
  const renderBatch = (byBatch) => Array.from(byBatch)
    .map(([batch, items]) =>
      `  ${batch || '<资产根下散文件>'}: ${items.slice(0, 5).join('、')}${items.length > 5 ? ` ……共 ${items.length}` : ''}`)
    .join('\n');
  /**
   * 统计某个堆里的文件总数。
   *
   * @param {Map<string, string[]>} byBatch 批次 → 文件
   * @returns {number} 文件总数
   */
  const countAll = (byBatch) => Array.from(byBatch.values()).reduce((sum, items) => sum + items.length, 0);

  // ① 真丢文件：曾经入库过（HEAD 树里有），现在索引里没有。任何模式都不放过。
  const lostTotal = countAll(lostByBatch);
  assert.equal(
    lostTotal,
    0,
    `有 ${lostTotal} 个资产在磁盘上但没入库（HEAD 树里有、索引里没有 ⇒ 真丢文件，换台机器就没了；`
      + `修复：git add <path>）：\n${renderBatch(lostByBatch)}`,
  );

  // ② 在产新帧：磁盘有、索引无、HEAD 里也没有 —— 美术刚画出来还没 add，正常施工态。
  const newTotal = countAll(newFrameByBatch);
  if (newTotal === 0) return;
  if (STRICT_IN_FLIGHT) {
    assert.equal(
      newTotal,
      0,
      `LX_PET_TRACKING_STRICT=1：有 ${newTotal} 个在产新帧还没入库`
        + `（严格模式要求"磁盘 = 索引"；CI 是干净 checkout，正常不会走到这里）：\n${renderBatch(newFrameByBatch)}`,
    );
    return;
  }
  for (const [batch, items] of newFrameByBatch) {
    // 显式打印、不计入通过：绿是"已知有未入库文件"的绿，不是"全都入库了"的绿
    console.log(`[pet-asset] 在产新帧（未入库，未计入通过）：${batch || '<资产根下散文件>'} 共 ${items.length} 个`);
  }
});

test('索引：已交付批次目录不得整批缺失（v1/v2/v3/v4/p1/poses/sit/companion）', () => {
  const tracked = listTrackedAssets();
  const batchDirs = [];
  for (const entry of fs.readdirSync(ASSET_ROOT_ABS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    batchDirs.push(entry.name);
    const abs = path.join(ASSET_ROOT_ABS, entry.name);
    for (const nested of fs.readdirSync(abs, { withFileTypes: true })) {
      if (nested.isDirectory()) batchDirs.push(`${entry.name}/${nested.name}`);
    }
  }
  assert.ok(batchDirs.length > 0, '没有识别到任何批次目录，断言会真空过');
  const emptyDelivered = [];
  const emptyInFlight = [];
  for (const batch of batchDirs) {
    const prefix = `${ASSET_ROOT_REL}/${batch}/`;
    const hasDisk = fs.existsSync(path.join(ASSET_ROOT_ABS, ...batch.split('/')));
    if (!hasDisk) continue;
    const hasTracked = Array.from(tracked).some((item) => item.startsWith(prefix));
    if (hasTracked) continue;
    if (isDeliveredBatch(batch) || STRICT_IN_FLIGHT) emptyDelivered.push(batch);
    else emptyInFlight.push(batch);
  }
  if (emptyInFlight.length > 0) {
    console.log(`[pet-asset] 在产批次目录（索引里为空，未计入通过，仅警告）：${emptyInFlight.join('、')}`);
  }
  assert.equal(
    emptyDelivered.length,
    0,
    `这些已交付批次在磁盘上有、索引里一个文件都没有：${emptyDelivered.join('、')}`,
  );
});

test('索引：git 历史里出现过、但索引整批为空的批次必须红（漏加 DELIVERED_PREFIXES 或索引被清空）', () => {
  // 这条断言专治 DELIVERED_PREFIXES 的**漏加**：
  // 手工清单漏一条 → 该批次的"整批清空"会被上面两条断言降级成警告；历史是客观事实，
  // 用它把"曾交付过但现在索引为空"补齐为硬失败。默认模式与 LX_PET_TRACKING_STRICT=1 下都生效
  //（它不属于"在产宽容"，而是"清空/漏加"检测）。
  const files = listFilesRecursive(ASSET_ROOT_ABS);
  const tracked = listTrackedAssets();
  assert.ok(files.length > 0, '资产目录里一个文件都没有，断言会真空过');
  assert.ok(tracked.size > 0, '索引里一个桌宠资产都没有，断言会真空过');
  /** @type {Map<string, number>} */
  const diskByBatch = new Map();
  for (const item of files) {
    const batch = batchOf(item);
    diskByBatch.set(batch, (diskByBatch.get(batch) || 0) + 1);
  }
  /** @type {Map<string, number>} */
  const trackedByBatch = new Map();
  for (const item of tracked) {
    const batch = batchOf(item);
    trackedByBatch.set(batch, (trackedByBatch.get(batch) || 0) + 1);
  }
  /** @type {Array<{batch: string, diskCount: number, commit: string}>} */
  const emptied = [];
  /** @type {string[]} */
  const freshInFlight = [];
  for (const [batch, diskCount] of diskByBatch) {
    // 资产根目录下的散文件交给上面那条逐文件断言，这里只按批次判
    if (batch === '') continue;
    // 批次里还有 tracked 文件 → "部分缺失"由上面那条逐文件断言负责，这里专管"整批为空"
    if ((trackedByBatch.get(batch) || 0) > 0) continue;
    // 白名单不能豁免这条：历史里出现过 = 确实交付过，与"未交付待入库"的豁免语义互斥
    const batchRel = `${ASSET_ROOT_REL}/${batch}`;
    const commit = lastCommitTouching(batchRel);
    if (commit === '') {
      freshInFlight.push(`${batch}(${diskCount})`);
      continue;
    }
    emptied.push({ batch, diskCount, commit: commit.slice(0, 8) });
  }
  if (freshInFlight.length > 0) {
    // 全新在产批次（历史为空）：只提示、不误报 —— 美术在产的新批次必须保持宽容
    console.log(`[pet-asset] 在产批次（git 历史里查不到，确认为新批次，仅警告）：${freshInFlight.join('、')}`);
  }
  const detail = emptied
    .map(({ batch, diskCount, commit }) =>
      `批次 ${batch} 在 git 历史里存在（曾交付过），但索引为空（磁盘上 ${diskCount} 个文件一个都没入库，最近提交 ${commit}）`
      + ` ⇒ 要么被整批清空（git rm -r --cached），要么 DELIVERED_PREFIXES 漏加。`
      + `修复：git add ${ASSET_ROOT_REL}/${batch} 把文件加回索引，或把 '${batch}/' 加进 DELIVERED_PREFIXES；`
      + `若确实是有意下架，请连目录一起删除并写明理由。`,
    )
    .join('\n');
  assert.equal(emptied.length, 0, `${emptied.length} 个曾交付过的批次现在整批不在索引里：\n${detail}`);
});

test('HEAD 树不存在（空仓库/首次提交）时优雅退化为"全部按在产新帧处理"，不抛异常', () => {
  const dir = path.join(REPO_ROOT, '.lingxi', 'tmp', `pet-head-probe-${process.pid}`);
  const probeRel = `${ASSET_ROOT_REL}/poses/zz-probe/source/f1.png`;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, ASSET_ROOT_REL, 'poses', 'zz-probe', 'source'), { recursive: true });
    fs.writeFileSync(path.join(dir, probeRel), 'probe');
    const init = runGit(['init', '--quiet'], { cwd: dir, scrubGitEnv: true });
    assert.equal(init.code, 0, `git init 失败：${init.stderr}`);
    // 硬要求：没有 HEAD 时不能抛异常，只能返回 null（调用方据此把"磁盘有、索引无"全当在产）
    assert.equal(listHeadAssets(dir), null, '空仓库（HEAD 不存在）必须返回 null，让调用方退化为"在产新帧"');
    const tracked = runGit(['ls-files', '-z', '--', ASSET_ROOT_REL], { cwd: dir, scrubGitEnv: true })
      .stdout.split('\0').filter(Boolean);
    assert.equal(tracked.length, 0, '空仓库里不该有索引条目');
    assert.equal(fs.existsSync(path.join(dir, probeRel)), true, '探针文件应存在于磁盘（三条件成立 ⇒ 在产新帧）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('白名单：每条豁免都必须写明状态/理由/解除条件（防止用白名单绕过入库要求）', () => {
  for (const entry of TRACKING_WHITELIST) {
    assert.equal(entry.pattern instanceof RegExp, true, '白名单条目必须是正则');
    assert.equal(typeof entry.status === 'string' && entry.status.length > 0, true, `白名单条目缺少状态：${String(entry.pattern)}`);
    assert.equal(
      typeof entry.reason === 'string' && entry.reason.trim().length >= 8,
      true,
      `白名单条目缺少可读理由：${String(entry.pattern)}`,
    );
    assert.equal(
      typeof entry.until === 'string' && entry.until.trim().length >= 8,
      true,
      `白名单条目缺少解除条件：${String(entry.pattern)}`,
    );
  }
});

test('白名单：已交付批次（v1/v2/v3/v4/p1/poses）不得被豁免', () => {
  const files = listFilesRecursive(ASSET_ROOT_ABS);
  const abused = files.filter((item) => {
    const inner = item.slice(ASSET_ROOT_REL.length + 1);
    const delivered = DELIVERED_PREFIXES.some((prefix) => inner.startsWith(prefix));
    return delivered && findWhitelistEntry(item) !== null;
  });
  assert.equal(abused.length, 0, `已交付批次被白名单放过（等于放弃可复现）：${abused.slice(0, 10).join('、')}`);
});

test('白名单：pending-delivery 条目不得过期（全部入库后必须摘掉）', () => {
  const files = listFilesRecursive(ASSET_ROOT_ABS);
  const tracked = listTrackedAssets();
  for (const entry of TRACKING_WHITELIST) {
    if (entry.status !== 'pending-delivery') continue;
    const matched = files.filter((item) => entry.pattern.test(item.slice(ASSET_ROOT_REL.length + 1)));
    if (matched.length === 0) continue;
    const untracked = matched.filter((item) => !tracked.has(item));
    assert.ok(
      untracked.length > 0,
      `白名单条目 ${String(entry.pattern)} 已过期：其下 ${matched.length} 个文件全部已入库，请删除该条目（解除条件：${entry.until}）`,
    );
  }
});
