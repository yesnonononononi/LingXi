package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.dp.checklist.application.ChecklistReminderText;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;

/**
 * 给模型补「本会话已有清单」的上下文。
 *
 * <p>新执行、历史压缩、挂起恢复之后，模型手上没有 checklistId 与稳定 stepId，
 * 就会凭记忆瞎猜。这里按自己的 sessionId 读一次 ACTIVE 清单补进去。</p>
 *
 * <p><b>有界</b>：注入事实记在执行属性里，键是 {@code checklistId:progressVersion}，
 * 只有进展版本变化（真的推进过步骤）才会再补一次；同一版本重复压缩不会重复烧 token。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChecklistContextInjector {

    /** 已注入标记：值形如 {@code checklistId:progressVersion}。 */
    static final String KEY_INJECTED = "lingxi.checklist.injected";

    private final ChecklistService checklistService;

    /** 只在确实有活动清单且本进展版本还没补过时注入；追加失败会原样上抛，不留下假标记。 */
    void injectIfNeeded(LoopContext context, Execution execution) {
        Optional<ChecklistVO> active = checklistService.findActive(ExecutionIdentity.sessionId(execution));
        if (active.isEmpty()) {
            return;
        }
        ChecklistVO snapshot = active.get();
        String marker = snapshot.getChecklistId() + ":" + snapshot.getProgressVersion();
        if (marker.equals(attributes(execution).get(KEY_INJECTED))) {
            return;
        }
        context.appendMessage(List.of(UserMessageEntity.from(ChecklistReminderText.renderContext(snapshot))));
        // 先追加再写标记：追加抛错时标记不会落下，下一轮能重放同一次注入
        writeAttribute(execution, next -> next.put(KEY_INJECTED, marker));
        log.info("注入清单上下文: checklistId={}, progressVersion={}", snapshot.getChecklistId(),
                snapshot.getProgressVersion());
    }

    private static Map<String, Object> attributes(Execution execution) {
        AgentRequest request = execution.getAgentRequest();
        return request == null ? Map.of() : request.runtimeParametersOrDefault().getAttributes();
    }

    /** 运行时属性在请求准备阶段是 {@code Map.copyOf}（不可变），只能整体换一份再挂回去。 */
    private static void writeAttribute(Execution execution, Consumer<Map<String, Object>> mutation) {
        AgentRequest request = execution.getAgentRequest();
        if (request == null) {
            return;
        }
        AgentRuntimeParameters parameters = request.runtimeParametersOrDefault();
        Map<String, Object> next = new HashMap<>(parameters.getAttributes());
        mutation.accept(next);
        parameters.setAttributes(Map.copyOf(next));
        request.setRuntimeParameters(parameters);
    }
}
