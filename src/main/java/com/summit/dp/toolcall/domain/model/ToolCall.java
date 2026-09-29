package com.summit.dp.toolcall.domain.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * 工具调用聚合根（充血状态机）。
 *
 * <p>它是 {@code tool_call} 表的领域投影，也是**全部工具调用**（人工在环的 {@link ToolCallType#PROMISE}
 * 与框架直通的 {@link ToolCallType#EXECUTE}）状态与卡片载荷的唯一权威源。</p>
 *
 * <p><b>状态机约定：</b>生命周期只有 {@code pending → in_progress → completed}，
 * {@code completed} 为终态、不可再变；所有流转都收敛到 {@link #transferTo(ToolCallStatus)}
 * 这一个入口，外部不得直接改 {@code status}。结论 / 异常一律写进
 * {@code rawOutput}（{@code outcome}），不新增失败 / 取消状态。</p>
 */
@Getter
@Builder(toBuilder = true)
@AllArgsConstructor
public class ToolCall {

    /** 工具调用 ID（模型下发的 call id，{@code call_xxx}）。 */
    private final String id;

    /** 所属会话（= {@code session.id}）。 */
    private final Long conversationId;

    /** 回指承载该调用的 {@code session_message.id}（TOOL 行）；可空，由 transcript 尽力回填。 */
    private Long sessionMessageId;

    /** 派生此次调用的执行 ID（{@code execution.id}）。 */
    private final Long executionId;

    /** 原始工具名（仅展示，不作卡片判别依据）。 */
    private String toolName;

    /**
     * 调用类型。
     *
     * <p>非 {@code final}：登记器以「最后写入者胜出」策略把 {@link ToolCallType#EXECUTE} 占位
     * 升级为 {@link ToolCallType#PROMISE}（见 {@link #promoteToPromise}），因此允许改型。</p>
     */
    private ToolCallType type;

    @Builder.Default
    private ToolCallStatus status = ToolCallStatus.PENDING;

    /** 卡片标题（PROMISE 卡片；EXECUTE 可空）。 */
    private String title;

    /** 多态内容块 JSON：{@code {kind:"PLAN|CHOICE|COMMAND", ...}}。 */
    private String content;

    /** 输入载荷 JSON：{@code {"args":<模型args>,"answers":<用户答复>}}。 */
    private String rawInput;

    /** 输出载荷 JSON：{@code {"outcome":...,"stdout":...,"exitCode":...}}。 */
    private String rawOutput;

    /** 扩展元数据 JSON（{@code _meta}）。 */
    private String metaData;

    private final Instant createdAt;

    @Builder.Default
    private Instant updatedAt = Instant.now();

    /**
     * 生命周期唯一流转入口：终态幂等。
     *
     * @return {@code true} 表示本次真正推进了状态；已是终态或目标态与当前相同时返回 {@code false}
     *         （幂等 no-op，调用方不应因此落库）
     */
    public boolean transferTo(ToolCallStatus next) {
        if (status == ToolCallStatus.COMPLETED) {
            return false;   // 终态幂等
        }
        if (status == next) {
            return false;   // 幂等 no-op
        }
        this.status = next;
        this.updatedAt = Instant.now();
        return true;
    }

    /** 放行执行：pending → in_progress（命令批准后进入执行中）。 */
    public boolean markInProgress() {
        return transferTo(ToolCallStatus.IN_PROGRESS);
    }

    /**
     * 收尾：→ completed。批准 / 拒绝 / 取消 / 成功 / 失败**全部**走这里，
     * 区别只在 {@code rawOutput.outcome}。
     *
     * <p>终态幂等：已是 completed 时不再覆盖已有结论，返回 {@code false}。</p>
     */
    public boolean complete(String rawOutputJson) {
        if (status == ToolCallStatus.COMPLETED) {
            return false;
        }
        boolean changed = transferTo(ToolCallStatus.COMPLETED);
        if (rawOutputJson != null) {
            this.rawOutput = rawOutputJson;
        }
        this.updatedAt = Instant.now();
        return changed;
    }

    /** 结论落定但**不**改状态（用于「先写结论、再执行命令」的两段式命令审批）。 */
    public void attachOutput(String rawOutputJson) {
        this.rawOutput = rawOutputJson;
        this.updatedAt = Instant.now();
    }

    /**
     * 登记器 UPSERT 升级入口：命中已有的 EXECUTE 占位行时升级为 PROMISE / pending，
     * 并补齐卡片载荷（最后写入者胜出）。已是 completed 的行不降级。
     */
    public void promoteToPromise(ToolCallType type, String toolName, String title, String content, String rawInput) {
        if (status == ToolCallStatus.COMPLETED) {
            return;
        }
        this.type = type;
        this.status = ToolCallStatus.PENDING;
        if (toolName != null) {
            this.toolName = toolName;
        }
        if (title != null) {
            this.title = title;
        }
        if (content != null) {
            this.content = content;
        }
        if (rawInput != null) {
            this.rawInput = rawInput;
        }
        this.updatedAt = Instant.now();
    }

    /** 是否仍在等待用户决策。 */
    public boolean isPending() {
        return status == ToolCallStatus.PENDING;
    }

    /** 是否已收尾。 */
    public boolean isCompleted() {
        return status == ToolCallStatus.COMPLETED;
    }

    /** 前端唯一可审批判定：{@code type == PROMISE && status == pending}。 */
    public boolean isApprovalPending() {
        return type == ToolCallType.PROMISE && status == ToolCallStatus.PENDING;
    }
}
