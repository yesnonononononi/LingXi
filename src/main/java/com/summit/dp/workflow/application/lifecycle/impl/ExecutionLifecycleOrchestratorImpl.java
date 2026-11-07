package com.summit.dp.workflow.application.lifecycle.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleOrchestrator;
import com.summit.dp.workflow.application.lifecycle.GateCheckResult;
import com.summit.dp.workflow.application.lifecycle.ResumeAcceptResult;
import com.summit.dp.workflow.application.lifecycle.ResumeRequest;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * 生命周期编排实现：暂停、恢复两个动作的唯一落点。
 *
 * <p><b>启动失败收口不在这里</b>：那由 {@code StartupFailureCloser} 按角色提供，各启动点直接用。
 *
 * <p><b>手动恢复保持同步</b>：入口要在同一个请求线程里拿到「被拒的原因」或「恢复后的消息」。
 * 其余触发入队后置派发，为的是「决策事务已提交、派发还没发生就崩了」这段窗口不丢恢复。</p>
 *
 * <p><b>锁纪律</b>：状态读写在执行门闩内，模型调用一律在锁外；会话门闩只圈住
 * 「恢复 + 上下文回写」这一整段，因为上下文回写属于旧轮收尾，迟到输入必须等它提交。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ExecutionLifecycleOrchestratorImpl implements ExecutionLifecycleOrchestrator {

    private final ExecutionRepository executionRepository;
    private final ExecutionControl executionControl;
    private final ExecutionLocator executionLocator;
    private final SuspensionGateChain gates;
    private final SuspendedExecutionResumer resumer;
    private final ExecutionResumeCoordinator resumeCoordinator;

    /**
     * 暂停会话下仍在生命周期内的执行。
     *
     * <p>查询与发信号之间执行可能已结束，{@code IllegalStateException} 是正常竞争，
     * 不能报成服务器故障。会话标识由调用方校验，这里只认已解析好的正数。</p>
     */
    @Override
    public void pauseSessionExecution(String sessionId) {
        for (String executionId : executionLocator.activeExecutionIds(Long.parseLong(sessionId))) {
            try {
                executionControl.suspend(executionId);
            } catch (IllegalStateException error) {
                log.debug("暂停时执行已退出: executionId={}", executionId);
            }
        }
    }

    @Override
    public ResumeAcceptResult requestResume(ResumeRequest request) {
        if (request.triggerType() == ResumeTriggerType.MANUAL_USER_RESUME) {
            return resumeSynchronously(request);
        }
        return queueResume(request);
    }

    /**
     * 手动恢复：同步预检 → 清挂起痕迹并提交 → 交回 loop → 回写上下文。
     *
     * <p><b>顺序不可交换</b>：清标记后的 {@code save} 必须早于 {@code resume} ——
     * 框架的控制槽位登记见到 {@code USER_PAUSED} 会直接拒绝，标记不先提交，登记就不放行。</p>
     */
    private ResumeAcceptResult resumeSynchronously(ResumeRequest request) {
        long executionId = numericId(request.executionId());
        synchronized (ExecutionCoordination.monitor("session:" + request.sessionId())) {
            Execution execution;
            synchronized (ExecutionCoordination.monitor(String.valueOf(executionId))) {
                execution = executionRepository.findById(request.executionId()).orElse(null);
                if (execution == null) {
                    return ResumeAcceptResult.blocked("该会话没有可恢复的执行");
                }
                GateCheckResult readiness = gates.checkReadiness(execution, request.triggerType());
                if (!readiness.allowed()) {
                    return ResumeAcceptResult.blocked(readiness.reason());
                }
                if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
                    return ResumeAcceptResult.blocked("执行不可以恢复");
                }
                gates.clearSuspensionState(execution, request.triggerType());
                executionRepository.save(execution);
            }
            // 补会话属性 → resume → 回写模型上下文都在 resumer 内，模型调用不在执行门闩里。
            resumer.resume(execution, request.sessionId());
            return ResumeAcceptResult.resumed(execution);
        }
    }

    /**
     * 其余触发：先落恢复请求，再在事务提交后派发。
     *
     * <p>队列消费端会用同一套门禁在锁内复检一次 —— 这里的判定只是「要不要入队」，
     * 不是「能不能恢复」的最终结论。</p>
     */
    private ResumeAcceptResult queueResume(ResumeRequest request) {
        ResumeDisposition disposition = resumeCoordinator.accept(numericId(request.executionId()));
        return switch (disposition) {
            case QUEUED -> ResumeAcceptResult.queued();
            case RUNNING -> ResumeAcceptResult.running();
            case ENDED -> ResumeAcceptResult.ended();
            case WAITING_OTHER_TOOLS -> ResumeAcceptResult.waitingUnresolved();
            case FAILED -> ResumeAcceptResult.blocked("恢复派发失败");
        };
    }

    private long numericId(String executionId) {
        try {
            return Long.parseLong(executionId);
        } catch (NumberFormatException error) {
            throw new IllegalStateException("执行 ID 必须是数字: executionId=" + executionId, error);
        }
    }
}
