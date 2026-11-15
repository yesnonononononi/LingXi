import assert from 'node:assert/strict';
import test from 'node:test';
import {groupRollbackPlan, resolveRollbackExecutionId} from '../src/utils/fileRollbackPlan';
import type {FileRollbackPlan} from '../src/services/fileRollback';

/**
 * 回滚弹窗的投影：分组、默认勾选、执行标识解析。
 *
 * <p>这些判断都有对错之分，写进 `.vue` 就只能靠点界面验。这里只验「后端事实怎么摆放」，
 * 门禁本身在后端 —— 前端不重算任何一条。</p>
 */

function plan(...items: Array<Partial<FileRollbackPlan['items'][number]> & {action: any; filePath: string}>): FileRollbackPlan {
  return {
    executionId: 'e1',
    items: items.map(item => ({
      filePath: item.filePath,
      action: item.action,
      reason: item.reason ?? null,
      baseline: item.baseline ?? null,
      recordId: item.recordId ?? 'r1'
    }))
  };
}

test('groupRollbackPlan：按 action 分三组，跳过项带上后端给的原因', () => {
  const groups = groupRollbackPlan(plan(
    {action: 'RESTORE', filePath: '/ws/a.ts', baseline: 'old\n'},
    {action: 'DELETE', filePath: '/ws/new.ts'},
    {action: 'SKIP', filePath: '/ws/b.ts', reason: '执行结束后文件被改动过'}
  ));

  assert.deepEqual(groups.restore.map(item => item.filePath), ['/ws/a.ts']);
  assert.deepEqual(groups.remove.map(item => item.filePath), ['/ws/new.ts']);
  assert.deepEqual(groups.skipped.map(item => item.filePath), ['/ws/b.ts']);
  assert.equal(groups.skipped[0].reason, '执行结束后文件被改动过');
});

test('groupRollbackPlan：默认只勾能执行的，跳过的一条都不选', () => {
  const groups = groupRollbackPlan(plan(
    {action: 'RESTORE', filePath: '/ws/a.ts'},
    {action: 'SKIP', filePath: '/ws/b.ts', reason: '基线已过期，无法回滚'}
  ));

  // 跳过是后端的结论，不是可勾的选项：勾上就等于承诺一件做不到的事。
  assert.deepEqual(groups.defaultSelection, ['/ws/a.ts']);
});

test('groupRollbackPlan：空计划与 null 都给空分组，不抛', () => {
  assert.deepEqual(groupRollbackPlan(null).defaultSelection, []);
  assert.deepEqual(groupRollbackPlan(plan()).restore, []);
});

test('resolveRollbackExecutionId：只有唯一执行才回填，其它一律 null', () => {
  assert.equal(resolveRollbackExecutionId(['e1', 'e1']), 'e1');
  assert.equal(resolveRollbackExecutionId(['e1', null, undefined, '']), 'e1', '空值不算另一个执行');
  assert.equal(resolveRollbackExecutionId(['e1', 'e2']), null, '两个执行说明数据异常，不许猜');
  assert.equal(resolveRollbackExecutionId([]), null);
  assert.equal(resolveRollbackExecutionId([null, '']), null);
});
