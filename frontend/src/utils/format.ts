/**
 * 展示层格式化（Token / 耗时 / 时钟）的唯一实现。
 *
 * 收敛原因：同一套格式化逻辑在多个组件里被逐字复制，改一处要改多处且已出现漂移。
 * 这里集中为纯函数，行为与原实现**逐字保持一致**（不顺手改语义）。
 *
 * 被替换的位置：
 *   - formatTokens   ← components/chat/SubAgentSidePanel.vue:50-53
 *                      components/chat/SubSessionsOverviewDrawer.vue:20-23
 *                      components/chat/SubSessionDetailDrawer.vue:64-67（displayTokens）
 *   - formatDuration ← components/chat/ChatMessageItem.vue:381-388
 *   - formatClockTime← components/chat/SubSessionDetailDrawer.vue:230
 *                      components/chat/SubSessionsOverviewDrawer.vue:166
 *                      （两处均为无参 `new Date(x).toLocaleTimeString()`，格式一致）
 *
 * 说明：ChatMessageItem 的 displayTime 使用 `toLocaleTimeString([], {hour,minute})`
 *       （两位时分，格式与上面两处不同），为避免改变 UI 输出，**未**纳入本模块。
 */

/**
 * Token 数量展示：≥1000 显示为 `1.2K tok`，否则 `123 tok`，缺省/0 显示 `0 tok`。
 */
export function formatTokens(t?: number): string {
  if (!t) return '0 tok';
  return t >= 1000 ? `${(t / 1000).toFixed(1)}K tok` : `${t} tok`;
}

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
 * 时钟展示：默认按运行环境 locale 输出本地时间字符串（含秒）。
 * 与 `new Date(value).toLocaleTimeString()` 等价。
 */
export function formatClockTime(value: Date | number | string): string {
  return new Date(value).toLocaleTimeString();
}
