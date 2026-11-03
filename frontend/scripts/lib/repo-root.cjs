'use strict';

/**
 * 仓库根探测的**唯一真源**。
 *
 * <p><b>为什么要单独一个模块：</b>同一个问题（"这个 frontend/ 属于哪个仓库"）在仓库里
 * 被实现了 4 次，各自一套退路。其中一份写死了固定层数
 * （`path.resolve(startDir, '..', '..', '..')`）：它在隔离工作树布局
 * （`<repo>/.lingxi/work/<task>/frontend`）下恰好算对，于是在主仓
 * （`D:\Code\LingXi\frontend`）下算到 `D:\` —— 守卫的截图于是落到
 * `D:\tmp\pet-face-guard`，**在工作区之外**，谁也不会去清。固定层数这个写法的缺陷不在于
 * "算错了"，而在于"在一棵树上对、在另一棵树上错"：本地怎么跑都是绿的。</p>
 *
 * <p><b>规则出处：</b>`scripts/build-pet-assets.mjs` 的 `toRepoRelative()` 早就在用正确规则——
 * 从起点逐级向上，找第一个含 `.git`（仓库）或 `.lingxi`（工作区标记）的目录。本模块就是那条
 * 规则的唯一实现，其余调用方一律从这里取，不要再出现第二份。</p>
 *
 * <p><b>为什么"找不到就返回 null"而不是退回某个猜测路径：</b>退回猜测路径会把"我没算出来"
 * 伪装成"算出来了"。运行产物一旦落到工作区之外，就是留给用户去清理的垃圾，而且没有任何
 * 报错提示。所以这里宁可让调用方拿到 null 并显式失败（见 {@link lingxiTmpDir}）。</p>
 *
 * <p><b>为什么不能把文件系统根当成仓库根：</b>只有到盘符根（Windows 的 `D:\`、POSIX 的 `/`）
 * 还没找到标记时才算失败。盘符根几乎必然不含 `.git`/`.lingxi`；一旦被当成仓库根，
 * `<根>/.lingxi/tmp` 就是 `D:\.lingxi\tmp` 这种根本不该存在的路径。</p>
 *
 * @module scripts/lib/repo-root
 */

const fs = require('node:fs');
const path = require('node:path');

/** 仓库根标记：`.git`（普通仓库或 worktree 的 `.git` 文件）与 `.lingxi`（隔离工作区）。 */
const REPO_MARKERS = Object.freeze(['.git', '.lingxi']);

/** 向上探测的层数上限（防御性上限，正常仓库远小于它）。 */
const MAX_ANCESTOR_DEPTH = 64;

/**
 * 某个目录本身是不是仓库根（含任一标记即可）。
 *
 * @param {string} dir 目录路径
 * @returns {boolean} 是否含 `.git` 或 `.lingxi`
 */
function isRepoRoot(dir) {
  for (const marker of REPO_MARKERS) {
    try {
      if (fs.existsSync(path.join(dir, marker))) return true;
    } catch {
      // 路径非法/无权限：当作"没有这个标记"，继续向上找
    }
  }
  return false;
}

/**
 * 从 `startDir` 逐级向上，返回**第一个**含 `.git` 或 `.lingxi` 的目录。
 *
 * <p>语义要点：</p>
 * <ul>
 *   <li>`startDir` 自身也算候选（调用方常从 `<repo>/frontend` 开始）；</li>
 *   <li>到盘符根还没找到 ⇒ 返回 `null`，**绝不**把文件系统根当仓库根；</li>
 *   <li>只做路径上溯 + `existsSync` 探测，不读文件内容、不依赖 cwd。</li>
 * </ul>
 *
 * @param {string} startDir 起点目录（绝对路径；相对路径按当前工作目录解析）
 * @returns {string|null} 仓库根绝对路径；找不到时为 `null`
 * @throws {TypeError} `startDir` 不是非空字符串时抛出
 */
function findRepoRoot(startDir) {
  if (typeof startDir !== 'string' || startDir.trim().length === 0) {
    throw new TypeError(`findRepoRoot: startDir 必须是非空字符串，实际收到 ${String(startDir)}`);
  }
  let cursor = path.resolve(startDir);
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    if (isRepoRoot(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  return null;
}

/**
 * 仓库内的临时目录：`<repoRoot>/.lingxi/tmp/<segments…>`。
 *
 * <p>运行产物（截图、日志、一次性索引副本）一律落这里，绝不落工作区之外。</p>
 *
 * @param {string} startDir 起点目录（通常传 frontend 根）
 * @param {...(string|number)} segments 子目录名（按顺序拼接，允许为空）
 * @returns {string} 绝对路径
 * @throws {TypeError} `startDir` 非法、或某个 segment 非字符串/数字时抛出
 * @throws {Error} 找不到仓库根时抛出（带"请从仓库内运行"的修法提示）
 * @throws {RangeError} `segments` 试图逃出 `.lingxi/tmp` 时抛出
 */
function lingxiTmpDir(startDir, ...segments) {
  const repoRoot = findRepoRoot(startDir);
  if (repoRoot === null) {
    const from = path.resolve(typeof startDir === 'string' && startDir.trim().length > 0 ? startDir : '.');
    throw new Error(
      `无法确定仓库根：从 ${from} 逐级向上直到盘符根都没有找到 ${REPO_MARKERS.join(' 或 ')}。`
        + ' 桌宠脚本的运行产物必须落在 <repo>/.lingxi/tmp 下；本工具不会退回到某个猜测路径'
        + '（那正是产物跑到工作区之外的成因）。'
        + ' 修法：请从仓库内运行（仓库根或它的 frontend/ 子目录）；'
        + '若脚本支持，也可用绝对路径显式指定产物目录（如守卫的 --out=<绝对路径>）。',
    );
  }
  const tmpRoot = path.join(repoRoot, '.lingxi', 'tmp');
  const parts = segments.map((segment) => {
    if (typeof segment === 'number') return String(segment);
    if (typeof segment !== 'string') {
      throw new TypeError(`lingxiTmpDir: segment 必须是字符串或数字，实际收到 ${String(segment)}`);
    }
    return segment;
  });
  const result = path.join(tmpRoot, ...parts);
  const relative = path.relative(tmpRoot, result);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RangeError(`lingxiTmpDir: 结果 ${result} 逃出了 ${tmpRoot}（segments=${JSON.stringify(parts)}）`);
  }
  return result;
}

module.exports = { findRepoRoot, lingxiTmpDir, isRepoRoot, REPO_MARKERS, MAX_ANCESTOR_DEPTH };
