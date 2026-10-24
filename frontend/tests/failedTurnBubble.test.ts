/**
 * 失败轮错误气泡的合成与接线测试。
 *
 * 背景（这是一条真实缺陷，别把测试删了）：
 *   「空块 + FAILED」的轮次在库里常常只有 USER 行、没有 assistant 行，FAILED 提示无处可挂。
 *   曾经的做法是把 `turn.errorReason` 拼进合成气泡的 content —— 但正文每次投影都由块重算，
 *   下一次投影（对账 / 翻页 / 快照）会把拼进去的原因抹成空串，失败轮又变回不可见。
 *
 *   现在的契约：**投影负责建行**（空块终态也建，见 `upsertTurnViewIntoMessages`），
 *   渲染层按气泡的 `failed` 标记 + `turn.errorReason` 展示；`synthesizeFailedTurnBubbles`
 *   只保留为「连 turnView 都没有」的旧数据兜底。
 *
 * 本测试同时覆盖两层：
 *   ① 合成函数语义（对没有视图的轮次仍然有效、幂等、插位）
 *   ② 接线（聚合产物里必须有可渲染的 assistant 行，且状态不被重投影抹掉）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  synthesizeFailedTurnBubbles,
} from '../src/utils/session';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { t } from '../src/i18n';
import type { ChatMessage, ChatTurn } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';

const SESSION_ID = '777000111222333444';
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');

/**
 * 历史侧的最小投影：把若干轮视图并入消息数组。
 *
 * <p>失败轮在库里常常只有 USER 行 —— 视图里就只有 {@code userMessage}、没有块，
 * 这正是「FAILED 徽标无处可挂」的场景。</p>
 */
function projectViews(views: TurnViewVO[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const versions = new Map<string, number>();
  for (const view of views) upsertTurnViewIntoMessages(messages, view, versions);
  return messages;
}

/** 一页里某几轮的视图（只给提问，不给块）。失败轮在库里常常只有 USER 行。 */
function viewsOfUserMessages(turnIds: string[]): TurnViewVO[] {
  return turnIds.map(turnId => ({
    sessionId: SESSION_ID, turnId, status: 'FAILED', viewVersion: '1', userMessage: '你好', blocks: [],
  }));
}

function failedTurn(errorReason?: string): ChatTurn {
  return {
    turnId: 'T-FAILED',
    status: 'FAILED',
    errorReason,
  } as ChatTurn;
}

// ================================================================ ① 纯函数语义

test('合成：FAILED 轮且缺 assistant 行时补一个错误气泡', () => {
  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: '你好',
      turnId: 'T-FAILED',
      timestamp: 0,
      isComplete: true,
    } as ChatMessage,
  ];
  const turns: Record<string, ChatTurn> = { 'T-FAILED': failedTurn('模型接口返回 400') };

  const out = synthesizeFailedTurnBubbles(messages, turns);

  assert.equal(out.length, 2, '应补出 1 条气泡');
  const synth = out.find(m => m.id === 'synthetic-failed-T-FAILED');
  assert.ok(synth, '必须存在合成气泡');
  assert.equal(synth!.role, 'assistant', '合成气泡必须是 assistant（FAILED 徽标挂在组尾 assistant 上）');
  assert.equal(synth!.content, '模型接口返回 400', '应带上轮次的失败原因');
  assert.equal(synth!.turnId, 'T-FAILED');
  assert.equal(synth!.isComplete, true, '合成气泡必须已终结，否则会一直转圈');
});

test('合成：errorReason 缺失时回落为「执行失败」而不是空串', () => {
  // 变异：把 `(turn.errorReason || '').trim() || '执行失败'` 改成直接取 errorReason → 内容为空，本测试红
  const messages: ChatMessage[] = [];
  const turns: Record<string, ChatTurn> = { 'T-FAILED': failedTurn(undefined) };

    const out = synthesizeFailedTurnBubbles(messages, turns);
  const synth = out.find(m => m.id === 'synthetic-failed-T-FAILED');
  assert.ok(synth);
  // 兜底文案已 i18n 化：断言等于当前语言的 turn.status.failed，既锁定「非空白」，
  // 又不把文案硬编码成某一语言（文案真值以字典为准）。
  assert.equal(synth!.content, t('turn.status.failed'), '空原因必须有兜底文案，不能是空白气泡');
  assert.ok(synth!.content.length > 0, '兜底文案不得为空串');
});

test('合成：轮次已有 assistant 行时不合成（幂等）', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'q', turnId: 'T-FAILED', timestamp: 0, isComplete: true } as ChatMessage,
    { id: 'a1', role: 'assistant', content: '已有回答', turnId: 'T-FAILED', timestamp: 0, isComplete: true } as ChatMessage,
  ];
  const turns: Record<string, ChatTurn> = { 'T-FAILED': failedTurn('x') };

  const out = synthesizeFailedTurnBubbles(messages, turns);
  assert.equal(out.length, 2, '已有 assistant 行时不得重复合成');
  assert.ok(!out.some(m => m.id === 'synthetic-failed-T-FAILED'));
});

test('合成：重复调用不累积（幂等）', () => {
  // 关键：接线后这条函数会在「对账」「翻页」等多条路径上被调用，
  // 不幂等就会每次刷新多一个气泡。
  // 变异：把「已有 assistant 行则跳过」的守卫删掉 → 第二次调用会再插一条，本测试红
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'q', turnId: 'T-FAILED', timestamp: 0, isComplete: true } as ChatMessage,
  ];
  const turns: Record<string, ChatTurn> = { 'T-FAILED': failedTurn('偶发错误') };

  const once = synthesizeFailedTurnBubbles(messages, turns);
  const twice = synthesizeFailedTurnBubbles(once, turns);

  assert.equal(once.length, 2);
  assert.equal(twice.length, 2, '第二次调用不得再插一条 —— 幂等性');
});

test('合成：非 FAILED 轮次不动', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'q', turnId: 'T1', timestamp: 0, isComplete: true } as ChatMessage,
  ];
  const turns: Record<string, ChatTurn> = {
    T1: { turnId: 'T1', status: 'COMPLETED' } as ChatTurn,
    T2: { turnId: 'T2', status: 'RUNNING' } as ChatTurn,
  };

  const out = synthesizeFailedTurnBubbles(messages, turns);
  assert.equal(out.length, 1, '只有 FAILED 才合成');
});

test('合成：turns 为空时不报错', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'q', turnId: 'T1', timestamp: 0, isComplete: true } as ChatMessage,
  ];
  assert.doesNotThrow(() => synthesizeFailedTurnBubbles(messages, {}));
  assert.equal(synthesizeFailedTurnBubbles(messages, {}).length, 1);
});

test('合成：插入位置紧跟该轮最后一行之后（在其回答组位置）', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'q1', turnId: 'T-A', timestamp: 0, isComplete: true } as ChatMessage,
    { id: 'u2', role: 'user', content: 'q2', turnId: 'T-FAILED', timestamp: 0, isComplete: true } as ChatMessage,
  ];
  const turns: Record<string, ChatTurn> = { 'T-FAILED': failedTurn('boom') };

  const out = synthesizeFailedTurnBubbles(messages, turns);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'u1');
  assert.equal(out[1].id, 'u2');
  assert.equal(out[2].id, 'synthetic-failed-T-FAILED', '必须紧跟本轮的 USER 行，而不是整体塞到最后');
});

// ================================================================ ② 接线验证

test('★ 接线：空失败轮必须留下可渲染的 assistant 行（原因由轮次摘要提供）', () => {
  // 这条是「失败轮不可见」缺陷的直接守卫：
  // 失败原因**不得**写进 content —— 正文每次投影都由块重算，写进去会被下一次投影抹掉。
  // 变异：把「空块终态也建行」删掉 → 这里只剩 1 条 user，界面回到空白。
  const views = viewsOfUserMessages(['T-FAILED']);
  const turns: Record<string, ChatTurn> = { 'T-FAILED': failedTurn('模型接口返回 400：invalid api key') };

  const projected = projectViews(views);
  const bubbles = projected.filter(m => m.role === 'assistant' && m.turnId === 'T-FAILED');
  assert.equal(bubbles.length, 1, '失败轮必须有一个可挂「已失败」的 assistant 行');
  assert.equal(bubbles[0].failed, true);
  assert.equal(bubbles[0].content, '', '失败原因不进正文');

  // 已有行时合成器不得再补一条（幂等），原因留在权威轮次摘要里供渲染层展示
  assert.equal(synthesizeFailedTurnBubbles(projected, turns).length, projected.length);
  assert.match(String(turns['T-FAILED'].errorReason), /invalid api key/);
});

test('★ 接线：再投影一次不会抹掉失败轮（正文重算不得吞掉状态）', () => {
  const views = viewsOfUserMessages(['T-FAILED']);
  const projected = projectViews(views);
  projectViews(views);

  const bubble = projected.find(m => m.role === 'assistant' && m.turnId === 'T-FAILED');
  assert.ok(bubble, '重投影后行必须还在');
  assert.equal(bubble!.failed, true, '重投影必须保留失败标记');
});

test('★ 接线：成功轮次不受影响（不产生多余气泡）', () => {
  const views: TurnViewVO[] = [
    ...viewsOfUserMessages(['T-OK']),
    {
      sessionId: SESSION_ID, turnId: 'T-OK', status: 'COMPLETED', viewVersion: '1', userMessage: '你好',
      blocks: [{ blockId: 'text:T-OK', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '这是回答' }],
    },
  ];
  const turns: Record<string, ChatTurn> = { 'T-OK': { turnId: 'T-OK', status: 'COMPLETED' } as ChatTurn };

  const projected = projectViews(views);
  const wired = synthesizeFailedTurnBubbles(projected, turns);

  assert.equal(wired.length, projected.length, '成功轮不得被插入任何合成气泡');
  assert.ok(!wired.some(m => String(m.id).startsWith('synthetic-failed-')), '不得出现合成气泡');
});

test('★ 接线：一次失败一轮成功时，只给失败轮建行', () => {
  const views: TurnViewVO[] = [
    {
      sessionId: SESSION_ID, turnId: 'T-OK', status: 'COMPLETED', viewVersion: '1', userMessage: '你好',
      blocks: [{ blockId: 'text:T-OK', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '正常回答' }],
    },
    { sessionId: SESSION_ID, turnId: 'T-FAILED', status: 'FAILED', viewVersion: '1', userMessage: '这一轮会失败', blocks: [] },
  ];
  const turns: Record<string, ChatTurn> = {
    'T-OK': { turnId: 'T-OK', status: 'COMPLETED' } as ChatTurn,
    'T-FAILED': failedTurn('超时'),
  };

  const projected = projectViews(views);
  const wired = synthesizeFailedTurnBubbles(projected, turns);

  assert.equal(wired.filter(m => String(m.id).startsWith('synthetic-failed-')).length, 0,
    '投影已建行，合成器不应再插');
  const failedRows = wired.filter(m => m.role === 'assistant' && m.turnId === 'T-FAILED');
  assert.equal(failedRows.length, 1);
  assert.equal(failedRows[0].failed, true);
});

// ================================================================ ③ 生产接线守卫

/**
 * 源级接线守卫。
 *
 * 为什么需要这一层：上面 ①② 两组测的都是 `synthesizeFailedTurnBubbles` **函数本身**，
 * 函数永远是对的 —— 缺陷在于**没人调用它**。删掉生产代码里的调用点，
 * 上面所有测试依然全绿。这类「函数正确但没接线」的缺陷，只能用源级断言兜住。
 *
 * ⚠️ 如果重构改了函数名或模块位置，这里会红 —— 那是**预期**的：
 *    故意让改动者被迫确认「合成逻辑仍然接在历史管线上」。
 */
test('★ 生产接线：历史管线的每个 messages 落点都必须经过 synthesizeFailedTurnBubbles', () => {
  const root = PROJECT_ROOT;

  // 每个条目 = 一个「会写 session.messages」的生产模块 + 期望出现的最小次数
  const targets: Array<{ file: string; min: number; why: string }> = [
    {
      file: 'src/views/chat/useChatSessionList.ts',
      min: 2,
      why: '首次点开会话（二分支：已存在会话合并 / 首屏 unshift）——用户最常走的路径',
    },
    {
      file: 'src/views/chat/useChatHistory.ts',
      min: 2,
      why: '流结束对账 + 往前翻页',
    },
    {
      file: 'src/views/chat/subSessionHistory.ts',
      min: 1,
      why: '子会话的唯一吸入点（面板首屏、翻页、详情抽屉共用）',
    },
  ];

  const failures: string[] = [];
  for (const t of targets) {
    const full = path.join(root, t.file);
    if (!fs.existsSync(full)) {
      failures.push(`${t.file} 不存在（被移动/删除了？）`);
      continue;
    }
    const src = fs.readFileSync(full, 'utf8');
    const count = (src.match(/synthesizeFailedTurnBubbles\s*\(/g) || []).length;
    if (count < t.min) {
      failures.push(
        `${t.file} 只调用了 synthesizeFailedTurnBubbles ${count} 次（应 ≥ ${t.min}）。` +
          `缺口：${t.why} —— 调用点被删掉会让失败轮的提示重新消失。`
      );
    }
  }

  // 子会话落点收敛到 subSessionHistory 之后，还要守住「两个调用方都走它」：
  // 任一调用方回退成自己投影，失败轮提示与实时状态就会在那个入口重新消失。
  const subSessionSinks: Array<{ file: string; min: number; why: string }> = [
    { file: 'src/views/chat/useChatSubSession.ts', min: 2, why: '子会话首屏 + 子会话翻页' },
    { file: 'src/components/chat/SubSessionDetailDrawer.vue', min: 1, why: '子代理详情抽屉' },
  ];
  for (const t of subSessionSinks) {
    const full = path.join(root, t.file);
    if (!fs.existsSync(full)) {
      failures.push(`${t.file} 不存在（被移动/删除了？）`);
      continue;
    }
    const count = (fs.readFileSync(full, 'utf8').match(/absorbSubSessionHistory\s*\(/g) || []).length;
    if (count < t.min) {
      failures.push(
        `${t.file} 只走了 absorbSubSessionHistory ${count} 次（应 ≥ ${t.min}）。` +
        `缺口：${t.why} —— 自己投影会绕开失败轮合成，也会丢掉实时状态。`
      );
    }
  }

  assert.deepEqual(failures, [], `历史管线接线不完整:\n${failures.join('\n')}`);
});

test('★ 生产接线：合成必须发生在逐轮 upsert 之后（用合并后的 turns）', () => {
  // 顺序错误是隐蔽的：先合成再 upsert，合成气泡会被整体替换吞掉，
  // 表现为「偶发看不到失败提示」。这里用源级断言钉死顺序。
  const src = fs.readFileSync(
    path.join(PROJECT_ROOT, 'src/views/chat/useChatSessionList.ts'),
    'utf8'
  );

  const upsertIdx = src.indexOf('upsertTurnViewIntoMessages(mergedMessages, view, versions)');
  const synthIdx = src.indexOf('synthesizeFailedTurnBubbles(mergedMessages, mergedTurns)');

  assert.ok(upsertIdx >= 0, '找不到逐轮 upsert 调用 —— 结构变了，请同步更新本测试');
  assert.ok(synthIdx >= 0, '合成没有使用 mergedMessages（合并结果）——必须合成「合并后」的数组');
  assert.ok(synthIdx > upsertIdx, '合成必须位于合并之后');
});
