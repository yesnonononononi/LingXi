#!/usr/bin/env node
/**
 * 预期变色清单生成器（V8）。
 *
 * <p><b>为什么需要它：</b>灰阶统一（gray-N ↔ zinc-N）会让一批目标的颜色发生**预期变化**。
 * 变化必须事先被盘点、被评审签字，否则「改了颜色」和「改错了颜色」在事后无法区分。
 * 这个脚本把三份数据合成一张可评审的 CSV：谁要变、从什么变成什么。</p>
 *
 * <p><b>三份数据来源（全部复用既有实现，不另造一套真值）：</b>
 *  1. 等价门禁的结构化报告 —— `node scripts/check-theme-equivalence.mjs --json`，
 *     它内部已经做完「令牌解析 / 三元配对 / dark: 变体覆盖」这些判定，
 *     这里只消费结果，避免第二套解析逻辑漂移；
 *  2. 视觉回归的 diff 图清单 —— `.lingxi/tmp/visual/**\/diff/` 下的文件，说明哪些场景真的变了；
 *  3. 低档位专项报告 —— `component-scenes.cjs --assert-low-tier` 的「预期变更候选」（可选增强）。</p>
 *
 * <p><b>签字机制：</b>文档要求「CSV 必须经评审签字才允许重建基线」。因此：
 *  - `--sign <名字>` 把签名与时间戳写进 CSV 末尾注释行；
 *  - `--verify` 校验 CSV 存在、已签字、且与实际 diff 情况一致，不一致即退出码 1。</p>
 *
 * 用法：
 *   node scripts/visual/expect-inventory.cjs                 # 生成 CSV
 *   node scripts/visual/expect-inventory.cjs --sign 寇豆码    # 生成并签字
 *   node scripts/visual/expect-inventory.cjs --verify        # 校验签字与实际 diff 是否一致
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 仓库根（脚本位于 frontend/scripts/visual/ 下）。 */
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
/** 视觉运行时产物根（与 scene-kit 的 ARTIFACT_ROOT 同址）。 */
const ARTIFACT_ROOT = path.join(REPO_ROOT, '.lingxi', 'tmp', 'visual');
/** 产物 CSV 路径。 */
const CSV_PATH = path.join(ARTIFACT_ROOT, 'expected-changes.csv');
/** 门禁脚本。 */
const GATE_SCRIPT = path.join(FRONTEND_ROOT, 'scripts', 'check-theme-equivalence.mjs');

/**
 * 解析命令行参数。
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{sign: string|null, verify: boolean, base: string, help: boolean}} 参数
 */
function parseArgs(argv) {
  const signIdx = argv.indexOf('--sign');
  const baseIdx = argv.indexOf('--base');
  const sign = signIdx >= 0 ? argv[signIdx + 1] : null;
  if (signIdx >= 0 && (sign === undefined || sign === null || sign.startsWith('--'))) {
    throw new Error('--sign 需要一个名字参数，例如 --sign 寇豆码');
  }
  return {
    sign,
    verify: argv.includes('--verify'),
    base: baseIdx >= 0 && argv[baseIdx + 1] ? argv[baseIdx + 1] : 'HEAD',
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

/**
 * 调用等价门禁拿结构化报告。
 *
 * <p>复用点：直接跑 `check-theme-equivalence.mjs --json`，从 stdout 里取最后一行 `[JSON] ...`。
 * 这样「旧类 → 新类」的配对、令牌解析、容差全部由门禁负责，本脚本零重复实现。</p>
 *
 * @param {string} base 基线 git ref
 * @returns {{atoms: Array<object>, totalDrift: number, fileCount: number, ok: boolean, message: string}} 门禁报告
 */
function runGateJson(base) {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [GATE_SCRIPT, '--json', '--base', base], {
      cwd: FRONTEND_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // 退出码 2 = 有漂移，这是本脚本的**正常**输入（正是要盘点的内容）；只有 1 才是基础设施失败
    status = typeof err.status === 'number' ? err.status : 1;
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
    if (status === 1) {
      return { atoms: [], totalDrift: 0, fileCount: 0, ok: false, message: `等价门禁无法执行（退出码 1）：\n${stdout.slice(-2000)}` };
    }
  }
  const marker = '[JSON] ';
  const idx = stdout.lastIndexOf(marker);
  if (idx < 0) {
    return { atoms: [], totalDrift: 0, fileCount: 0, ok: false, message: `等价门禁没有输出结构化报告（退出码 ${status}）；请确认已 npm run build，且门禁版本支持 --json` };
  }
  const line = stdout.slice(idx + marker.length).split(/\r?\n/)[0];
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { atoms: [], totalDrift: 0, fileCount: 0, ok: false, message: `结构化报告解析失败：${e.message}` };
  }
  return {
    atoms: Array.isArray(parsed.atoms) ? parsed.atoms : [],
    totalDrift: Number(parsed.totalDrift ?? 0),
    fileCount: Number(parsed.fileCount ?? 0),
    ok: true,
    message: '',
  };
}

/**
 * 递归列出目录下的所有文件。
 * @param {string} dir 起始目录
 * @returns {string[]} 文件绝对路径
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * 收集「本轮真的变了」的图像清单。
 *
 * <p><b>为什么读 manifest 而不是 diff 目录：</b>`compare.mjs` 对**每张**比对过的图都写
 * `*.diff.png`（通过也写），所以「diff 目录非空」根本不能证明有变化 —— 直接数目录里的文件，
 * 一张零差异的图也会被当成「本轮变更」。真正的信号是比对明细里 `status !== 'pass'`，
 * 两个 check 脚本会把它固化成 `diff-manifest.json`，这里只做汇总。</p>
 *
 * @returns {{images: string[], manifests: number, compared: number}} 失败图像与统计
 */
function collectDiffImages() {
  const manifests = walk(ARTIFACT_ROOT).filter((f) => path.basename(f) === 'diff-manifest.json');
  /** @type {string[]} */
  const images = [];
  let compared = 0;
  for (const file of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // manifest 损坏不阻塞清单生成（会在统计里少一份，但不会编造数据）
    }
    compared += Number(parsed.imagesCompared ?? 0);
    for (const item of Array.isArray(parsed.failures) ? parsed.failures : []) {
      if (item && item.image) images.push(`${path.relative(REPO_ROOT, path.dirname(file)).split(path.sep).join('/')}/${item.image}`);
    }
  }
  return { images: [...new Set(images)].sort(), manifests: manifests.length, compared };
}

/** CSV 单元格转义：逗号 / 引号 / 换行都必须包起来，否则行会被拆错。 */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 把原子差异渲染成「按文件分组」的 CSV 文本。
 *
 * @param {Array<object>} atoms 门禁给的结构化原子差异
 * @param {string[]} diffImages diff 图清单
 * @param {string|null} sign 签字人
 * @returns {string} CSV 全文
 */
function renderCsv(atoms, diffImages, sign, diffStats = { manifests: 0, compared: 0 }) {
  const lines = [];
  lines.push('# 预期变色清单（灰阶统一 gray-N ↔ zinc-N）');
  lines.push(`# 生成时间: ${new Date().toISOString()}`);
  lines.push(`# 生成器  : scripts/visual/expect-inventory.cjs`);
  lines.push(`# 数据源  : check-theme-equivalence.mjs --json（门禁结构化报告）+ .lingxi/tmp/visual/**/diff-manifest.json（失败图像清单）`);
  lines.push('# 列      : 文件:行 | 属性 | 旧值 | 新值');
  if (diffImages.length > 0) {
    lines.push(`# 本轮像素变化图 (${diffImages.length})（来自 diff-manifest.json 的 status!=pass 项）:`);
    for (const d of diffImages) lines.push(`#   ${d}`);
  } else {
    lines.push(`# 本轮像素变化图: 无（已比对 ${diffStats.manifests} 份 manifest / ${diffStats.compared} 张图，全部通过）`);
  }
  lines.push('文件:行,属性,旧值,新值');
  if (atoms.length === 0) {
    lines.push('# 当前无预期变更（门禁报告零原子差异，且无 diff 图）');
  } else {
    let currentFile = '';
    for (const a of atoms) {
      const file = String(a.file || '');
      if (file !== currentFile) {
        currentFile = file;
        lines.push(`# ===== ${file} =====`);
      }
      const location = `${file}:${a.line && Number(a.line) > 0 ? a.line : '?'}`;
      const prop = a.state ? `${a.prop} [${a.state}]` : String(a.prop || '');
      const oldValue = a.oldClass ? `${a.oldClass} → ${a.oldValue}` : '(无)';
      const newValue = a.newClass ? `${a.newClass} → ${a.newValue}` : '(无)';
      lines.push([location, prop, oldValue, newValue].map(csvCell).join(','));
    }
  }
  if (sign) {
    lines.push(`# SIGNED-BY: ${sign}`);
    lines.push(`# SIGNED-AT: ${new Date().toISOString()}`);
  } else {
    lines.push('# UNSIGNED: 未签字。未经评审签字的清单不得用于重建基线。');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 读取已存在 CSV 的签字信息与「当时是否有变更」。
 *
 * @param {string} text CSV 全文
 * @returns {{signedBy: string|null, signedAt: string|null, hadChanges: boolean, diffCount: number}} 元信息
 */
function readCsvMeta(text) {
  const byMatch = /^#\s*SIGNED-BY:\s*(.+)$/m.exec(text);
  const atMatch = /^#\s*SIGNED-AT:\s*(.+)$/m.exec(text);
  const noChange = text.includes('# 当前无预期变更');
  const diffMatch = /^#\s*本轮 diff 图 \((\d+)\):/m.exec(text);
  return {
    signedBy: byMatch ? byMatch[1].trim() : null,
    signedAt: atMatch ? atMatch[1].trim() : null,
    hadChanges: !noChange,
    diffCount: diffMatch ? Number(diffMatch[1]) : 0,
  };
}

/**
 * 主流程。
 * @returns {number} 退出码（0 = 一致/已生成，1 = 未签字或与实际不一致，2 = 参数错误）
 */
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[expect-inventory] ${e.message}`);
    return 2;
  }
  if (args.help) {
    console.log([
      '用法：node scripts/visual/expect-inventory.cjs [选项]',
      '',
      '  --sign <名字>   生成 CSV 并写入签字与时间戳',
      '  --verify        校验：CSV 存在、已签字、且与实际 diff 情况一致（不一致退出码 1）',
      '  --base <ref>    门禁比较基线，默认 HEAD',
      '',
      `产物：${path.relative(REPO_ROOT, CSV_PATH).split(path.sep).join('/')}`,
    ].join('\n'));
    return 0;
  }

  const gate = runGateJson(args.base);
  if (!gate.ok) {
    console.error(`[expect-inventory] ${gate.message}`);
    return 1;
  }
  const diff = collectDiffImages();
  const diffImages = diff.images;

  if (args.verify) {
    if (!fs.existsSync(CSV_PATH)) {
      console.error(`[expect-inventory] --verify 失败：清单不存在（${path.relative(REPO_ROOT, CSV_PATH)}）。先跑一次生成并评审签字。`);
      return 1;
    }
    const text = fs.readFileSync(CSV_PATH, 'utf8');
    const meta = readCsvMeta(text);
    /** @type {string[]} */
    const failures = [];
    if (!meta.signedBy) failures.push('清单未签字（缺少 SIGNED-BY）');
    // 签字必须有约束力：只有产品负责人/主理人可以签字放行。工程师自签不算。
    const AUTHORIZED_SIGNERS = ['summit', '科比', '齐活林', 'Qi'];
    if (meta.signedBy && !AUTHORIZED_SIGNERS.includes(meta.signedBy)) {
      failures.push(`签字人「${meta.signedBy}」无授权。预期变色是产品决策，只接受 ${AUTHORIZED_SIGNERS.join(' / ')} 签字；工程师自签无效。`);
    }
    if (gate.atoms.length > 0 && !meta.hadChanges) {
      failures.push(`实际存在 ${gate.atoms.length} 条预期变更，但清单声明「当前无预期变更」`);
    }
    if (gate.atoms.length === 0 && meta.hadChanges) {
      failures.push('清单记录了变更，但当前实际零差异（清单已过期，需重新生成并签字）');
    }
    if (meta.diffCount !== diffImages.length) {
      failures.push(`清单记录的 diff 图数量（${meta.diffCount}）与实际（${diffImages.length}）不一致`);
    }
    if (failures.length > 0) {
      console.error('[expect-inventory] --verify 失败：');
      for (const f of failures) console.error(`  - ${f}`);
      return 1;
    }
    console.log(`[expect-inventory] --verify 通过：签字人 ${meta.signedBy}（${meta.signedAt}），预期变更 ${gate.atoms.length} 条，diff 图 ${diffImages.length} 张`);
    return 0;
  }

  const csv = renderCsv(gate.atoms, diffImages, args.sign, diff);
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  fs.writeFileSync(CSV_PATH, csv);
  console.log(`[expect-inventory] 已写出 ${path.relative(REPO_ROOT, CSV_PATH).split(path.sep).join('/')}`);
  console.log(`  预期变更条目: ${gate.atoms.length}`);
  console.log(`  diff 图数量 : ${diffImages.length}`);
  console.log(`  签字        : ${args.sign ? args.sign : '未签字（需 --sign <名字> 才能用于重建基线）'}`);
  // 导出前 10 行，便于在 CI 日志里直接看到清单长什么样
  const preview = csv.split(/\r?\n/).slice(0, 10);
  console.log('  ---- 前 10 行 ----');
  for (const line of preview) console.log(`  ${line}`);
  return 0;
}

process.exit(main());
