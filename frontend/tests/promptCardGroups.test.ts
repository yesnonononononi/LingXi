import test from 'node:test';
import assert from 'node:assert/strict';
import { groupInteractionCards, groupChoiceQuestions, isPendingCardEntry, type PromptCardEntry } from '../src/utils/promptCardGroups';
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
  const groups = groupChoiceQuestions([first, entry('cmd'), second, next, other]);
  assert.deepEqual(groups.map(group => group.choices?.map(item => item.id) ?? ['cmd']), [['q1', 'q2'], ['cmd'], ['q3'], ['q4']]);
  assert.equal(groups[0]!.choices![0]!.card, first.card);
  assert.equal('choices' in first, false);
});

test('本轮卡片按类型归组，不改写卡片身份', () => {
  const source = [entry('plan', 'PLAN'), entry('cmd-1'), entry('choice', 'CHOICE'), entry('cmd-2'), entry('unknown', 'UNAVAILABLE')];
  const grouped = groupInteractionCards(source);
  assert.deepEqual(grouped.map(item => item.entries[0]!.id), ['plan', 'cmd-1', 'choice', 'unknown']);
  assert.deepEqual(grouped[1]!.entries, [source[1], source[3]]);
  assert.equal(grouped[1]!.entries![1]!.card, source[3]!.card);
  assert.equal(grouped[1]!.entries![1]!.card.version, '7');
  assert.equal(source.length, 5);
  assert.equal('entries' in source[1]!, false);
});

test('待决与准备中分类优先于已决分类，同状态分类保留原序', () => {
  const completed = entry('done', 'PLAN');
  const pending = entry('waiting', 'CHOICE');
  pending.card = { ...pending.card, status: 'pending', pending: true };
  const preparing = entry('preparing', 'COMMAND');
  preparing.card = { ...preparing.card, status: 'preparing', pending: false };
  const source = [completed, pending, preparing];
  assert.deepEqual(groupInteractionCards(source).map(category => category.kind), ['CHOICE', 'COMMAND', 'PLAN']);
  assert.deepEqual(source.map(item => item.id), ['done', 'waiting', 'preparing']);
});

test('分组状态不会跨轮次泄漏，待审批与已决记录均保留', () => {
  const pending = entry('pending');
  pending.card = { ...pending.card, pending: true, status: 'pending', outcome: undefined, allowedActions: ['APPROVE', 'REJECT'] };
  const firstTurn = groupInteractionCards([entry('old'), pending]);
  const secondTurn = groupInteractionCards([entry('another-turn')]);
  assert.deepEqual(firstTurn[0]!.entries!.map(item => item.id), ['old', 'pending']);
  assert.deepEqual(secondTurn[0]!.entries!.map(item => item.id), ['another-turn']);
  assert.deepEqual(firstTurn[0]!.entries![1]!.card.allowedActions, ['APPROVE', 'REJECT']);
  assert.deepEqual(groupInteractionCards([]), []);
});

test('多份计划归入同组，与穿插的命令审批分开并保留版本和动作', () => {
  const first = entry('plan-1', 'PLAN');
  const pending = entry('plan-2', 'PLAN');
  pending.card = { ...pending.card, status: 'pending', pending: true, outcome: undefined, allowedActions: ['APPROVE', 'REJECT'] };
  const command = entry('cmd');
  const source = [first, command, entry('choice', 'CHOICE'), pending];
  const grouped = groupInteractionCards(source);
  assert.deepEqual(grouped.map(item => item.entries[0]!.id), ['plan-1', 'cmd', 'choice']);
  assert.deepEqual(grouped[0]!.entries, [first, pending]);
  assert.deepEqual(grouped[1]!.entries, [command]);
  assert.equal(grouped[0]!.entries![1]!.card, pending.card);
  assert.equal(grouped[0]!.entries![1]!.card.version, '7');
  assert.deepEqual(grouped[0]!.entries![1]!.card.allowedActions, ['APPROVE', 'REJECT']);
  assert.equal('entries' in first, false);
  assert.deepEqual(groupInteractionCards([entry('other-plan', 'PLAN')])[0]!.entries!.map(item => item.id), ['other-plan']);
});

test('组内状态保留取消、拒绝、失败和待审批的区别', () => {
  const card = entry('cmd').card;
  for (const [outcome, label] of [['APPROVED', '已批准'], ['CANCELLED', '已取消'], ['REJECTED', '已拒绝'], ['FAILED', '已失败']]) {
    assert.equal(resolveCardStatusLabel({ ...card, outcome }), label);
  }
  assert.equal(resolveCardStatusLabel({ ...card, outcome: undefined, status: 'pending', pending: true }), '等待审批');
});

test('批准后执行中的命令不再计入待处理，准备中与待审批仍保留', () => {
  const running = entry('running');
  running.card = { ...running.card, status: 'in_progress', pending: false, allowedActions: [] };
  const waiting = entry('waiting', 'PLAN');
  waiting.card = { ...waiting.card, status: 'pending', pending: true, outcome: undefined };
  const preparing = entry('preparing', 'CHOICE');
  preparing.card = { ...preparing.card, status: 'preparing', pending: false, outcome: undefined };
  assert.equal(resolveCardStatusLabel(running.card), '已批准');
  assert.equal(isPendingCardEntry(running), false);
  assert.equal(isPendingCardEntry({ ...running, card: { ...running.card, outcome: undefined } }), false);
  assert.equal(isPendingCardEntry(waiting), true);
  assert.equal(isPendingCardEntry(preparing), true);
  assert.deepEqual(groupInteractionCards([running, waiting, preparing]).map(category => category.kind),
    ['PLAN', 'CHOICE', 'COMMAND']);
});

test('提问合并进同一类型下拉，提交批次仍按会话和响应身份隔离', () => {
  const first = { ...entry('q1', 'CHOICE'), responseId: '101' };
  const later = { ...entry('q2', 'CHOICE'), responseId: '102' };
  const sameBatch = { ...entry('q3', 'CHOICE'), responseId: '101' };
  const categories = groupInteractionCards([first, entry('plan', 'PLAN'), later, sameBatch]);
  assert.deepEqual(categories.map(category => category.kind), ['CHOICE', 'PLAN']);
  assert.deepEqual(categories[0]!.entries, [first, later, sameBatch]);
  const batches = groupChoiceQuestions(categories[0]!.entries);
  assert.deepEqual(batches.map(batch => batch.choices!.map(item => item.id)), [['q1', 'q3'], ['q2']]);
  assert.equal(batches[0]!.responseId, '101');
  assert.equal(batches[1]!.responseId, '102');
});
