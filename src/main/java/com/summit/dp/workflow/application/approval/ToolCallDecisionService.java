package com.summit.dp.workflow.application.approval;

import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.workflow.application.decision.DecisionReceipt;
import com.summit.dp.workflow.application.decision.ImmediateDecision;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.ResumeIntent;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * v1 互动决策的<b>流式适配器</b>：判定与落库全在 {@link InteractionDecisionEngine}，本类只管流。
 *
 * <p><b>时序是契约，且顺序不可调：先建流 → 再提交决策 → 恢复落定才关流</b>。
 * 前端靠「连接仍开着」判断还在恢复，所以：</p>
 * <ol>
 *   <li><b>先 connect 再 decide</b>：恢复请求在决策事务提交后立刻派发，若此时还没连接，
 *       恢复期事件就会丢在空气里。</li>
 *   <li><b>落定驱动关流</b>：恢复改由 Phase3 持久化队列承担
 *       （{@link ResumeIntent#COORDINATOR}），关流时机由协调器的落定回调给出 ——
 *       成功、被取代、门禁暂缓、启动失败、中断、派发被拒都会落定，
 *       因此不存在「恢复结束了但流还开着」或反之。</li>
 *   <li><b>受理失败原样抛出</b>：先 {@code completeWithError} 再抛，前端既能看到错误也能收到流结束。</li>
 * </ol>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ToolCallDecisionService {

    private final ExecutionLocator executionLocator;
    private final SseEventPublisher sseEventPublisher;
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
        long rootId = executionLocator.resolveRootSessionId(conversationId);
        // 先建流：恢复请求在提交后立即派发，此时必须已经有连接可接事件。
        SseEmitter emitter = sseEventPublisher.connect(rootId);
        DecisionReceipt receipt;
        try {
            receipt = engine.decide(new ImmediateDecision(conversationId, toolCall.getId(), null, null,
                    approved ? ToolCallAction.APPROVE : ToolCallAction.REJECT, text,
                    v1Digest(toolCall, conversationId, approved, text), ResumeIntent.COORDINATOR,
                    () -> sseEventPublisher.finish(emitter)), contract);
        } catch (RuntimeException failure) {
            // 决策没落库：这条流不会有任何恢复事件，必须当场以错误收尾再原样抛出。
            emitter.completeWithError(failure);
            throw failure;
        }
        if (!receipt.decisionApplied()) {
            // 幂等 no-op：没有登记恢复，也就不会有落定回调，这里直接关流。
            sseEventPublisher.finish(emitter);
        }
        return emitter;
    }

    /**
     * v1 请求摘要。
     *
     * <p>v1 没有 commandId，但摘要仍要落库：它让「同一决策经 v1 与 v2 落库」可以逐字段比对，
     * 也让日后审计看到一致的事实。带上观察到的版本，与 v2 的 {@code expectedVersion} 同源。</p>
     */
    private static String v1Digest(ToolCall toolCall, long conversationId, boolean approved, String text) {
        return CommandDigest.build(toolCall.getId(), conversationId, toolCall.getVersion(),
                (approved ? ToolCallAction.APPROVE : ToolCallAction.REJECT).wireValue(), text);
    }
}


