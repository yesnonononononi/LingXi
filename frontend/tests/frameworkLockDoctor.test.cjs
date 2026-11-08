/**
 * 框架锁文件体检（framework-lock-doctor.mjs）单测。
 *
 * <p><b>零副作用约定</b>：本文件不访问网络、不调用真实 git、不读真实仓库 —— 全部走脚本暴露的
 * 纯函数与可注入依赖（假 git 执行器 / 假 exists / 假临时目录），因此离线和 CI 上都可跑。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const doctorModule = import('../scripts/framework-lock-doctor.mjs');

const REF_HARNESS = '9e1480612aad6159e87be29d4964ee1caa1e1139';
const REF_DDD = 'b9e762f90d24137d5bfcde6296a75ff3faca3fde';
const REF_ADVANCED = '5a931c2f0b16ffa7427c7c4ea158fdebcd39b35d';

/** 合法的锁文件对象（与仓库真实结构一致）。 */
const validLock = () => ({
  schemaVersion: 1,
  frameworks: {
    harness: {repository: 'yesnonononononi/lingxi-harness-starter', ref: REF_HARNESS, version: '1.1.8-SNAPSHOT'},
    ddd: {repository: 'yesnonononononi/dev-framework-ddd-starter', ref: REF_DDD, version: '1.0.7'},
  },
});

/**
 * 假 git 执行器：按「子命令 + 关键参数」路由返回预设结果，并记录调用。
 *
 * @param {object} routes 路由表：键为匹配片段数组，值为 `{status, stdout, stderr}`
 * @returns {{calls: Array<{args: string[], cwd: string}>, git: Function}}
 */
function fakeGit(routes) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push({args, cwd});
    for (const [signature, result] of Object.entries(routes)) {
      const parts = signature.split(' ');
      if (parts.every((part) => args.includes(part))) {
        return {status: 0, stdout: '', stderr: '', ...result};
      }
    }
    return {status: 1, stdout: '', stderr: `unrouted git call: ${args.join(' ')}`};
  };
  return {calls, git};
}

/** 一个「本地框架一切正常」的路由表。 */
const healthyRoutes = (head = REF_HARNESS) => ({
  'cat-file -e': {status: 0},
  'branch -r --contains': {status: 0, stdout: `origin/main\n`},
  'rev-parse HEAD': {status: 0, stdout: `${head}\n`},
  'merge-base --is-ancestor': {status: 1},
  'rev-list --count': {status: 0, stdout: '0\n'},
});

test('parseFrameworkLock：解析真实结构，保留 id / repository / ref / version', async () => {
  const {parseFrameworkLock} = await doctorModule;
  const parsed = parseFrameworkLock(JSON.stringify(validLock()));
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.frameworks.map((entry) => entry.id), ['harness', 'ddd']);
  const harness = parsed.frameworks[0];
  assert.equal(harness.repository, 'yesnonononononi/lingxi-harness-starter');
  assert.equal(harness.ref, REF_HARNESS);
  assert.equal(harness.version, '1.1.8-SNAPSHOT');
});

test('parseFrameworkLock：非法 JSON / 版本 / 结构 / 条目一律抛错（不静默放过）', async () => {
  const {parseFrameworkLock} = await doctorModule;
  assert.throws(() => parseFrameworkLock('{oops'), /不是合法 JSON/);
  assert.throws(() => parseFrameworkLock({schemaVersion: 2, frameworks: {}}), /版本不支持/);
  assert.throws(() => parseFrameworkLock({schemaVersion: 1}), /frameworks 对象/);
  assert.throws(() => parseFrameworkLock({schemaVersion: 1, frameworks: {}}), /frameworks 为空/);
  assert.throws(
    () => parseFrameworkLock({schemaVersion: 1, frameworks: {harness: {repository: 'x', ref: REF_HARNESS, version: '1.0.0'}}}),
    /repository 必须形如 owner\/repo/
  );
  assert.throws(
    () => parseFrameworkLock({schemaVersion: 1, frameworks: {harness: {repository: 'a/b', ref: 'main', version: '1.0.0'}}}),
    /完整的 40 位 commit SHA/
  );
  assert.throws(
    () => parseFrameworkLock({schemaVersion: 1, frameworks: {harness: {repository: 'a/b', ref: REF_HARNESS, version: 'v1'}}}),
    /version 必须形如/
  );
});

test('resolveFrameworkPath：环境变量优先，其次内置默认表，未知框架返回 null', async () => {
  const {resolveFrameworkPath, DEFAULT_FRAMEWORK_PATHS} = await doctorModule;
  assert.equal(resolveFrameworkPath('harness', {LINGXI_FRAMEWORK_HARNESS: 'E:/custom/harness'}), 'E:/custom/harness');
  assert.equal(resolveFrameworkPath('harness', {}), DEFAULT_FRAMEWORK_PATHS.harness);
  assert.equal(resolveFrameworkPath('ddd', {}), DEFAULT_FRAMEWORK_PATHS.ddd);
  assert.equal(resolveFrameworkPath('harness', {LINGXI_FRAMEWORK_HARNESS: '   '}), DEFAULT_FRAMEWORK_PATHS.harness);
  assert.equal(resolveFrameworkPath('brand-new', {}), null, '未知框架且无默认值 → null（调用方 SKIP）');
  assert.equal(resolveFrameworkPath('brand-new', {LINGXI_FRAMEWORK_BRAND_NEW: 'E:/nb'}), 'E:/nb');
});

test('classifyLocalProbe：ref 本地缺失 → FAIL', async () => {
  const {classifyLocalProbe, STATUS} = await doctorModule;
  const result = classifyLocalProbe({
    id: 'harness', ref: REF_HARNESS, refPresent: false, remoteContains: false, head: null,
    refIsAncestorOfHead: false, headIsAncestorOfRef: false, commitsAhead: null,
  });
  assert.equal(result.status, STATUS.FAIL);
  assert.equal(result.scope, '本地');
  assert.match(result.message, /本地不存在/);
  assert.match(result.message, new RegExp(REF_HARNESS.slice(0, 8)));
});

test('classifyLocalProbe：远端分支未包含 → FAIL（提示先 push）', async () => {
  const {classifyLocalProbe, STATUS} = await doctorModule;
  const result = classifyLocalProbe({
    id: 'harness', ref: REF_HARNESS, refPresent: true, remoteContains: false, head: REF_HARNESS,
    refIsAncestorOfHead: false, headIsAncestorOfRef: false, commitsAhead: null,
  });
  assert.equal(result.status, STATUS.FAIL);
  assert.match(result.message, /未推送/);
  assert.match(result.message, /先 push/);
  assert.match(result.message, /别人 clone 拉不到/);
});

test('classifyLocalProbe：HEAD === ref → OK；HEAD 领先 → WARN（含提交数）', async () => {
  const {classifyLocalProbe, STATUS} = await doctorModule;
  assert.equal(classifyLocalProbe({
    id: 'harness', ref: REF_HARNESS, refPresent: true, remoteContains: true, head: REF_HARNESS,
    refIsAncestorOfHead: false, headIsAncestorOfRef: false, commitsAhead: null,
  }).status, STATUS.OK);

  const ahead = classifyLocalProbe({
    id: 'harness', ref: REF_HARNESS, refPresent: true, remoteContains: true, head: REF_ADVANCED,
    refIsAncestorOfHead: true, headIsAncestorOfRef: false, commitsAhead: 3,
  });
  assert.equal(ahead.status, STATUS.WARN);
  assert.match(ahead.message, /比锁文件新 3 个提交/);
  assert.match(ahead.message, /framework:lock/);
  assert.match(ahead.message, /推送/);

  // 提交数未知也要给出可读文案（不出现 "null 个提交"）
  const unknownCount = classifyLocalProbe({
    id: 'harness', ref: REF_HARNESS, refPresent: true, remoteContains: true, head: REF_ADVANCED,
    refIsAncestorOfHead: true, headIsAncestorOfRef: false, commitsAhead: null,
  });
  assert.equal(unknownCount.status, STATUS.WARN);
  assert.doesNotMatch(unknownCount.message, /null/);
});

test('classifyLocalProbe：本地落后 / 无共同祖先 → FAIL', async () => {
  const {classifyLocalProbe, STATUS} = await doctorModule;
  const behind = classifyLocalProbe({
    id: 'harness', ref: REF_HARNESS, refPresent: true, remoteContains: true, head: REF_ADVANCED,
    refIsAncestorOfHead: false, headIsAncestorOfRef: true, commitsAhead: null,
  });
  assert.equal(behind.status, STATUS.FAIL);
  assert.match(behind.message, /落后/);

  const unrelated = classifyLocalProbe({
    id: 'harness', ref: REF_HARNESS, refPresent: true, remoteContains: true, head: REF_ADVANCED,
    refIsAncestorOfHead: false, headIsAncestorOfRef: false, commitsAhead: null,
  });
  assert.equal(unrelated.status, STATUS.FAIL);
  assert.match(unrelated.message, /无共同祖先/);
});

test('evaluateLocal：仓不存在 → SKIP 且不调用 git（CI 场景）', async () => {
  const {evaluateLocal, STATUS, parseFrameworkLock} = await doctorModule;
  const {git, calls} = fakeGit(healthyRoutes());
  const results = evaluateLocal({
    entries: parseFrameworkLock(validLock()).frameworks,
    env: {},
    exists: () => false,
    git,
  });
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, STATUS.SKIP);
    assert.match(result.message, /CI 上属正常/);
  }
  assert.equal(calls.length, 0, '没有仓就不该调 git');
});

test('evaluateLocal：注入假 git 复现「本地 HEAD 领先锁文件」→ WARN', async () => {
  const {evaluateLocal, STATUS, parseFrameworkLock} = await doctorModule;
  const {git} = fakeGit({
    'cat-file -e': {status: 0},
    'branch -r --contains': {status: 0, stdout: 'origin/main\n'},
    'rev-parse HEAD': {status: 0, stdout: `${REF_ADVANCED}\n`},
    'merge-base --is-ancestor': {status: 0}, // ref 是 HEAD 的祖先
    'rev-list --count': {status: 0, stdout: '2\n'},
  });
  const results = evaluateLocal({
    entries: parseFrameworkLock(validLock()).frameworks,
    env: {LINGXI_FRAMEWORK_HARNESS: 'E:/h', LINGXI_FRAMEWORK_DDD: 'E:/d'},
    exists: () => true,
    git,
  });
  for (const result of results) {
    assert.equal(result.status, STATUS.WARN);
    assert.match(result.message, /比锁文件新 2 个提交/);
  }
});

test('evaluateLocal：远端未包含时先 fetch --prune origin 再判 → 仍 FAIL', async () => {
  const {evaluateLocal, STATUS, parseFrameworkLock} = await doctorModule;
  const {git, calls} = fakeGit({
    'cat-file -e': {status: 0},
    'branch -r --contains': {status: 0, stdout: ''},
    'fetch --prune origin': {status: 0},
    'rev-parse HEAD': {status: 0, stdout: `${REF_HARNESS}\n`},
  });
  const results = evaluateLocal({
    entries: parseFrameworkLock(validLock()).frameworks.slice(0, 1),
    env: {LINGXI_FRAMEWORK_HARNESS: 'E:/h'},
    exists: () => true,
    git,
  });
  assert.equal(results[0].status, STATUS.FAIL);
  assert.match(results[0].message, /未推送/);
  assert.ok(calls.some((call) => call.args.join(' ') === 'fetch --prune origin'), '必须先抓一次远端再判');
  assert.equal(calls.filter((call) => call.args.join(' ') === 'branch -r --contains ' + REF_HARNESS).length, 2, '抓取后要复查一次');
});

test('evaluateRemote：fetch 失败 → FAIL，且临时目录一定被清理', async () => {
  const {evaluateRemote, STATUS, parseFrameworkLock} = await doctorModule;
  const removed = [];
  const {git, calls} = fakeGit({init: {status: 0}, fetch: {status: 128, stderr: 'fatal: could not read from remote'}});
  const results = evaluateRemote({
    entries: parseFrameworkLock(validLock()).frameworks,
    git,
    makeTempDir: (id) => `tmp/${id}`,
    removeTempDir: (directory) => removed.push(directory),
  });
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.status, STATUS.FAIL);
    assert.equal(result.scope, '远端');
    assert.match(result.message, /远端拉不到/);
    assert.match(result.message, /could not read from remote/);
    assert.match(result.message, /先 push 或重新锁定/);
  }
  assert.deepEqual(removed, ['tmp/harness', 'tmp/ddd'], '失败也必须清理临时目录');
  assert.ok(calls.every((call) => call.args[0] === 'init' || call.args[0] === 'fetch'));
  // fetch 用的是锁文件里的仓库与 ref
  const fetchCall = calls.find((call) => call.args[0] === 'fetch');
  assert.deepEqual(fetchCall.args, ['fetch', '--depth=1', 'https://github.com/yesnonononononi/lingxi-harness-starter.git', REF_HARNESS]);
});

test('evaluateRemote：fetch 成功 → OK；临时目录同样清理', async () => {
  const {evaluateRemote, STATUS, parseFrameworkLock} = await doctorModule;
  const removed = [];
  const {git} = fakeGit({init: {status: 0}, fetch: {status: 0}});
  const results = evaluateRemote({
    entries: parseFrameworkLock(validLock()).frameworks,
    git,
    makeTempDir: (id) => `tmp/${id}`,
    removeTempDir: (directory) => removed.push(directory),
  });
  for (const result of results) {
    assert.equal(result.status, STATUS.OK);
    assert.match(result.message, /远端可达/);
  }
  assert.deepEqual(removed, ['tmp/harness', 'tmp/ddd']);
});

test('evaluateRemote：makeTempDir 抛错也不吞异常成因（判 FAIL）', async () => {
  const {evaluateRemote, STATUS, parseFrameworkLock} = await doctorModule;
  const {git} = fakeGit({});
  const results = evaluateRemote({
    entries: parseFrameworkLock(validLock()).frameworks.slice(0, 1),
    git,
    makeTempDir: () => { throw new Error('disk full'); },
    removeTempDir: () => { throw new Error('should not be called'); },
  });
  assert.equal(results[0].status, STATUS.FAIL);
  assert.match(results[0].message, /disk full/);
});

test('summarizeResults / resolveExitCode：只有 WARN/SKIP → 0；--strict 下 WARN → 1；FAIL 恒 1', async () => {
  const {summarizeResults, resolveExitCode, STATUS} = await doctorModule;

  const warnOnly = summarizeResults([
    {status: STATUS.WARN}, {status: STATUS.SKIP}, {status: STATUS.OK},
  ]);
  assert.deepEqual(warnOnly.counts, {OK: 1, WARN: 1, FAIL: 0, SKIP: 1});
  assert.equal(warnOnly.verdict, 'WARN');
  assert.equal(resolveExitCode(warnOnly), 0, '无 --strict 时 WARN 不退非零');
  assert.equal(resolveExitCode(warnOnly, {strict: true}), 1, '--strict 时 WARN 变 1');

  const skipOnly = summarizeResults([{status: STATUS.SKIP}, {status: STATUS.SKIP}]);
  assert.equal(skipOnly.verdict, 'PASS');
  assert.equal(resolveExitCode(skipOnly, {strict: true}), 0, 'SKIP 永远不算失败（CI 上没有框架仓）');

  const withFail = summarizeResults([{status: STATUS.FAIL}, {status: STATUS.WARN}]);
  assert.equal(withFail.verdict, 'FAIL');
  assert.equal(resolveExitCode(withFail), 1);
  assert.equal(resolveExitCode(withFail, {strict: true}), 1);

  assert.equal(resolveExitCode(summarizeResults([])), 0, '空结果按通过');
  assert.throws(() => summarizeResults([{status: 'WHATEVER'}]), /未知的检查状态/);
});

test('formatReport：中文表格含每框架一行 + 合计 + 总判定（strict 文案不同）', async () => {
  const {formatReport, summarizeResults, STATUS} = await doctorModule;
  const results = [
    {id: 'harness', scope: '本地', status: STATUS.WARN, message: '本地框架比锁文件新 2 个提交'},
    {id: 'ddd', scope: '本地', status: STATUS.FAIL, message: '锁定向未推送的 commit b9e762f9'},
  ];
  const summary = summarizeResults(results);
  const text = formatReport({results, summary, checks: ['本地']});
  assert.match(text, /框架锁文件体检（本地漂移）/);
  assert.match(text, /框架\s+检查\s+状态\s+说明/);
  assert.match(text, /harness\s+本地\s+警告\s+本地框架比锁文件新 2 个提交/);
  assert.match(text, /ddd\s+本地\s+失败\s+锁定向未推送的 commit b9e762f9/);
  assert.match(text, /合计：一致 0 \/ 警告 1 \/ 失败 1 \/ 跳过 0/);
  assert.match(text, /总判定：失败/);
  assert.match(text, /framework:lock/, '失败时提示走发版流，不要手改锁文件');

  const warnText = formatReport({
    results: [results[0]],
    summary: summarizeResults([results[0]]),
    strict: false,
    checks: ['本地', '远端'],
  });
  assert.match(warnText, /框架锁文件体检（本地漂移 \+ 远端可达性）/);
  assert.match(warnText, /总判定：通过（有警告）/);
  assert.match(warnText, /--strict/);
  const strictText = formatReport({
    results: [results[0]],
    summary: summarizeResults([results[0]]),
    strict: true,
    checks: ['本地'],
  });
  assert.match(strictText, /总判定：失败（--strict/);

  // 全 OK 的文案
  const okText = formatReport({
    results: [{id: 'harness', scope: '远端', status: STATUS.OK, message: '远端可达'}],
    summary: summarizeResults([{status: STATUS.OK}]),
    checks: ['远端'],
  });
  assert.match(okText, /总判定：通过/);
});

test('parseArgs：默认只做本地检查，--remote / --strict / --no-local 独立开关', async () => {
  const {parseArgs} = await doctorModule;
  assert.deepEqual(parseArgs([]), {local: true, remote: false, strict: false, help: false});
  assert.deepEqual(parseArgs(['--remote']), {local: true, remote: true, strict: false, help: false});
  assert.deepEqual(parseArgs(['--remote', '--strict']), {local: true, remote: true, strict: true, help: false});
  assert.equal(parseArgs(['--no-local', '--remote']).local, false);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--strict-local']), /未知参数/);
});

test('main：锁文件解析失败 → 退出码 1 且不做事（无 git 调用）', async () => {
  const {main} = await doctorModule;
  const messages = [];
  const {git, calls} = fakeGit(healthyRoutes());
  const code = main([], {
    repoRoot: 'repo',
    readFile: () => '{oops',
    exists: () => true,
    git,
    out: () => {},
    err: (text) => messages.push(text),
  });
  assert.equal(code, 1);
  assert.match(messages.join('\n'), /框架锁文件体检失败/);
  assert.equal(calls.length, 0);
});

test('main：仓不存在 → SKIP → 退出码 0；注入假 git 复现 WARN，--strict 变 1', async () => {
  const {main} = await doctorModule;
  const outputs = [];
  const near = {repoRoot: 'repo', readFile: () => JSON.stringify(validLock())};

  const skipCode = main([], {
    ...near, env: {}, exists: () => false, git: fakeGit(healthyRoutes()).git,
    out: (text) => outputs.push(text), err: () => {},
  });
  assert.equal(skipCode, 0, '仓不存在只 SKIP，退出码 0');
  assert.match(outputs.at(-1), /跳过/);
  assert.match(outputs.at(-1), /总判定：通过/);

  const leadingGit = fakeGit({
    'cat-file -e': {status: 0},
    'branch -r --contains': {status: 0, stdout: 'origin/main\n'},
    'rev-parse HEAD': {status: 0, stdout: `${REF_ADVANCED}\n`},
    'merge-base --is-ancestor': {status: 0},
    'rev-list --count': {status: 0, stdout: '2\n'},
  }).git;
  const strictOutputs = [];
  const warnCode = main([], {
    ...near,
    env: {LINGXI_FRAMEWORK_HARNESS: 'E:/h', LINGXI_FRAMEWORK_DDD: 'E:/d'},
    exists: () => true,
    git: leadingGit,
    out: (text) => strictOutputs.push(text),
    err: () => {},
  });
  assert.equal(warnCode, 0, '默认 WARN 不退非零');
  assert.match(strictOutputs.at(-1), /警告/);

  const strictCode = main(['--strict'], {
    ...near,
    env: {LINGXI_FRAMEWORK_HARNESS: 'E:/h', LINGXI_FRAMEWORK_DDD: 'E:/d'},
    exists: () => true,
    git: leadingGit,
    out: () => {}, err: () => {},
  });
  assert.equal(strictCode, 1, '--strict 下 WARN 变 1');
});

test('main：--no-local 需要配合 --remote，否则不静默空跑', async () => {
  const {main} = await doctorModule;
  const messages = [];
  const code = main(['--no-local'], {
    repoRoot: 'repo', readFile: () => JSON.stringify(validLock()), exists: () => true,
    git: fakeGit(healthyRoutes()).git, out: () => {}, err: (text) => messages.push(text),
  });
  assert.equal(code, 1);
  assert.match(messages.join('\n'), /--no-local 需要同时给 --remote/);
});

test('main：--remote 走远端检查（注入假 git，无网络），失败 → 1', async () => {
  const {main} = await doctorModule;
  const outputs = [];
  const removed = [];
  const code = main(['--remote', '--no-local'], {
    repoRoot: 'repo',
    readFile: () => JSON.stringify(validLock()),
    env: {},
    exists: () => false,
    git: fakeGit({init: {status: 0}, fetch: {status: 128, stderr: 'fatal: remote error'}}).git,
    makeTempDir: (id) => `tmp/${id}`,
    removeTempDir: (directory) => removed.push(directory),
    out: (text) => outputs.push(text), err: () => {},
  });
  assert.equal(code, 1);
  assert.deepEqual(removed, ['tmp/harness', 'tmp/ddd']);
  assert.match(outputs.at(-1), /远端可达性/);
  assert.match(outputs.at(-1), /总判定：失败/);
});
