package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.toolcall.application.service.ToolRequestOrderRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 每次模型返回后，登记本轮工具请求的**模型顺序**，供工具块实时装配读取。
 *
 * <p><b>为什么挂 {@code onAfterModelInvoke}</b>：这是「模型刚返回、尚未执行任何工具」的唯一时点。
 * 此刻 {@code response.getAiMessageEntity().toolCalls} 已是**完整且有序**的请求列表；
 * 过了这里，工具就进入并发调度，完成顺序再也还原不出模型意图。放在
 * {@code onAfterToolCall} 或工具监听器里登记，拿到的只是完成顺序，正好是本契约要避免的东西。</p>
 *
 * <p><b>为什么 catchErr 用默认的 true</b>：登记只是观测，失败不改业务语义 ——
 * 没登记到顺序时，装配侧回退到按 toolCallId 稳定排序，世界仍然一致。吞掉异常、记一条日志即可。</p>
 *
 * <p>业务侧 order 分段：本类取 {@code -900}（最前段），保证在其它读取工具顺序的钩子之前跑完。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ToolRequestOrderInterceptor implements LoopInterceptor {

    private final ToolRequestOrderRegistry toolRequestOrderRegistry;

    @Override
    public int order() {
        return -900;
    }

    /**
     * 登记本轮工具请求顺序。
     *
     * <p>只登记「确实有工具请求」的轮次；无工具请求的轮次是循环出口，没有顺序可言。
     * 顺带记下本执行最近一次模型调用的身份，供 {@code onLoopEnd} 精确清档 ——
     * 逐轮清理比整执行清理更保守：本轮结束后，其顺序已无实时装配用途。</p>
     */
    @Override
    public InterceptorResult onAfterModelInvoke(LoopContext context, ChatResponseEntity response) {
        if (response == null) {
            return InterceptorResult.NONE;
        }
        AiMessageEntity aiMessage = response.getAiMessageEntity();
        if (aiMessage == null) {
            return InterceptorResult.NONE;
        }
        List<?> toolCalls = aiMessage.getToolCalls();
        if (toolCalls == null || toolCalls.isEmpty()) {
            return InterceptorResult.NONE;
        }
        String executionId = executionIdOf(context);
        if (executionId == null) {
            return InterceptorResult.NONE;
        }
        try {
            toolRequestOrderRegistry.register(executionId, response.getResponseId(), aiMessage);
        } catch (RuntimeException e) {
            // 观测链路不得拖垮主执行流：登记失败只告警，工具照常执行。
            log.warn("登记工具请求顺序失败: executionId={}, responseId={}, error={}",
                    executionId, response.getResponseId(), e.toString());
        }
        return InterceptorResult.NONE;
    }

    /**
     * 执行结束整体清档。
     *
     * <p><b>为什么收尾在 onRunEnd 而不是 onLoopEnd</b>：{@code LoopContext} 不持有本轮的
     * {@code responseId}，逐轮精确清理需要额外状态；而顺序登记只在「该轮尚未落库、实时装配正在读」
     * 的窗口内有意义，窗口最长到执行结束。因此按执行 id 整体清档既正确又简单 ——
     * 一个执行的所有轮次结束时，其下所有档一起摘除，不漏不清。</p>
     *
     * <p>{@code onRunEnd} 只在 COMPLETED/CANCELLED/FAILED 触发，不含 SUSPENDED ——
     * 挂起期间顺序仍需保留（恢复后同一轮可能继续装配），因此不在此处清理挂起中的执行。</p>
     */
    @Override
    public InterceptorResult onRunEnd(Execution execution) {
        if (execution != null) {
            toolRequestOrderRegistry.clearExecution(execution.getId());
        }
        return InterceptorResult.NONE;
    }

    /** 取执行身份；缺失返回 {@code null}（由调用方短路，不抛异常）。 */
    private static String executionIdOf(LoopContext context) {
        if (context == null || context.execution() == null) {
            return null;
        }
        String executionId = context.execution().getId();
        return executionId == null || executionId.isBlank() ? null : executionId;
    }
}
