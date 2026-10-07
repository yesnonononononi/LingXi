package com.summit.dp.toolcall.application.service.impl;

import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/** 工具查询与决策入口；决策按执行串行，命令副作用由独立两段事务处理。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ToolCallServiceImpl implements ToolCallService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;

    private final TransactionTemplate transactions;

    private final CommandApprovalExecutor commandApprovalExecutor;
    private final ToolCallDecisionService decisionService;

    private final CardAvailabilityPolicy cardAvailability;

    /** v1 请求级 SSE：命令审批在提交前先建流，恢复期事件与命令输出经它下发。 */
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionIdentity executionIdentity;

    // ------------------------------------------------------------------
    // 读侧
    // ------------------------------------------------------------------

    @Override
    public Optional<ToolCallVO> findById(String toolCallId) {
        if (toolCallId == null || toolCallId.isBlank()) {
            return Optional.empty();
        }
        return toolCallRepository.findById(toolCallId).map(converter::toVO);
    }

    @Override
    public List<ToolCallVO> listByConversationId(Long conversationId) {
        if (conversationId == null) {
            return List.of();
        }
        return toolCallRepository.listByConversationId(conversationId).stream()
                .map(converter::toVO)
                .toList();
    }

    // ------------------------------------------------------------------
    // 决策编排
    // ------------------------------------------------------------------

    @Override
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
                        executionIdentity.resolveRootSessionId(toolCall.getConversationId()));
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

    // ------------------------------------------------------------------
    // 执行终结钩子（由 LocalExecutionRepository 的 loop 边界经生命周期端口调用）
    // ------------------------------------------------------------------

    @Override
    public void cancelPendingToolCalls(String executionId) {
        Long id = numericOrNull(executionId);
        if (id == null) return;
        synchronized (ExecutionCoordination.monitor(executionId)) {
            TransactionTemplate closure = new TransactionTemplate(transactions.getTransactionManager());
            closure.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            closure.executeWithoutResult(status -> {
                for (ToolCall toolCall : toolCallRepository.listUnresolvedByExecutionId(id)) {
                    if (toolCall.complete(converter.cancelled("执行已结束，未完成互动已收口"))) toolCallRepository.updateById(toolCall);
                }
            });
        }
    }

    // ------------------------------------------------------------------
    // 内部工具方法
    // ------------------------------------------------------------------

    private static Long numericOrNull(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Long.valueOf(raw.trim());
        } catch (NumberFormatException e) {
            return null;
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
