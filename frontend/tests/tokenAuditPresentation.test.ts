/**
 * 用量审计面板派生逻辑单测。
 *
 * <p>只测纯函数（`src/views/chat/tokenAuditPresentation.ts`）：面板组件的渲染规则最终都落在这里，
 * 因此这里是「N 项取数组长度、callCount 永不渲染、null ≠ 0、前端不重算占比」四条铁律的唯一防线。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countToolGroupKinds,
  formatBarWidth,
  formatCapturedAt,
  formatRatioPercent,
  formatTokenAmount,
  hasContextSection,
  hasOverheadSection,
  resolveCapturingDrift,
  resolveContextSummary,
  resolveMessageRows,
  resolveMessagesTotalText,
  resolveToolDefinitionRows,
  resolveToolGroupRows,
} from '../src/views/chat/tokenAuditPresentation';
import type {
  SessionTokenAuditVO,
  TokenAuditRequestOverheadVO,
  TokenAuditToolBreakdownVO,
} from '../src/types/tokenAudit';

/** 构造一份「普通工具 + MCP + Skill」齐全的工具构成。 */
const fullTools = (): TokenAuditToolBreakdownVO => ({
  tokens: 73080,
  ratio: 0.512,
  ordinary: {
    groupKind: 'ORDINARY',
    tokens: 24180,
    ratio: 0.331,
    callCount: 0,
    items: [
      {toolName: 'search_web', tokens: 9420, ratio: 0.39, callCount: 0},
      {toolName: 'read_file', tokens: 6850, ratio: 0.283, callCount: 0},
      {toolName: 'execute_code', tokens: 4960, ratio: 0.205, callCount: 0},
      {toolName: 'grep_search', tokens: 2950, ratio: 0.122, callCount: 0},
    ],
  },
  mcp: {groupKind: 'MCP', tokens: 34700, ratio: 0.475, callCount: 0, items: []},
  skill: {groupKind: 'SKILL', tokens: 14200, ratio: 0.194, callCount: 0, items: []},
});

/** 构造一份「已采集」的完整审计 VO。 */
const collectedAudit = (): SessionTokenAuditVO => ({
  sessionId: '1234567890',
  displayState: 'COLLECTED',
  liveTotalTokens: 148200,
  liveMaxTokens: 200000,
  liveRatio: 0.741,
  remainingTokens: 51800,
  remainingRatio: 0.259,
  capturedAt: '2026-11-08T05:00:00.000Z',
  messages: [
    {type: 'SYSTEM', tokens: 12400, ratio: 0.087, expandable: false},
    {type: 'USER', tokens: 18920, ratio: 0.132, expandable: false},
    {type: 'AI', tokens: 38450, ratio: 0.269, expandable: false},
    {type: 'TOOL', tokens: 73080, ratio: 0.512, expandable: true},
  ],
  messagesTotalTokens: 142850,
  tools: fullTools(),
  requestOverhead: {
    tokens: 15200,
    ratio: 0.106,
    itemCount: 2,
    toolDefinition: {tokens: 10400, ratio: 0.684},
    mcpToolDefinition: {tokens: 4800, ratio: 0.316},
    framingResidualTokens: 0,
  },
});

// ─────────────────────────── 文本格式化 ───────────────────────────

test('formatTokenAmount：千分位；null/undefined 返回空串（不渲染 0）', () => {
  assert.equal(formatTokenAmount(148200), '148,200');
  assert.equal(formatTokenAmount(0), '0');
  assert.equal(formatTokenAmount(null), '');
  assert.equal(formatTokenAmount(undefined), '');
  assert.equal(formatTokenAmount(Number.NaN), '');
});

test('formatRatioPercent：比值 → 百分数；缺失返回空串', () => {
  assert.equal(formatRatioPercent(0.741), '74.1%');
  assert.equal(formatRatioPercent(0), '0.0%');
  assert.equal(formatRatioPercent(null), '');
  assert.equal(formatRatioPercent(undefined), '');
});

test('formatBarWidth：直接用后端 ratio 当宽度，缺失返回 null（不画 0% 空条）', () => {
  assert.equal(formatBarWidth(0.741), '74.1%');
  assert.equal(formatBarWidth(0), '0.0%');
  assert.equal(formatBarWidth(null), null);
  assert.equal(formatBarWidth(undefined), null);
  // 越界值裁剪，不产生 >100% 的宽度
  assert.equal(formatBarWidth(1.4), '100.0%');
});

test('formatCapturedAt：非法时间降级为空串', () => {
  assert.equal(formatCapturedAt('2026-11-08T05:00:00.000Z'), new Date('2026-11-08T05:00:00.000Z').toLocaleTimeString());
  assert.equal(formatCapturedAt('not-a-date'), '');
  assert.equal(formatCapturedAt('  '), '');
  assert.equal(formatCapturedAt(null), '');
});

// ─────────────────────────── 当前上下文 ───────────────────────────

test('resolveContextSummary：全部消费后端字段，缺失保持 null', () => {
  const summary = resolveContextSummary(collectedAudit());
  assert.equal(summary.usedTokens, 148200);
  assert.equal(summary.maxTokens, 200000);
  assert.equal(summary.ratioPercent, '74.1%');
  assert.equal(summary.barWidth, '74.1%');
  assert.equal(summary.remainingTokens, 51800);
  assert.equal(summary.remainingPercent, '25.9%');
});

test('resolveContextSummary：空 VO 全为 null（绝不补 0）', () => {
  const summary = resolveContextSummary({sessionId: '1', displayState: 'NOT_COLLECTED'});
  assert.deepEqual(summary, {
    usedTokens: null,
    maxTokens: null,
    ratioPercent: null,
    barWidth: null,
    remainingTokens: null,
    remainingPercent: null,
  });
  assert.equal(hasContextSection({sessionId: '1', displayState: 'NOT_COLLECTED'}), false);
  assert.equal(hasContextSection({sessionId: '1', displayState: 'NOT_COLLECTED', liveTotalTokens: 10}), true);
});

// ─────────────────────────── 消息构成 ───────────────────────────

test('resolveMessageRows：按 SYSTEM/USER/AI/TOOL 定序并保留后端占比', () => {
  const rows = resolveMessageRows(collectedAudit().messages);
  assert.deepEqual(rows.map((row) => row.type), ['SYSTEM', 'USER', 'AI', 'TOOL']);
  assert.equal(rows[3]!.tokens, 73080);
  assert.equal(rows[3]!.ratio, 0.512);
  assert.equal(rows[3]!.expandable, true);
  assert.equal(rows[0]!.labelKey, 'chat.tokenAudit.category.system');
});

test('resolveMessageRows：tokens 缺失的行整行丢弃，不渲染 0', () => {
  const rows = resolveMessageRows([
    {type: 'SYSTEM', tokens: 12400, expandable: false},
    {type: 'USER', tokens: undefined as unknown as number, expandable: false},
  ]);
  assert.deepEqual(rows.map((row) => row.type), ['SYSTEM']);
  assert.deepEqual(resolveMessageRows(null), []);
  assert.deepEqual(resolveMessageRows(undefined), []);
});

test('resolveMessagesTotalText：缺 messagesTotalTokens 返回空串', () => {
  assert.equal(resolveMessagesTotalText(collectedAudit()), '142,850');
  assert.equal(resolveMessagesTotalText({sessionId: '1', displayState: 'NOT_COLLECTED'}), '');
});

// ─────────────────────────── 工具来源（「N 类」/「N 项」） ───────────────────────────

test('countToolGroupKinds：「3 类」= 存在的分组数，与 callCount 无关', () => {
  assert.equal(countToolGroupKinds(fullTools()), 3);
  const twoGroups = fullTools();
  delete twoGroups.skill;
  assert.equal(countToolGroupKinds(twoGroups), 2);
  assert.equal(countToolGroupKinds(null), 0);
  assert.equal(countToolGroupKinds(undefined), 0);
});

test('countToolGroupKinds：显式 null 分组不计入（null = 不存在）', () => {
  const tools = fullTools();
  tools.mcp = null;
  assert.equal(countToolGroupKinds(tools), 2);
});

test('resolveToolGroupRows：「N 项」取 items 长度，callCount 恒 0 不参与', () => {
  const rows = resolveToolGroupRows(fullTools());
  assert.deepEqual(rows.map((row) => row.kind), ['ORDINARY', 'MCP', 'SKILL']);
  assert.equal(rows[0]!.itemCount, 4);
  // MCP / Skill 的分组对象存在但 items 为空 → 0 项，列不展开
  assert.equal(rows[1]!.itemCount, 0);
  assert.equal(rows[2]!.itemCount, 0);
  assert.equal(rows[0]!.items[0]!.toolName, 'search_web');
  assert.equal(rows[0]!.items[0]!.tokens, 9420);
});

test('resolveToolGroupRows：分组 tokens 为真实 0 时仍渲染该行（0 是已知值）', () => {
  const tools: TokenAuditToolBreakdownVO = {
    tokens: 0,
    ordinary: {groupKind: 'ORDINARY', tokens: 0, callCount: 0, items: []},
  };
  const rows = resolveToolGroupRows(tools);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tokens, 0);
  assert.equal(rows[0]!.ratio, null);
});

test('resolveToolGroupRows：items 为 null 时按 0 项处理', () => {
  const tools: TokenAuditToolBreakdownVO = {
    tokens: 100,
    ordinary: {groupKind: 'ORDINARY', tokens: 100, items: null},
  };
  assert.equal(resolveToolGroupRows(tools)[0]!.itemCount, 0);
});

// ─────────────────────────── 其他消息（请求开销） ───────────────────────────

test('hasOverheadSection：整节缺失不渲染', () => {
  assert.equal(hasOverheadSection(collectedAudit().requestOverhead), true);
  assert.equal(hasOverheadSection(null), false);
  assert.equal(hasOverheadSection(undefined), false);
  assert.equal(hasOverheadSection({} as TokenAuditRequestOverheadVO), false);
});

test('resolveToolDefinitionRows：缺失的定义项跳过，不渲染 0', () => {
  const both = resolveToolDefinitionRows(collectedAudit().requestOverhead);
  assert.deepEqual(both.map((row) => row.key), ['kernel', 'mcp']);
  assert.equal(both[0]!.labelKey, 'chat.tokenAudit.definition.kernel');
  assert.equal(both[0]!.tokens, 10400);

  const onlyKernel = resolveToolDefinitionRows({tokens: 15200, itemCount: 2, toolDefinition: {tokens: 10400}});
  assert.deepEqual(onlyKernel.map((row) => row.key), ['kernel']);
  assert.equal(onlyKernel[0]!.ratio, null);

  assert.deepEqual(resolveToolDefinitionRows(null), []);
});

// ─────────────────────────── 兜底状态 ───────────────────────────

test('resolveCapturingDrift：仅 CAPTURING 且有差额时给出提示值', () => {
  const capturing: SessionTokenAuditVO = {...collectedAudit(), displayState: 'CAPTURING', driftTokens: 1234};
  assert.equal(resolveCapturingDrift(capturing), 1234);
  assert.equal(resolveCapturingDrift({...capturing, driftTokens: null}), null);
  assert.equal(resolveCapturingDrift(collectedAudit()), null);
  assert.equal(resolveCapturingDrift(null), null);
});
