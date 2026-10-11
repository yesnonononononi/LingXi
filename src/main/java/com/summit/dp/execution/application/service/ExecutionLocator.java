package com.summit.dp.execution.application.service;

import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * 执行归属定位：执行标识 → 所属会话 → 根会话，以及会话下的活跃 / 可恢复执行。
 *
 * <p>与 {@link ExecutionQueryService} 分工：后者是**展示投影读**（状态摘要、检查点），
 * 产出的是给人看的视图；本类只回答「这次执行归谁」，产出路由键。</p>
 *
 * <p>读路径一律走领域仓储，不接触 {@code ExecutionMapper} / {@code ExecutionPO}。</p>
 */
@Service
@RequiredArgsConstructor
public class ExecutionLocator {

    private final ExecutionRepository executionRepository;
    private final SessionRepository sessionRepository;

    /** 执行标识 → 所属会话；执行行不存在或未写会话时抛错，调用方无从继续。 */
    public long sessionId(String executionId) {
        return executionRepository.findSessionId(numeric(executionId))
                .orElseThrow(() -> new IllegalStateException("执行不存在: executionId=" + executionId));
    }

    /** 执行标识 → 所属根会话。 */
    public long rootSessionId(String executionId) {
        return resolveRootSessionId(sessionId(executionId));
    }

    /** 会话 → 根会话；子会话回指自己的根，根会话返回自身。 */
    public long resolveRootSessionId(long sessionId) {
        Session session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new IllegalStateException("会话不存在: sessionId=" + sessionId));
        return session.isSubSession() ? session.getRootSessionId() : sessionId;
    }

    /**
     * 同 {@link #resolveRootSessionId(long)}，但会话查不到返回 {@code null} 而不抛异常。
     *
     * <p><b>两种失败语义并存是有意的</b>：用户显式点名的入口（订阅自己的会话）查不到就是业务失败，
     * 必须报错；而投影与自动恢复这类**旁路**动作查不到只说明实体尚未落库或已被清理，静默跳过即可，
     * 抛异常会把「开始一次模型调用」变成 500。</p>
     */
    public Long resolveRootSessionIdOrNull(Long sessionId) {
        if (sessionId == null) {
            return null;
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        if (session == null) {
            return null;
        }
        return session.isSubSession() ? session.getRootSessionId() : session.getId();
    }

    /**
     * 会话下最近一次被暂停的执行标识；没有挂起执行返回 {@code null}。
     *
     * <p>「无可恢复的执行」是正常业务状态（用户对空闲会话点了恢复），不是系统错误 ——
     * 返回 null 交由调用方决定呈现方式，不在这里抛异常把业务失败顶成 500。</p>
     */
    public String latestSuspendedExecutionId(long sessionId) {
        return executionRepository.findLatestSuspendedId(sessionId)
                .map(String::valueOf)
                .orElse(null);
    }

    /** 会话下仍在生命周期内（创建 / 运行 / 暂停）的执行标识，用于取消与中断。 */
    public List<String> activeExecutionIds(long sessionId) {
        return executionRepository.findUnfinishedBySessions(List.of(sessionId)).stream()
                .map(Execution::getId)
                .map(String::valueOf)
                .toList();
    }

    private static long numeric(String executionId) {
        try {
            return Long.parseLong(executionId);
        } catch (NumberFormatException e) {
            throw new IllegalStateException("执行 ID 必须是数字: executionId=" + executionId, e);
        }
    }
}
