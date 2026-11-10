/**
 * 统一差异与全文合并的单测。
 *
 * <p>重点是「删除行不消耗全文行、新增行必须消耗全文行」这一对方向相反的推进规则：
 * 弄反一次，后面所有行号与内容都会整体错位。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeFullFileDiff, parseUnifiedDiff} from '../src/utils/fileDiff';

test('parseUnifiedDiff：只认 @@ 头之后的 +-空格 行，忽略 No newline 标记', () => {
  const hunks = parseUnifiedDiff([
    '--- a.txt', '+++ a.txt',
    '@@ -1,2 +1,3 @@',
    ' a', '-b', '+B', '+c',
    '\\ No newline at end of file',
  ].join('\n'));
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    oldStart: 1, newStart: 1,
    lines: [{ type: ' ', text: 'a' }, { type: '-', text: 'b' }, { type: '+', text: 'B' }, { type: '+', text: 'c' }],
  });
});

test('mergeFullFileDiff：删除行插入原位置，新增行替换全文对应行', () => {
  const full = 'alpha\nBETA\ngamma\n';
  const diff = ['--- a', '+++ b', '@@ -1,3 +1,3 @@', ' alpha', '-beta', '+BETA', ' gamma'].join('\n');

  assert.deepEqual(mergeFullFileDiff(full, diff), [
    { kind: 'context', lineNumber: 1, text: 'alpha' },
    { kind: 'del', lineNumber: 2, text: 'beta' },
    { kind: 'add', lineNumber: 2, text: 'BETA' },
    { kind: 'context', lineNumber: 3, text: 'gamma' },
  ]);
});

test('mergeFullFileDiff：hunk 覆盖不到的尾部行按上下文补齐', () => {
  // 全文是编辑后的内容，新增行文本以全文为准。
  const full = 'A\nb\nc\nd\n';
  const diff = ['@@ -1,1 +1,1 @@', '-a', '+A'].join('\n');
  const merged = mergeFullFileDiff(full, diff);

  assert.deepEqual(merged.map(line => [line.kind, line.lineNumber, line.text]), [
    ['del', 1, 'a'],
    ['add', 1, 'A'],
    ['context', 2, 'b'],
    ['context', 3, 'c'],
    ['context', 4, 'd'],
  ]);
});

test('mergeFullFileDiff：纯删除不产生新增行，行号仍连续', () => {
  const full = 'a\nc\n';
  const diff = ['@@ -1,2 +1,1 @@', ' a', '-b'].join('\n');
  const merged = mergeFullFileDiff(full, diff);

  assert.deepEqual(merged, [
    { kind: 'context', lineNumber: 1, text: 'a' },
    { kind: 'del', lineNumber: 2, text: 'b' },
    { kind: 'context', lineNumber: 2, text: 'c' },
  ]);
});

test('mergeFullFileDiff：空差异等于原样返回全文', () => {
  assert.deepEqual(mergeFullFileDiff('a\nb\n', ''), [
    { kind: 'context', lineNumber: 1, text: 'a' },
    { kind: 'context', lineNumber: 2, text: 'b' },
  ]);
});

test('mergeFullFileDiff：CRLF 全文与 LF 差异仍能对齐', () => {
  const full = 'alphaX\r\nBETA\r\n';
  const diff = ['@@ -1,2 +1,2 @@', '-alpha', '+alphaX', ' BETA'].join('\n');
  const merged = mergeFullFileDiff(full, diff);

  assert.deepEqual(merged.map(line => [line.kind, line.text]), [
    ['del', 'alpha'], ['add', 'alphaX'], ['context', 'BETA'],
  ]);
});
