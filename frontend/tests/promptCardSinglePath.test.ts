/**
 * 人工在环卡片「唯一落点」测试。
 *
 * 背景（为什么必须有这个文件）：
 *   互动卡片的载荷有唯一权威来源 —— `ToolCallVO`（PROMISE 形态）：
 *   - 展示结构（块的身份 / 顺序 / 状态）来自轮次视图；
 *   - 卡片载荷（kind / 标题 / 内容 / 可执行动作 / 决策结果）来自权威 `ToolCallVO`。
 *
 *   落卡只有一处：`upsertPromptCard`。历史上曾存在第二条路径 ——
 *   `utils/session.ts` 聚合 `session_message` 原始行时从 `toolCall` 重建卡片；
 *   两条路径产出若漂移，会表现为「实时显示已批准、刷新后又变回等待审批」这类**静默**不一致。
 *   本次改造已把历史聚合整条链路删除，卡片只从块视图 + 权威 VO 来。
 *
 * 本文件守两件事：
 *   ① `upsertPromptCard` 的语义（同 id 覆盖、非 PROMISE 不入卡、幂等）；
 *   ② 生产代码里不得再长出第二份落卡逻辑（源级守卫）。
 *
 * ⚠️ 本测试不依赖 DOM，也不需要起 Vue —— 它测的是纯函数层。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  upsertPromptCard,
  toPromptCardData,
  isApprovableCard,
  canDecideCard,
} from '../src/utils/toolCallCard';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import type { ChatMessage, ToolCallVO } from '../src/types/chat';

const SESSION_ID = '555000111222333444';

/** 一张「等待审批的 COMMAND 卡」的权威 VO */
function commandCardVO(overrides: Partial<ToolCallVO> = {}): ToolCallVO {
  return {
    id: 'call-cmd-1',
    type: 'PROMISE',
    status: 'pending',
    toolName: 'execute_command',
    content: {
      kind: 'COMMAND',
      command: 'rm -rf ./build',
      workDir: 'D:\\Code\\LingXi',
      shell: 'bash',
      intention: '清理构建产物',
    },
    allowedActions: ['APPROVE', 'REJECT'],
    version: '3',
    pending: true,
    ...overrides,
  } as ToolCallVO;
}

/** 生产路径：轮次视图投影出气泡，再把权威卡片 VO 落到该气泡上。 */
function viaProducePath(vO: ToolCallVO): ChatMessage {
  const messages: ChatMessage[] = [];
  upsertTurnViewIntoMessages(messages, {
    sessionId: SESSION_ID,
    turnId: 'T-CARD',
    status: 'COMPLETED',
    viewVersion: '1',
    userMessage: '准备执行命令',
    blocks: [
      { blockId: `tool:${vO.id}`, type: 'TOOL', order: 0, status: 'PROMISED', toolCallId: vO.id, toolName: vO.toolName },
    ],
  }, new Map());
  const bubble = messages.find(m => m.role === 'assistant')!;
  upsertPromptCard(bubble, vO);
  return bubble;
}

// ================================================================ 生产路径

test('★ 生产路径：轮次视图建气泡，权威 VO 落卡，展示数据一致', () => {
  const vO = commandCardVO();
  const bubble = viaProducePath(vO);

  assert.equal(bubble.promptCards?.length, 1, '应有 1 张卡');
  const data = toPromptCardData(bubble.promptCards![0]);
  assert.equal(data.kind, 'COMMAND');
  assert.equal(data.command, 'rm -rf ./build');
  assert.deepEqual(data.allowedActions, ['APPROVE', 'REJECT']);
});

test('★ 生产路径：已决卡片（带 rawOutput）不可再审批', () => {
  const decided = commandCardVO({
    status: 'completed',
    pending: false,
    allowedActions: [],
    rawOutput: { outcome: 'SUCCEEDED', stdout: 'done', exitCode: 0 },
  });

  const bubble = viaProducePath(decided);
  assert.equal(bubble.promptCards?.length, 1);
  assert.equal(canDecideCard(toPromptCardData(bubble.promptCards![0]), 'APPROVE'), false);
});

test('★ 生产路径：可审批门控一致（pending + allowedActions）', () => {
  const vO = commandCardVO();
  const bubble = viaProducePath(vO);

  assert.equal(isApprovableCard(bubble.promptCards![0]), true);
  const data = toPromptCardData(bubble.promptCards![0]);
  assert.equal(canDecideCard(data, 'APPROVE'), true);
  assert.equal(canDecideCard(data, 'ANSWER'), false, 'COMMAND 卡没有 ANSWER 动作');
});

// ================================================================ upsertPromptCard 语义

test('upsertPromptCard：同 id 覆盖而非追加（幂等）', () => {
  // 这条是幂等基础：实时会重试拉取、对账会重放。
  // 变异：把 findIndex 分支删掉、改为无条件 push → 本测试红
  const bubble: { promptCards?: ToolCallVO[] } = {};
  upsertPromptCard(bubble, commandCardVO({ status: 'pending' }));
  upsertPromptCard(bubble, commandCardVO({ status: 'completed' }));

  assert.equal(bubble.promptCards!.length, 1, '同 id 必须覆盖，不能堆出两张');
  assert.equal(bubble.promptCards![0].status, 'completed', '后到者应覆盖先到者');
});

test('upsertPromptCard：不同 id 追加', () => {
  const bubble: { promptCards?: ToolCallVO[] } = {};
  upsertPromptCard(bubble, commandCardVO({ id: 'a' }));
  upsertPromptCard(bubble, commandCardVO({ id: 'b' }));
  assert.equal(bubble.promptCards!.length, 2);
});

test('upsertPromptCard：非 PROMISE 一律不入卡（含 EXECUTE）', () => {
  // ★ 这是安全相关的守卫：普通工具调用（type=EXECUTE）绝不能被当成人工在环卡片，
  //    否则会渲染出带「批准并执行」按钮的 UI，而它根本没有对应的待决策请求。
  const bubble: { promptCards?: ToolCallVO[] } = {};
  assert.equal(upsertPromptCard(bubble, commandCardVO({ type: 'EXECUTE' })), false);
  assert.equal(upsertPromptCard(bubble, null), false);
  assert.equal(upsertPromptCard(bubble, undefined), false);
  assert.equal(bubble.promptCards, undefined, '非 PROMISE 不得创建 promptCards 数组');
});

test('upsertPromptCard：返回值反映是否写入', () => {
  const bubble: { promptCards?: ToolCallVO[] } = {};
  assert.equal(upsertPromptCard(bubble, commandCardVO()), true);
  assert.equal(upsertPromptCard(bubble, commandCardVO({ id: 'x', type: 'EXECUTE' })), false);
});

// ================================================================ 唯一落点守卫

test('★ 唯一落点：生产代码里不得再出现第二份「按 id 覆盖否则 push」的卡片落卡逻辑', () => {
  // 源级守卫 —— 本测试的目的不是覆盖行为，而是**阻止实现再次分裂**。
  // 变异：任何生产文件里手写 promptCards[idx] = / push → 本测试红
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const files = [
    'src/utils/session.ts',
    'src/views/chat/turnStreamReducer.ts',
    'src/views/chat/blockProjection.ts',
    'src/views/chat/useChatHistory.ts',
    'src/views/chat/useChatSessionList.ts',
  ];

  for (const rel of files) {
    const full = path.join(projectRoot, rel);
    const src = fs.readFileSync(full, 'utf8');

    // 手写落卡的指纹：findIndex + promptCards[idx] = 赋值 同时出现
    const hasManualUpsert =
      /promptCards\[idx\]\s*=/.test(src) || /promptCards\.push\(/.test(src);

    assert.equal(
      hasManualUpsert,
      false,
      `${rel} 里出现了手写的卡片落卡逻辑（promptCards[idx] = / push）——` +
        '必须统一走 upsertPromptCard，否则卡片状态会再次漂移'
    );
  }
});

test('★ 唯一落点：同一张卡重放时不会重复（幂等）', () => {
  const vO = commandCardVO();
  const bubble = viaProducePath(vO);
  upsertPromptCard(bubble, vO);
  upsertPromptCard(bubble, vO);
  assert.equal(bubble.promptCards?.length, 1, '同一 toolCallId 只应有一张卡');
});

test('★ 唯一落点：历史聚合链路已删除（生产代码不再从原始行重建卡片）', () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(projectRoot, 'src/utils/session.ts'), 'utf8');

  assert.equal(
    /aggregateSessionMessages/.test(src),
    false,
    'session.ts 不得再保留从原始行聚合的旧链路',
  );
  assert.equal(
    /upsertPromptCard/.test(src),
    false,
    'session.ts 不再直接落卡 —— 卡片载荷只由块视图 + 权威 VO 提供',
  );
});
