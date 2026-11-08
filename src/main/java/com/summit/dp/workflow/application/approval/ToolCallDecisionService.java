package com.summit.dp.workflow.application.approval;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.workflow.application.decision.DecisionReceipt;
import com.summit.dp.workflow.application.decision.ImmediateDecision;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.ResumeIntent;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * v1 互动决策的<b>流式适配器</b>：判定与落库全在 {@link InteractionDecisionEngine}，本类只管流。
 *
 * <p><b>时序是契约</b>：先建流、再把恢复跑完、最后才关流 —— 前端靠「连接仍开着」判断还在恢复。
 * 因此恢复留在本入口（{@link ResumeIntent#ENTRY_MANAGED}），而不是交给恢复协调器入队：
 * 入队后本线程立刻收尾关流，前端会在恢复还没开始时就收到结束。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ToolCallDecisionService {

    private final ExecutionLocator executionLocator;
    private final SseEventPublisher sseEventPublisher;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final UnresolvedToolSuspensionGate unresolvedToolGate;
    private final SuspendedExecutionResumer resumer;
    private final ManagedAsyncExecutor asyncExecutor;
    private final InteractionDecisionEngine engine;
    private final ReactiveDecisionContract contract;

    /**
     * 提交一次普通互动决策（同意 / 拒绝 / 作答）。
     *
     * @param toolCall 目标卡片（锁外定位结果）
     * @param approved v1 布尔语义：CHOICE 的「批准」等价于「已作答」
     * @param text     用户答复原文，可空
     * @return 请求级 SSE 流
     */
    public SseEmitter decide(ToolCall toolCall, boolean approved, String text) {
        long conversationId = toolCall.getConversationId();
        String executionId = String.valueOf(toolCall.getExecutionId());
        DecisionReceipt receipt = engine.decide(new ImmediateDecision(conversationId, toolCall.getId(), null, null,
                approved ? ToolCallAction.APPROVE : ToolCallAction.REJECT, text,
                v1Digest(toolCall, conversationId, approved, text), ResumeIntent.ENTRY_MANAGED), contract);
        if (!receipt.decisionApplied()) {
            // 幂等 no-op：已处理的审批不再恢复执行，也不该开一条永远不会结束的流。
            return completedEmitter();
        }

        ExecutionRepository repository = executionRepository.getObject();
        // 未决判定在事务提交后即已完成：异步段只负责恢复。
        boolean pending = unresolvedToolGate.hasUnresolvedSlot(toolCall.getExecutionId());
        long rootId = executionLocator.resolveRootSessionId(conversationId);
        SseEmitter emitter = sseEventPublisher.connect(rootId);
        boolean accepted = asyncExecutor.tryExecute("工具决策后恢复执行", () -> {
            try {
                if (!pending) {
                    Execution latest = repository.findById(executionId).orElse(null);
                    if (latest != null) {
                        resumer.resume(latest, conversationId);
                    }
                }
            } catch (Exception e) {
                log.warn("恢复执行失败: executionId={}, error={}", executionId, e.toString());
            } finally {
                sseEventPublisher.finish(emitter);
            }
        });
        if (!accepted) {
            // 执行器已关闭：后台段不会跑，收尾就没人做。这里当场关流，绝不留一条永不结束的连接。
            log.warn("恢复任务未被受理，直接关闭本次 SSE 连接: executionId={}", executionId);
            sseEventPublisher.finish(emitter);
        }
        return emitter;
    }

    /**
     * v1 请求摘要。
     *
     * <p>v1 没有 commandId，但摘要仍要落库：它让「同一决策经 v1 与 v2 落库」可以逐字段比对，
     * 也让日后审计看到一致的事实。构造参数与 v2 同源（v1 无版本号，故传 {@code null}）。</p>
     */
    private static String v1Digest(ToolCall toolCall, long conversationId, boolean approved, String text) {
        // 带上读到的版本：v1 虽不校验版本，但摘要要与 v2（客户端传 expectedVersion）同源，
        // 否则同一决策经两条入口记录出两份不同摘要，等价性无从比对。
        return CommandDigest.build(toolCall.getId(), conversationId, toolCall.getVersion(),
                (approved ? ToolCallAction.APPROVE : ToolCallAction.REJECT).wireValue(), text);
    }

    /** 立即完成的流：用于幂等 no-op（已处理的审批不再恢复执行）。 */
    private static SseEmitter completedEmitter() {
        SseEmitter emitter = new SseEmitter(0L);
        emitter.complete();
        return emitter;
    }
}

