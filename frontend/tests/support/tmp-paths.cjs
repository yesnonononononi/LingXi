'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 路径规范化策略：`realpathSync.native` 优先（走系统的 GetFinalPathNameByHandle，能把 8.3 短名
 * 展开成长名、解开符号链接/联接点），退回 JS 实现的 `realpathSync`，两者都失败时交给调用方兜底。
 *
 * @type {Array<(target: string) => string>}
 */
const REALPATH_STRATEGIES = [
  target => fs.realpathSync.native(target),
  target => fs.realpathSync(target),
];

/**
 * 试一次规范化；目标不存在（ENOENT/ENOTDIR）返回 null，其它错误照常抛出。
 *
 * @param {string} target 绝对路径
 * @returns {string|null} 规范化后的路径；不存在时 null
 */
function tryRealpath(target) {
  for (const strategy of REALPATH_STRATEGIES) {
    try {
      return strategy(target);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      throw error;
    }
  }
  return null;
}

/**
 * 把路径规范化成"机器的长名写法"——这是路径比较的**唯一**口径。
 *
 * <p>语义：能拿到真实路径就用真实路径（展开 8.3 短名、解开联接点）；目标还不存在时，
 * 规范化**最近的已存在祖先**再把剩下的尾段原样拼回去（这样 `mkdtemp` 之前算出来的路径
 * 与创建之后的规范化结果一致）。两种策略都不可用时退回 {@link path.resolve}。</p>
 *
 * @param {string} value 任意路径（相对路径按 `process.cwd()` 解析）
 * @returns {string} 规范化的绝对路径
 * @throws {TypeError} 入参不是非空字符串
 */
function canonicalPath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('canonicalPath: 需要一个非空路径字符串');
  }
  const absolute = path.resolve(value);
  const tail = [];
  let current = absolute;
  for (;;) {
    const resolved = tryRealpath(current);
    if (resolved !== null) return tail.length === 0 ? resolved : path.join(resolved, ...tail);
    const parent = path.dirname(current);
    // 连根都不存在（或已到盘符根）：没有更可靠的规范形，退回 path.resolve 的结果
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * 规范化的临时目录根：**一次性**把 `os.tmpdir()` 变成机器的长名写法。
 *
 * <p>所有测试 fixture 一律基于它创建，而不是直接用 `os.tmpdir()`。原因见文件头：
 * 短名只会在"JS 侧字符串"和"子进程回报的路径"之间制造假的不相等。</p>
 *
 * @type {string}
 */
const TMP_ROOT = canonicalPath(os.tmpdir());

module.exports = { canonicalPath, TMP_ROOT };