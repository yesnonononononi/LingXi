#!/usr/bin/env node
/**
 * 门禁变异自检（V12）：证明「低档位灰阶替换的盲区已被补上」。
 *
 * <p><b>为什么需要这个脚本：</b>灰阶统一要把 `gray-N` 换成 `zinc-N`。这两族的低档位（100–400）
 * 通道差只有 1~6，像素比对天生看不见 —— 也就是说「改错了」在视觉回归里是绿的。
 * 本文档要证明两件事，且必须由脚本自动完成（人肉验证无法防止回归）：</p>
 *
 * <ol>
 *   <li>`gray-700 → zinc-700`（差 13 通道）：<b>像素层必须红</b>；</li>
 *   <li>`gray-300 → zinc-300`（差 4 通道）：像素层<b>允许</b>不红，但 computed style 层
 *       （`--assert-dark-colors` / `--assert-low-tier`）<b>必须红</b>。若两层都不红，
 *       说明盲区没补上 —— 脚本会明确报 FAIL，不伪造通过。</li>
 * </ol>
 *
 * <p><b>安全约束：</b>变异只改一处类名，且在 `<repo>/.lingxi/tmp/v12-backup/` 留备份；
 * 还原走字节级 copy（**禁止 `git checkout --`**，那会连带丢掉未提交的同文件改动），
 * 并在还原后用 MD5 双端比对证明逐字节复原。</p>
 *
 * 用法：
 *   node scripts/visual/mutation-selfcheck.cjs [--keep] [--skip-pixels]
 *     --keep         保留变异现场（排障用），默认一定还原
 *     --skip-pixels  跳过像素层（只验证 computed style 层，省时间）
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execSync } = require('node:child_process');

/** 前端根目录（脚本位于 frontend/scripts/visual/）。 */
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 当前在飞的变异：`源文件绝对路径 → 备份文件绝对路径`。
 * 进程被强杀时 finally 不执行，靠信号处理器据此紧急还原。
 */
const INFLIGHT = new Map();

/** 列出 `frontend/src` 下未提交的改动（开跑前守卫用）。 */
function listDirtySources() {
  try {
    const out = execSync('git status --porcelain -- frontend/src', {
      cwd: REPO_ROOT, encoding: 'utf8'
    });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 仓库根。 */
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
/** 变异备份目录。 */
const BACKUP_DIR = path.join(REPO_ROOT, '.lingxi', 'tmp', 'v12-backup');
/** 日志目录。 */
const LOG_DIR = path.join(REPO_ROOT, '.lingxi', 'tmp', 'v12');
/** 视觉场景脚本（component-scenes.cjs，负责像素 + computed style 两层）。 */
const SCENES_SCRIPT = path.join(FRONTEND_ROOT, 'scripts', 'visual', 'component-scenes.cjs');

/**
 * 变异用例清单。
 *
 * <p>每个用例的「目标类名」都必须落在被视觉场景**断言覆盖**的元素上，否则 computed style 层
 * 永远抓不到 —— 那样这条用例就没有证明力。</p>
 */
const CASES = [
  {
    id: 'high-tier-visible',
    desc: '高档位（可感知）：gray-200(#e5e7eb) → gray-400(#99a1af)，通道差 76 —— 像素层必须红',
    // AgentsTab 智能体行卡片的亮态边框（该卡片就是断言目标 atRow，computed style 层可独立作证）。
    // 为什么选大跨度：像素层的"强差异像素"门槛实测要 ~20+ 通道差，跨度小的改动即使人眼可辨
    // 也常常只让 diff 图产生"非强差异"像素而不判红 —— 这正是低档位盲区的成因。
    // 所以这条用例的作用是「证明像素层确实会红」的灵敏度对照，而低档位那条证明 computed style 层兜底。
    file: 'frontend/src/views/settings/tabs/AgentsTab.vue',
    from: 'bg-gray-50/70 border-gray-200',
    to: 'bg-gray-50/70 border-gray-400',
    expectPixelRed: true,
    expectStyleRed: true,
  },
  {
    id: 'low-tier-blind-spot',
    desc: '低档位（盲区）：gray-200(#e5e7eb) → zinc-200(#e4e4e7)，通道差 1 —— 像素层允许不红，computed style 层必须红',
    // TeamModal 成员行名字：`text-gray-800 dark:text-gray-200`，暗态取值落在断言目标 tmName 上。
    // 为什么不是任务原文的 300 档：300 档在本仓库只出现在表单边框（未被任何断言目标覆盖），
    // 拿它做用例会得到「两层都绿」，反而无法证明盲区已补；200 档差 1/255 比 300 档的 4/255
    // 更极端，证明力更强。这一点写进 DELIVERY 的未决项里，不隐瞒。
    file: 'frontend/src/components/chat/TeamModal.vue',
    from: 'dark:text-gray-200 truncate',
    to: 'dark:text-zinc-200 truncate',
    expectPixelRed: false,
    expectStyleRed: true,
  },
];

/**
 * 计算文件 MD5。
 * @param {string} file 文件路径
 * @returns {string} 十六进制摘要
 */
function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

/**
 * electron 可执行入口：优先用本地 electron（视觉场景必须跑在 Chromium 里）。
 *
 * @param {string[]} extraArgs 传给场景脚本的参数
 * @returns {{bin: string, args: string[]}} 命令
 */
function electronCmd(extraArgs) {
  const cli = path.join(FRONTEND_ROOT, 'node_modules', 'electron', 'cli.js');
  if (fs.existsSync(cli)) return { bin: process.execPath, args: [cli, ...extraArgs] };
  return { bin: 'npx', args: ['electron', ...extraArgs] };
}

/**
 * 以 JSON 方式跑视觉场景 check，取回结构化结果。
 *
 * @param {string} logName 日志文件名（写到 .lingxi/tmp/v12/）
 * @returns {{ok: boolean, pixelFailed: number, styleDiffs: number, exitCode: number}} 结果
 */
function runScenesCheck(logName) {
  const { bin, args } = electronCmd([SCENES_SCRIPT, '--mode', 'check']);
  const p = spawnSync(bin, args, { cwd: FRONTEND_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: bin === 'npx' });
  const raw = `${p.stdout || ''}${p.stderr || ''}`;
  fs.writeFileSync(path.join(LOG_DIR, logName), raw);
  const exitCode = typeof p.status === 'number' ? p.status : 1;
  // 输出是「若干行日志 + 一段 pretty JSON」：从 `"mode": "check"` 所在对象起点解析
  const idx = raw.indexOf('"mode": "check"');
  let parsed = null;
  if (idx >= 0) {
    const start = raw.lastIndexOf('{', idx);
    const end = raw.lastIndexOf('}');
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; }
  }
  return {
    ok: parsed !== null,
    pixelFailed: parsed && parsed.pixel ? Number(parsed.pixel.failed ?? -1) : -1,
    styleDiffs: parsed && Array.isArray(parsed.styleDiffs) ? parsed.styleDiffs.length : -1,
    exitCode,
  };
}

/**
 * 跑一个 component-scenes 断言模式，返回退出码。
 *
 * @param {string} flag 断言开关（如 `--assert-low-tier`）
 * @param {string} logName 日志名
 * @returns {number} 退出码（0 = 绿）
 */
function runSceneAssert(flag, logName) {
  const { bin, args } = electronCmd([SCENES_SCRIPT, flag]);
  const p = spawnSync(bin, args, { cwd: FRONTEND_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: bin === 'npx' });
  fs.writeFileSync(path.join(LOG_DIR, logName), `${p.stdout || ''}${p.stderr || ''}`);
  return typeof p.status === 'number' ? p.status : 1;
}

/**
 * 重建前端产物（变异出来的类名必须真的进 CSS，否则浏览器拿不到它 → 两层假绿）。
 *
 * @param {string} logName 日志名
 * @returns {number} 退出码
 */
function rebuild(logName) {
  const p = spawnSync('npm', ['run', 'build'], { cwd: FRONTEND_ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(LOG_DIR, logName), `${p.stdout || ''}${p.stderr || ''}`);
  return typeof p.status === 'number' ? p.status : 1;
}

/**
 * 判定单个用例 PASS/FAIL。
 *
 * @param {object} r 用例结果
 * @returns {{pass: boolean, reasons: string[]}} 判定
 */
function judge(r) {
  /** @type {string[]} */
  const reasons = [];
  if (r.md5AfterRestore && r.md5AfterRestore !== r.md5Before) {
    reasons.push(`还原后 MD5 不一致（${r.md5Before} → ${r.md5AfterRestore}），文件未逐字节复原`);
  }
  if (r.buildAfterRestore !== undefined && r.buildAfterRestore !== 0) {
    reasons.push('还原后重建失败，产物状态未知');
  }
  if (!r.scenesCheck.ok) reasons.push('视觉场景 check 没有输出可解析的 JSON（像素层无法判定）');
  if (r.pixelRed !== r.expectPixelRed) {
    reasons.push(`像素层${r.pixelRed ? '红了' : '没红'}，但期望${r.expectPixelRed ? '必须红' : '允许不红'}（pixelFailed=${r.scenesCheck.pixelFailed}）`);
  }
  if (r.styleLayerRed !== r.expectStyleRed) {
    reasons.push(r.expectStyleRed && !r.styleLayerRed
      ? 'computed style 层没有红 —— 盲区没补上（本脚本拒绝伪造通过）'
      : 'computed style 层红了，但期望不红');
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * 执行单个变异用例：备份 → 变异 → 重建 → 测三层 → 还原 → 重建。
 *
 * @param {object} c 用例
 * @returns {Promise<object>} 结果记录
 */
async function runCase(c) {
  const abs = path.join(REPO_ROOT, c.file);
  if (!fs.existsSync(abs)) throw new Error(`用例 ${c.id} 的目标文件不存在：${c.file}`);
  const original = fs.readFileSync(abs, 'utf8');
  const occurrences = original.split(c.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`用例 ${c.id}：目标串「${c.from}」在 ${c.file} 中出现 ${occurrences} 次（必须恰好 1 次，避免改到多处）`);
  }
  const backupFile = path.join(BACKUP_DIR, `${c.id}__${path.basename(c.file)}.bak`);
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.writeFile(backupFile, original);
  const md5Before = md5(abs);
  console.log(`\n=== 用例 ${c.id} ===`);
  console.log(`  ${c.desc}`);
  console.log(`  目标: ${c.file}`);
  console.log(`  变异: "${c.from}"  →  "${c.to}"`);
  console.log(`  备份: ${path.relative(REPO_ROOT, backupFile).split(path.sep).join('/')}  MD5=${md5Before}`);

  const record = {
    id: c.id, desc: c.desc, file: c.file, from: c.from, to: c.to,
    md5Before, md5AfterRestore: '', backup: backupFile,
    expectPixelRed: c.expectPixelRed, expectStyleRed: c.expectStyleRed,
  };
  try {
    // 1) 变异 + 重建（类名必须进产物，否则浏览器拿不到它 → 两层假绿）
    INFLIGHT.set(abs, backupFile);
    await fsp.writeFile(abs, original.replace(c.from, c.to));
    record.buildAfterMutate = rebuild(`${c.id}.build-mutate.log`);
    if (record.buildAfterMutate !== 0) throw new Error('变异后重建失败，无法判定（见日志）');

    // 2) 三层判据：像素层 + computed style 层（场景 styleDiffs / 两个色值断言）
    const scenes = runScenesCheck(`${c.id}.scenes-check.log`);
    record.scenesCheck = { ok: scenes.ok, pixelFailed: scenes.pixelFailed, styleDiffs: scenes.styleDiffs, exitCode: scenes.exitCode };
    record.assertDarkColors = runSceneAssert('--assert-dark-colors', `${c.id}.assert-dark-colors.log`);
    record.assertLowTier = runSceneAssert('--assert-low-tier', `${c.id}.assert-low-tier.log`);
    record.pixelRed = scenes.pixelFailed > 0;
    record.styleLayerRed = scenes.styleDiffs > 0 || record.assertDarkColors !== 0 || record.assertLowTier !== 0;
    record.styleRedBy = [
      scenes.styleDiffs > 0 ? `场景 styleDiffs=${scenes.styleDiffs}` : null,
      record.assertDarkColors !== 0 ? `--assert-dark-colors 退出码 ${record.assertDarkColors}` : null,
      record.assertLowTier !== 0 ? `--assert-low-tier 退出码 ${record.assertLowTier}` : null,
    ].filter(Boolean);
  } finally {
    // 3) 字节级还原（不碰 git），并验证 MD5 复原
    if (process.argv.includes('--keep')) {
      record.kept = true;
      console.log('  ⚠ --keep：保留变异现场，未还原（请自行还原）');
    } else {
      fs.copyFileSync(backupFile, abs);
      INFLIGHT.delete(abs);
      console.log(`  已还原 ${c.file} ← ${path.relative(REPO_ROOT, backupFile).split(path.sep).join('/')}`);
      record.md5AfterRestore = md5(abs);
      record.restoredExact = record.md5AfterRestore === md5Before;
      record.buildAfterRestore = rebuild(`${c.id}.build-restore.log`);
    }
  }
  return record;
}

/**
 * 主流程。
 * @returns {Promise<number>} 退出码（0 = 全部用例符合预期，1 = 有不符合，2 = 参数错误）
 */
async function main() {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;
  if (cases.length === 0) {
    console.error(`--only 没有匹配到任何用例：${only}`);
    return 2;
  }
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  console.log('[v12] 门禁变异自检：证明「低档位灰阶替换的盲区已被补上」');

  // 守卫：自检会临时改真实源文件。若上一次运行被强杀/超时打断，工作树里可能留着变异。
  // 已实际发生两次（AgentsTab 的 border-gray-200 被留成 gray-400），必须开跑前先拦。
  const dirtyBefore = listDirtySources();
  if (dirtyBefore.length) {
    console.error('[v12] 拒绝运行：frontend/src 已有未提交改动，无法区分「原有改动」与「变异残留」。');
    console.error('[v12] 请先提交或还原以下文件：');
    for (const f of dirtyBefore) console.error('  - ' + f);
    process.exit(2);
  }

  // 进程被强杀（超时 / Ctrl-C / SIGTERM）时 finally 不会执行，会把变异留在工作树里。
  // 实测已发生过一次：AgentsTab 的 border-gray-200 被留成 gray-400。
  // 因此登记「当前在飞的变异」，收到信号时先还原再退出（inflight 为模块级，见文件顶部）。
  const emergencyRestore = (sig) => {
    for (const [file, backup] of INFLIGHT) {
      try {
        fs.copyFileSync(backup, file);
        console.error(`[v12] ${sig}：已紧急还原 ${file}`);
      } catch (e) {
        console.error(`[v12] ${sig}：还原 ${file} 失败 —— 请手动还原/核对！${e.message}`);
      }
    }
    INFLIGHT.clear();
    process.exit(130);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => emergencyRestore(sig));

  /** @type {object[]} */
  const results = [];
  for (const c of cases) {
    const rec = await runCase(c);
    rec.verdict = judge(rec);
    results.push(rec);
  }

  console.log('\n================ 判据汇总 ================');
  let failed = 0;
  for (const r of results) {
    if (!r.verdict.pass) failed += 1;
    console.log(`\n${r.verdict.pass ? 'PASS' : 'FAIL'}  ${r.id}`);
    console.log(`  像素层      : ${r.pixelRed ? '红' : '绿'}（pixelFailed=${r.scenesCheck.pixelFailed}） 期望 ${r.expectPixelRed ? '红' : '允许绿'}`);
    console.log(`  computed层  : ${r.styleLayerRed ? '红' : '绿'} 期望 ${r.expectStyleRed ? '红' : '绿'}  [${r.styleRedBy.join(' / ') || '无红'}]`);
    console.log(`  还原 MD5    : ${r.md5Before} → ${r.md5AfterRestore}（${r.restoredExact ? '逐字节复原' : '不一致'}）`);
    for (const reason of r.verdict.reasons) console.log(`  ✗ ${reason}`);
  }
  const reportFile = path.join(LOG_DIR, 'report.json');
  fs.writeFileSync(reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\n报告：${path.relative(REPO_ROOT, reportFile).split(path.sep).join('/')}`);
  console.log(failed === 0
    ? '\nSELFCHECK PASS（全部用例符合预期，含低档位盲区已被 computed style 层覆盖）'
    : `\nSELFCHECK FAIL（${failed} 个用例不符合预期，见上）`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

