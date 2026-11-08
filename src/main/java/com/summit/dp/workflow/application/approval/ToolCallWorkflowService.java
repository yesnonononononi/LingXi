package com.summit.dp.workflow.application.approval;

import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.decision.CommandDecision;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.ResumeIntent;
import com.summit.dp.workflow.application.decision.TwoPhaseCommandResolutionStrategy;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Objects;

/**
 * v1 决策入口：只做输入/输出转换与流管理，业务一律交给统一引擎。
 *
 * <p><b>命令为何单独一条</b>：v1 命令要求「先建流、再提交」，收尾由回调关流。
 * 建流必须发生在提交之前，而提交前又要先完成受理校验 —— 两者顺序相反，
 * 因此命令在这里先走一遍<b>同一份</b>契约闸门（{@link ReactiveDecisionContract}），
 * 再建流，最后交给命令形态策略执行 T1/T2。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ToolCallWorkflowService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final TwoPhaseCommandResolutionStrategy commandStrategy;
    private final ToolCallDecisionService decisionService;
    private final ReactiveDecisionContract contract;

    /** v1 请求级 SSE：命令审批在提交前先建流，恢复期事件与命令输出经它下发。 */
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionLocator executionLocator;

    /**
     * 受理一次 v1 决策。
     *
     * @param conversationId 会话 id，可空（不校验归属）
     * @param toolCallId     目标卡片
     * @param approved       是否批准；缺省按拒绝
     * @param text           用户答复原文，可空
     */
    public SseEmitter decide(Long conversationId, String toolCallId, boolean approved, String text) {
        throwIf(toolCallId == null || toolCallId.isBlank(), "工具调用标识不能为空");
        ToolCall located = toolCallRepository.findById(toolCallId).orElseThrow(ClientException::new);
        ToolCallKind kind = converter.resolveKind(located.getContent());
        // 形态必须先判：它决定走哪条链路，也决定「不可识别 / 无需审批」这两条旧文案。
        throwIf(kind == null, "互动内容不可识别，请刷新后重试");
        throwIf(kind != ToolCallKind.PLAN && kind != ToolCallKind.CHOICE && kind != ToolCallKind.COMMAND,
                "该工具调用无需人工审批，子代理结果会自动回填");
        if (kind != ToolCallKind.COMMAND) {
            // 普通互动：归属、准备中、已处理、活跃执行与执行态全部由引擎按 v1 契约判定。
            return decisionService.decide(located, approved, text);
        }
        return decideCommand(conversationId, toolCallId, approved);
    }

    /** 命令审批：同一份受理闸门 → 建流 → 两阶段执行 → 回调关流。 */
    private SseEmitter decideCommand(Long conversationId, String toolCallId, boolean approved) {
        ToolCall located = toolCallRepository.findById(toolCallId).orElseThrow(ClientException::new);
        synchronized (ExecutionCoordination.monitor(String.valueOf(located.getExecutionId()))) {
            ToolCall toolCall = toolCallRepository.findById(toolCallId).orElseThrow(ClientException::new);
            throwIf(conversationId != null && !Objects.equals(conversationId, toolCall.getConversationId()),
                    "会话与工具调用不匹配");
            contract.admitCard(toolCall);
            if (!toolCall.isApprovalPending()) {
                return completedEmitter();
            }
            contract.admitExecution(toolCall);
            // v1 请求级 SSE：先建流再提交，恢复期事件才接得住；收尾由回调关流。
            SseEmitter emitter = sseEventPublisher.connect(
                    executionLocator.resolveRootSessionId(toolCall.getConversationId()));
            try {
                ToolCallAction action = approved ? ToolCallAction.APPROVE : ToolCallAction.REJECT;
                commandStrategy.resolve(toolCall, new CommandDecision(toolCall.getConversationId(),
                        toolCall.getId(), null, null, action,
                        CommandDigest.build(toolCall.getId(), toolCall.getConversationId(), toolCall.getVersion(),
                                action.wireValue(), null),
                        ResumeIntent.ENTRY_MANAGED), contract, () -> sseEventPublisher.finish(emitter));
            } catch (RuntimeException failure) {
                emitter.completeWithError(failure);
                throw failure;
            }
            return emitter;
        }
    }

    /** 立即完成的流：用于幂等 no-op（已处理的审批不再恢复执行）。 */
    private static SseEmitter completedEmitter() {
        SseEmitter emitter = new SseEmitter(0L);
        emitter.complete();
        return emitter;
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}

