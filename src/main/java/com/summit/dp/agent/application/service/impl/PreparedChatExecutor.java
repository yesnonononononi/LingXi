package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ModelContextService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;

import com.summit.dp.execution.application.service.ExecutionRegistrationService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;

/**
 * 已受理上下文的执行协作：负责「用户消息已落库之后」到「模型跑完」这一段。
 *
 * <p><b>为什么从受理脚本里独立出来</b>：受理只保证「命令被接住了」（消息与轮次同事务落库），
 * 模型调用是随后的异步动作。两者混在一个方法里会出现一个致命歧义 ——
 * 异常发生时无法判断该回「受理失败」还是「执行失败」，而这两者对前端的含义完全不同：
 * 前者要保留输入让用户重发，后者输入已生效、只需展示失败。拆开后
 * 受理脚本的异常一律是受理失败，执行协作的异常一律是执行失败。</p>
 *
 * <p><b>收尾纪律</b>：运行资格（{@link SessionExecutionRegistry#finishRoot}）由本类在
 * {@code finally} 释放 —— 它必须覆盖模型调用的完整生命周期，否则一次模型异常就把会话
 * 永久锁死在「执行中」，用户再也发不出第二条消息。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PreparedChatExecutor {

    private final AgentWorkflowOrchestrator agentWorkflowOrchestrator;
    private final ModelContextService modelContextService;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ExecutionRegistrationService executionRegistrationService;
    private final ChatTurnService chatTurnService;

    /**
     * 跑完一次已受理的执行。
     *
     * <p><b>调用前置</b>：运行资格已由受理脚本通过 {@code beginRoot} 拿到，用户消息与业务轮次
     * 已同事务落库。本方法不重复提交消息，也不重复校验单飞 —— 那些都在受理阶段完成了，
     * 在这里重做一遍只会把「受理失败」误报成「执行失败」。</p>
     *
     * @param context 已带 turnId 的上下文
     * @return 本次执行的框架对象（v1 同步入口要拿它的消息集合作返回值）
     */
    public Execution run(RuntimeContext context) {
        long rootSessionId = context.executionContext().rootSessionId();
        try {
            Execution execution = start(context);
            modelContextService.replace(ExecutionIdentity.sessionId(execution), execution.getMessages());
            return execution;
        } catch (RuntimeException e) {
            // 启动失败：执行行还停在 CREATED，必须收口成终态，否则历史里会留下一条
            // 永远「创建中」、既无回复也无失败提示的记录。
            markStartupFailedQuietly(context, e);
            throw e;
        } finally {
            sessionExecutionRegistry.finishRoot(rootSessionId);
        }
    }

    /** 执行档位：团队 > 单 Agent > 裸模型。 */
    private Execution start(RuntimeContext context) {
        if (context.teamId() != null) {
            return agentWorkflowOrchestrator.executeWorkflow(context.teamId(), context);
        }
        if (context.agentId() != null) {
            return agentWorkflowOrchestrator.executeSingleAgent(context.agentId(), context);
        }
        return agentWorkflowOrchestrator.executeDefaultAgent(context);
    }

    /**
     * 收口启动失败的执行与轮次；收口本身失败只告警，绝不掩盖原始异常。
     *
     * <p>归属用 {@link RuntimeContext} 里已固化的 executionId（显式传递），
     * 不通过「当前会话最新执行」猜测 —— 并发下那样必然认错执行。</p>
     */
    private void markStartupFailedQuietly(RuntimeContext context, RuntimeException cause) {
        Long executionId = ExecutionIdentity.numericOrNull(context.executionContext().executionId());
        if (executionId == null) {
            return;
        }
        try {
            executionRegistrationService.markStartupFailed(executionId);
        } catch (RuntimeException markFailure) {
            log.warn("收口启动失败的执行时出错: executionId={}, cause={}, 收口失败原因={}",
                    executionId, cause.toString(), markFailure.toString());
        }
        try {
            // 轮次同样要收口：它在「受理」那一刻就落库了，若不收口会永远停在「已受理」，
            // 而启动收尸钩子只会在**下次重启**时补 —— 这中间用户看到的是「已受理」，没有失败原因。
            String executionIdText = String.valueOf(executionId);
            // 根身份取自已固化的执行上下文：本路径只处理根会话聊天，会话自身即根。
            Long rootSessionId = context.executionContext().sessionId();
            chatTurnService.markTerminal(executionIdText, ChatTurnStatus.FAILED,
                    null, null, null, Instant.now(), rootSessionId);
            chatTurnService.recordFailureReason(executionIdText, cause.getMessage(), rootSessionId);
        } catch (RuntimeException markFailure) {
            log.warn("收口启动失败的轮次时出错: executionId={}, cause={}, 收口失败原因={}",
                    executionId, cause.toString(), markFailure.toString());
        }
    }
}
