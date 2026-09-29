/**
 * OpenAI 兼容 `/v1/models` 响应解析的唯一实现。
 *
 * 收敛原因：SettingsModal 与 ModelFormView 各自复制了一整段结构猜测逻辑，
 * 两处规则完全一致，属于纯冗余。
 *
 * ⚠️ 外部依赖（非自家后端）：各厂商对 OpenAI 协议的实现不一致，
 *    响应可能是 { data: [...] } / { models: [...] } / 裸数组，
 *    元素可能是字符串也可能是对话对象。这是第三方契约问题，前端无法约束，
 *    只能在此唯一入口兼容。
 */

import type { OpenAIModelItem } from '../types/chat';

export function parseOpenAIModelList(json: unknown): OpenAIModelItem[] {
  let rawItems: unknown[] = [];

  if (Array.isArray(json)) {
    rawItems = json;
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, any>;
    if (Array.isArray(obj.data)) {
      rawItems = obj.data;
    } else if (Array.isArray(obj.models)) {
      rawItems = obj.models;
    }
  }

  const items: OpenAIModelItem[] = [];
  const seen = new Set<string>();

  for (const raw of rawItems) {
    const id = typeof raw === 'string' ? raw : (raw as Record<string, any>)?.id;
    if (typeof id !== 'string') continue;

    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);

    const detail = typeof raw === 'string' ? {} : ((raw as Record<string, any>) ?? {});
    items.push({
      id: trimmed,
      object: detail.object ?? 'model',
      created: detail.created,
      owned_by: detail.owned_by,
      shutdown_date: detail.shutdown_date,
    });
  }

  return items;
}

/**
 * 从 OpenAI 风格错误响应中提取错误信息。
 * ⚠️ 外部依赖：错误体可能是 { error: { message } } 或 { message }。
 */
export function extractOpenAIError(json: unknown, fallback: string): string {
  if (!json || typeof json !== 'object') return fallback;
  const obj = json as Record<string, any>;
  const nested = obj.error && typeof obj.error === 'object' ? obj.error.message : undefined;
  const message = nested ?? obj.message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}
