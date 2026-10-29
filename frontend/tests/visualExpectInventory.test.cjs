'use strict';

/**
 * G-10：视觉签字清单（过程证据，必须入仓）与运行时产物（可再生，不入库）解耦的回归测试。
 *
 * <p>这里锁死三件事：
 *  1. <b>路径分离</b>：签字清单在 `frontend/scripts/theme-spec/`（被 git 跟踪），
 *     运行时产物在 `.lingxi/tmp/visual/`（被 gitignore）。这是 G-10 的根因，必须有断言守着。
 *  2. <b>防回退</b>：源码里不许再出现「把 expected-changes.csv 拼到 ARTIFACT_ROOT 下」的写法，
 *     旧的 `CSV_PATH` 常量也不许复活（兼容分支会让路径再次漂移）。
 *  3. <b>三档退出码</b>：`evaluateVerification()` 是纯函数，用构造入参覆盖 0 / 1 / 2 全部矩阵，
 *     不落盘、不操纵 git 索引、不 spawn `--verify`（它要跑等价门禁，CI 上会假红）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ARTIFACT_ROOT,
  SIGNED_CSV_PATH,
  isTrackedByGit,
  evaluateVerification,
} = require('../scripts/visual/expect-inventory.cjs');

/** 脚本自身路径（相对于仓库根被 git 跟踪，用作 isTrackedByGit 的正样本）。 */
const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'visual', 'expect-inventory.cjs');
/** 仓库根：tests/ -> frontend/ -> repo root。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

/**
 * 去掉注释、只留代码，避免「注释里提到 ARTIFACT_ROOT」这类噪声干扰源码扫描断言。
 * @param {string} src 源文本
 * @returns {string} 去掉注释后的代码文本
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CODE = stripComments(SOURCE);

/* ------------------------------------------------------------------ *
 * 1. 路径分离（G-10 根因）
 * ------------------------------------------------------------------ */

test('路径分离：SIGNED_CSV_PATH 位于 scripts/theme-spec 且不含 .lingxi', () => {
  assert.equal(typeof SIGNED_CSV_PATH, 'string', 'SIGNED_CSV_PATH 必须导出为字符串');
  const posix = SIGNED_CSV_PATH.split(path.sep).join('/');
  assert.ok(
    posix.endsWith('/scripts/theme-spec/expected-changes.csv'),
    `签字清单必须落在 frontend/scripts/theme-spec/ 下，实际：${posix}`,
  );
  assert.ok(posix.includes('frontend/scripts/theme-spec'), `签字清单必须在 frontend/scripts/theme-spec 下，实际：${posix}`);
  assert.ok(!posix.includes('.lingxi'), `签字清单不得位于 .lingxi（gitignore 区域），实际：${posix}`);
  assert.ok(!posix.startsWith(ARTIFACT_ROOT), '签字清单不得位于运行时产物根之下');
});

test('路径分离：ARTIFACT_ROOT 指向 .lingxi/tmp/visual 且不含 theme-spec', () => {
  const posix = ARTIFACT_ROOT.split(path.sep).join('/');
  assert.ok(posix.includes('/.lingxi/tmp/visual'), `运行时产物根必须是 .lingxi/tmp/visual，实际：${posix}`);
  assert.ok(!posix.includes('theme-spec'), `运行时产物根不得混入 theme-spec，实际：${posix}`);
  assert.ok(!ARTIFACT_ROOT.split(path.sep).join('/').includes('expected-changes'), '运行时产物根不得包含签字清单名');
});

test('路径分离：两个根互不包含（拆开而不是「两处都能用」）', () => {
  const rel = path.relative(ARTIFACT_ROOT, SIGNED_CSV_PATH);
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `签字清单不得在 ARTIFACT_ROOT 内，相对路径：${rel}`);
  assert.notEqual(path.dirname(SIGNED_CSV_PATH), ARTIFACT_ROOT, '签字清单目录不得等于产物根');
});

/* ------------------------------------------------------------------ *
 * 2. 防回退（源码扫描型）
 * ------------------------------------------------------------------ */

test('防回退：源码中不存在把 expected-changes.csv 拼到 ARTIFACT_ROOT 下的写法', () => {
  const sameLine = CODE.split('\n').filter((line) => /ARTIFACT_ROOT/.test(line) && /expected-changes/.test(line));
  assert.deepEqual(sameLine, [], `不允许同一行同时出现 ARTIFACT_ROOT 与 expected-changes：\n${sameLine.join('\n')}`);

  const genericJoin = /(?:path\s*\.\s*(?:join|resolve)\s*\(|`)[^;`]{0,200}ARTIFACT_ROOT[^;`]{0,200}expected-changes\.csv/;
  assert.ok(!genericJoin.test(CODE), '不允许把 expected-changes.csv 作为 ARTIFACT_ROOT 的子路径拼接');
});

test('防回退：旧常量 CSV_PATH 已不存在', () => {
  assert.ok(!/\bconst\s+CSV_PATH\b/.test(CODE), '旧常量 const CSV_PATH 必须已删除，不得保留兼容分支');
  assert.ok(!/\bCSV_PATH\b/.test(CODE), '源码中不得再出现裸标识符 CSV_PATH（只允许 SIGNED_CSV_PATH）');
});

test('防回退：SIGNED_CSV_PATH 的定义行只引用 theme-spec，不引用 ARTIFACT_ROOT', () => {
  const defLine = CODE.split('\n').find((line) => /\bconst\s+SIGNED_CSV_PATH\b/.test(line));
  assert.ok(defLine, '源码中必须存在 const SIGNED_CSV_PATH 定义');
  assert.ok(defLine.includes('theme-spec'), `定义行必须落在 theme-spec：${defLine.trim()}`);
  assert.ok(defLine.includes('expected-changes.csv'), `定义行必须指向 expected-changes.csv：${defLine.trim()}`);
  assert.ok(!/ARTIFACT_ROOT/.test(defLine), `定义行不得引用 ARTIFACT_ROOT：${defLine.trim()}`);
});

/* ------------------------------------------------------------------ *
 * 3. evaluateVerification 全矩阵（纯函数，纯内存）
 * ------------------------------------------------------------------ */

/** 构造一份「内容完全正确」的清单元信息。 */
function okMeta(overrides = {}) {
  return {
    signedBy: '齐活林',
    signedAt: '2026-10-29T20:00:00+08:00',
    atomCount: 2,
    diffCount: 2,
    listedDiffs: ['a/diff/1.png', 'b/diff/2.png'],
    ...overrides,
  };
}

/** 构造一份「条数与 diff 图一致」的门禁报告。 */
function okGate(atomCount = 2) {
  return { atoms: Array.from({ length: atomCount }, (_, i) => ({ index: i })) };
}

const OK_DIFFS = ['a/diff/1.png', 'b/diff/2.png'];
const TRACKED = { tracked: true, gitAvailable: true, reason: '' };
const UNTRACKED = { tracked: false, gitAvailable: true, reason: '未被 git 跟踪' };
const GIT_MISSING = { tracked: false, gitAvailable: false, reason: 'git 不可用' };

test('矩阵-0：已跟踪 + 签字合法 + 条数一致 + diff 图一致 ⇒ exit 0', () => {
  const result = evaluateVerification({ meta: okMeta(), gate: okGate(), diffImages: OK_DIFFS, trackedState: TRACKED });
  assert.equal(result.exitCode, 0, `应通过，实际失败项：${JSON.stringify(result)}`);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.evidenceFailures, []);
});

test('矩阵-2：清单存在但未跟踪 ⇒ exit 2 且 evidenceFailures 恰好一条', () => {
  const result = evaluateVerification({ meta: okMeta(), gate: okGate(), diffImages: OK_DIFFS, trackedState: UNTRACKED });
  assert.equal(result.exitCode, 2, `未入仓必须给 2，实际 ${result.exitCode}`);
  assert.equal(result.evidenceFailures.length, 1, `evidenceFailures 必须恰好 1 条，实际 ${JSON.stringify(result.evidenceFailures)}`);
  assert.deepEqual(result.failures, [], '内容本身正确时不应有内容故障');
  assert.match(result.evidenceFailures[0], /未纳入版本库/, '证据故障文案必须说明未入仓');
});

test('矩阵-1：已跟踪 + 未签字 ⇒ exit 1', () => {
  const result = evaluateVerification({
    meta: okMeta({ signedBy: null, signedAt: null }),
    gate: okGate(),
    diffImages: OK_DIFFS,
    trackedState: TRACKED,
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.evidenceFailures, []);
  assert.ok(result.failures.some((f) => /未签字/.test(f)), `失败项应包含「未签字」：${JSON.stringify(result.failures)}`);
});

test('矩阵-1：签字人无授权（工程师自签）⇒ exit 1', () => {
  const result = evaluateVerification({
    meta: okMeta({ signedBy: '寇豆码' }),
    gate: okGate(),
    diffImages: OK_DIFFS,
    trackedState: TRACKED,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((f) => /无授权/.test(f)), `失败项应包含「无授权」：${JSON.stringify(result.failures)}`);
});

test('矩阵-1：白名单 summit / 科比 / 齐活林 / Qi 全部放行（权限判定不得误杀）', () => {
  for (const signer of ['summit', '科比', '齐活林', 'Qi']) {
    const result = evaluateVerification({
      meta: okMeta({ signedBy: signer }),
      gate: okGate(),
      diffImages: OK_DIFFS,
      trackedState: TRACKED,
    });
    assert.equal(result.exitCode, 0, `签字人 ${signer} 在白名单内，应通过：${JSON.stringify(result.failures)}`);
  }
});

test('矩阵-1：atomCount === -1（旧格式清单）⇒ exit 1', () => {
  const result = evaluateVerification({
    meta: okMeta({ atomCount: -1 }),
    gate: okGate(),
    diffImages: OK_DIFFS,
    trackedState: TRACKED,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((f) => /旧格式/.test(f)), `失败项应包含「旧格式」：${JSON.stringify(result.failures)}`);
});

test('矩阵-1：atomCount 与实际条数不符 ⇒ exit 1', () => {
  const result = evaluateVerification({
    meta: okMeta({ atomCount: 3 }),
    gate: okGate(2),
    diffImages: OK_DIFFS,
    trackedState: TRACKED,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((f) => /预期变更条目/.test(f)), `失败项应包含条目数不一致：${JSON.stringify(result.failures)}`);
});

test('矩阵-1：diffCount 与实际 diff 图数量不符 ⇒ exit 1', () => {
  const result = evaluateVerification({
    meta: okMeta({ diffCount: 1 }),
    gate: okGate(),
    diffImages: OK_DIFFS,
    trackedState: TRACKED,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((f) => /diff 图数量/.test(f)), `失败项应包含 diff 数量不一致：${JSON.stringify(result.failures)}`);
});

test('矩阵-1：清单漏列 diff 图 ⇒ exit 1', () => {
  const result = evaluateVerification({
    meta: okMeta({ listedDiffs: ['a/diff/1.png'] }),
    gate: okGate(),
    diffImages: OK_DIFFS,
    trackedState: TRACKED,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((f) => /漏列/.test(f)), `失败项应包含「漏列」：${JSON.stringify(result.failures)}`);
});

test('矩阵-1：清单多列了不存在的 diff 图 ⇒ exit 1', () => {
  const result = evaluateVerification({
    meta: okMeta({ listedDiffs: ['a/diff/1.png', 'b/diff/2.png', 'ghost/diff/9.png'] }),
    gate: okGate(),
    diffImages: OK_DIFFS,
    trackedState: TRACKED,
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some((f) => /不存在/.test(f)), `失败项应包含「不存在」：${JSON.stringify(result.failures)}`);
});

test('矩阵-git 不可用：不因「没 git」判红 ⇒ exit 0', () => {
  const result = evaluateVerification({ meta: okMeta(), gate: okGate(), diffImages: OK_DIFFS, trackedState: GIT_MISSING });
  assert.equal(result.exitCode, 0, `git 不可用时应跳过「已入仓」检查，实际 ${result.exitCode}`);
  assert.deepEqual(result.evidenceFailures, [], 'git 不可用时不得推进 evidenceFailures（WARN 由 main() 打印）');
});

test('矩阵-优先级：未跟踪 + 内容不符 ⇒ exit 2（过程证据故障优先）', () => {
  const result = evaluateVerification({
    meta: okMeta({ signedBy: null, signedAt: null, atomCount: 5, diffCount: 0, listedDiffs: [] }),
    gate: okGate(),
    diffImages: OK_DIFFS,
    trackedState: UNTRACKED,
  });
  assert.ok(result.failures.length > 0, '内容确实不符时 failures 必须非空');
  assert.equal(result.evidenceFailures.length, 1);
  assert.equal(result.exitCode, 2, `未跟踪压过内容不一致，必须是 2，实际 ${result.exitCode}`);
});

test('矩阵-契约：返回值结构固定为 {failures, evidenceFailures, exitCode}', () => {
  const result = evaluateVerification({ meta: okMeta(), gate: okGate(), diffImages: OK_DIFFS, trackedState: TRACKED });
  assert.deepEqual(Object.keys(result).sort(), ['evidenceFailures', 'exitCode', 'failures']);
  assert.ok(Array.isArray(result.failures) && Array.isArray(result.evidenceFailures));
  assert.equal(typeof result.exitCode, 'number');
  assert.ok([0, 1, 2].includes(result.exitCode), 'exitCode 只能是 0 / 1 / 2 三档之一');
});

/* ------------------------------------------------------------------ *
 * 4. isTrackedByGit
 * ------------------------------------------------------------------ */

test('isTrackedByGit：已入仓文件（脚本自身）返回 tracked:true, gitAvailable:true', () => {
  const state = isTrackedByGit(SCRIPT_PATH);
  assert.equal(state.gitAvailable, true, `当前环境应有可用 git：${state.reason}`);
  assert.equal(state.tracked, true, `expect-inventory.cjs 应已被 git 跟踪：${state.reason}`);
});

test('isTrackedByGit：仓库内不存在的路径返回 tracked:false', () => {
  const state = isTrackedByGit(path.join(REPO_ROOT, '.lingxi', 'tmp', 'g10-mut', 'definitely-missing-file.xyz'));
  assert.equal(state.gitAvailable, true, `当前环境应有可用 git：${state.reason}`);
  assert.equal(state.tracked, false, '不存在的路径不得被判定为已跟踪');
});

/* ------------------------------------------------------------------ *
 * 5. --help（唯一允许的 spawn：不跑门禁）
 * ------------------------------------------------------------------ */

test('--help：退出码 0，且同时展示入仓路径与运行时产物路径', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const stdout = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 0, `--help 应退出 0，实际 ${result.status}：${stdout}`);
  assert.ok(stdout.includes('frontend/scripts/theme-spec/expected-changes.csv'), `--help 必须打印入仓路径：${stdout}`);
  assert.ok(stdout.includes('.lingxi/tmp/visual'), `--help 必须打印运行时产物路径：${stdout}`);
});
