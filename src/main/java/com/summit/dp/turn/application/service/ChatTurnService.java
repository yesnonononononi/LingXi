package com.summit.dp.turn.application.service;

import com.summit.core.agent.Execution;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 业务轮次应用服务：轮次的创建、状态推进与查询。
 *
 * <p><b>谁写它</b>：业务自己在「受理请求」那一刻创建（与用户消息同事务），
 * 之后由框架的运行观察钩子按 {@code executionId} 推进状态与用量。
 * 业务从不写框架的 {@code execution} 表。</p>
 *
 * <p><b>找不到轮次时一律静默跳过（只记 DEBUG）</b>：本次改造之前产生的执行没有对应轮次行，
 * 它们的事件照样会到达观察者。这不是异常，是预期的历史数据形态 —— 报错会把旧执行的事件
 * 变成噪音日志，甚至打断观察链路。</p>
 */
public interface ChatTurnService {

    /**
     * 受理一次请求：以 ACCEPTED 创建轮次并落库，返回 turnId。
     *
     * <p>由调用方放在与用户消息同一个短事务里 —— 提问与轮次要么一起可见，要么都不可见。
     * 此时框架执行行可能还没创建，但**执行 ID 已经确定**（业务在 prepare 阶段就生成了它），
     * 因此直接写入 {@code executionId}，后续观察钩子才能按它找回本轮次。</p>
     *
     * @param executionId 本次执行的框架 ID（业务已生成，可为 null 表示尚未确定）
     */
    long acceptTurn(long sessionId, Long rootSessionId, Long parentTurnId, Long executionId,
                    String modelName, String modelProvider);

    /**
     * 带命令身份的受理：命令 ID 与请求摘要与轮次同事务落库。
     *
     * <p>同 {@code commandId} 的重试靠它查回首次结果，不再写用户消息、不再开启执行。
     * {@code commandDigest} 不一致时调用方必须拒绝，不得把后一次意图当作成功覆盖。</p>
     *
     * @param commandId     命令受理身份；为 {@code null} 表示本次不参与命令幂等
     * @param commandDigest 请求摘要
     */
    long acceptTurn(long sessionId, Long rootSessionId, Long parentTurnId, Long executionId,
                    String modelName, String modelProvider,
                    String commandId, String commandDigest);

    /**
     * 按命令受理身份反查轮次；受理回执丢失时前端凭它查回首次结果。
     *
     * <p>返回空表示该命令从未被受理过。</p>
     */
    Optional<ChatTurn> findByCommandId(String commandId);

    /** 框架开始执行（onStart）：ACCEPTED/WAITING → RUNNING；{@code startedAt} 仅首次设置。 */
    void markRunning(String executionId, Instant startedAt, Long rootSessionId);

    /** 按执行 ID 取轮次；查不到返回空（本次改造之前的执行没有对应轮次行，属预期形态）。 */
    Optional<ChatTurn> findByExecutionId(Long executionId);

    /** 框架挂起（SUSPENDED）：→ WAITING。挂起不是终态，不写结束时间。 */
    void markWaiting(String executionId, Long rootSessionId);

    /** 已提交的挂起执行只推进等待状态，不写结束时间。 */
    void markExecutionWaiting(Execution execution);

    /** 终态和结束时间取已提交执行，用量仍由运行事件独立更新。 */
    void finishExecution(Execution execution);

    /**
     * 进入终态：COMPLETED / FAILED / CANCELLED，写入结束时间。
     *
     * <p><b>用量不从这里进</b>：用量权威在三个终态事件的 {@code tokenInfo}，由
     * {@link #refreshUsage} 覆盖入账，执行终结处理不覆盖已知用量。
     * 保留用量形参只为兼容「已知用量时顺带补齐」的调用方（启动失败等路径一律传 {@code null}），
     * 且 {@code null} 永不覆盖已知值。</p>
     *
     * <p>重复的终态通知是幂等的（同一终态只补齐用量），改成另一种终态会抛异常。</p>
     */
    void markTerminal(String executionId, ChatTurnStatus terminalStatus,
                      Long inputTokens, Long outputTokens, Long totalTokens, Instant completedAt,
                      Long rootSessionId);

    /**
     * 只刷新用量，不动状态。
     *
     * <p><b>唯一调用方是终态事件观察者</b>：框架在完成 / 失败 / 取消三个终态事件上都带
     * {@code tokenInfo}（失败与取消带的是**结束前已累计**的部分用量），由
     * {@code ChatTurnRuntimeListener} 转成这里的覆盖写入。</p>
     *
     * <p>覆盖而非累加 —— resume 之后再完成会重发该事件（带最终累计值），
     * 重复触发不得把同一执行算两遍；{@code null} 表示未采集到，不覆盖已知值。</p>
     */
    void refreshUsage(String executionId, Long inputTokens, Long outputTokens, Long totalTokens,
                      Long rootSessionId);

    /**
     * 记下**面向用户的失败原因**（不改状态）。
     *
     * <p>失败是轮次的属性：状态由框架生命周期信号驱动置为 FAILED，原因由本方法写入
     * {@code chat_turn.error_reason}，两者由前端按 {@code status == FAILED} 共同渲染 ——
     * **不再往消息列表追加 ERROR 行**。</p>
     *
     * <p>查不到轮次（本次改造之前的执行）或文案为空时静默跳过，不猜测、不报错。</p>
     */
    void recordFailureReason(String executionId, String reason, Long rootSessionId);

    /**
     * 崩溃收尸：把仍停留在 ACCEPTED / RUNNING 的轮次收口为 FAILED。
     *
     * <p>与框架的孤儿执行收尸同口径、同时机（启动时）。WAITING 不受影响（可恢复）。</p>
     *
     * @return 被收口的行数
     */
    int reapOrphans();

    /**
     * 按一批执行 ID 批量取轮次，键为执行 ID。
     *
     * <p>历史接口用一次 IN 查询把本页消息的 {@code executionId} 映射到轮次，
     * 不做逐消息查询。</p>
     */
    Map<Long, ChatTurn> findByExecutionIds(Collection<Long> executionIds);

    /**
     * 按一批**轮次 ID** 批量取轮次，键为轮次 ID。
     *
     * <p>历史接口用一次 IN 查询装配 {@code turns} 字典 —— 读路径已经直接用消息行上的
     * {@code turn_id}，不再需要先按执行 ID 反查。</p>
     */
    Map<Long, ChatTurn> findByIds(Collection<Long> turnIds);

    /**
     * 按一批**会话 id** 批量取进行中轮次（ACCEPTED / RUNNING / WAITING）。
     *
     * <p>bootstrap 用一次 IN 查询补「历史分页取不到的活跃轮次」；已终结轮次由历史页的
     * {@code turns} 承载，两者互补不重叠。查询次数不随会话数增长。</p>
     */
    List<ChatTurn> findActiveBySessionIds(Collection<Long> sessionIds);

    /**
     * 会话回滚：删除目标轮次及其之后的全部轮次，返回被删除的那些轮次（按主键升序）。
     *
     * <p>返回整行而不是行数，是为了让调用方直接拿它们的 {@code executionId} 级联清理工具调用卡片，
     * 不在「查」与「删」之间留窗口。本方法是轮次唯一的物理删除入口，只服务重发 ——
     * 被作废的分支连同它的用量统计一起丢弃，没有哪个终态能表达这个语义。</p>
     */
    List<ChatTurn> rollbackFrom(long sessionId, long fromTurnId);
}
