/**
 * MCP 服务行「启用 / 停用」的方向判定。
 *
 * <p>只有配置态 `status` 参与：`0`（停用）切到 `1`，其余一律写 `0`。
 * `status` 缺省说明旧数据没带该字段，按「已启用」看待，所以切换结果是 `0`；
 * 反过来把缺省当停用去「启用」，用户的停用状态会被反复翻回去。</p>
 *
 * @param status 行当前配置态，`1` 启用 / `0` 停用 / `undefined` 未知
 * @returns 要提交给后端的下一状态，只会是 `1` 或 `0`
 */
export function nextMcpStatus(status?: number): number {
  return status === 0 ? 1 : 0;
}
