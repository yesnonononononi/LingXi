/**
 * 对话列与右侧面板之间的宽度契约。
 *
 * <p>右侧面板（文件预览 / 子代理轨迹）宽度由用户拖，但**必须给对话列留下可用宽度**：
 * 输入卡片底部工具栏实测约 450px 宽，列再窄就只能是「消息被压成一条竖线、工具按钮被裁掉」。
 * 这个下限此前只散落在两处 `window.innerWidth - 360/400` 里，且都漏算左侧边栏，
 * 于是「拖宽面板 / 展开侧边栏」都能把对话列压到 100px 出头。</p>
 */

/** 对话列最小可用宽度（px）：低于它输入区工具栏就会溢出卡片。改这里不需要改别处。 */
export const CHAT_COLUMN_MIN_WIDTH = 400;

/**
 * 侧面板宽度上限：所在弹性行的实测宽度减去对话列最小宽度。
 *
 * @param rowWidth 弹性行实测宽度（面板父元素），不是 `window.innerWidth`
 * @param minPanelWidth 该面板自己的最小宽度，行太窄时至少保住它
 */
export function resolveSidePanelMaxWidth(rowWidth: number, minPanelWidth: number): number {
  return Math.max(minPanelWidth, Math.round(rowWidth) - CHAT_COLUMN_MIN_WIDTH);
}
