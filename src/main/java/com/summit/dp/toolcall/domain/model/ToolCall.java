package com.summit.dp.toolcall.domain.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/** 工具状态与结论的权威对象；准备完成只允许推进一次，终态不回退。 */
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

    /** 执行占位可升级为互动，已登记的互动不能再次覆盖。 */
    private ToolCallType type;

    @Builder.Default
    private ToolCallStatus status = ToolCallStatus.PENDING;

    /** 卡片标题（PROMISE 卡片；EXECUTE 可空）。 */
    private String title;

    /** 多态内容块 JSON：{@code {kind:"PLAN|CHOICE|COMMAND", ...}}。 */
    private String content;

    /** 输入载荷 JSON：{@code {"args":<模型args>,"answer":<用户答复>}}。 */
    private String rawInput;

    /** 输出载荷 JSON：{@code {"outcome":...,"stdout":...,"exitCode":...}}。 */
    private String rawOutput;

    /** 扩展元数据 JSON（{@code _meta}）。 */
    private String metaData;

    @Builder.Default
    private Long version = 1L;

    /** 落定本结论的决策命令 ID；决策重试据此返回首次结论而不是重新执行。 */
    private String decisionCommandId;

    /** 决策请求摘要；同 commandId 但内容不同即拒绝，不会把后一次意图当作成功覆盖。 */
    private String decisionDigest;

    public void acceptPersistedVersion(long nextVersion) {
        this.version = nextVersion;
    }

    /**
     * 记录决策命令身份。
     *
     * <p><b>刻意不与 {@link #complete} 合并成一个入口</b>：命令审批的 T1 要先写
     * 「决策已接受 + in_progress」再执行外部命令，此时还没有结论；T2 才补结论。
     * 两段各自赋值、最终同事务落库，决策元信息因此总能与会话里的实际结论对齐。</p>
     *
     * <p><b>同 commandId 重复调用是幂等的</b>：重试返回首次结论，不改写元信息。</p>
     *
     * @param commandId 决策命令 ID
     * @param digest    请求摘要，用于判定「同 ID 不同内容」
     */
    public void attachDecision(String commandId, String digest) {
        if (isCompleted() && commandId != null && commandId.equals(this.decisionCommandId)) {
            return;
        }
        this.decisionCommandId = commandId;
        this.decisionDigest = digest;
        this.updatedAt = Instant.now();
    }

    /** 该结论是否由指定命令落定；用于「同 commandId 重试」判定。 */
    public boolean isDecidedBy(String commandId) {
        return commandId != null && commandId.equals(this.decisionCommandId);
    }

    public void bindSessionMessage(Long messageId) {
        this.sessionMessageId = messageId;
        this.updatedAt = Instant.now();
    }

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
        if (next == ToolCallStatus.PREPARING
                || (next == ToolCallStatus.PENDING && status != ToolCallStatus.PREPARING)
                || (next == ToolCallStatus.IN_PROGRESS && status != ToolCallStatus.PENDING)) {
            return false;
        }
        this.status = next;
        this.updatedAt = Instant.now();
        return true;
    }

    /** 放行执行：pending → in_progress（命令批准后进入执行中）。 */
    public boolean markInProgress() {
        return transferTo(ToolCallStatus.IN_PROGRESS);
    }

    public boolean markReady() {
        return type == ToolCallType.PROMISE && status == ToolCallStatus.PREPARING
                && transferTo(ToolCallStatus.PENDING);
    }

    public boolean isUnresolved() {
        return type == ToolCallType.PROMISE && status != ToolCallStatus.COMPLETED;
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
        if (isCompleted()) return;
        this.rawOutput = rawOutputJson;
        this.updatedAt = Instant.now();
    }

    /**
     * 只升级未完成的执行占位，已有互动不能再次登记或降级。
     *
     * <p><b>为什么这里可以绕过 {@link #transferTo}</b>：本方法不是「推进生命周期」，
     * 而是「重新分类」—— {@code ToolCallRegistrarImpl#markExecuteStarted} 先按普通工具
     * 落一行 {@code EXECUTE + IN_PROGRESS} 占位，模型随后用同一个 call id 发起
     * {@code create_plan} / {@code require_choice} 时，靠这次重分类把它转成待决卡片。
     * {@code IN_PROGRESS} 在这里是「工具已被框架调度」的记录，不是「用户已批准，正在执行」，
     * 因此打回 {@code PREPARING} 是正确的，且 {@code transferTo} 本就拒绝该迁移。</p>
     */
    public void promoteToPromise(ToolCallType type, String toolName, String title, String content, String rawInput) {
        if (status == ToolCallStatus.COMPLETED || this.type == ToolCallType.PROMISE) {
            return;
        }
        this.type = type;
        this.status = ToolCallStatus.PREPARING;
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

    /** 仅表示未决槽位，不代表人工可操作。 */
    public boolean isPending() {
        return status == ToolCallStatus.PENDING;
    }

    /** 是否已收尾。 */
    public boolean isCompleted() {
        return status == ToolCallStatus.COMPLETED;
    }

    /** 仅判断槽位状态；人工可操作性还要核对形态与执行是否退出。 */
    public boolean isApprovalPending() {
        return type == ToolCallType.PROMISE && status == ToolCallStatus.PENDING;
    }
}
