import assert from 'node:assert/strict';
import test from 'node:test';

import {buildTurnFileChangeRows, collectTurnFileChangeFlags, turnFileChangeTotals} from '../src/utils/turnFileChanges';
import {isEditFileTool} from '../src/utils/toolMeta';

test('buildTurnFileChangeRows：同一文件已被后端合并成一条，前端只投影不累加', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: '/ws/src/a.ts', plusLines: 5, minusLines: 2, edits: 3, created: false,
      executionId: 'e1', recordId: 'r1'},
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'a.ts');
  assert.equal(rows[0].dir, '/ws/src');
  // 数字原样透出：再「帮后端加一次」会把改过去又改回来的场景记成 +2/−2。
  assert.equal(rows[0].plusLines, 5);
  assert.equal(rows[0].minusLines, 2);
  assert.deepEqual(rows[0].edit, {executionId: 'e1', recordId: 'r1'});
});

test('buildTurnFileChangeRows：缺执行或记录标识时该行不可点开差异', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: 'a.ts', plusLines: 1, minusLines: 0, executionId: 'e1'},
    {filePath: 'b.ts', plusLines: 1, minusLines: 0, recordId: 'r1'},
  ]);

  assert.equal(rows[0].edit, null, '只有 executionId 无法定位记录');
  assert.equal(rows[1].edit, null, '只有 recordId 无法定位记录');
});

test('buildTurnFileChangeRows：Windows 反斜杠路径也能拆出文件名', () => {
  const rows = buildTurnFileChangeRows([{filePath: 'D:\\repo\\src\\b.vue', plusLines: 0, minusLines: 3}]);

  assert.equal(rows[0].name, 'b.vue');
  assert.equal(rows[0].dir, 'D:/repo/src');
});

test('buildTurnFileChangeRows：根级文件没有目录副文案，缺失字段按 0 而非 NaN', () => {
  const rows = buildTurnFileChangeRows([{filePath: 'README.md'}]);

  assert.equal(rows[0].name, 'README.md');
  assert.equal(rows[0].dir, '');
  assert.equal(rows[0].plusLines, 0);
  assert.equal(rows[0].minusLines, 0);
  assert.equal(rows[0].edits, 0);
  assert.equal(rows[0].created, false);
});

test('buildTurnFileChangeRows：空输入返回空数组', () => {
  assert.deepEqual(buildTurnFileChangeRows(null), []);
  assert.deepEqual(buildTurnFileChangeRows(undefined), []);
  assert.deepEqual(buildTurnFileChangeRows([]), []);
});

test('turnFileChangeTotals：逐行相加得到全轮合计', () => {
  const rows = buildTurnFileChangeRows([
    {filePath: 'a.ts', plusLines: 5, minusLines: 2},
    {filePath: 'b.ts', plusLines: 1, minusLines: 4},
  ]);

  assert.deepEqual(turnFileChangeTotals(rows), {plusLines: 6, minusLines: 6});
});

test('collectTurnFileChangeFlags：只有带编辑痕迹的轮次才进入清单候选', () => {
  const flags = collectTurnFileChangeFlags([
    {turnId: '1', toolCalls: [{toolName: 'execute_command'}]},
    {turnId: '2', toolCalls: [{toolName: 'edit_file'}]},
    {turnId: '3', fileEdits: [{filePath: 'a.ts'}]},
  ], isEditFileTool);

  assert.equal(flags.get('1') ?? false, false, '只跑过命令的轮次不该发汇总请求');
  assert.equal(flags.get('2'), true);
  assert.equal(flags.get('3'), true);
});

test('collectTurnFileChangeFlags：无归属的旧数据与空输入都不会被算成改过文件', () => {
  const flags = collectTurnFileChangeFlags([
    {turnId: null, toolCalls: [{toolName: 'edit_file'}]},
    {toolCalls: [{toolName: 'edit_file'}]},
    {turnId: '9', toolCalls: []},
  ], isEditFileTool);

  assert.equal(flags.size, 0);
  assert.equal(collectTurnFileChangeFlags(null, isEditFileTool).size, 0);
});
