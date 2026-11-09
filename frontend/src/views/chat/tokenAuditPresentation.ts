import {formatClockTime} from '../../utils/format';
import type {
  SessionTokenAuditSnapshot,
  TokenAuditCategoryType,
  TokenAuditCategory,
  TokenAuditRequestOverhead,
  TokenAuditToolBreakdown,
  TokenAuditToolGroupKind,
  TokenAuditToolGroup,
  TokenAuditToolItem,
} from '../../types/tokenAudit';

/**
 * 用量审计面板的派生逻辑（纯函数，无 Vue 依赖，便于单测）。
 *
 * <p>本模块只做「已归一快照 → 渲染行」的形状转换与文本格式化，<b>绝不</b>：
 * 重算 token 总数、重算占比、用数组长度冒充「N 项」、把 `null` 当 0。
 * 任何一处违反都会让面板显示虚假数据，比不显示更糟。</p>
 *
 * <p>标签一律返回 i18n **键**，由组件 `t()` 翻译：纯函数保持与语言无关，测试不依赖字典。</p>
 */

/** 消息分项的固定展示顺序（后端顺序不作保证，前端按业务语义定序）。 */
export const CATEGORY_ORDER: readonly TokenAuditCategoryType[] = ['SYSTEM', 'USER', 'ATTACHMENT', 'AI', 'TOOL'];

/** 工具来源分组的固定展示顺序：普通工具 → MCP → Skill。 */
export const TOOL_GROUP_ORDER: readonly TokenAuditToolGroupKind[] = ['ORDINARY', 'MCP', 'SKILL'];

/** 消息分项标签的 i18n 键。 */
export const CATEGORY_LABEL_KEY: Readonly<Record<TokenAuditCategoryType, string>> = {
  SYSTEM: 'chat.tokenAudit.category.system',
  USER: 'chat.tokenAudit.category.user',
  ATTACHMENT: 'chat.tokenAudit.category.attachment',
  AI: 'chat.tokenAudit.category.ai',
  TOOL: 'chat.tokenAudit.category.tool',
};

/** 工具来源分组标签的 i18n 键。 */
export const TOOL_GROUP_LABEL_KEY: Readonly<Record<TokenAuditToolGroupKind, string>> = {
  ORDINARY: 'chat.tokenAudit.toolGroup.ordinary',
  MCP: 'chat.tokenAudit.toolGroup.mcp',
  SKILL: 'chat.tokenAudit.toolGroup.skill',
};

/** 「当前上下文」小节的派生结果；任一字段为 null 即表示该项「不知道」，不渲染。 */
export interface TokenAuditContextSummary {
  usedTokens: number | null;
  maxTokens: number | null;
  /** 已用占比文本，如 `74.1%`。 */
  ratioPercent: string | null;
  /** 进度条宽度，直接用后端 ratio 换算，如 `74.1%`。 */
  barWidth: string | null;
  remainingTokens: number | null;
  remainingPercent: string | null;
}

/** 「消息构成」里的一行。 */
export interface TokenAuditMessageRow {
  type: TokenAuditCategoryType;
  labelKey: string;
  tokens: number;
  ratio?: number | null;
  expandable: boolean;
}

/** 工具来源分组的一行（含组内明细）。 */
export interface TokenAuditToolGroupRow {
  kind: TokenAuditToolGroupKind;
  labelKey: string;
  tokens: number;
  ratio?: number | null;

}

/** 逐项工具行保留框架的输入与输出计数。 */
export type TokenAuditToolItemRow = TokenAuditToolItem & {tokens: number};

/** 框架提供的工具定义分项。 */
export interface TokenAuditDefinitionRow {
  key: 'kernel' | 'mcp' | 'framing';
  labelKey: string;
  tokens: number;
  ratio?: number | null;
}

/**
 * 判断一个数值字段是否「已知」。
 *
 * @param value 任意可能缺失的数值
 * @returns 有限数值返回 true；null/undefined/NaN/Infinity 返回 false
 */
const isKnownNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * 判断一个「token 数 + 占比」对象是否可用于渲染。
 *
 * <p>收窄目标是 `T & {tokens: number}` 而不只是 `T`：归一后的 `tokens` 类型是 `number | null`，
 * 只收窄对象本身的话，调用方读 `value.tokens` 拿到的仍是 `number | null`，行模型就得跟着放宽 ——
 * 「能渲染的行一定有确定 token 数」这条不变式就会在类型上失效。</p>
 *
 * @param value 待判定对象
 * @returns 存在且 tokens 为有限数值时返回 true
 */
const isRenderableAmount = <T extends {tokens: number | null}>(
  value: T | null | undefined
): value is T & {tokens: number} =>
  value !== null && value !== undefined && isKnownNumber(value.tokens);

/**
 * 金额格式化：千分位，不缩写（`148200` → `148,200`）。
 *
 * @param tokens token 数；缺失返回空串，调用方据此整行不渲染
 * @returns 格式化文本或空串
 */
export function formatTokenAmount(tokens?: number | null): string {
  if (!isKnownNumber(tokens)) return '';
  return tokens.toLocaleString('en-US');
}

/**
 * 保留 1 位小数并去掉多余的 `.0`（`200.0` → `200`、`16.4` 保持）。
 *
 * @param value 待格式化数值
 * @returns 紧凑文本
 */
const trimTrailingZero = (value: number): string => {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
};

/**
 * 上限/刻度的**简写**形态（设计稿的 `200k`）。
 *
 * <p>只做「同一数量的显示单位缩写」，不产生任何新数据：值本身仍取后端字段，
 * 不是拿别的字段除出来的。用于「当前上下文」标题与刻度上限这类<b>空间紧</b>的位置；
 * 「已用 / 剩余」这类需要精确读数的位置仍用 {@link formatTokenAmount} 的千分位全量。</p>
 *
 * @param tokens token 数；缺失返回空串
 * @returns 如 `200k`、`1.2M`、`999`，缺失返回空串
 */
export function formatTokenLimit(tokens?: number | null): string {
  if (!isKnownNumber(tokens)) return '';
  const abs = Math.abs(tokens);
  // 缩写规则按十进制（与「200k = 200,000」的直觉一致），不做二进制取整。
  if (abs >= 1_000_000) return `${trimTrailingZero(tokens / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimTrailingZero(tokens / 1_000)}k`;
  return String(tokens);
}

/**
 * 占比格式化：后端给的是 0..1 的比值，这里只做「比值 → 百分数文本」的单位换算。
 *
 * @param ratio 0..1 的比值；缺失返回空串
 * @returns 如 `8.7%`，缺失返回空串
 */
export function formatRatioPercent(ratio?: number | null): string {
  if (!isKnownNumber(ratio)) return '';
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * 进度条宽度：直接消费后端 ratio（裁剪到 0..100%），不做任何补算。
 *
 * @param ratio 0..1 的比值；缺失返回 null，调用方据此不画进度条
 * @returns 形如 `74.1%` 的 CSS 宽度，或 null
 */
export function formatBarWidth(ratio?: number | null): string | null {
  if (!isKnownNumber(ratio)) return null;
  const clamped = Math.min(Math.max(ratio, 0), 1);
  return `${(clamped * 100).toFixed(1)}%`;
}

/**
 * 采集时刻格式化：后端 `Instant` 可能序列化成 ISO 字符串或 epoch 数值，两种都接受。
 * 非法值一律降级为空串（绝不渲染 `Invalid Date`）。
 *
 * @param value ISO 字符串 / epoch 毫秒或秒 / Date
 * @returns 本地时间文本，无法解析返回空串
 */
export function formatCapturedAt(value?: string | number | null): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatClockTime(date);
}

/**
 * 「当前上下文」小节派生。
 *
 * @param audit 已归一快照
 * @returns 已归一化的展示字段；无实时数据时各数值字段为 null
 */
export function resolveContextSummary(audit?: SessionTokenAuditSnapshot | null): TokenAuditContextSummary {
  const used = isKnownNumber(audit?.liveTotalTokens) ? audit.liveTotalTokens : null;
  const max = isKnownNumber(audit?.liveMaxTokens) ? audit.liveMaxTokens : null;
  const ratio = isKnownNumber(audit?.liveRatio) ? audit.liveRatio : null;
  const remaining = isKnownNumber(audit?.remainingTokens) ? audit.remainingTokens : null;
  const remainingRatio = isKnownNumber(audit?.remainingRatio) ? audit.remainingRatio : null;
  return {
    usedTokens: used,
    maxTokens: max,
    ratioPercent: formatRatioPercent(ratio) || null,
    barWidth: formatBarWidth(ratio),
    remainingTokens: remaining,
    remainingPercent: formatRatioPercent(remainingRatio) || null,
  };
}

/**
 * 「消息构成」行派生：丢弃不可渲染项，并按 {@link CATEGORY_ORDER} 定序。
 *
 * @param messages 后端分项数组
 * @returns 可直接渲染的行；无有效分项时返回空数组
 */
export function resolveMessageRows(messages?: TokenAuditCategory[] | null): TokenAuditMessageRow[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((item): item is TokenAuditCategory & {tokens: number} =>
      isRenderableAmount(item) && !!CATEGORY_LABEL_KEY[item.type])
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.type) - CATEGORY_ORDER.indexOf(b.type))
    .map((item) => ({
      type: item.type,
      labelKey: CATEGORY_LABEL_KEY[item.type],
      tokens: item.tokens,
      ratio: item.ratio ?? null,
      expandable: item.expandable === true,
    }));
}

/**
 * 收集存在的工具来源分组（`null`/`undefined` = 该来源不存在，不渲染）。
 *
 * @param tools 工具构成
 * @returns 按 {@link TOOL_GROUP_ORDER} 定序的分组列表
 */
const collectToolGroups = (
  tools?: TokenAuditToolBreakdown | null
): (TokenAuditToolGroup & {tokens: number})[] => {
  if (!tools) return [];
  const byKind: Record<TokenAuditToolGroupKind, TokenAuditToolGroup | null | undefined> = {
    ORDINARY: null,
    MCP: tools.mcp,
    SKILL: tools.skill,
  };
  return TOOL_GROUP_ORDER.filter(kind => kind !== 'ORDINARY')
    .map((kind) => byKind[kind])
    .filter((group): group is TokenAuditToolGroup & {tokens: number} => isRenderableAmount(group));
};

/**
 * 「工具返回消息 [N 类]」的 N：**存在的分组个数**，不是工具明细个数、也不是调用次数（该字段已从契约移除）。
 *
 * @param tools 工具构成
 * @returns 非空分组数（0..3）
 */
export function countToolGroupKinds(tools?: TokenAuditToolBreakdown | null): number {
  return collectToolGroups(tools).length + (resolveOrdinaryToolRows(tools).length > 0 ? 1 : 0);
}

/**
 * 工具来源分组行派生（含组内明细）。
 *
 * @param tools 工具构成
 * @returns 可直接渲染的分组行；无分组时返回空数组
 */
export function resolveToolGroupRows(tools?: TokenAuditToolBreakdown | null): TokenAuditToolGroupRow[] {
  return collectToolGroups(tools).map(group => ({
    kind: group.groupKind,
    labelKey: TOOL_GROUP_LABEL_KEY[group.groupKind],
    tokens: group.tokens,
    ratio: group.ratio ?? null,
  }));
}

/** 普通工具只有框架逐项计数，直接平铺，不生成分组汇总或比例。 */
export function resolveOrdinaryToolRows(tools?: TokenAuditToolBreakdown | null): TokenAuditToolItemRow[] {
  return (tools?.ordinary?.items ?? []).filter(isRenderableAmount);
}

/**
 * 工具定义子项派生：内核、MCP，以及「其它」（框架分词残差）。
 *
 * <p>残差行规则（三条都不能省）：</p>
 * <ol>
 *   <li><b>已知且非 0</b> 才渲染：为 0 说明内核 + MCP 已精确解释父项，多一行 0 是噪声；</li>
 *   <li><b>未知（null）不渲染、不猜 0</b>；</li>
 *   <li><b>负值照常渲染</b>：残差本来就可正可负，它是框架「合并计数 vs 分开计数」的分词差异；
 *       隐藏负数会让子项合计大于父项，正是用户看到「儿子比爹大」的根因。</li>
 * </ol>
 *
 * <p>残差行 `ratio` 恒为 `null`：后端不给它的比例，前端<b>不许</b>做除法补一个假百分比。</p>
 *
 * @param overhead 请求开销小节
 * @returns 可渲染的子项行；无子项时返回空数组
 */
export function resolveToolDefinitionRows(
  overhead?: TokenAuditRequestOverhead | null
): TokenAuditDefinitionRow[] {
  if (!overhead) return [];
  const rows: TokenAuditDefinitionRow[] = [];
  if (isRenderableAmount(overhead.toolDefinition)) {
    rows.push({
      key: 'kernel',
      labelKey: 'chat.tokenAudit.definition.kernel',
      tokens: overhead.toolDefinition.tokens,
      ratio: overhead.toolDefinition.ratio ?? null,
    });
  }
  if (isRenderableAmount(overhead.mcpToolDefinition)) {
    rows.push({
      key: 'mcp',
      labelKey: 'chat.tokenAudit.definition.mcp',
      tokens: overhead.mcpToolDefinition.tokens,
      ratio: overhead.mcpToolDefinition.ratio ?? null,
    });
  }
  const residual = overhead.framingResidualTokens;
  if (isKnownNumber(residual) && residual !== 0) {
    rows.push({
      key: 'framing',
      labelKey: 'chat.tokenAudit.definition.framing',
      tokens: residual,
      ratio: null,
    });
  }
  return rows;
}

/**
 * 「其他消息」父项的金额与占比。
 *
 * <p>父项 = 快照总量 − 消息构成合计，是后端落库的事实。父项不显示的话，
 * 消息构成永远合不上（曾出现「父项无金额、子项比父项大」的读图事故）。</p>
 *
 * @param overhead 请求开销小节
 * @returns 金额与百分比文本；未知项为 null（模板据此整块不渲染）
 */
export function resolveOverheadSummary(
  overhead?: TokenAuditRequestOverhead | null
): {tokens: number | null; ratioPercent: string | null} {
  const tokens = isKnownNumber(overhead?.tokens) ? overhead.tokens : null;
  const ratio = isKnownNumber(overhead?.ratio) ? overhead.ratio : null;
  return {tokens, ratioPercent: formatRatioPercent(ratio) || null};
}

/**
 * 工具定义小节（含父项金额）是否渲染。
 *
 * <p>父项金额已知就渲染：两个子项都审计失败时，框架不给子项，但父项仍是可闭合的事实，
 * 整块消失只会让用户以为「没有其他消息」。</p>
 *
 * @param overhead 请求开销小节
 * @returns 可渲染返回 true
 */
export function hasOverheadSection(overhead?: TokenAuditRequestOverhead | null): boolean {
  if (!overhead) return false;
  return isKnownNumber(overhead.tokens) || resolveToolDefinitionRows(overhead).length > 0;
}

/** 当前上下文与审计快照的有符号差额。 */
export function resolveSnapshotDrift(audit?: SessionTokenAuditSnapshot | null): number | null {
  if (audit?.displayState !== 'CAPTURING') return null;
  const drift = audit.driftTokens;
  return isKnownNumber(drift) && drift !== 0 ? drift : null;
}

/**
 * 是否展示「当前上下文」小节。
 *
 * @param audit 已归一快照
 * @returns 任一实时字段已知即为 true（`NOT_COLLECTED` 也能只有这一节）
 */
export function hasContextSection(audit?: SessionTokenAuditSnapshot | null): boolean {
  if (!audit) return false;
  return isKnownNumber(audit.liveTotalTokens) || isKnownNumber(audit.liveMaxTokens);
}

