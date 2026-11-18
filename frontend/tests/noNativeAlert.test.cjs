/**
 * 原生弹窗禁令的静态守卫。
 *
 * <p>为什么必须拦住：`window.alert` 在 Electron 里的标题由 app name 决定（历史包名
 * `aether-agent-chat` 就是这样漏到用户脸上的），样式与主题完全脱钩，还会阻塞渲染线程 ——
 * 换句话说，用户看到的不是「我们产品的弹窗」，而是「操作系统的告警」。项目已有
 * `useConfirm`（confirm / notice / busy），没有任何理由再写原生弹窗。</p>
 *
 * <p><b>金丝雀正对照</b>：本文件先证明扫描器能命中一段故意包含 `window.alert(` 的样本，
 * 再去断言源码里没有 —— 否则「0 处」可能只是扫描器没工作（路径写错、没递归、被当二进制跳过）。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
const NATIVE_ALERT = /\bwindow\.alert\s*\(|\balert\s*\(/;

/** 递归列出源码文件：只扫 .ts / .vue（含 src 下任意深度的目录）。 */
function collectSourceFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) {
      result.push(full);
    }
  }
  return result;
}

/** 去掉注释：说明文字里提到 `window.alert`（比如「为什么不用它」）不算违规。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

test('金丝雀：扫描器确实能命中 window.alert 与裸 alert', () => {
  assert.match('window.alert(t(\'x\'))', NATIVE_ALERT, 'window.alert 样本必须命中');
  assert.match('alert(\'x\')', NATIVE_ALERT, '裸 alert 样本必须命中');
  assert.doesNotMatch('notify(t(\'x\'))', NATIVE_ALERT, 'notify 不得误判');
});

test('源码文件确实被扫到（不是空集合假绿）', () => {
  const files = collectSourceFiles(SRC);
  assert.ok(files.length > 100, `扫描到的源码文件过少（${files.length}），说明路径或递归有问题`);
  assert.ok(
    files.some(file => file.endsWith(path.join('composables', 'useConfirm.ts'))),
    '深层目录必须被递归到（useConfirm.ts 在 src/composables 下）',
  );
});

test('src 下不得残留原生弹窗', () => {
  const offenders = [];
  for (const file of collectSourceFiles(SRC)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    source.split(/\r?\n/).forEach((line, index) => {
      if (NATIVE_ALERT.test(line)) {
        offenders.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `原生弹窗必须迁移到 useConfirm 的 notice/busy：\n${offenders.join('\n')}`);
});
