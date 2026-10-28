package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ReminderDecision;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 自然收尾时检查执行清单：还有待处理步骤就先提醒一轮，再收尾仍无推进就关闭清单。
 *
 * <p><b>order 为什么必须是 -600</b>：{@code BackgroundTaskLoopInterceptor} 是 -650、
 * {@code SubAgentWaitInterceptor} 是 -700。它们负责「等后台任务 / 等子执行」这类<b>挂起</b>。
 * 拦截器链按 order 升序执行，一旦我们排到它们前面并返回续轮，
 * 那些挂起就永远不会发生，而提醒额度却已经被消耗掉——模型被叫起来看清单，
 * 后台命令结果却没人等。所以本拦截器必须排在它们之后（数值更大），
 * 让挂起优先发生，等执行真正走到自然收尾时再判定清单。</p>
 *
 * <p>{@code catchErr() = false}：状态写入或消息注入失败必须上抛。
 * 吞掉之后库里的清单状态与模型所见将不再一致，这比一轮失败更糟。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChecklistReminderInterceptor implements LoopInterceptor {

    private final ChecklistService checklistService;
    private final ChecklistContextInjector contextInjector;
    private final ChecklistReminderDelivery delivery;

    @Override
    public int order() {
        return -600;
    }

    @Override
    public boolean catchErr() {
        return false;
    }

    /** 补入或更新系统上下文，不参与收尾额度判定。 */
    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        if (execution == null || !canMaintainChecklist(execution)) {
            return InterceptorResult.NONE;
        }
        contextInjector.injectIfNeeded(context, execution);
        return InterceptorResult.NONE;
    }

    /**
     * 收尾判定：有活动清单且有未结束步骤时提醒一次。
     *
     * <p>只做三件事：取执行身份与投递证据、问服务要结论、按结论追加消息并返回续轮。
     * 状态机、CAS、归属判断都在 {@code ChecklistService} 里；投递证据来自执行检查点，
     * 不能把「额度被占」当成「模型已经收到提醒」。</p>
     */
    @Override
    public InterceptorResult onBeforeComplete(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        if (execution == null) {
            return InterceptorResult.NONE;
        }
        if (!canMaintainChecklist(execution)) {
            // 没有更新能力就不提醒：否则模型会看到「请标记步骤」却无工具可用，白耗一轮
            return InterceptorResult.NONE;
        }
        ReminderDecision decision = checklistService.remindOnNaturalComplete(delivery.buildContext(execution));
        if (!decision.requiresAnotherRound()) {
            log.debug("清单收尾判定放行: outcome={}, reason={}", decision.outcome(), decision.reason());
            return InterceptorResult.NONE;
        }
        // 先追加消息再返回续轮：注入失败要直接抛出，绝不能消费了额度却静默完成
        delivery.append(context, decision);
        log.info("清单提醒续轮: checklistId={}, sessionId={}, outcome={}, pending={}",
                decision.checklist() == null ? null : decision.checklist().getChecklistId(),
                decision.checklist() == null ? null : decision.checklist().getSessionId(),
                decision.outcome(), decision.pendingSteps().size());
        return InterceptorResult.of(LoopResult.continueLoop(), false);
    }

    /**
     * 本次执行最终获准的工具集里有没有「能清掉待处理步骤」的工具。
     *
     * <p>只认 {@code update_checklist_step}：它是唯一能把步骤推到终态的入口。
     * 工具集未知（{@code null}）时按「没有能力」处理——无法证明能推进，就不该提醒。</p>
     */
    private boolean canMaintainChecklist(Execution execution) {
        AgentRequest request = execution.getAgentRequest();
        if (request == null) {
            return false;
        }
        List<String> tools = request.getToolList();
        return tools != null && tools.contains(ToolCatalog.UPDATE_CHECKLIST_STEP);
    }
}
