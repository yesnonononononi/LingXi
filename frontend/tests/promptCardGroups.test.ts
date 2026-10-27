import test from 'node:test';
import assert from 'node:assert/strict';
import { groupApprovalCards, groupChoiceQuestions, type PromptCardEntry } from '../src/utils/promptCardGroups';
import { resolveCardStatusLabel } from '../src/utils/toolCallCard';
import { setPreference } from '../src/i18n';

setPreference('zh-CN');
const entry = (id: string, kind: PromptCardEntry['card']['kind'] = 'COMMAND'): PromptCardEntry => ({
  id, card: { toolCallId: id, conversationId: '42', kind, title: '', content: 'git status',
    command: 'git status', status: 'completed', pending: false, outcome: 'APPROVED', version: '7' }
});

test('选择按模型响应和会话分组，同一业务轮次的后续提问保持独立', () => {
  const first = { ...entry('q1', 'CHOICE'), responseId: 'response-1' };
  const second = { ...entry('q2', 'CHOICE'), responseId: 'response-1' };
  const next = { ...entry('q3', 'CHOICE'), responseId: 'response-2' };
  const other = { ...entry('q4', 'CHOICE'), responseId: 'response-1', card: { ...first.card, conversationId: '99' } };
  const groups = groupChoiceQuestions(groupApprovalCards([first, entry('cmd'), second, next, other]));
  assert.deepEqual(groups.map(group => group.choices?.map(item => item.id) ?? ['cmd']), [['q1', 'q2'], ['cmd'], ['q3'], ['q4']]);
  assert.equal(groups[0]!.choices![0]!.card, first.card);
  assert.equal('choices' in first, false);
});

test('本轮审批按类型归组，提问保持独立且不改写卡片身份', () => {
  const source = [entry('plan', 'PLAN'), entry('cmd-1'), entry('choice', 'CHOICE'), entry('cmd-2'), entry('unknown', 'UNAVAILABLE')];
  const grouped = groupApprovalCards(source);
  assert.deepEqual(grouped.map(item => item.id), ['plan', 'cmd-1', 'choice', 'unknown']);
  assert.deepEqual(grouped[1]!.approvals, [source[1], source[3]]);
  assert.equal(grouped[1]!.approvals![1]!.card, source[3]!.card);
  assert.equal(grouped[1]!.approvals![1]!.card.version, '7');
  assert.equal(source.length, 5);
  assert.equal('approvals' in source[1]!, false);
});

test('分组状态不会跨轮次泄漏，待审批与已决记录均保留', () => {
  const pending = entry('pending');
  pending.card = { ...pending.card, pending: true, status: 'pending', outcome: undefined, allowedActions: ['APPROVE', 'REJECT'] };
  const firstTurn = groupApprovalCards([entry('old'), pending]);
  const secondTurn = groupApprovalCards([entry('another-turn')]);
  assert.deepEqual(firstTurn[0]!.approvals!.map(item => item.id), ['old', 'pending']);
  assert.deepEqual(secondTurn[0]!.approvals!.map(item => item.id), ['another-turn']);
  assert.deepEqual(firstTurn[0]!.approvals![1]!.card.allowedActions, ['APPROVE', 'REJECT']);
  assert.deepEqual(groupApprovalCards([]), []);
});

test('多份计划归入同组，与穿插的命令审批分开并保留版本和动作', () => {
  const first = entry('plan-1', 'PLAN');
  const pending = entry('plan-2', 'PLAN');
  pending.card = { ...pending.card, status: 'pending', pending: true, outcome: undefined, allowedActions: ['APPROVE', 'REJECT'] };
  const command = entry('cmd');
  const source = [first, command, entry('choice', 'CHOICE'), pending];
  const grouped = groupApprovalCards(source);
  assert.deepEqual(grouped.map(item => item.id), ['plan-1', 'cmd', 'choice']);
  assert.deepEqual(grouped[0]!.approvals, [first, pending]);
  assert.deepEqual(grouped[1]!.approvals, [command]);
  assert.equal(grouped[0]!.approvals![1]!.card, pending.card);
  assert.equal(grouped[0]!.approvals![1]!.card.version, '7');
  assert.deepEqual(grouped[0]!.approvals![1]!.card.allowedActions, ['APPROVE', 'REJECT']);
  assert.equal('approvals' in first, false);
  assert.deepEqual(groupApprovalCards([entry('other-plan', 'PLAN')])[0]!.approvals!.map(item => item.id), ['other-plan']);
});

test('组内状态保留取消、拒绝、失败和待审批的区别', () => {
  const card = entry('cmd').card;
  for (const [outcome, label] of [['APPROVED', '已批准'], ['CANCELLED', '已取消'], ['REJECTED', '已拒绝'], ['FAILED', '已失败']]) {
    assert.equal(resolveCardStatusLabel({ ...card, outcome }), label);
  }
  assert.equal(resolveCardStatusLabel({ ...card, outcome: undefined, status: 'pending', pending: true }), '等待审批');
});
