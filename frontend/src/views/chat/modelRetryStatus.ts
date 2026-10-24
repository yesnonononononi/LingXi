/**
 * 重试提示文案的**唯一**实现（主消息气泡与子会话详情共用）。
 *
 * <p>为什么单独成模块：这条提示有两个渲染点（根会话气泡、子会话详情抽屉），
 * 文案与单位换算一旦各写一份，改一处必然漏另一处 —— 之前 `retryDelay` 采了不用、
 * 两个界面口径不同就是这种重复的直接后果。现在两处都只调用这里。</p>
 *
 * <p>它只认毫秒（框架契约 {@code TimeUnit.MILLISECONDS}），不做其它单位换算：
 * 多一个单位维度就多一份「后端换单位、前端静默算错」的机会。</p>
 */
import { t } from '../../i18n';

/**
 * 低于该阈值不展示等待时长。
 *
 * <p>线上真实重试的等待常常是 0～几百毫秒（抓包 fixture 就是 `retryDelay: 0`），
 * 把亚秒级时长写进文案只会闪一下再加一秒的视觉噪音，收益为零。</p>
 */
const DELAY_DISPLAY_THRESHOLD_MS = 1000;

/** 重试提示只依赖这两个数值，调用方可以直接传展示态对象。 */
export interface ModelRetryLike {
  retryCount?: number | null;
  retryDelay?: number | null;
}

/**
 * 毫秒 → 秒的展示串：最多一位小数，整数不带 `.0`。
 *
 * @param delayMs 等待时长（毫秒）
 * @returns 可直接插入文案的秒数；非有限值或非正数返回空串（宁可不显示，也不显示 NaN）
 */
export function formatRetryDelay(delayMs?: number | null): string {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) return '';
  const rounded = Math.round(delayMs / 10) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 生成重试提示文案。
 *
 * @param retry 展示态；缺失或空对象返回空串，调用方据此决定整行是否渲染
 * @returns 本地化文案（含第几次重试；等待时长够长时附带秒数）
 */
export function resolveModelRetryText(retry?: ModelRetryLike | null): string {
  if (!retry) return '';
  const raw = retry.retryCount;
  const count = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1;
  const delayMs = retry.retryDelay;
  const delay = typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= DELAY_DISPLAY_THRESHOLD_MS
    ? formatRetryDelay(delayMs)
    : '';
  return delay ? t('chat.message.retryingWithDelay', { count, delay })
    : t('chat.message.retrying', { count });
}
