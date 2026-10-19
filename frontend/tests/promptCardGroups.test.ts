import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCommandApprovals, type PromptCardEntry } from '../src/utils/promptCardGroups';
import { resolveCardStatusLabel } from '../src/utils/toolCallCard';
import { setPreference } from '../src/i18n';

setPreference('zh-CN');
const entry = (id: string, kind: PromptCardEntry['card']['kind'] = 'COMMAND'): PromptCardEntry => ({
  id, card: { toolCallId: id, conversationId: '42', kind, title: '', content: 'git status',
    command: 'git status', status: 'completed', pending: false, outcome: 'APPROVED', version: '7' }
});

test('本轮命令按类型合成一组，计划和提问保持独立且不改写卡片身份', () => {
  const source = [entry('plan', 'PLAN'), entry('cmd-1'), entry('choice', 'CHOICE'), entry('cmd-2'), entry('unknown', 'UNAVAILABLE')];
  const grouped = groupCommandApprovals(source);
  assert.deepEqual(grouped.map(item => item.id), ['plan', 'cmd-1', 'choice', 'unknown']);
  assert.deepEqual(grouped[1]!.commands, [source[1], source[3]]);
  assert.equal(grouped[1]!.commands![1]!.card, source[3]!.card);
  assert.equal(grouped[1]!.commands![1]!.card.version, '7');
  assert.equal(source.length, 5);
  assert.equal('commands' in source[1]!, false);
});

test('分组状态不会跨轮次泄漏，待审批与已决记录均保留', () => {
  const pending = entry('pending');
  pending.card = { ...pending.card, pending: true, status: 'pending', outcome: undefined, allowedActions: ['APPROVE', 'REJECT'] };
  const firstTurn = groupCommandApprovals([entry('old'), pending]);
  const secondTurn = groupCommandApprovals([entry('another-turn')]);
  assert.deepEqual(firstTurn[0]!.commands!.map(item => item.id), ['old', 'pending']);
  assert.deepEqual(secondTurn[0]!.commands!.map(item => item.id), ['another-turn']);
  assert.deepEqual(firstTurn[0]!.commands![1]!.card.allowedActions, ['APPROVE', 'REJECT']);
  assert.deepEqual(groupCommandApprovals([]), []);
});

test('组内状态保留取消、拒绝、失败和待审批的区别', () => {
  const card = entry('cmd').card;
  for (const [outcome, label] of [['APPROVED', '已批准'], ['CANCELLED', '已取消'], ['REJECTED', '已拒绝'], ['FAILED', '已失败']]) {
    assert.equal(resolveCardStatusLabel({ ...card, outcome }), label);
  }
  assert.equal(resolveCardStatusLabel({ ...card, outcome: undefined, status: 'pending', pending: true }), '等待审批');
});
