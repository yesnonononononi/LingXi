package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.shared.event.ToolCallPendingEvent;
import com.summit.dp.shared.exception.AccessDeniedException;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * 工具调用应用服务实现：读侧查询 + 决策编排。
 *
 * <p><b>职责边界（评审 P1-① 第一刀）：</b>本类只保留「编排入口 + 归属校验 + 幂等判定 + SSE 建流」
 * 与无副作用的 {@code PLAN}/{@code CHOICE} 单事务决策；有外部副作用的 {@code COMMAND} 两段式执行
 * 已下沉到 {@link CommandApprovalExecutor}。</p>
 *
 * <p><b>关于 {@code ObjectProvider}：</b>{@code ExecutionControl} / {@code ExecutionRepository} 仍
 * 延迟取用——它们的 bean 图上挂着框架 {@code ChatAgent}(={@code IChatAgent}) / 工具注册表，
 * 与「本服务 ← 执行生命周期订阅者」形成构造期环，故只在请求处理阶段取值。命令执行相关上下文
 * 的重量级依赖已随 {@link CommandApprovalExecutor} 一并移出本类。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ToolCallServiceImpl implements ToolCallService {

    private static final String LOG_PREFIX = "【tool-call】";

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final ExecutionIdentity executionIdentity;
    private final ModelContextService modelContextService;
    private final SseEventPublisher sseEventPublisher;
    private final ToolCallEventPublisher toolCallEventPublisher;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionControl> executionControl;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final CommandApprovalExecutor commandApprovalExecutor;
    private final SessionAttributeRestorer sessionAttributeRestorer;

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
    public synchronized SseEmitter decide(Long conversationId, String toolCallId, boolean approved, String text) {
        ToolCall toolCall = toolCallRepository.findById(toolCallId)
                .orElseThrow(() -> new ClientException("工具调用不存在: " + toolCallId));

        if (conversationId != null && !Objects.equals(conversationId, toolCall.getConversationId())) {
            throw new AccessDeniedException("会话与工具调用不匹配");
        }
        // 幂等：非「可审批」状态视为已处理，返回一个立即完成的流（不覆盖首次结论）。
        if (!toolCall.isApprovalPending()) {
            return completedEmitter();
        }
        ToolCallKind kind = converter.kindOf(toolCall.getContent());
        if (kind == ToolCallKind.COMMAND) {
            return commandApprovalExecutor.decide(toolCall, approved, text);
        }
        if (kind == ToolCallKind.DELEGATION) {
            // 委派槽位不是人工审批：等的是子执行终态，由 DelegationBackfillListener 自动回填。
            throw new ClientException("子代理执行无需人工审批，等待其审批落定后会自动回填结果");
        }
        return decideDecision(toolCall, kind, approved, text);
    }

    /** 分支 A：{@code PLAN} / {@code CHOICE}（无外部副作用）——单事务。 */
    private SseEmitter decideDecision(ToolCall toolCall, ToolCallKind kind, boolean approved, String text) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = String.valueOf(toolCall.getExecutionId());
        Execution execution = repository.findById(executionId)
                .orElseThrow(() -> new ClientException("执行不存在: " + executionId));
        if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
            throw new ClientException("执行尚未暂停或已结束，请稍后重试");
        }

        ToolCallOutcome outcome = kind == ToolCallKind.CHOICE ? ToolCallOutcome.ANSWERED
                : (approved ? ToolCallOutcome.APPROVED : ToolCallOutcome.REJECTED);
        boolean affirmative = outcome == ToolCallOutcome.APPROVED || outcome == ToolCallOutcome.ANSWERED;
        String rawOutput = converter.decisionOutcome(outcome, text, affirmative);
        String outputText = affirmative
                ? (text == null || text.isBlank() ? "User approved the interaction" : text)
                : "User reject the interaction";

        // 事务 T：同一事务内先写执行末条 toolcall 结论，再落 tool_call 状态 / 输出，最后回写模型上下文。
        transactions.executeWithoutResult(status -> {
            if (!ExecutionToolSlot.write(execution, toolCall.getId(), toolCall.getToolName(), outputText)) {
                throw new ClientException("找不到原工具结果，不能恢复执行");
            }
            toolCall.complete(rawOutput);
            toolCallRepository.updateById(toolCall);
            repository.save(execution);
            modelContextService.replace(conversationId, execution.getMessages());
        });

        boolean pending = !toolCallRepository.listPendingByExecutionId(toolCall.getExecutionId()).isEmpty();
        SseEmitter emitter = sseEventPublisher.connect(executionIdentity.rootSessionIdOfSession(conversationId));
        ExecutionControl control = executionControl.getObject();
        CompletableFuture.runAsync(() -> {
            try {
                if (!pending) {
                    Execution latest = repository.findById(executionId).orElse(execution);
                    // 恢复不经过 RequestPreparer：先把会话级业务属性（团队绑定）补回请求再交给 loop，
                    // 否则恢复后的委派工具解析不到团队，子 Agent 起不来。
                    sessionAttributeRestorer.restore(latest, conversationId);
                    Execution resumed = control.resume(latest);
                    modelContextService.replace(conversationId, resumed.getMessages());
                }
            } catch (Exception e) {
                log.warn("{} failed to resume execution: executionId={}, error={}",
                        LOG_PREFIX, executionId, e.toString());
            } finally {
                emitter.complete();
            }
        });
        return emitter;
    }

    // ------------------------------------------------------------------
    // 执行终结钩子（由 LocalExecutionRepository 的 loop 边界经生命周期端口调用）
    // ------------------------------------------------------------------

    @Override
    public void publishPendingToolCalls(String executionId) {
        Long id = numericOrNull(executionId);
        if (id == null) {
            return;
        }
        for (ToolCall toolCall : toolCallRepository.listPendingByExecutionId(id)) {
            publish(toolCall);
        }
    }

    @Override
    @Transactional
    public void cancelPendingToolCalls(String executionId) {
        Long id = numericOrNull(executionId);
        if (id == null) {
            return;
        }
        for (ToolCall toolCall : toolCallRepository.listPendingByExecutionId(id)) {
            if (toolCall.complete(converter.cancelled("执行已取消"))) {
                toolCallRepository.updateById(toolCall);
            }
        }
    }

    // ------------------------------------------------------------------
    // 内部工具方法
    // ------------------------------------------------------------------

    /** 定向推送一张 pending 卡片事件（按根会话路由）；解析失败只告警，不拖垮 loop 边界。 */
    private void publish(ToolCall toolCall) {
        try {
            long rootSessionId = executionIdentity.rootSessionIdOfSession(toolCall.getConversationId());
            ToolCallKind kind = converter.kindOf(toolCall.getContent());
            toolCallEventPublisher.publish(rootSessionId, ToolCallPendingEvent.of(
                    rootSessionId,
                    toolCall.getId(),
                    kind == null ? null : kind.name(),
                    String.valueOf(toolCall.getConversationId()),
                    String.valueOf(toolCall.getExecutionId())));
        } catch (RuntimeException e) {
            log.warn("{} publish pending tool call failed: id={}, error={}",
                    LOG_PREFIX, toolCall.getId(), e.toString());
        }
    }

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
}
