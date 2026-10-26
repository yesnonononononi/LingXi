import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProcessTimeline, resolveSubAgentToolCalls } from '../src/utils/processTimeline';
import { AgentToolName } from '../src/utils/toolNames';
import type { ChatMessage } from '../src/types/chat';

test('UI 投影保持跨响应顺序，协同成员合并，互动卡片独立排在过程之后', () => {
  const message: ChatMessage = {
    id: 'answer', role: 'assistant', timestamp: 0, content: '最终答案',
    thoughtSteps: [{ id: 'thinking:101', responseId: '101', order: 0,
      title: '思考', content: '检查', status: 'success' }],
    aiMessages: [{ id: 'text:102', responseId: '102', order: 1, text: '继续检查' }],
    toolCalls: [
      { id: 'read', toolName: AgentToolName.ReadFile, responseId: '101', order: 2, status: 'success' },
      { id: 'delegate', toolName: AgentToolName.CallSubAgent, responseId: '102', order: 2,
        subSessionId: '88', status: 'success' },
    ],
    promptCards: [{ id: 'approval', type: 'PROMISE', status: 'pending', kind: 'COMMAND' } as never],
  };
  const members = resolveSubAgentToolCalls(message.toolCalls,
    [{ id: '88', name: '工程师', agentName: '工程师' }]);
  assert.deepEqual(buildProcessTimeline(message, members).map(item => item.id),
    ['thinking:101', 'read', 'text:102', 'sub-agents-banner', 'card-approval']);
  assert.equal(members[0]?.subAgentName, '工程师');
  message.toolCalls!.push({ ...message.toolCalls![1]!, id: 'delegate-again', responseId: '103' });
  assert.equal(resolveSubAgentToolCalls(message.toolCalls).length, 1);
});

test('用途升级后，同一 UI 投影从过程移出正文，不依赖死字段', () => {
  const message: ChatMessage = { id: 'a', role: 'assistant', timestamp: 0, content: '',
    aiMessages: [{ id: 'text:101', responseId: '101', order: 1, text: '答案' }] };
  assert.deepEqual(buildProcessTimeline(message).map(item => item.id), ['text:101']);
  message.content = '答案';
  message.aiMessages = [];
  assert.deepEqual(buildProcessTimeline(message), []);
});
