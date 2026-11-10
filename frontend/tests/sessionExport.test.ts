import assert from 'node:assert/strict';
import test from 'node:test';
import type {ChatMessage} from '../src/types/chat';
import {buildSessionMarkdown} from '../src/utils/session';

test('会话导出：格式严谨且绝对不含唐人 Emoji (🤖 / 👤)，助手标头直接叫 agent', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      role: 'user',
      content: '请分析 edit_file 工具的行号契约',
      timestamp: 1731254400000,
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: '已完成契约对齐，包含 oldStartLine 与 newStartLine。',
      timestamp: 1731254410000,
      model: 'Gemini 1.5 Pro',
    },
  ];

  const md = buildSessionMarkdown('分析当前edit_file工具', messages, {
    exportTime: '2026-11-11 00:05:52',
  });

  assert.equal(md.includes('🤖'), false, '导出正文不得包含 🤖 图标');
  assert.equal(md.includes('👤'), false, '导出正文不得包含 👤 图标');
  assert.match(md, /### 用户/, '必须包含规范的用户标头');
  assert.match(md, /### agent/, '助手标头必须直接叫 agent');
});

test('会话导出：结构化 YAML Frontmatter 与概览信息表', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      turnId: 'turn-1',
      role: 'user',
      content: '问题 1',
      timestamp: 1731254400000,
    },
    {
      id: 'msg-2',
      turnId: 'turn-1',
      role: 'assistant',
      content: '回答 1',
      timestamp: 1731254405000,
      model: 'Claude 3.5 Sonnet',
    },
  ];

  const md = buildSessionMarkdown('测试会话', messages, {
    exportTime: '2026-11-11 00:05:52',
  });

  // Frontmatter 检查
  assert.match(md, /^---\r?\ntitle: "测试会话"/, '必须以标准 YAML Frontmatter 开头');
  assert.match(md, /date: "2026-11-11 00:05:52"/, 'Frontmatter 必须记录导出时间');
  assert.match(md, /generator: "agent"/, 'Frontmatter 生成器标识为 agent');
  assert.match(md, /turns: 1/, 'Frontmatter 必须统计轮次数');
  assert.match(md, /messages: 2/, 'Frontmatter 必须统计有效消息数');

  // 概览表检查
  assert.match(md, /\| 属性 \| 详情 \|/, '必须包含概览表头');
  assert.match(md, /\|\s*\*\*导出时间\*\*\s*\|\s*2026-11-11 00:05:52\s*\|/, '概览表必须包含导出时间');
  assert.match(md, /\|\s*\*\*对话轮次\*\*\s*\|\s*共 1 轮\s*\|/, '概览表必须包含轮次统计');
  assert.match(md, /\|\s*\*\*有效消息\*\*\s*\|\s*共 2 条\s*\|/, '概览表必须包含消息数统计');
});

test('会话导出：杜绝僵尸空气泡与未发送气泡', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      turnId: 'turn-1',
      role: 'user',
      content: '第一问',
      timestamp: 1731254400000,
    },
    // 空气泡 1：content 为空字符串
    {
      id: 'msg-empty-1',
      turnId: 'turn-1',
      role: 'assistant',
      content: '',
      timestamp: 1731254401000,
    },
    // 空气泡 2：仅空白字符
    {
      id: 'msg-empty-2',
      turnId: 'turn-1',
      role: 'assistant',
      content: '   \n\t  ',
      timestamp: 1731254402000,
    },
    // 未发送乐观气泡（受理被拒）
    {
      id: 'msg-unsent',
      turnId: 'turn-1',
      role: 'user',
      content: '受理被拒的废弃输入',
      unsent: true,
      timestamp: 1731254403000,
    },
    {
      id: 'msg-2',
      turnId: 'turn-1',
      role: 'assistant',
      content: '第一答正常完成',
      timestamp: 1731254410000,
    },
  ];

  const md = buildSessionMarkdown('空泡治理测试', messages, {
    exportTime: '2026-11-11 00:05:52',
  });

  // 只应保留有效消息：第一问 + 第一答 = 2 条
  assert.match(md, /messages: 2/, '有效消息数应严格为 2，空气泡与未发送必须剔除');
  assert.equal(md.includes('受理被拒的废弃输入'), false, '未发送气泡不得泄露至导出文件');

  // 严禁存在连续的 agent 标题（空气泡遗留）
  const assistantCount = (md.match(/### agent/g) || []).length;
  assert.equal(assistantCount, 1, 'agent 标题仅应出现 1 次，不得产生孤立空标题');
});

test('会话导出：工具调用概括收敛于元信息副标题，不输出生硬不可折叠的 details 标签', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      turnId: 'turn-1',
      role: 'user',
      content: '帮我查看并修改文件',
      timestamp: 1731254400000,
    },
    {
      id: 'msg-2',
      turnId: 'turn-1',
      role: 'assistant',
      content: '已完成文件查看与修改。',
      timestamp: 1731254410000,
      model: 'Gemini 1.5 Pro',
      toolCalls: [
        {
          id: 'tool-1',
          toolName: 'read_file',
          target: 'src/utils/session.ts',
          status: 'success',
        },
        {
          id: 'tool-2',
          toolName: 'execute_command',
          command: 'npm test',
          status: 'success',
        },
      ],
    },
  ];

  const md = buildSessionMarkdown('工具调用导出测试', messages, {
    exportTime: '2026-11-11 00:05:52',
  });

  // 不得输出在 Typora / 某些 Markdown 编辑器中无法折叠的 details 标签
  assert.equal(md.includes('<details>'), false, 'Markdown 导出不得使用原生 details 标签');
  assert.equal(md.includes('</details>'), false, 'Markdown 导出不得使用原生 details 闭合标签');

  // 工具调用应优雅收敛于消息元数据行
  assert.match(md, /> \*模型：Gemini 1\.5 Pro · 时间：.* · 调用工具 2 次\*/);
});

test('会话导出：多轮次边界与元信息（模型/时间戳）分段清晰', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      turnId: 'turn-101',
      role: 'user',
      content: '轮次一问',
      timestamp: 1731254400000,
    },
    {
      id: 'msg-2',
      turnId: 'turn-101',
      role: 'assistant',
      content: '轮次一答',
      model: 'Gemini 1.5 Pro',
      timestamp: 1731254420000,
    },
    {
      id: 'msg-3',
      turnId: 'turn-102',
      role: 'user',
      content: '轮次二问',
      timestamp: 1731254500000,
    },
    {
      id: 'msg-4',
      turnId: 'turn-102',
      role: 'assistant',
      content: '轮次二答',
      model: 'Claude 3.5 Sonnet',
      timestamp: 1731254520000,
    },
  ];

  const md = buildSessionMarkdown('多轮会话测试', messages, {
    exportTime: '2026-11-11 00:05:52',
  });

  assert.match(md, /## 轮次 01/, '必须包含轮次 01 标题');
  assert.match(md, /## 轮次 02/, '必须包含轮次 02 标题');
  assert.match(md, /> \*模型：Gemini 1\.5 Pro · 时间：/, '必须包含第一轮助手模型与时间元信息');
  assert.match(md, /> \*模型：Claude 3\.5 Sonnet · 时间：/, '必须包含第二轮助手模型与时间元信息');
});
