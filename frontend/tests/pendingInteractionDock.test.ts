import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {ChatMessage} from '../src/types/chat';
import {collectDockedPendingInteractions} from '../src/utils/promptCardGroups';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

const requireCjs = createRequire(import.meta.url);
const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: Record<string, unknown>) => unknown;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
  find: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode | undefined;
};

interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: MemoryNode[];
}

function collectText(node: MemoryNode): string {
  return [node.text, ...node.children.map(collectText)].filter(Boolean).join(' ');
}

function buildMixedMessage(): ChatMessage {
  return {
    id: 'assistant-mixed',
    turnId: 'turn-1',
    role: 'assistant',
    timestamp: 1000,
    content: '需要处理以下交互：',
    isComplete: false,
    isSuspended: true,
    toolCalls: [
      { id: 'cmd-pending', toolName: 'execute_command', status: 'pending', order: 1, responseId: 'r1' },
      { id: 'cmd-done', toolName: 'execute_command', status: 'success', order: 2, responseId: 'r1' },
      { id: 'plan-pending', toolName: 'exit_plan_mode', status: 'pending', order: 3, responseId: 'r1' },
    ],
    promptCards: [
      {
        id: 'cmd-pending',
        conversationId: '42',
        type: 'PROMISE',
        status: 'pending',
        allowedActions: ['APPROVE', 'REJECT'],
        content: { kind: 'COMMAND', command: 'npm test', intention: '运行单测' },
      },
      {
        id: 'cmd-done',
        conversationId: '42',
        type: 'PROMISE',
        status: 'completed',
        allowedActions: [],
        content: { kind: 'COMMAND', command: 'git status', intention: '检查仓库' },
        rawOutput: { outcome: 'APPROVED' },
      },
      {
        id: 'plan-pending',
        conversationId: '42',
        type: 'PROMISE',
        status: 'pending',
        allowedActions: ['APPROVE', 'REJECT'],
        content: { kind: 'PLAN', title: '重构计划', text: '## 步骤\n\n1. 测试' },
      },
    ],
  };
}

test('启用 dockPendingInteractionCards 后，消息流只留已决卡与 PLAN，未决审批进入底部 Dock', t => {
  const MessageItem = harness.componentFromSrc('components/chat/ChatMessageItem.vue', { realPlanCards: true });
  const PendingDock = harness.componentFromSrc('components/chat/PendingInteractionDock.vue', { realPlanCards: true });
  const message = buildMixedMessage();

  const messageRoot = harness.mountComponent(t, MessageItem, {
    message,
    sessionId: '42',
    isDark: false,
    dockPendingInteractionCards: true,
  });

  const messageCommands = harness.findAll(
    messageRoot,
    node => node.props['data-testid'] === 'command-approval-entry-toggle',
  );
  assert.equal(messageCommands.length, 1, '消息流应仅保留已决命令审批');
  assert.ok(collectText(messageCommands[0]!).includes('检查仓库'));

  const messagePlans = harness.findAll(
    messageRoot,
    node => node.props['data-testid'] === 'plan-approval-group',
  );
  assert.equal(messagePlans.length, 1, '未决 PLAN 审批仍须留在消息流');

  const collected = collectDockedPendingInteractions([message]);
  const dockRoot = harness.mountComponent(t, PendingDock, {
    entries: collected.entries,
    toolCalls: collected.toolCalls,
    sessionId: '42',
    isDark: false,
  });

  const dockNode = harness.find(dockRoot, node => node.props['data-testid'] === 'pending-interaction-dock');
  assert.ok(dockNode, '底部 Dock 应渲染未决审批');
  assert.ok(collectText(dockNode).includes('运行单测'), '底部 Dock 应直接渲染未决命令审批内容');
  assert.equal(
    harness.find(dockRoot, node => node.props['data-testid'] === 'plan-approval-group'),
    undefined,
    'PLAN 不得进入底部 Dock',
  );
});

test('未启用 dockPendingInteractionCards（如子会话）时，消息流保持原样渲染全部卡片', t => {
  const MessageItem = harness.componentFromSrc('components/chat/ChatMessageItem.vue', { realPlanCards: true });
  const messageRoot = harness.mountComponent(t, MessageItem, {
    message: buildMixedMessage(),
    sessionId: '42',
    isDark: false,
  });

  const messageCommands = harness.findAll(
    messageRoot,
    node => node.props['data-testid'] === 'command-approval-entry-toggle',
  );
  assert.equal(messageCommands.length, 2, '默认模式应继续在消息流渲染全部命令审批');
});
