package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.ExecutionToolSlot;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.sub_agent.result.SubAgentResultRenderer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 委派结果回填的<b>落定</b>：把子执行结果写回父执行的委派槽位、收口卡片、落父检查点与
 * 模型上下文；门闩释放后再按未决情况恢复父执行。
 *
 * <p><b>为什么独立成类</b>：{@link DelegationBackfillListener} 的职责是「匹配到该被填的
 * 槽位 → 异步委派出去」，落定细节（终态父执行、槽位缺失兜底、检查点写入）不该挤在
 * 监听器里。拆开后监听器只剩匹配与调度，事务边界集中在一处。</p>
 *
 * <p><b>锁序不变量</b>：{@code ExecutionCoordination} 门闩只护住落库段；模型上下文替换与
 * resume 都必须在门闩之外，否则与审批路径的锁序倒置。模型运行更不能持有决策门闩。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DelegationSettleService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final SubAgentResultRenderer resultRenderer;
    private final ModelContextService modelContextService;
    private final TransactionTemplate transactions;
    private final ExecutionResumeCoordinator resumeCoordinator;

    /** 回填落定：槽位写入 + 槽位卡片收口 + 父检查点/上下文落库（单事务），父执行无 pending 后恢复。 */
    public void settle(DelegationBackfillListener.BackfillTarget target, ExecutionRepository repository) {
        synchronized (ExecutionCoordination.monitor(String.valueOf(target.parentExecutionId()))) {
            try {
                if (!settleInsideLatch(target, repository)) {
                    return;
                }
            } catch (Exception e) {
                log.error("委派回填失败: toolCallId={}, parentExecutionId={}",
                        target.slot().getId(), target.parentExecutionId(), e);
                return;
            }
        }
        // 模型运行不能持有决策门闩；登记槽位仍由框架保证单飞。
        // 恢复意图交给统一协调器派发：它先落库再派发，崩溃窗口由巡检兜住。
        // 这里刻意不再本地直接 resume —— 本地直接跑就没有「决策已落库但恢复没派发」的恢复点。
        ResumeDisposition disposition = resumeCoordinator.accept(target.parentExecutionId());
        log.info("委派回填已受理父执行恢复: parentExecutionId={}, disposition={}",
                target.parentExecutionId(), disposition);
    }

    /**
     * 门闩内的落库段。
     *
     * @return 是否应继续走门闩外的恢复判定（父执行缺失、未就绪、已终态都返回 {@code false}）
     */
    private boolean settleInsideLatch(DelegationBackfillListener.BackfillTarget target,
                                      ExecutionRepository repository) {
        Execution parent = repository.findById(String.valueOf(target.parentExecutionId())).orElse(null);
        if (parent == null) {
            return false;
        }
        ToolCall current = toolCallRepository.findById(target.slot().getId()).orElseThrow(ClientException::new);
        if (!current.isUnresolved()) {
            return false;
        }
        if (ExecutionStatusCodes.isTerminalState(parent.getExecutionState())) {
            transactions.executeWithoutResult(status -> {
                current.complete(converter.cancelled("父执行已结束"));
                toolCallRepository.updateById(current);
            });
            return false;
        }
        // 父检查点尚未提交槽位时不能写回；退出通知会按明确的子执行身份再次校准。
        if (parent.getExecutionState() != ExecutionState.SUSPENDED) {
            return false;
        }
        String resultText = resultRenderer.render(target.subExecution());
        ToolCallOutcome outcome = resolveOutcome(target.subExecution());
        String rawOutput = outcome == ToolCallOutcome.CANCELLED
                ? converter.cancelled("子代理执行已取消")
                : converter.executeOutcome(outcome, resultText);

        boolean slotWritten = ExecutionToolSlot.write(parent, target.slot().getId(),
                target.slot().getToolName(), resultText);
        if (!slotWritten) {
            // 槽位缺失（检查点不一致）也要把卡片收口，让父执行还能被恢复或停止，不悬挂。
            log.warn("委派槽位缺失: toolCallId={}, parentExecutionId={}",
                    target.slot().getId(), target.parentExecutionId());
        }
        final boolean written = slotWritten;
        transactions.executeWithoutResult(status -> {
            if (current.complete(rawOutput)) toolCallRepository.updateById(current);
            if (written) {
                repository.save(parent);
                modelContextService.replace(resolveParentSessionId(parent), parent.getMessages());
            }
        });
        return true;
    }

    private static ToolCallOutcome resolveOutcome(Execution execution) {
        return switch (execution.getExecutionState()) {
            case COMPLETED -> ToolCallOutcome.SUCCEEDED;
            case CANCELLED -> ToolCallOutcome.CANCELLED;
            default -> ToolCallOutcome.FAILED;
        };
    }

    /** 父执行的所属会话：回填的模型上下文按它落库。缺失即数据不完整，抛错走统一失败日志。 */
    private static Long resolveParentSessionId(Execution parent) {
        try {
            return ExecutionIdentity.sessionId(parent.getAgentRequest());
        } catch (RuntimeException e) {
            throw new ClientException("父执行缺少会话标识，不能回填: " + parent.getId());
        }
    }
}
