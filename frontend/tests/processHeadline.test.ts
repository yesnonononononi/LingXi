/**
 * 过程摘要文案单测。
 *
 * <p>覆盖：标题的类别去重与「等 N 类操作」阈值、预览的概览 / 流式两种语义、
 * 状态计数与 running 策略、阈值参数化、中英文切换，以及与现实数据链
 * （summarizeProcess → formatProcessHeadline）的串联。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { setPreference } from '../src/i18n';
import { formatProcessHeadline, formatProcessStatus } from '../src/utils/processHeadline';
import { summarizeProcess } from '../src/utils/processSegments';
import type { ProcessSummary } from '../src/utils/processSegments';
import type { ProcessTimelineItem, ToolCallTrace } from '../src/types/chat';
import { AgentToolName } from '../src/utils/toolNames';

const summary = (patch: Partial<ProcessSummary> = {}): ProcessSummary => ({
  toolNames: [], targets: [], pendingCount: 0, runningCount: 0, unknownCount: 0, latest: undefined, ...patch,
});

/** 文案跟随全局语言，切换后要等 i18n 的 watch 落地。 */
async function useLocale(locale: 'zh-CN' | 'en-US'): Promise<void> {
  setPreference(locale);
  await nextTick();
}

function toolItem(id: string, toolName: string, order: number, extra: Partial<ToolCallTrace> = {}): ProcessTimelineItem {
  return { id, type: 'tool', order, tool: { id, toolName, order, status: 'success', ...extra } };
}

function thoughtItem(id: string, content: string, order = 0): ProcessTimelineItem {
  return { id, type: 'thought', order, step: { id, title: '思考', content, order, status: 'running' } };
}

test('四类工具收敛成「等 4 类操作」，目标按出现顺序列出', async () => {
  await useLocale('zh-CN');
  const headline = formatProcessHeadline(summary({
    toolNames: [AgentToolName.ExecuteCommand, AgentToolName.EditFile, AgentToolName.ReadFile, AgentToolName.WebSearch],
    targets: ['markdown.ts', 'MarkdownRenderer.vue'],
  }));
  assert.equal(headline.title, '执行命令、写入、读取等 4 类操作');
  assert.equal(headline.preview, 'markdown.ts、MarkdownRenderer.vue');
  assert.equal(headline.previewKind, 'value');
  assert.equal(headline.status, '');
});

test('重复工具名只算一类，恰好到阈值时不出现「等」', async () => {
  await useLocale('zh-CN');
  const repeated = summary({ toolNames: [AgentToolName.ReadFile, AgentToolName.ReadFile, AgentToolName.EditFile] });
  assert.equal(formatProcessHeadline(repeated).title, '读取、写入');
  const exact = summary({ toolNames: [AgentToolName.ExecuteCommand, AgentToolName.ReadFile, AgentToolName.EditFile] });
  assert.equal(formatProcessHeadline(exact).title, '执行命令、读取、写入');
});

test('空摘要退到「思考」，预览与状态为空', async () => {
  await useLocale('zh-CN');
  const headline = formatProcessHeadline(summary());
  assert.equal(headline.title, '思考');
  assert.equal(headline.preview, '');
  assert.equal(headline.previewKind, 'none');
  assert.equal(headline.status, '');
});

test('流式态预览取思考正文尾部并压缩空白', async () => {
  await useLocale('zh-CN');
  const content = `开头${'x'.repeat(400)}  \n\t 收尾标记 `;
  const headline = formatProcessHeadline(summary({ latest: thoughtItem('s1', content) }), { active: true });
  assert.equal(headline.title, '思考');
  assert.equal(headline.previewKind, 'text');
  assert.ok(headline.preview.endsWith('收尾标记'), headline.preview);
  assert.ok(!headline.preview.includes('开头'), '只保留尾部，不能从头部取');
  assert.ok(!headline.preview.includes('  '), '连续空白要压成单个空格');
  assert.ok(!headline.preview.includes('\n') && !headline.preview.includes('\t'));
});

test('预览按尾部裁剪，长度由参数决定', async () => {
  await useLocale('zh-CN');
  const headline = formatProcessHeadline(summary({ latest: thoughtItem('s', '0123456789') }),
    { active: true, maxPreviewChars: 4 });
  assert.equal(headline.preview, '6789');
});

test('只有空白的思考正文不产生预览', async () => {
  await useLocale('zh-CN');
  const headline = formatProcessHeadline(summary({ latest: thoughtItem('s', '  \n  ') }), { active: true });
  assert.equal(headline.preview, '');
  assert.equal(headline.previewKind, 'none');
});

test('流式态工具预览按「目标基线名 → 意图 → 命令」降级', async () => {
  await useLocale('zh-CN');
  const edit = formatProcessHeadline(summary({ latest: toolItem('t1', AgentToolName.EditFile, 0,
    { args: { path: 'C:\\project\\web\\markdown.ts' } }) }), { active: true });
  assert.equal(edit.preview, 'markdown.ts');
  assert.equal(edit.previewKind, 'value');
  const intent = formatProcessHeadline(summary({ latest: toolItem('t2', AgentToolName.ExecuteCommand, 1,
    { args: { command: 'npm test', intention: '跑单测' } }) }), { active: true });
  assert.equal(intent.preview, '跑单测');
  const command = formatProcessHeadline(summary({ latest: toolItem('t3', AgentToolName.ExecuteCommand, 2,
    { args: { command: 'npm test' } }) }), { active: true });
  assert.equal(command.preview, 'npm test');
});

test('状态计数按 active 与 running 策略决定 running 是否入列', async () => {
  await useLocale('zh-CN');
  const counts = summary({ pendingCount: 1, unknownCount: 2, runningCount: 3 });
  assert.equal(formatProcessStatus(counts), '1 项待确认、2 项状态未知、3 项进行中');
  assert.equal(formatProcessStatus(counts, { active: true }), '1 项待确认、2 项状态未知');
  assert.equal(formatProcessStatus(counts, { running: 'never' }), '1 项待确认、2 项状态未知');
  assert.equal(formatProcessStatus(summary()), '');
  assert.equal(formatProcessHeadline(counts, { active: true }).status, '1 项待确认、2 项状态未知');
  assert.equal(formatProcessHeadline(counts).status, '1 项待确认、2 项状态未知、3 项进行中');
});

test('阈值可参数化，标题与目标超限时只报总数', async () => {
  await useLocale('zh-CN');
  const full = summary({
    toolNames: [AgentToolName.ExecuteCommand, AgentToolName.EditFile, AgentToolName.ReadFile, AgentToolName.WebSearch],
    targets: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
  });
  assert.equal(formatProcessHeadline(full, { maxNames: 1 }).title, '执行命令等 4 类操作');
  assert.equal(formatProcessHeadline(full, { maxTargets: 2 }).preview, 'a.ts、b.ts等 4 个目标');
  assert.equal(formatProcessHeadline(full, { maxTargets: 4 }).preview, 'a.ts、b.ts、c.ts、d.ts');
});

test('英文语言下阈值文案与分隔符同步切换', async () => {
  await useLocale('en-US');
  const full = summary({
    toolNames: [AgentToolName.ExecuteCommand, AgentToolName.EditFile, AgentToolName.ReadFile, AgentToolName.WebSearch],
    targets: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
  });
  assert.equal(formatProcessHeadline(full).title, 'Command, Write, Read (4 operation types)');
  assert.equal(formatProcessHeadline(full).preview, 'a.ts, b.ts, c.ts (4 targets)');
  assert.equal(formatProcessStatus(summary({ pendingCount: 2 })), '2 awaiting input');
  await useLocale('zh-CN');
});

test('与 summarizeProcess 串联：标题、目标与最新活动均来自同一份事实', async () => {
  await useLocale('zh-CN');
  const items = [
    toolItem('c1', AgentToolName.ExecuteCommand, 0, { args: { command: 'npm test', intention: '跑单测' } }),
    toolItem('c2', AgentToolName.EditFile, 1, { args: { path: 'D:\\repo\\frontend\\src\\utils\\processHeadline.ts' } }),
    toolItem('c3', AgentToolName.ReadFile, 2, { args: { path: 'D:\\repo\\frontend\\src\\components\\chat\\MarkdownRenderer.vue' } }),
    toolItem('c4', AgentToolName.WebSearch, 3, { args: { query: 'vue' } }),
  ];
  const facts = summarizeProcess(items);
  assert.deepEqual(facts.targets, ['processHeadline.ts', 'MarkdownRenderer.vue']);
  const overview = formatProcessHeadline(facts);
  assert.equal(overview.title, '执行命令、写入、读取等 4 类操作');
  assert.equal(overview.preview, 'processHeadline.ts、MarkdownRenderer.vue');
  assert.equal(overview.previewKind, 'value');
  const live = formatProcessHeadline(facts, { active: true });
  assert.equal(live.title, '检索网络资源');
  assert.equal(live.preview, '');
  assert.equal(live.previewKind, 'none');
});
