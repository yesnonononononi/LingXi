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

/**
 * 运行态是否卡在「需要授权」。
 *
 * <p>单独成函数是因为判定被两处消费（列表卡片的状态徽标、授权动作的显示条件）。
 * 它不读配置态 `status`：停用优先于任何运行态的规则属于调用方的展示顺序，不在这里猜。</p>
 *
 * @param state 连接表里的运行态；缺失表示还没有状态行
 */
export function isMcpAuthorizationRequired(state?: string | null): boolean {
  return state === 'AUTHORIZATION_REQUIRED';
}
