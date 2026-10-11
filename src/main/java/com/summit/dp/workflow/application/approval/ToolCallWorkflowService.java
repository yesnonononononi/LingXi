package com.summit.dp.workflow.application.approval;

import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Objects;

/** 决策按执行串行，命令副作用必须在受理事务提交后运行。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ToolCallWorkflowService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final CommandApprovalExecutor commandApprovalExecutor;
    private final ToolCallDecisionService decisionService;

    private final CardAvailabilityPolicy cardAvailability;

    /** v1 请求级 SSE：命令审批在提交前先建流，恢复期事件与命令输出经它下发。 */
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionLocator executionLocator;

    public SseEmitter decide(Long conversationId, String toolCallId, boolean approved, String text) {
        throwIf(toolCallId == null || toolCallId.isBlank(), "工具调用标识不能为空");
        ToolCall toolCall = toolCallRepository.findById(toolCallId)
                .orElseThrow(ClientException::new);
        synchronized (ExecutionCoordination.monitor(String.valueOf(toolCall.getExecutionId()))) {
            toolCall = toolCallRepository.findById(toolCallId).orElseThrow(ClientException::new);

            throwIf(conversationId != null && !Objects.equals(conversationId, toolCall.getConversationId()), "会话与工具调用不匹配");
            // 幂等：非「可审批」状态视为已处理，返回一个立即完成的流（不覆盖首次结论）。
            throwIf(toolCall.getStatus() == ToolCallStatus.PREPARING, "互动尚在准备，请等待执行暂停后再提交");
            if (!toolCall.isApprovalPending()) {
                return completedEmitter();
            }
            ToolCallKind kind = converter.resolveKind(toolCall.getContent());
            throwIf(kind == null, "互动内容不可识别，请刷新后重试");
            throwIf(cardAvailability.isExecutionActive(String.valueOf(toolCall.getExecutionId())),
                    "执行仍在运行或退出，请等待后再提交");
            if (kind == ToolCallKind.COMMAND) {
                // v1 请求级 SSE：先建流再提交，恢复期事件才接得住；收尾由回调关流。
                SseEmitter emitter = sseEventPublisher.connect(
                        executionLocator.resolveRootSessionId(toolCall.getConversationId()));
                try {
                    commandApprovalExecutor.decide(toolCall, approved, null, null,
                            () -> sseEventPublisher.finish(emitter));
                } catch (RuntimeException failure) {
                    emitter.completeWithError(failure);
                    throw failure;
                }
                return emitter;
            }
            throwIf(kind != ToolCallKind.PLAN && kind != ToolCallKind.CHOICE,
                    "该工具调用无需人工审批，子代理结果会自动回填");
            return decisionService.decide(toolCall, kind, approved, text);
        }
    }

    /** 立即完成的流：用于幂等 no-op（已处理的审批不再恢复执行）。 */
    private static SseEmitter completedEmitter() {
        SseEmitter emitter = new SseEmitter(0L);
        emitter.complete();
        return emitter;
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
