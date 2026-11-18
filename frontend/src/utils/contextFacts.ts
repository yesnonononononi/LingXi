import type {
  ContextChangedEvent,
  ContextRebuiltEvent,
  ContextSectionKind,
} from '../types/Event';

/**
 * 上下文事实卡片的纯逻辑层（无 Vue、无 DOM）。
 *
 * <p>框架把「上下文变了什么」当成**事实**发布（{@code CONTEXT_CHANGED} / {@code CONTEXT_REBUILT}），
 * 这里只做三件事：把事件翻译成卡片数据、按事实去重、按寿命淘汰。渲染与 i18n 完全在外层，
 * 于是这套判定可以脱离浏览器做靶向测试。</p>
 *
 * <p><b>只留类别，不留两侧全文</b>：卡片要回答的是「哪几类动态段被改写了」。把新旧两段全文
 * 搬进前端，除了能渲染一次没人盯着的红绿行，只会让内存和去重签名都跟着膨胀 —— 事实本身
 * 已经说明白，明细就不再呈现。</p>
 */

/** 卡片种类：动态段被改写 / 上下文被摘要重建。 */
export type ContextFactKind = 'changed' | 'rebuilt';

/** 一张上下文事实卡片。 */
export interface ContextFactCard {
  /** 事实签名：同样的事实重复下发不会叠出第二张卡。 */
  id: string;
  kind: ContextFactKind;
  /** 被改写的动态段类别（重建卡为空：重建不是「改了几段」，而是整份历史被换掉）。 */
  changedKinds: ContextSectionKind[];
  /** 变化理由（框架 {@code ContextChangeReason}）。 */
  reasons: string[];
  /** 缓存前缀是否幸存（由后端事实给出，前端不再自己推断）。 */
  prefixPreserved: boolean;
  /** 活上下文块数 / 容忍上限；框架未给时为 null。 */
  liveBlocks: { current: number; max: number } | null;
  /** 重建后的摘要代数；仅重建卡有。 */
  summaryGeneration: number | null;
  /** 重建后上下文的消息条数；仅重建卡有。 */
  messageCount: number | null;
  createdAt: number;
}

/** 卡片默认存活时间：够读完，也不至于挡住对话区。 */
export const DEFAULT_CONTEXT_FACT_TTL_MS = 20_000;

/** 同时最多保留几张卡：上下文事实通常成对出现，堆成瀑布只会遮挡内容。 */
export const DEFAULT_CONTEXT_FACT_LIMIT = 3;

/** 动态段种类的稳定顺序，保证同一份事实渲染出的类别顺序恒定。 */
const SECTION_ORDER: ContextSectionKind[] = [
  'MCP',
  'SKILL',
  'MEMORY',
  'WORK_DIR',
  'PERMISSION',
  'ENVIRONMENT',
  'FORBIDDEN_TOOLS',
  'TASK',
];

function sortKinds(kinds: ContextSectionKind[]): ContextSectionKind[] {
  const rank = (kind: ContextSectionKind): number => {
    const index = SECTION_ORDER.indexOf(kind);
    return index === -1 ? SECTION_ORDER.length : index;
  };
  return [...kinds].sort((left, right) => rank(left) - rank(right));
}

/** 从 `changedSections` 的键取出类别；两侧全文在这里就被丢掉，不进卡片。 */
function readChangedKinds(event: ContextChangedEvent): ContextSectionKind[] {
  const changed = event.changedSections || {};
  const kinds: ContextSectionKind[] = [];
  for (const [kind, diff] of Object.entries(changed)) {
    if (!diff) continue;
    kinds.push(kind as ContextSectionKind);
  }
  return sortKinds(kinds);
}

/**
 * 事实签名：种类 + 执行身份 + 载荷本身。
 *
 * <p>用它而不是「时间戳」做 id —— 断线重连或重复投递的同一份事实不该在界面上出现两次。</p>
 */
function resolveSignature(kind: ContextFactKind, event: ContextChangedEvent | ContextRebuiltEvent,
                          changedKinds: ContextSectionKind[]): string {
  const executionId = event.executionId ?? '';
  if (kind === 'rebuilt') {
    const rebuilt = event as ContextRebuiltEvent;
    return `rebuilt:${executionId}:${rebuilt.summaryGeneration ?? 0}:${rebuilt.messageCount ?? 0}`;
  }
  const changed = event as ContextChangedEvent;
  const reasons = [...(changed.reasons || [])].sort().join('+');
  // 正文不到前端，能区分「同一轮里的第二次改写」的只剩类别与活片段计数
  const live = `${changed.currentLiveBlocks ?? ''}/${changed.maxLiveBlocks ?? ''}`;
  return `changed:${executionId}:${reasons}:${changedKinds.join(',')}:${live}`;
}

/**
 * 事件 → 卡片；不是这两种事实时返回 null（调用方据此决定是否继续走别的分支）。
 *
 * @param event 运行时事件
 * @param now 生成时刻（毫秒），显式传入便于测试
 */
export function toContextFactCard(
  event: { type: string },
  now: number = Date.now(),
): ContextFactCard | null {
  if (event.type === 'CONTEXT_REBUILT') {
    const rebuilt = event as unknown as ContextRebuiltEvent;
    return {
      id: resolveSignature('rebuilt', rebuilt, []),
      kind: 'rebuilt',
      changedKinds: [],
      reasons: [],
      prefixPreserved: false,
      liveBlocks: null,
      summaryGeneration: typeof rebuilt.summaryGeneration === 'number' ? rebuilt.summaryGeneration : null,
      messageCount: typeof rebuilt.messageCount === 'number' ? rebuilt.messageCount : null,
      createdAt: now,
    };
  }
  if (event.type !== 'CONTEXT_CHANGED') return null;

  const changed = event as unknown as ContextChangedEvent;
  const changedKinds = readChangedKinds(changed);
  const live = typeof changed.currentLiveBlocks === 'number' && typeof changed.maxLiveBlocks === 'number'
    ? { current: changed.currentLiveBlocks, max: changed.maxLiveBlocks }
    : null;
  return {
    id: resolveSignature('changed', changed, changedKinds),
    kind: 'changed',
    changedKinds,
    reasons: [...(changed.reasons || [])],
    // 字段确实缺失时按「不乐观」处理：说前缀还在，比说得更严重危险得多。
    prefixPreserved: changed.prefixPreserved === true,
    liveBlocks: live,
    summaryGeneration: null,
    messageCount: null,
    createdAt: now,
  };
}

/**
 * 卡片队列：去重、限长、按寿命淘汰。
 *
 * <p>不用「按 id 覆盖」：同一份事实重复投递连卡片都不该重建（否则动画会重播）。</p>
 */
export class ContextFactFeed {
  private items: ContextFactCard[] = [];
  private readonly limit: number;

  constructor(limit: number = DEFAULT_CONTEXT_FACT_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** 入队一张卡；重复事实返回 false。 */
  push(card: ContextFactCard): boolean {
    if (this.items.some(item => item.id === card.id)) return false;
    this.items = [...this.items, card];
    // 超出上限时淘汰最旧的：新事实永远比旧事实更值得看
    while (this.items.length > this.limit) this.items.shift();
    return true;
  }

  dismiss(id: string): void {
    this.items = this.items.filter(item => item.id !== id);
  }

  /** 惰性过期：宿主按时钟调用，过期即移除。 */
  expire(now: number, ttlMs: number = DEFAULT_CONTEXT_FACT_TTL_MS): void {
    this.items = this.items.filter(item => now - item.createdAt < ttlMs);
  }

  clear(): void {
    this.items = [];
  }

  list(): ContextFactCard[] {
    return this.items;
  }
}
