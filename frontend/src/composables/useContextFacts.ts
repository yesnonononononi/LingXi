import {ref, type Ref} from 'vue';
import {
  ContextFactFeed,
  DEFAULT_CONTEXT_FACT_LIMIT,
  DEFAULT_CONTEXT_FACT_TTL_MS,
  toContextFactCard,
  type ContextFactCard,
} from '../utils/contextFacts';

export interface UseContextFactsOptions {
  /** 宿主注入的定时器登记（保证卸载后回调不再触发）；缺省用裸 setTimeout。 */
  scheduleTimeout?: (handler: () => void, delayMs: number) => number;
  ttlMs?: number;
  limit?: number;
}

/** 上下文事实卡片（实时渲染）的 Vue 外壳：判定全在 {@link ContextFactFeed}。 */
export function useContextFacts(options: UseContextFactsOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_FACT_TTL_MS;
  const feed = new ContextFactFeed(options.limit ?? DEFAULT_CONTEXT_FACT_LIMIT);
  const cards: Ref<ContextFactCard[]> = ref([]);
  const schedule = options.scheduleTimeout
    ?? ((handler: () => void, delayMs: number) => setTimeout(handler, delayMs) as unknown as number);

  const sync = (): void => {
    cards.value = feed.list();
  };

  const scheduleExpiry = (): void => {
    schedule(() => {
      feed.expire(Date.now(), ttlMs);
      sync();
    }, ttlMs);
  };

  /**
   * 消费一条运行时事件。
   *
   * @returns true 表示这条事件是上下文事实（已被本模块消费），false 表示与它无关
   */
  const accept = (event: { type: string }, now: number = Date.now()): boolean => {
    const card = toContextFactCard(event, now);
    if (!card) return false;
    // 重复事实也返回 true：它确实是上下文事实，只是不必重复呈现
    if (feed.push(card)) {
      sync();
      scheduleExpiry();
    }
    return true;
  };

  const dismiss = (id: string): void => {
    feed.dismiss(id);
    sync();
  };

  const clear = (): void => {
    feed.clear();
    sync();
  };

  return {cards, accept, dismiss, clear};
}
