package com.summit.dp.toolcall.infrastructure.listener;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.ExecutionToolSlot;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.sub_agent.result.SubAgentResultRenderer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 委派回填：子执行终态 → 父执行的 {@code DELEGATION} 槽位写入子代理最终结果 → 恢复父执行。
 *
 * <p>这是「挂起沿委派链传播」的另一半：{@code CallSubAgentTool} 在子执行挂起时把父执行
 * 以 PROMISE 槽位同步挂起；本监听器在子执行走到终态（审批落定后恢复跑完 / 被取消 / 失败）
 * 时把结果回填进槽位，父执行像收到普通工具结果一样继续推理 —— 子代理的产出由此被消费。</p>
 *
 * <p><b>为什么必须异步</b>：本端口在 {@code LocalExecutionRepository} 的 {@code synchronized}
 * 边界内触发（{@code unregister} / {@code requireCancel}），父执行的恢复是一段可能很长的
 * loop —— 同步执行会把仓储监视器一直握着，阻塞其它会话的登记与注销。</p>
 *
 * <p><b>多委派并发回填</b>：同一父执行的多个子执行可能先后（甚至同时）落定，恢复前以
 * 「父执行是否还有 pending 槽位」为准 —— 全部落定才恢复，父模型一次看到全部结果；
 * 每个父执行一把锁串行化回填，避免并发者基于同一份检查点互相覆盖。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DelegationBackfillListener implements ExecutionLifecycleListener {

    private static final String LOG_PREFIX = "【delegation-backfill】";

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final SubAgentResultRenderer resultRenderer;
    private final ModelContextService modelContextService;
    private final SessionAttributeRestorer sessionAttributeRestorer;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final ObjectProvider<ExecutionControl> executionControl;

    /** 每个父执行一把锁：串行化并发子执行的回填，保护「读检查点 → 写槽位 → 恢复」的顺序性。 */
    private final Map<Long, Object> parentLocks = new ConcurrentHashMap<>();

    /** 委派回填只关心终态：挂起信号由卡片推送监听器（{@code ExecutionLifecycleAdapter}）处理。 */
    @Override
    public void onExecutionSuspended(String executionId) {
    }

    @Override
    public void onExecutionFinished(String executionId, Execution execution) {
        try {
            BackfillTarget target = matchParentSlot(execution);
            if (target != null) {
                CompletableFuture.runAsync(() -> settle(target));
            }
        } catch (RuntimeException e) {
            log.warn("{} 回填检查失败（不影响执行本身）: executionId={}, error={}",
                    LOG_PREFIX, executionId, e.toString());
        }
    }

    /**
     * 判断刚终结的执行是否有父执行的待回填委派槽位；有则构造回填目标，无则返回 {@code null}。
     * 主执行（无 {@code ROOT_EXECUTION_ID}）、旧格式数据（升级前挂起的子执行，父侧没有
     * DELEGATION 槽位）都在这里自然短路，保持旧行为。包私有仅供测试直调。
     */
    BackfillTarget matchParentSlot(Execution execution) {
        if (execution == null) {
            return null;
        }
        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Long parentExecutionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_EXECUTION_ID);
        if (parentExecutionId == null) {
            return null;
        }
        String subSessionId = String.valueOf(ExecutionIdentity.sessionId(attributes));
        ToolCall slot = toolCallRepository.listPendingByExecutionId(parentExecutionId).stream()
                .filter(call -> converter.kindOf(call.getContent()) == ToolCallKind.DELEGATION)
                .filter(call -> Objects.equals(subSessionId, subSessionIdOf(call)))
                .findFirst()
                .orElse(null);
        return slot == null ? null : new BackfillTarget(slot, parentExecutionId, execution);
    }

    private String subSessionIdOf(ToolCall call) {
        JsonNode node = converter.parse(call.getContent());
        return node == null || !node.hasNonNull(ToolCallKeys.SUB_SESSION_ID)
                ? null : node.get(ToolCallKeys.SUB_SESSION_ID).asText();
    }

    /** 回填落定：槽位写入 + 槽位卡片收口 + 父检查点/上下文落库（单事务），父执行无 pending 后恢复。包私有仅供测试直调。 */
    void settle(BackfillTarget target) {
        synchronized (parentLocks.computeIfAbsent(target.parentExecutionId(), key -> new Object())) {
            try {
                ExecutionRepository repository = executionRepository.getObject();
                Execution parent = repository.findById(String.valueOf(target.parentExecutionId())).orElse(null);
                if (parent == null) {
                    return;
                }
                String resultText = resultRenderer.render(target.subExecution());
                ToolCallOutcome outcome = outcomeOf(target.subExecution());
                String rawOutput = outcome == ToolCallOutcome.CANCELLED
                        ? converter.cancelled("子代理执行已取消")
                        : converter.executeOutcome(outcome, resultText);

                boolean slotWritten = ExecutionToolSlot.write(parent, target.slot().getId(),
                        target.slot().getToolName(), resultText);
                if (!slotWritten) {
                    // 槽位缺失（检查点不一致）也要把卡片收口，让父执行还能被恢复或停止，不悬挂。
                    log.warn("{} 父执行找不到委派槽位，跳过消息回填: toolCallId={}, parentExecutionId={}",
                            LOG_PREFIX, target.slot().getId(), target.parentExecutionId());
                }
                transactions.executeWithoutResult(status -> {
                    toolCallRepository.findById(target.slot().getId()).ifPresent(current -> {
                        if (current.complete(rawOutput)) {
                            toolCallRepository.updateById(current);
                        }
                    });
                    if (slotWritten) {
                        repository.save(parent);
                        modelContextService.replace(parentSessionIdOf(parent), parent.getMessages());
                    }
                });

                resumeIfReady(target.parentExecutionId(), parent);
            } catch (Exception e) {
                log.error("{} 回填失败: toolCallId={}, parentExecutionId={}",
                        LOG_PREFIX, target.slot().getId(), target.parentExecutionId(), e);
            }
        }
    }

    /** 父执行仍有 pending 槽位（其它子执行未落定）或已非挂起态（如随停止被取消）时不恢复。 */
    private void resumeIfReady(long parentExecutionId, Execution parent) {
        boolean parentStillPending = !toolCallRepository.listPendingByExecutionId(parentExecutionId).isEmpty();
        if (parentStillPending) {
            log.debug("{} 父执行还有未落定的委派槽位，暂不恢复: parentExecutionId={}", LOG_PREFIX, parentExecutionId);
            return;
        }
        if (parent.getExecutionState() != ExecutionState.SUSPENDED) {
            log.debug("{} 父执行已非挂起态，跳过恢复: parentExecutionId={}, state={}",
                    LOG_PREFIX, parentExecutionId, parent.getExecutionState());
            return;
        }
        // 恢复不经过 RequestPreparer：先把会话级业务属性（团队绑定）补回请求再交给 loop。
        sessionAttributeRestorer.restore(parent, parentSessionIdOf(parent));
        executionControl.getObject().resume(parent);
    }

    private static ToolCallOutcome outcomeOf(Execution execution) {
        return switch (execution.getExecutionState()) {
            case COMPLETED -> ToolCallOutcome.SUCCEEDED;
            case CANCELLED -> ToolCallOutcome.CANCELLED;
            default -> ToolCallOutcome.FAILED;
        };
    }

    /** 父执行的所属会话：回填的模型上下文按它落库。缺失即数据不完整，抛错走统一失败日志。 */
    private static Long parentSessionIdOf(Execution parent) {
        try {
            return ExecutionIdentity.sessionId(parent.getAgentRequest());
        } catch (RuntimeException e) {
            throw new ClientException("父执行缺少会话标识，不能回填: " + parent.getId());
        }
    }

    /** 一次待落定的回填：父执行上的槽位卡片 + 刚终结的子执行。 */
    record BackfillTarget(ToolCall slot, long parentExecutionId, Execution subExecution) {
    }
}
