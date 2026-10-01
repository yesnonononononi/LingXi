package com.summit.dp.turn.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * 业务轮次（充血模型）：业务上最权威的「用户单次请求」记录。
 *
 * <p><b>为什么不复用框架 execution</b>：execution 的语义是「运行时快照记录，提供可回滚能力」，
 * 业务只该读它。而「这次请求受理了吗、用的哪个模型、花了多少 token、多久」是业务事实，
 * 必须在框架执行还不存在时就已存在（受理即落库）。把业务事实塞进框架表，会派生出一串
 * 补丁：抢在框架建行前预插、再为那行收口终态、把展示字段写进别人的表。</p>
 *
 * <p><b>状态变更一律经领域方法</b>，非法转移明确报错（不静默纠正）。特别是：</p>
 * <ul>
 *   <li>终态**不可改写** —— 重复收到同一终态通知是幂等的（只补齐用量），
 *       但试图把终态改成另一种终态会抛异常，避免"后续通知失败把已保存的终态改掉"；</li>
 *   <li>{@code startedAt} **只在首次设置**（恢复不重置），保证「总历时」从第一次开始算；</li>
 *   <li>用量为**覆盖**语义且 {@code null} 不覆盖已知值 —— 同一执行重复保存不得翻倍。</li>
 * </ul>
 */
@Builder
@Getter
public class ChatTurn {

    private final Long id;
    private final Long sessionId;
    /** 发起本次子 Agent 委派的主轮次；普通用户提问为 {@code null}。 */
    private final Long parentTurnId;
    /** 关联的框架执行 ID；受理时还不知道，执行创建后回填。 */
    private Long executionId;
    private ChatTurnStatus status;
    /** 本轮实际使用的模型名称快照（受理时从业务自己解析出的配置写入，不回读框架对象）。 */
    private String modelName;
    /** 本轮实际使用的模型提供方快照。 */
    private String modelProvider;
    /** 已采集输入 token；{@code null} = 未知，与 0（确实为 0）严格区分。 */
    private Long inputTokenCount;
    private Long outputTokenCount;
    private Long totalTokenCount;
    /** 首次开始执行时间（取框架 onStart 时刻）；未真正开始为 {@code null}。 */
    private Instant startedAt;
    /** 进入终态的时间；未结束为 {@code null}。 */
    private Instant completedAt;
    /**
     * 面向用户的失败原因；仅 {@link ChatTurnStatus#FAILED} 时渲染。
     *
     * <p>失败是**轮次的属性**，不是一轮对话里的一条消息 —— 此前把失败伪装成一条
     * {@code type='ERROR'} 的消息塞进时间轴，既污染了消息列表，也让同一个状态存在两处。</p>
     */
    private String errorReason;
    /** 受理时刻。 */
    private final Instant createdAt;
    private Instant updatedAt;

    /**
     * 受理一次请求：轮次在「接受请求」那一刻就以 ACCEPTED 落库，此时框架执行可能还不存在。
     *
     * @param modelName     受理时业务已解析出的模型名（可为 null，例如模型解析失败）
     * @param modelProvider 同上
     */
    public static ChatTurn accept(long id, long sessionId, Long parentTurnId,
                                  String modelName, String modelProvider) {
        return ChatTurn.builder()
                .id(id)
                .sessionId(sessionId)
                .parentTurnId(parentTurnId)
                .status(ChatTurnStatus.ACCEPTED)
                .modelName(modelName)
                .modelProvider(modelProvider)
                .createdAt(Instant.now())
                .build();
    }

    /**
     * 回填框架执行 ID。
     *
     * <p>允许重复回填同一个值（幂等）；但**不允许改绑**到另一个执行 —— 一轮一次执行，
     * 改绑意味着归属错乱，宁可报错也不要静默把统计挪到别的执行上。</p>
     */
    public void attachExecution(Long executionId) {
        if (executionId == null) {
            return;
        }
        if (this.executionId != null && !this.executionId.equals(executionId)) {
            throw new IllegalStateException("轮次已关联执行，不允许改绑: turnId=" + id
                    + ", existing=" + this.executionId + ", incoming=" + executionId);
        }
        this.executionId = executionId;
    }

    /**
     * 标记开始执行（框架 onStart）。
     *
     * <p>{@code startedAt} 只在首次设置：恢复执行会再次触发本方法，若覆盖就把「总历时」
     * 算成了「本次恢复之后的耗时」。</p>
     */
    public void markRunning(Instant startedAt) {
        requireNotTerminal("开始执行");
        if (status != ChatTurnStatus.ACCEPTED && status != ChatTurnStatus.WAITING
                && status != ChatTurnStatus.RUNNING) {
            throw new IllegalStateException("轮次状态 " + status + " 不允许转为 RUNNING: turnId=" + id);
        }
        this.status = ChatTurnStatus.RUNNING;
        if (this.startedAt == null && startedAt != null) {
            this.startedAt = startedAt;
        }
    }

    /**
     * 标记等待（框架 SUSPENDED）。挂起不是终态：不写 {@code completedAt}。
     *
     * <p><b>刻意不限制来源状态</b>：命令审批「批准后继续」会把执行从 RUNNING 再推回 SUSPENDED，
     * 框架会**再次**发出挂起信号，此时轮次已是 WAITING —— 若要求「必须从 RUNNING 转来」，
     * 这条正常路径会抛异常。挂起是可逆的中间态，重复标记天然幂等，不需要额外校验。</p>
     */
    public void markWaiting() {
        requireNotTerminal("挂起");
        this.status = ChatTurnStatus.WAITING;
    }

    public void markCompleted(Long inputTokens, Long outputTokens, Long totalTokens, Instant completedAt) {
        finish(ChatTurnStatus.COMPLETED, inputTokens, outputTokens, totalTokens, completedAt);
    }

    public void markFailed(Long inputTokens, Long outputTokens, Long totalTokens, Instant completedAt) {
        finish(ChatTurnStatus.FAILED, inputTokens, outputTokens, totalTokens, completedAt);
    }

    public void markCancelled(Long inputTokens, Long outputTokens, Long totalTokens, Instant completedAt) {
        finish(ChatTurnStatus.CANCELLED, inputTokens, outputTokens, totalTokens, completedAt);
    }

    /**
     * 记下面向用户的失败原因。
     *
     * <p><b>刻意不改状态</b>：状态由框架生命周期信号驱动（终态通知会把它置为 FAILED），
     * 这里只负责把「为什么失败」留在轮次上 —— 两个来源各管一件事，不会互相覆盖。</p>
     *
     * <p>空文案不覆盖已有值；非 FAILED 的轮次即使残留了原因也不会被渲染
     * （渲染条件由展示层按 {@code status} 判定，所以残留无害）。</p>
     */
    public void recordFailureReason(String reason) {
        if (reason == null || reason.isBlank()) {
            return;
        }
        this.errorReason = reason.trim();
    }

    /**
     * 覆盖写入已采集用量。
     *
     * <p><b>覆盖而非累加</b>：框架的用量本身就是跨轮累加的结果，再累加一次会把同一执行算两遍
     * （resume 后终态事件会重发，重复触发是常态）。</p>
     *
     * <p>{@code null} 不覆盖已知值：未采集到 ≠ 0，也绝不能用「未知」把已经采集到的数字抹掉。</p>
     */
    public void refreshUsage(Long inputTokens, Long outputTokens, Long totalTokens) {
        if (inputTokens != null) {
            this.inputTokenCount = inputTokens;
        }
        if (outputTokens != null) {
            this.outputTokenCount = outputTokens;
        }
        if (totalTokens != null) {
            this.totalTokenCount = totalTokens;
        }
    }

    private void finish(ChatTurnStatus target, Long inputTokens, Long outputTokens,
                        Long totalTokens, Instant completedAt) {
        if (status != null && status.isTerminal()) {
            if (status == target) {
                // 幂等：重复的终态通知只补齐用量，绝不改写状态与结束时间。
                refreshUsage(inputTokens, outputTokens, totalTokens);
                return;
            }
            throw new IllegalStateException("轮次已是终态 " + status + "，不允许改写为 " + target
                    + ": turnId=" + id);
        }
        this.status = target;
        if (completedAt != null) {
            this.completedAt = completedAt;
        }
        refreshUsage(inputTokens, outputTokens, totalTokens);
    }

    private void requireNotTerminal(String action) {
        if (status != null && status.isTerminal()) {
            throw new IllegalStateException("轮次已进入终态 " + status + "，不允许再" + action
                    + ": turnId=" + id);
        }
    }
}
