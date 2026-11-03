#!/usr/bin/env node
/**
 * 探活/端口隔离的**变异自检**：证明新增测试真的会红，而不是"写了个总能过的测试"。
 *
 * <p><b>为什么需要它：</b>"桌宠窗口加载成主应用界面"这个缺陷之所以能上线，是因为
 * 探活只看状态码——它永远不会红。修完以后如果新测试同样不会红，等于什么都没修。
 * 所以每次改动都用一个变异体（mutation）验证：把防护拿掉，测试<b>必须</b>挂。</p>
 *
 * <p>本脚本对每个变异体做三件事，缺一步就算 FAIL：</p>
 * <ol>
 *   <li>先跑一次目标测试文件，确认<b>绿</b>（否则后面的"红"毫无意义）；</li>
 *   <li>注入变异（字符串替换，要求命中<b>恰好一处</b>，命中数不为 1 直接中止）；</li>
 *   <li>再跑一次，要求<b>非 0 退出</b>且输出里出现预期断言文本。</li>
 * </ol>
 *
 * <p><b>安全约束：</b>变异只作用于源码文本，备份放在进程内存里；每个变异体结束后
 * 立刻按字节还原并比对 SHA-256，全部结束再跑一遍目标测试确认回到绿。
 * 中转路径不落任何临时文件，异常/中断也会尽量还原。</p>
 *
 * 用法：`npm run test:pet:mutate`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 前端根目录（脚本位于 `frontend/scripts/`）。 */
const FRONTEND_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 变异体清单。
 *
 * <p>每个变异体都必须对应一条真实修复点，`expect` 里写的是"测试红起来时输出里必然出现的
 * 断言消息"——只判退出码不够：测试可能因为语法错误而红，那是假红。</p>
 */
/**
 * 入口页字面量（运行时拼出来）。
 *
 * <p><b>为什么不在源码里直接写：</b>本文件也在「单一真源扫描」的消费方清单里
 * （`tests/petDevEndpoint.test.cjs` 会扫描代码里的 `pet.html` 字面量），
 * 而变异体恰恰要**故意**造出一个硬编码。用拼接构造既能让变异体生效，
 * 又不会让扫描器误报自己。</p>
 *
 * @type {string}
 */
const ENTRY_PAGE_LITERAL = ['pet', 'html'].join('.');

const MUTATIONS = [
  {
    id: 'probe-no-fingerprint',
    goal: '探活退回"只看状态码"（原始缺陷）：200 + 主应用 index.html 必须被判失败',
    file: 'electron/pet-dev-probe.cjs',
    find: 'const missingMarkers = PET_PAGE_MARKERS.filter((marker) => !body.includes(marker));',
    replace: 'const missingMarkers = [];',
    testFile: 'tests/petDevProbe.test.cjs',
    expect: '200 但内容是主应用 index.html',
  },
  {
    id: 'strict-port-off',
    goal: '关掉 strictPort：端口被占时 Vite 会静默 +1 漂移，测试必须红',
    file: 'electron/pet-dev-endpoint.cjs',
    find: 'strictPort: true,',
    replace: 'strictPort: false,',
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: 'strictPort 必须是 true',
  },
  {
    id: 'app-type-spa',
    goal: `把 appType 改回 spa（history fallback 复活）：/${ENTRY_PAGE_LITERAL} 又会兜成 index.html`,
    file: 'electron/pet-dev-endpoint.cjs',
    find: "appType: 'mpa',",
    replace: "appType: 'spa',",
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: 'appType 必须是 mpa',
  },
  {
    id: 'ensure-starts-anyway',
    goal: '去掉"端口被非桌宠占用"的早退：会白抢一轮锁并多做一次探活，必须被抓住',
    file: 'scripts/pet-dev-server.cjs',
    find: '  if (first.reason !== PROBE_REASON.NO_SERVICE) {',
    replace: '  if (false) {',
    testFile: 'tests/petDevServer.test.cjs',
    expect: '端口被占用时不该白抢一次锁',
  },
  {
    id: 'entry-page-literal',
    goal: `K4 回退：窗口入口页改回字面量（dev 分支不再取真源 ${ENTRY_PAGE_LITERAL}）`,
    file: 'electron/pet-window.cjs',
    find: 'return { kind: \'url\', value: `${resolveDevEntryUrl(rawUrl)}${PET_ENTRY_PAGE}` };',
    replace: 'return { kind: \'url\', value: `${resolveDevEntryUrl(rawUrl)}' + ENTRY_PAGE_LITERAL + '` };',
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: '在代码里写死了入口页名',
  },
  {
    id: 'body-stall-as-network-error',
    goal: 'K1 回退：响应体停滞重新被判成 network-error（exit 6），与文档的 exit 5 冲突',
    file: 'electron/pet-dev-probe.cjs',
    find: 'return { reason: PROBE_REASON.TIMEOUT, cause: PROBE_CAUSE.BODY_TIMEOUT, detail: verdict.detail };',
    replace: 'return { reason: PROBE_REASON.NETWORK_ERROR, cause: PROBE_CAUSE.NETWORK_ERROR, detail: verdict.detail };',
    testFile: 'tests/petDevProbe.test.cjs',
    expect: '响应体停滞必须归入 timeout',
  },
  {
    id: 'lock-ignored-spawn-anyway',
    goal: 'K3 回退：拿不到锁也当拿到（并发时静默拉起第二个 dev server）',
    file: 'scripts/pet-dev-server.cjs',
    find: "    if (claim.acquired) return { acquired: true, lock: claim, reason: '' };",
    replace: "    if (true) return { acquired: true, lock: claim, reason: '' };",
    testFile: 'tests/petDevServer.test.cjs',
    expect: '拿不到锁时绝不允许 spawn 第二个 dev server',
  },
];

/** 当前在飞的变异：绝对路径 → 原始文本（进程被中断时据此还原）。 */
const INFLIGHT = new Map();

/**
 * 还原全部在飞变异。
 *
 * @returns {void}
 */
function restoreAll() {
  for (const [absPath, original] of INFLIGHT) {
    try {
      writeFileSync(absPath, original, 'utf8');
    } catch (err) {
      console.error(`[mutate] 还原失败：${absPath}（${(err && err.message) || err}）`);
    }
  }
  INFLIGHT.clear();
}

// 进程被信号打断时也必须还原，否则会把变异体留在工作区
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  restoreAll();
  console.error(`[mutate] 未捕获异常：${(err && err.stack) || err}`);
  process.exit(1);
});

/**
 * 计算文本 SHA-256（还原后逐字节比对用）。
 *
 * @param {string} text 文本
 * @returns {string} 十六进制摘要
 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 跑目标测试文件。
 *
 * @param {string} testFile 相对 frontend 的测试路径
 * @returns {{ok: boolean, code: number, out: string, ms: number}} 运行结果
 */
function runTests(testFile) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, ['--test', testFile], {
    cwd: FRONTEND_ROOT,
    encoding: 'utf8',
  });
  const code = typeof proc.status === 'number' ? proc.status : 1;
  return {
    ok: code === 0,
    code,
    out: `${proc.stdout || ''}${proc.stderr || ''}`,
    ms: Date.now() - started,
  };
}

/**
 * 注入一个变异体。
 *
 * @param {{file: string, find: string, replace: string}} mutation 变异体
 * @returns {{absPath: string, original: string}} 还原所需信息
 * @throws {Error} 命中数不为 1 时抛出
 */
function applyMutation(mutation) {
  const absPath = path.join(FRONTEND_ROOT, mutation.file);
  const original = readFileSync(absPath, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.id}：变异锚点在 ${mutation.file} 命中 ${occurrences} 处（应为 1），源码结构可能已变，请同步脚本`);
  }
  INFLIGHT.set(absPath, original);
  writeFileSync(absPath, original.replace(mutation.find, mutation.replace), 'utf8');
  return { absPath, original };
}

/**
 * 还原一个变异体并校验逐字节一致。
 *
 * @param {string} absPath 文件绝对路径
 * @param {string} original 原始文本
 * @returns {boolean} 是否逐字节还原
 */
function restoreMutation(absPath, original) {
  writeFileSync(absPath, original, 'utf8');
  const now = readFileSync(absPath, 'utf8');
  INFLIGHT.delete(absPath);
  return sha256(now) === sha256(original);
}

/** 依次执行全部变异体并汇总。 */
function main() {
  console.log('[mutate] 桌宠探活/端口隔离变异自检开始');
  console.log(`[mutate] 前端根目录：${FRONTEND_ROOT}`);

  const results = [];
  /** 每个测试文件的基线（绿）检查只做一次。 */
  const baseline = new Map();

  for (const mutation of MUTATIONS) {
    console.log('');
    console.log(`=== 变异体 ${mutation.id} ===`);
    console.log(`  目的：${mutation.goal}`);
    console.log(`  位置：${mutation.file}`);

    if (!baseline.has(mutation.testFile)) {
      const green = runTests(mutation.testFile);
      baseline.set(mutation.testFile, green.ok);
      console.log(`  基线（变异前）：${green.ok ? '绿 OK' : '红 FAIL'}  用时 ${green.ms}ms`);
      if (!green.ok) {
        console.log(green.out);
        results.push({ id: mutation.id, passed: false, reason: `基线测试未通过：${mutation.testFile}` });
        continue;
      }
    }

    let applied = null;
    let outcome;
    try {
      applied = applyMutation(mutation);
      const red = runTests(mutation.testFile);
      const sawExpected = red.out.includes(mutation.expect);
      console.log(`  变异后：退出码 ${red.code}（要求非 0）· 断言文本"${mutation.expect}" ${sawExpected ? '出现 OK' : '未出现 FAIL'}`);
      if (red.ok) {
        console.log(red.out);
      }
      outcome = {
        id: mutation.id,
        passed: !red.ok && sawExpected,
        reason: !red.ok
          ? (sawExpected ? '' : `退出码非 0 但未出现预期断言文本，可能是假红`)
          : '变异后测试仍然全绿：测试没有守住这条修复',
      };
    } catch (err) {
      outcome = { id: mutation.id, passed: false, reason: (err && err.message) || String(err) };
    } finally {
      if (applied) {
        const restored = restoreMutation(applied.absPath, applied.original);
        console.log(`  还原：${restored ? '逐字节一致 OK' : '不一致 FAIL'}`);
        if (!restored) outcome = { id: mutation.id, passed: false, reason: '还原后内容与原文不一致' };
      }
    }

    if (outcome.passed) {
      const greenAgain = runTests(mutation.testFile);
      console.log(`  还原后重跑：${greenAgain.ok ? '绿 OK' : '红 FAIL'}`);
      if (!greenAgain.ok) {
        console.log(greenAgain.out);
        outcome = { id: mutation.id, passed: false, reason: '还原后测试未回到绿' };
      }
    }
    results.push(outcome);
    console.log(`  结论：${outcome.passed ? 'PASS（变异成功变红）' : `FAIL（${outcome.reason}）`}`);
  }

  console.log('');
  const failed = results.filter((item) => !item.passed);
  console.log(`[mutate] 汇总：${results.length - failed.length}/${results.length} 个变异体成功变红`);
  for (const item of results) {
    console.log(`  - ${item.passed ? 'PASS' : 'FAIL'} ${item.id}${item.reason ? `：${item.reason}` : ''}`);
  }
  if (failed.length > 0) {
    console.error('[mutate] 变异自检未通过：新增测试没能守住对应的修复点');
    return 1;
  }
  console.log('[mutate] 变异自检通过');
  return 0;
}

process.exitCode = main();
