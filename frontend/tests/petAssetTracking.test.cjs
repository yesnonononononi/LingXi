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
 * `reason`（为什么它可以暂不入库）、`until`（解除条件）。当前只有一条：
 * companion（云灵）美术仍在产，主理人确认交付后才单独入库。</p>
 *
 * <p><b>为什么不能写成自动跳过：</b>如果"未跟踪就跳过"，那么把 `.gitignore` 退回 `docs/`
 * 之后（变异体 `gitignore-desktop-pet-exception-removed`）所有文件都"未跟踪"，
 * 测试会集体静默放行，M1 就杀不死了。显式清单 + 下文的"已交付路径不得豁免"断言
 * 把放水面锁死在一处，且过期必须摘掉。</p>
 *
 * @type {Array<{pattern: RegExp, status: string, reason: string, until: string}>}
 */
const TRACKING_WHITELIST = [
  {
    pattern: /^companion\//,
    status: 'pending-delivery',
    reason: 'companion（云灵）美术仍在产，v1 当前是中间态；入库会留下"看似定稿实则待改"的资产',
    until: '主理人确认 companion 交付后再单独入库，并同步删除本条',
  },
];

/**
 * **已交付**的批次前缀：这些路径不允许出现在白名单里。
 *
 * <p>白名单只用于"还没交付"的东西。已交付批次若被豁免，等于把"必须可复现"的承诺作废，
 * 所以这里单独断言一层（新增批次时把前缀加进来）。</p>
 *
 * @type {string[]}
 */
const DELIVERED_PREFIXES = ['v1/', 'v2/', 'v3/', 'v4/', 'p1/', 'poses/'];

/**
 * 执行一条 git 命令。
 *
 * @param {string[]} args git 参数（不含 `git` 本身与 `-C`）
 * @param {{input?: string, allowExit?: number[]}} [options] 输入与允许的退出码
 * @returns {{code: number, stdout: string, stderr: string}} 执行结果
 * @throws {Error} 退出码既不在允许集合内、也不为 0 时抛出
 */
function runGit(args, options) {
  const opts = options || {};
  const allowExit = Array.isArray(opts.allowExit) ? opts.allowExit : [];
  const proc = spawnSync('git', ['-C', REPO_ROOT].concat(args), {
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

test('索引：desktop-pet 下每个磁盘文件都已入库（白名单除外）', () => {
  const files = listFilesRecursive(ASSET_ROOT_ABS);
  const tracked = listTrackedAssets();
  const missing = files.filter((item) => !tracked.has(item) && findWhitelistEntry(item) === null);
  assert.equal(
    missing.length,
    0,
    `有 ${missing.length} 个资产在磁盘上但没入库（换台机器就没了；修复：git add <path>）：\n${missing
      .slice(0, 10)
      .map((item) => `  ${item}`)
      .join('\n')}`,
  );
});

test('索引：每个实际存在的批次目录都在索引里（v1/v2/v3/v4/p1/poses/*/companion/*）', () => {
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
  const empty = [];
  const exempted = [];
  for (const batch of batchDirs) {
    const prefix = `${ASSET_ROOT_REL}/${batch}/`;
    const hasTracked = Array.from(tracked).some((item) => item.startsWith(prefix));
    const hasDisk = fs.existsSync(path.join(ASSET_ROOT_ABS, ...batch.split('/')));
    if (!hasDisk) continue;
    if (hasTracked) continue;
    // 整批都被白名单豁免（例如 companion 未交付）才算合法例外；否则是真漏
    const batchFiles = listFilesRecursive(path.join(ASSET_ROOT_ABS, ...batch.split('/')));
    const allWhitelisted = batchFiles.length > 0 && batchFiles.every((item) => findWhitelistEntry(item) !== null);
    if (allWhitelisted) {
      exempted.push(batch);
      continue;
    }
    empty.push(batch);
  }
  if (exempted.length > 0) console.log(`[pet-asset] 白名单豁免的批次（未交付）：${exempted.join('、')}`);
  assert.equal(empty.length, 0, `这些批次目录在磁盘上有、索引里一个文件都没有：${empty.join('、')}`);
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
