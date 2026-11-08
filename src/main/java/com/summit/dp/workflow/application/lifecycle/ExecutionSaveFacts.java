package com.summit.dp.workflow.application.lifecycle;

/**
 * 一次检查点保存的生命周期事实。
 *
 * <p>仓储把「这次保存意味着执行走到了哪」翻译成这个记录，业务侧据此决定要做什么。
 * 类型明确的字段是刻意的：仓储不该再往业务侧塞 {@code Execution} 之外的松散属性，
 * 业务侧也不该反过来读库推断这些事实。</p>
 *
 * @param executionId       执行 ID
 * @param sessionId         所属会话 ID
 * @param rootSessionId     根会话 ID；可能为空（子会话尚未归属）
 * @param newState          本次落库的执行状态名
 * @param terminal          本次落库状态是否终态
 * @param firstFailure      是否首次落为失败（启动失败只有这一次收口机会）
 * @param closureDue        本次是否需要跑终态收口脚本（终态 + 无控制槽位 + 首失败或上次收口未完成）
 * @param withoutControlSlot 保存时该执行是否没有控制槽位（没有就等不到 unregister 这条收尾路径）
 */
public record ExecutionSaveFacts(
        long executionId,
        long sessionId,
        Long rootSessionId,
        String newState,
        boolean terminal,
        boolean firstFailure,
        boolean closureDue,
        boolean withoutControlSlot) {
}
