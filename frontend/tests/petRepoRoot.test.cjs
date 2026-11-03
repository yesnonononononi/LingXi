'use strict';
/**
 * 仓库根探测（`scripts/lib/repo-root.cjs`）的单测：纯 Node、零依赖、离线。
 *
 * <p><b>为什么这组用例必须存在：</b>守卫的产物目录以前是"向上数三层"算出来的
 * （`path.resolve(FRONTEND_ROOT, '..', '..', '..')`）。这个写法在隔离工作树布局下恰好算对，
 * 于是本地一直是绿的；但主仓 `D:\Code\LingXi\frontend` 三层向上是 `D:\`，产物落到
 * `D:\tmp\pet-face-guard` —— **工作区之外**。这类缺陷的形态是"在一棵树上对、在另一棵树上错"，
 * 只有把**两种布局都跑一遍**才抓得住，否则修法和测试会一起长歪。</p>
 *
 * <p>覆盖：主仓/工作树布局、隔离工作树布局（`top/x/work/task/frontend` + 顶层 `.lingxi`）、
 * 就近优先、找不到仓库时返回 null 且不把盘符根当仓库根、`lingxiTmpDir` 的落点与逃逸校验、
 * 以及守卫确实接线到本模块（不许再写死层数）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findRepoRoot, lingxiTmpDir, REPO_MARKERS } = require('../scripts/lib/repo-root.cjs');

/** 本用例所在的 frontend 目录（主仓与工作树都适用）。 */
const FRONTEND_ROOT = path.resolve(__dirname, '..');

/** 期望的仓库根：frontend 的上一级（主仓是默认分支的工作区，工作树里则是 worktree 根）。 */
const EXPECTED_REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');

/** 盘符根（Windows 为 `D:\`，POSIX 为 `/`）。 */
const DRIVE_ROOT = path.parse(FRONTEND_ROOT).root;

/** 每个用例自己建 fixture 子目录，`after` 统一删掉（不留 `%TEMP%` 垃圾）。 */
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-repo-root-'));

test.after(() => {
  try {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  } catch {
    // 清理失败不影响结论（只是临时目录），但不要吞掉用例结果
  }
});

/**
 * 造一棵假的目录树（只建目录与标记文件，不建源码）。
 *
 * @param {string} name fixture 名（在 FIXTURE_ROOT 下）
 * @param {string[]} dirs 需要创建的相对目录（POSIX 风格）
 * @param {string[]} markers 需要在哪个相对目录放 `.lingxi`（POSIX 风格，空串表示 fixture 根）
 * @returns {string} fixture 根目录绝对路径
 */
function makeFixtureTree(name, dirs, markers) {
  const root = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(root, { recursive: true });
  for (const rel of dirs) fs.mkdirSync(path.join(root, ...rel.split('/')), { recursive: true });
  for (const rel of markers) {
    const markerDir = rel.length === 0 ? root : path.join(root, ...rel.split('/'));
    fs.mkdirSync(markerDir, { recursive: true });
    fs.mkdirSync(path.join(markerDir, '.lingxi'), { recursive: true });
  }
  return root;
}

/**
 * 断言某个路径不是盘符根（原始缺陷会返回 `D:\` 这种值）。
 *
 * @param {string|null} value 待检查值
 * @param {string} message 断言消息
 * @returns {void}
 */
function assertNotDriveRoot(value, message) {
  assert.ok(value !== null, message);
  assert.notEqual(value, path.parse(value).root, message);
}

test('主仓/工作树布局：frontend 的上一级就是仓库根，且绝不是盘符根', () => {
  const root = findRepoRoot(FRONTEND_ROOT);
  assert.equal(root, EXPECTED_REPO_ROOT, '主仓布局下仓库根必须是 frontend 的上一级');
  assertNotDriveRoot(root, '仓库根绝不能是盘符根（原始缺陷会返回 D:\\）');
  assert.ok(
    REPO_MARKERS.some((marker) => fs.existsSync(path.join(root, marker))),
    `仓库根 ${root} 必须含 ${REPO_MARKERS.join('/')} 之一`,
  );
});

test('隔离工作树布局：top/x/work/task/frontend 必须找到顶层 top，而不是 top/x', () => {
  const top = makeFixtureTree('worktree', ['x/work/task/frontend'], ['']);
  const frontend = path.join(top, 'x', 'work', 'task', 'frontend');
  const root = findRepoRoot(frontend);
  assert.equal(root, top, '隔离工作树布局下仓库根必须是顶层（含 .lingxi 的那一层）');
  assert.equal(
    root !== path.resolve(frontend, '..', '..', '..'),
    true,
    '隔离工作树布局下必须找到顶层仓库根，不能靠固定层数（三层向上会得到 top/x）',
  );
  // 产物目录必须挂在顶层 `.lingxi/tmp` 下，不是 top/x 下
  assert.equal(
    lingxiTmpDir(frontend, 'pet-face-guard'),
    path.join(top, '.lingxi', 'tmp', 'pet-face-guard'),
    '隔离工作树布局下产物目录必须是 <顶层>/.lingxi/tmp/<名字>',
  );
});

test('就近优先：离得更近的 .lingxi 胜出（不越过第一个标记继续往上找）', () => {
  const top = makeFixtureTree('nearest', ['x/work/task/frontend'], ['', 'x']);
  const frontend = path.join(top, 'x', 'work', 'task', 'frontend');
  assert.equal(
    findRepoRoot(frontend),
    path.join(top, 'x'),
    '必须返回第一个（最近的）含标记目录，而不是最顶层的那个',
  );
});

test('回归（核心）：守卫的产物目录落在 <repo>/.lingxi/tmp 内，且不等于盘符根的 tmp', () => {
  const repoRoot = findRepoRoot(FRONTEND_ROOT);
  const guardRoot = lingxiTmpDir(FRONTEND_ROOT, 'pet-face-guard');
  const tmpRoot = path.join(repoRoot, '.lingxi', 'tmp');
  const relative = path.relative(tmpRoot, guardRoot);
  assert.equal(
    relative.startsWith('..') || path.isAbsolute(relative),
    false,
    `守卫产物目录必须落在 ${tmpRoot} 之内，实际 ${guardRoot}`,
  );
  assertNotDriveRoot(guardRoot, '守卫产物目录绝不能是盘符根');
  assert.notEqual(
    path.resolve(guardRoot),
    path.resolve(path.join(DRIVE_ROOT, 'tmp', 'pet-face-guard')),
    '守卫产物目录必须落在仓库内 .lingxi/tmp 下，不许落到盘符根的 tmp（原始缺陷形态：D:\\tmp\\pet-face-guard）',
  );
  assert.equal(
    path.resolve(guardRoot),
    path.resolve(path.join(repoRoot, '.lingxi', 'tmp', 'pet-face-guard')),
    `守卫产物目录必须是 <repo>/.lingxi/tmp/pet-face-guard，实际 ${guardRoot}`,
  );
});

test('找不到仓库时返回 null（绝不把盘符根当仓库根），并且 lingxiTmpDir 抛明确错误', () => {
  // 前置条件：盘符根本身不能带标记，否则这个场景在物理上不成立
  for (const marker of REPO_MARKERS) {
    assert.equal(
      fs.existsSync(path.join(DRIVE_ROOT, marker)),
      false,
      `前置条件不成立：盘符根 ${DRIVE_ROOT} 下存在 ${marker}，无法构造"无仓库标记"的场景`,
    );
  }
  assert.equal(findRepoRoot(DRIVE_ROOT), null, '从盘符根向上找不到标记时必须返回 null，不能返回盘符根');
  assert.throws(
    () => lingxiTmpDir(DRIVE_ROOT, 'pet-face-guard'),
    /请从仓库内运行/,
    '判断不出仓库根时必须抛错并给出"请从仓库内运行"的修法，不能静默退回猜测路径',
  );
});

test('参数校验：非法 startDir / 非法 segment / 逃逸路径都必须显式失败', () => {
  assert.throws(() => findRepoRoot(''), TypeError);
  assert.throws(() => findRepoRoot(null), TypeError);
  assert.throws(() => findRepoRoot(undefined), TypeError);
  assert.throws(() => lingxiTmpDir(FRONTEND_ROOT, '..', '..'), RangeError);
  assert.throws(() => lingxiTmpDir(FRONTEND_ROOT, {}), TypeError);
  // 数字 segment 是合法的（拼接成目录名），不要因为"想加校验"把它拒了
  assert.equal(
    lingxiTmpDir(FRONTEND_ROOT, 42),
    path.join(findRepoRoot(FRONTEND_ROOT), '.lingxi', 'tmp', '42'),
    '数字 segment 应被接受并拼成目录名',
  );
});

/**
 * 去掉 CJS 源码里的注释（`//` 与 `/* *\/`），只留代码。
 *
 * <p>为什么要去注释：守卫的 JSDoc 里**必须**写清"历史上的固定层数写法错在哪"，
 * 那是给下一个人看的；但"注释里提到过"不等于"代码里还在用"。不过滤的话，
 * 一条有用的注释会让这条断言假红，久而久之就会有人把它删掉换绿。</p>
 *
 * @param {string} source 源码全文
 * @returns {string} 去掉注释后的文本
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('守卫接线：pet-face-visual-guard.cjs 必须用真源判定仓库根，不许再写死向上层数', () => {
  const guardPath = path.join(FRONTEND_ROOT, 'scripts', 'pet-face-visual-guard.cjs');
  const source = fs.readFileSync(guardPath, 'utf8');
  assert.match(
    source,
    /require\(path\.join\(__dirname, 'lib', 'repo-root\.cjs'\)\)/,
    '守卫必须 require scripts/lib/repo-root.cjs（仓库根的唯一真源）',
  );
  assert.match(source, /lingxiTmpDir\(FRONTEND_ROOT, 'pet-face-guard'\)/, '守卫必须用 lingxiTmpDir 算产物目录');
  const code = stripComments(source);
  const fixedLevels = `path.resolve(FRONTEND_ROOT, '..', '..', '..')`;
  assert.equal(
    code.includes(fixedLevels),
    false,
    '守卫不许再写死"向上三层"算仓库根（主仓下会算到盘符根，产物跑到工作区之外）',
  );
});
