/**
 * 用量审计面板派生逻辑单测。
 *
 * <p>只测纯函数（`src/views/chat/tokenAuditPresentation.ts` 与 `src/views/chat/tokenAuditStream.ts`）：
 * 面板组件的渲染规则最终都落在这里，因此这里是「N 项取数组长度、调用次数已从契约移除、
 * null ≠ 0、前端不重算占比」四条铁律的唯一防线。</p>
 *
 * <p>流推送与 GET 走<b>同一套</b>解析与派生路径，所以这里也覆盖「推送覆盖旧快照」、
 * 「无推送时回退 GET」、「推送 payload 缺字段时整行不渲染」三条来源选择规则。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countToolGroupKinds,
  formatBarWidth,
  formatCapturedAt,
  formatRatioPercent,
  formatTokenAmount,
  formatTokenLimit,
  hasContextSection,
  hasOverheadSection,
  resolveCapturingDrift,
  resolveContextSummary,
  resolveMessageRows,
  resolveMessagesTotalText,
  resolveToolDefinitionRows,
  resolveToolGroupRows,
} from '../src/views/chat/tokenAuditPresentation';
import {
  clearTokenAuditStreamEntry,
  getTokenAuditStreamEntry,
  normalizeTokenAuditSnapshot,
  recordTokenAuditSnapshot,
  resetTokenAuditStream,
  resolveDisplayedSnapshot,
  toTokenAuditNumber,
} from '../src/views/chat/tokenAuditStream';
import type {
  SessionTokenAuditSnapshot,
  TokenAuditRequestOverhead,
  TokenAuditToolBreakdown,
} from '../src/types/tokenAudit';

/** 构造一份「普通工具 + MCP + Skill」齐全的工具构成。 */
const fullTools = (): TokenAuditToolBreakdown => ({
  tokens: 73080,
  ratio: 0.512,
  ordinary: {
    groupKind: 'ORDINARY',
    tokens: 24180,
    ratio: 0.331,
    items: [
      {toolName: 'search_web', tokens: 9420, ratio: 0.39},
      {toolName: 'read_file', tokens: 6850, ratio: 0.283},
      {toolName: 'execute_code', tokens: 4960, ratio: 0.205},
      {toolName: 'grep_search', tokens: 2950, ratio: 0.122},
    ],
  },
  mcp: {groupKind: 'MCP', tokens: 34700, ratio: 0.475, items: []},
  skill: {groupKind: 'SKILL', tokens: 14200, ratio: 0.194, items: []},
});

/** 构造一份「已采集」的完整审计 VO。 */
const collectedAudit = (): SessionTokenAuditSnapshot => ({
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

test('countToolGroupKinds：「3 类」= 存在的分组数，与调用次数无关', () => {
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

test('resolveToolGroupRows：「N 项」取 items 长度（调用次数已从契约移除）', () => {
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
  const tools: TokenAuditToolBreakdown = {
    tokens: 0,
    ordinary: {groupKind: 'ORDINARY', tokens: 0, items: []},
  };
  const rows = resolveToolGroupRows(tools);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tokens, 0);
  assert.equal(rows[0]!.ratio, null);
});

test('resolveToolGroupRows：items 为 null 时按 0 项处理', () => {
  const tools: TokenAuditToolBreakdown = {
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
  assert.equal(hasOverheadSection({} as TokenAuditRequestOverhead), false);
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
  const capturing: SessionTokenAuditSnapshot = {...collectedAudit(), displayState: 'CAPTURING', driftTokens: 1234};
  assert.equal(resolveCapturingDrift(capturing), 1234);
  assert.equal(resolveCapturingDrift({...capturing, driftTokens: null}), null);
  assert.equal(resolveCapturingDrift(collectedAudit()), null);
  assert.equal(resolveCapturingDrift(null), null);
});

// ─────────────────── 流推送存储（与 GET 同构、同一解析路径） ───────────────────

test('normalizeTokenAuditSnapshot：GET 的 data 原样可用，缺 sessionId 时回退兜底 id', () => {
  const raw = collectedAudit();
  const normalized = normalizeTokenAuditSnapshot(raw, null);
  assert.ok(normalized);
  assert.equal(normalized!.sessionId, '1234567890');
  assert.equal(normalized!.displayState, 'COLLECTED');
  assert.equal(normalized!.liveTotalTokens, raw.liveTotalTokens);

  const noOwner = {...raw, sessionId: undefined};
  assert.equal(normalizeTokenAuditSnapshot(noOwner, null), null, '归属不明必须丢弃');
  assert.equal(normalizeTokenAuditSnapshot(noOwner, 'root-9')!.sessionId, 'root-9');
});

test('normalizeTokenAuditSnapshot：SSE 帧的判别式 type 被剔除，与 GET 形状一致', () => {
  const normalized = normalizeTokenAuditSnapshot({...collectedAudit(), type: 'token_audit_snapshot'}, null);
  assert.ok(normalized);
  assert.equal('type' in (normalized as unknown as Record<string, unknown>), false);
});

test('normalizeTokenAuditSnapshot：非法 displayState 与非法形状一律兜底为 NOT_COLLECTED / null', () => {
  assert.equal(normalizeTokenAuditSnapshot(null, 's1'), null);
  assert.equal(normalizeTokenAuditSnapshot(undefined, 's1'), null);
  assert.equal(normalizeTokenAuditSnapshot('not-an-object', 's1'), null);
  assert.equal(normalizeTokenAuditSnapshot([], 's1'), null);
  const weird = normalizeTokenAuditSnapshot({sessionId: 's1', displayState: 'WHATEVER'}, null);
  assert.equal(weird!.displayState, 'NOT_COLLECTED', '未知状态不得被当成已采集');
});

test('推送覆盖旧快照：同一会话后到的一帧替换先到的一帧', () => {
  resetTokenAuditStream();
  const first = {...collectedAudit(), liveTotalTokens: 148200};
  const second = {...collectedAudit(), liveTotalTokens: 99000};

  assert.equal(getTokenAuditStreamEntry('1234567890'), null, '未推送前无记录');
  recordTokenAuditSnapshot(first, null, 1000);
  assert.equal(getTokenAuditStreamEntry('1234567890')!.snapshot.liveTotalTokens, 148200);
  assert.equal(getTokenAuditStreamEntry('1234567890')!.receivedAt, 1000);

  recordTokenAuditSnapshot(second, null, 2000);
  const entry = getTokenAuditStreamEntry('1234567890');
  assert.equal(entry!.snapshot.liveTotalTokens, 99000, '后到的推送必须覆盖');
  assert.equal(entry!.receivedAt, 2000);
  resetTokenAuditStream();
});

test('推送覆盖旧快照：无法归属的帧不覆盖既有记录', () => {
  resetTokenAuditStream();
  recordTokenAuditSnapshot(collectedAudit(), null, 1000);
  const before = getTokenAuditStreamEntry('1234567890')!.snapshot;
  assert.equal(recordTokenAuditSnapshot({liveTotalTokens: 1}, null), null);
  assert.equal(getTokenAuditStreamEntry('1234567890')!.snapshot, before);
  resetTokenAuditStream();
});

test('推送按事件自带 sessionId 归属，与兜底根会话无关（后端按根会话路由）', () => {
  resetTokenAuditStream();
  recordTokenAuditSnapshot({...collectedAudit(), sessionId: 'child-7'}, 'root-1', 1000);
  assert.ok(getTokenAuditStreamEntry('child-7'), '事件自带归属优先');
  assert.equal(getTokenAuditStreamEntry('root-1'), null);
  // 真缺归属时才回退到根会话
  recordTokenAuditSnapshot({...collectedAudit(), sessionId: undefined}, 'root-1', 2000);
  assert.ok(getTokenAuditStreamEntry('root-1'));
  resetTokenAuditStream();
});

test('无推送时回退 GET；有推送时推送优先；手动刷新清掉推送后 GET 立刻生效', () => {
  resetTokenAuditStream();
  const fetched = collectedAudit();
  const pushed: SessionTokenAuditSnapshot = {...collectedAudit(), liveTotalTokens: 42};

  // 无推送 → GET
  assert.equal(resolveDisplayedSnapshot(null, fetched), fetched);
  // 有推送 → 推送优先（GET 的旧值不得盖住新推送）
  recordTokenAuditSnapshot(pushed, null, 1000);
  const streamEntry = getTokenAuditStreamEntry('1234567890');
  assert.equal(resolveDisplayedSnapshot(streamEntry, fetched)!.liveTotalTokens, 42);
  // 两者都没有 → null（面板按「未采集」渲染，不臆造内容）
  assert.equal(resolveDisplayedSnapshot(null, null), null);
  // 手动刷新：丢弃推送后 GET 立即可见
  assert.equal(clearTokenAuditStreamEntry('1234567890'), true);
  assert.equal(resolveDisplayedSnapshot(getTokenAuditStreamEntry('1234567890'), fetched)!.liveTotalTokens,
    fetched.liveTotalTokens);
  assert.equal(clearTokenAuditStreamEntry('1234567890'), false, '重复清理返回 false');
  resetTokenAuditStream();
});

test('推送 payload 缺字段时整行不渲染（与 GET 同一套派生规则）', () => {
  resetTokenAuditStream();
  // 只给状态，messages / tools / requestOverhead 全缺
  const sparse = {sessionId: 'sparse-1', displayState: 'COLLECTED'};
  const snapshot = recordTokenAuditSnapshot(sparse, null, 1000);
  assert.ok(snapshot);
  const shown = resolveDisplayedSnapshot(getTokenAuditStreamEntry('sparse-1'), collectedAudit());

  assert.notEqual(shown, collectedAudit(), '有推送时不得回退 GET');
  assert.deepEqual(resolveMessageRows(shown!.messages), [], '消息构成整块不渲染');
  assert.deepEqual(resolveToolGroupRows(shown!.tools), [], '工具来源整块不渲染');
  assert.equal(countToolGroupKinds(shown!.tools), 0);
  assert.equal(resolveMessagesTotalText(shown), '', '总数缺失即不渲染');
  assert.equal(hasContextSection(shown), false, '上下文段整块不渲染');
  assert.equal(hasOverheadSection(shown!.requestOverhead), false, '请求开销整段不渲染');
  assert.deepEqual(resolveToolDefinitionRows(shown!.requestOverhead), []);
  assert.equal(formatRatioPercent(shown!.messages?.ratio ?? null), '', 'null 不渲染成 0%');
  assert.equal(formatBarWidth(null), null, 'null 不画 0% 空进度条');
  assert.equal(formatTokenAmount(null), '');
  resetTokenAuditStream();
});

test('推送 payload 的「N 项」仍取数组长度，且不接受未知字段冒充', () => {
  resetTokenAuditStream();
  recordTokenAuditSnapshot({...collectedAudit(), type: 'token_audit_snapshot'}, null, 1000);
  const shown = getTokenAuditStreamEntry('1234567890')!.snapshot;
  const rows = resolveToolGroupRows(shown.tools);
  assert.equal(rows[0]!.itemCount, 4, '普通工具 4 项 = items.length');
  assert.equal(countToolGroupKinds(shown.tools), 3, '3 类 = 存在的分组数');
  resetTokenAuditStream();
});

// ─────────────── 数值字段以字符串到达（Jackson 把 Long 序列化成字符串） ───────────────

/** 复现线上真实 payload：`liveTotalTokens` / `remainingTokens` 是字符串。 */
const stringNumericPayload = (): Record<string, unknown> => ({
  sessionId: '1801439850948198',
  displayState: 'COLLECTED',
  liveTotalTokens: '148200',
  liveMaxTokens: 200000,
  liveRatio: '0.741',
  remainingTokens: '51800',
  remainingRatio: '0.259',
  totalTokens: '148200',
  messagesTotalTokens: '142850',
  driftTokens: '0',
  capturedAt: '2026-11-08T05:00:00.000Z',
  messages: [
    {type: 'SYSTEM', tokens: '12400', ratio: '0.087', expandable: false},
    {type: 'USER', tokens: '18920', ratio: '0.132', expandable: false},
    {type: 'AI', tokens: '38450', ratio: '0.269', expandable: false},
    {type: 'TOOL', tokens: '73080', ratio: '0.512', expandable: true},
  ],
  tools: {
    tokens: '73080',
    ratio: '0.512',
    ordinary: {
      groupKind: 'ORDINARY',
      tokens: '24180',
      ratio: '0.331',
      items: [{toolName: 'search_web', tokens: '9420', ratio: '0.39', argumentTokens: '120', outputTokens: '980'}],
    },
    mcp: {groupKind: 'MCP', tokens: '34700', ratio: '0.475', items: []},
    skill: null,
  },
  requestOverhead: {
    tokens: '15200',
    ratio: '0.106',
    itemCount: '2',
    toolDefinition: {tokens: '10400', ratio: '0.684'},
    mcpToolDefinition: null,
    framingResidualTokens: '0',
  },
  reconciliation: {
    totalTokens: '148200',
    messagesTokens: '142850',
    requestOverheadTokens: '15200',
    toolGroupingDrift: '0',
  },
});

test('数值字段以字符串到达时仍正常渲染：148200 / 200k 与剩余可用 51,800 tok · 25.9%', () => {
  const snapshot = normalizeTokenAuditSnapshot(stringNumericPayload(), null);
  assert.ok(snapshot);
  // 顶层字段已收敛为数值
  assert.equal(snapshot!.liveTotalTokens, 148200);
  assert.equal(snapshot!.liveMaxTokens, 200000);
  assert.equal(snapshot!.liveRatio, 0.741);
  assert.equal(snapshot!.remainingTokens, 51800);
  assert.equal(snapshot!.remainingRatio, 0.259);
  assert.equal(snapshot!.messagesTotalTokens, 142850);

  // 「当前上下文」两行都可见（模板的 v-if 条件即看这两个字段是否为 null）
  const summary = resolveContextSummary(snapshot);
  assert.notEqual(summary.usedTokens, null, '总量行必须可见');
  assert.equal(summary.usedTokens, 148200);
  assert.equal(summary.maxTokens, 200000);
  assert.equal(summary.ratioPercent, '74.1%');
  assert.equal(summary.barWidth, '74.1%');
  assert.equal(summary.remainingTokens, 51800, '剩余可用行必须可见');
  assert.equal(summary.remainingPercent, '25.9%');
  assert.equal(hasContextSection(snapshot), true);

  // 设计稿呈现：`148,200 / 200k`
  assert.equal(formatTokenAmount(summary.usedTokens), '148,200');
  assert.equal(formatTokenLimit(summary.maxTokens), '200k');

  // 嵌套字段同样收敛
  const rows = resolveMessageRows(snapshot!.messages);
  assert.equal(rows.length, 4);
  assert.equal(rows[3]!.tokens, 73080);
  const groups = resolveToolGroupRows(snapshot!.tools);
  assert.equal(groups[0]!.tokens, 24180);
  assert.equal(groups[0]!.items[0]!.tokens, 9420);
  assert.equal(groups[0]!.items[0]!.tokens, 9420);
  assert.equal(snapshot!.tools!.ordinary!.items![0]!.argumentTokens, 120);
  assert.equal(snapshot!.tools!.ordinary!.items![0]!.outputTokens, 980);
  assert.equal(snapshot!.requestOverhead!.itemCount, 2);
  assert.equal(resolveToolDefinitionRows(snapshot!.requestOverhead)[0]!.tokens, 10400);
  assert.equal(snapshot!.reconciliation!.messagesTokens, 142850);
});

test('sessionId 保持字符串：雪花 ID 不因「看起来像数字」被转成 number', () => {
  const snapshot = normalizeTokenAuditSnapshot(stringNumericPayload(), null);
  assert.equal(snapshot!.sessionId, '1801439850948198');
  assert.equal(typeof snapshot!.sessionId, 'string');
  // 原始载荷若给的是数值，也只会被拼成字符串（不做数值运算）
  assert.equal(normalizeTokenAuditSnapshot({sessionId: 123, displayState: 'COLLECTED'}, null)!.sessionId, '123');
});

test('非数字字符串 → 未知 → 整行不渲染（不猜 0）', () => {
  for (const bad of ['abc', '', '  ', '12px', '1e5', '0x10', 'NaN']) {
    const snapshot = normalizeTokenAuditSnapshot({
      sessionId: 's-bad',
      displayState: 'COLLECTED',
      liveTotalTokens: bad,
      liveMaxTokens: bad,
      liveRatio: bad,
      remainingTokens: bad,
      remainingRatio: bad,
    }, null);
    assert.ok(snapshot, `payload(${JSON.stringify(bad)}) 应仍可解析`);
    assert.equal(snapshot!.liveTotalTokens, null, `${JSON.stringify(bad)} 必须为未知`);
    assert.equal(snapshot!.remainingTokens, null);
    assert.equal(snapshot!.remainingRatio, null);

    const summary = resolveContextSummary(snapshot);
    assert.equal(summary.usedTokens, null, '总量行整行不渲染');
    assert.equal(summary.remainingTokens, null, '剩余可用行整行不渲染');
    assert.equal(summary.remainingPercent, null);
    assert.equal(summary.barWidth, null);
    assert.equal(hasContextSection(snapshot), false, '整节不渲染');
  }
  // null / undefined / 布尔 / 对象同样不猜 0
  const snapshot = normalizeTokenAuditSnapshot({
    sessionId: 's-null', displayState: 'COLLECTED',
    liveTotalTokens: null, remainingTokens: undefined, liveRatio: true, messagesTotalTokens: {},
  }, null);
  assert.equal(snapshot!.liveTotalTokens, null);
  assert.equal(snapshot!.remainingTokens, null);
  assert.equal(snapshot!.liveRatio, null);
  assert.equal(snapshot!.messagesTotalTokens, null);
});

test('0 仍是已知值："0" 渲染 0，不当未知', () => {
  const snapshot = normalizeTokenAuditSnapshot({
    sessionId: 's-zero',
    displayState: 'COLLECTED',
    liveTotalTokens: '0',
    liveMaxTokens: '200000',
    liveRatio: '0',
    remainingTokens: '0',
    remainingRatio: '0',
    totalTokens: '0',
    messagesTotalTokens: '0',
  }, null);
  assert.equal(snapshot!.remainingTokens, 0);
  assert.equal(snapshot!.liveTotalTokens, 0);
  assert.equal(snapshot!.remainingRatio, 0);

  const summary = resolveContextSummary(snapshot);
  assert.equal(summary.usedTokens, 0, '0 是已知值，≠ null');
  assert.equal(summary.remainingTokens, 0, '剩余 0 也要渲染');
  assert.equal(summary.ratioPercent, '0.0%');
  assert.equal(summary.remainingPercent, '0.0%');
  assert.equal(summary.barWidth, '0.0%');
  assert.equal(hasContextSection(snapshot), true, '0 也算有实时数据');
  assert.equal(formatTokenAmount(summary.remainingTokens), '0');
  // 表单里的 `0` 与「未知」在渲染上必须能区分
  assert.notEqual(summary.remainingTokens, null);
});

test('formatTokenLimit：上限简写（200k / 1.2M / 原样小数值），缺失返回空串', () => {
  assert.equal(formatTokenLimit(200000), '200k');
  assert.equal(formatTokenLimit(128000), '128k');
  assert.equal(formatTokenLimit(16384), '16.4k');
  assert.equal(formatTokenLimit(1_200_000), '1.2M');
  assert.equal(formatTokenLimit(999), '999');
  assert.equal(formatTokenLimit(0), '0');
  assert.equal(formatTokenLimit(null), '');
  assert.equal(formatTokenLimit(undefined), '');
  assert.equal(formatTokenLimit(Number.NaN), '');
});

test('toTokenAuditNumber：只认十进制数值形态，其余一律 null', () => {
  assert.equal(toTokenAuditNumber(148200), 148200);
  assert.equal(toTokenAuditNumber('148200'), 148200);
  assert.equal(toTokenAuditNumber(' 148200 '), 148200);
  assert.equal(toTokenAuditNumber('0.259'), 0.259);
  assert.equal(toTokenAuditNumber('.5'), 0.5);
  assert.equal(toTokenAuditNumber('-42'), -42);
  assert.equal(toTokenAuditNumber('0'), 0);
  assert.equal(toTokenAuditNumber(''), null);
  assert.equal(toTokenAuditNumber('abc'), null);
  assert.equal(toTokenAuditNumber('1e5'), null);
  assert.equal(toTokenAuditNumber('0x10'), null);
  assert.equal(toTokenAuditNumber('12px'), null);
  assert.equal(toTokenAuditNumber(null), null);
  assert.equal(toTokenAuditNumber(undefined), null);
  assert.equal(toTokenAuditNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(toTokenAuditNumber(true), null);
  assert.equal(toTokenAuditNumber({}), null);
});


