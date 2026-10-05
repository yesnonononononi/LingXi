import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatMessage, ChatSession } from '../src/types/chat';
import { buildSessionDisplayMessages, resolveSessionSending } from '../src/utils/sessionRunState';
import { chatApi } from '../src/services/chat';
import { SessionAPI } from '../src/services/session';
import { useChatHistory } from '../src/views/chat/useChatHistory';

const userMessage: ChatMessage = {
  id: 'user-1', role: 'user', content: '2', timestamp: 1000, turnId: 'turn-1',
};

function buildSession(runStatus: ChatSession['runStatus'] = 'RUNNING', messages: ChatMessage[] = [userMessage]): ChatSession {
  return {
    id: '2106063382401646592', title: '2', createdAt: 1000, updatedAt: 1000,
    modelId: '', activeTools: [], messages, runStatus,
  };
}

test('重载 RUNNING 会话即使没有本地请求流，也保持停止按钮和发送守卫', () => {
  assert.equal(resolveSessionSending(buildSession(), 0), true);
  assert.equal(resolveSessionSending(buildSession('IDLE'), 0), false);
  assert.equal(resolveSessionSending(buildSession('SUSPENDED'), 0), false);
  assert.equal(resolveSessionSending(buildSession('IDLE'), 1), true);
});

test('运行中只有用户消息时补上探索气泡，不修改持久化历史', () => {
  const session = buildSession();
  const messages = buildSessionDisplayMessages(session);
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.role, 'assistant');
  assert.equal(messages[1]?.turnId, userMessage.turnId);
  assert.equal(messages[1]?.isExploring, true);
  assert.equal(messages[1]?.isComplete, false);
  assert.equal(session.messages.length, 1);
  assert.equal(buildSessionDisplayMessages(session)[1]?.id, messages[1]?.id);
});

test('运行中消息尚未可见也展示探索占位，空闲新会话不展示', () => {
  assert.equal(buildSessionDisplayMessages(buildSession('RUNNING', []))[0]?.isExploring, true);
  assert.deepEqual(buildSessionDisplayMessages(buildSession('IDLE', [])), []);
});

test('真实回复到达后替换探索占位，不产生重复助手气泡', () => {
  const session = buildSession();
  const reply: ChatMessage = {
    id: 'assistant-1', role: 'assistant', content: '收到', timestamp: 1100, turnId: 'turn-1',
  };
  session.messages.push(reply);
  assert.deepEqual(buildSessionDisplayMessages(session), [userMessage, reply]);
});

test('已结束或已挂起的会话不补探索气泡，也不把上一轮回复标为运行中', () => {
  for (const runStatus of ['IDLE', 'SUSPENDED'] as const) {
    const session = buildSession(runStatus);
    assert.equal(buildSessionDisplayMessages(session), session.messages);
  }
  const previousReply: ChatMessage = {
    id: 'assistant-old', role: 'assistant', content: '上一轮回复', timestamp: 500, isComplete: true,
  };
  const session = buildSession('RUNNING', [previousReply, userMessage]);
  assert.equal(buildSessionDisplayMessages(session)[0]?.isComplete, true);
  assert.equal(buildSessionDisplayMessages(session)[2]?.isExploring, true);
});

test('用户提供的会话树经过详情加载后保留 RUNNING，重载能派生运行展示', async context => {
  context.mock.method(SessionAPI, 'tree', async () => ({
    code: 1,
    data: {
      rootSessionId: '2106063382401646592',
      sessions: [{
        id: '2106063382401646592', name: '2', runStatus: 'RUNNING', lastOutcome: null,
        rootSessionId: '0', createTime: '2026-10-02T16:46:53Z', workspaceId: '4', messageCount: '1',
      }],
    },
  }));
  context.mock.method(chatApi, 'fetchSessionMessages', async () => ({
    ok: true, data: { records: [], messages: [userMessage], turns: {}, nextCursor: null, hasMore: false },
  }));
  context.mock.method(chatApi, 'fetchAgents', async () => ({ ok: true, data: [] }));

  const result = await chatApi.fetchSessionDetail('2106063382401646592');
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail(result.error);
  assert.equal(result.data.runStatus, 'RUNNING');
  assert.equal(result.data.lastOutcome, null);
  assert.equal(resolveSessionSending(result.data, 0), true);
  assert.equal(buildSessionDisplayMessages(result.data)[1]?.isExploring, true);
});

test('终态对账刷新运行状态，停止按钮和探索占位一同消失', async context => {
  setActivePinia(createPinia());
  const localSessions = ref([buildSession()]);
  context.mock.method(chatApi, 'fetchSessionTree', async () => ({
    ok: true, data: {
      rootSessionId: localSessions.value[0]!.id,
      root: { id: localSessions.value[0]!.id, runStatus: 'IDLE', lastOutcome: 'CANCELLED' },
      subSessions: [],
    },
  }));
  context.mock.method(chatApi, 'fetchSessionMessages', async () => ({
    ok: true, data: {
      records: [{ id: userMessage.id, turnId: userMessage.turnId, type: 'USER', text: userMessage.content,
        createTime: new Date(userMessage.timestamp).toISOString() }],
      messages: [], turns: {}, nextCursor: null, hasMore: false,
    },
  }));
  const history = useChatHistory({
    currentActiveSession: computed(() => localSessions.value[0]), localSessions,
    messagesContainerRef: ref(null), lastKnownFirstMsgId: ref(null), scheduleTimeout: () => 0,
  });

  await history.reconcileSessionAfterStream(localSessions.value[0]!.id);

  const session = localSessions.value[0]!;
  assert.equal(session.lastOutcome, 'CANCELLED');
  assert.equal(resolveSessionSending(session, 0), false);
  assert.deepEqual(buildSessionDisplayMessages(session), [userMessage]);
});
