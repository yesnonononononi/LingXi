/**
 * 展示层格式化（耗时 / 时钟）的实现。
 *
 * 收敛原因：同一套格式化逻辑在多个组件里被逐字复制，改一处要改多处且已出现漂移。
 * 这里集中为纯函数，行为与原实现**逐字保持一致**（不顺手改语义）。
 *
 * 被替换的位置：
 *   - formatDuration ← components/chat/ChatMessageItem.vue:381-388
 *   - formatClockTime← components/chat/SubSessionDetailDrawer.vue:230
 *                      components/chat/SubSessionsOverviewDrawer.vue:166
 *                      （两处均为无参 `new Date(x).toLocaleTimeString()`，格式一致）
 *
 * 说明：ChatMessageItem 的 displayTime 使用 `toLocaleTimeString([], {hour,minute})`
 *       （两位时分，格式与上面两处不同），为避免改变 UI 输出，**未**纳入本模块。
 *
 * Token 数量格式化**不在本模块**：ChatMessageItem.vue:1114 的 formatTokenCount 才是在用的
 * 那份（缺省显示「暂无统计」，不把 0 与缺省混为一谈）。曾经的 formatTokens 把三者都显示成
 * `0 tok`，违反「缺省不等于 0」约定，且已零引用，于 10-06 删除。
 */

/**
 * 耗时展示：<1s 或缺省显示 `1秒`；<60s 显示 `12秒`；否则 `1分5秒`。
 */
export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '1秒';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}分${secs}秒`;
}

/**
 * 耗时展示文案（可为空）：null/undefined 返回「暂无统计」，绝不显示成 0；有值走 {@link formatDuration}。
 *
 * <p>回答组工具条的耗时真源是轮次摘要的 elapsedMs（null = startedAt 缺失、无法计算）；
 * 实时流在摘要尚未落库时用气泡自带 durationMs 兜底。二者都缺失即「暂无统计」。
 * 收敛于此以保证所有分支都返回字符串（历史缺陷：兜底分支缺失会渲染出 undefined）。</p>
 */
export function formatDurationOrPlaceholder(ms?: number | null): string {
  return ms == null ? '暂无统计' : formatDuration(ms);
}

/**
 * 时钟展示：默认按运行环境 locale 输出本地时间字符串（含秒）。
 * 与 `new Date(value).toLocaleTimeString()` 等价。
 */
export function formatClockTime(value: Date | number | string): string {
  return new Date(value).toLocaleTimeString();
}
