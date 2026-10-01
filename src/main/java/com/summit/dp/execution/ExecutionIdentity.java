package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/** Resolves the stable conversation identity independently from a single run. */
@Component
@RequiredArgsConstructor
public class ExecutionIdentity {

    /** execution.status 取值，与框架 ExecutionState 的序号一一对应。 */
    private static final int STATUS_CREATED = 0;
    private static final int STATUS_RUNNING = 1;
    private static final int STATUS_SUSPENDED = 2;

    private final ExecutionMapper executionMapper;
    private final SessionRepository sessionRepository;



    /**
     * 解析执行标识所属会话。
     *
     * <p>直接回查 execution 表：execution 主键即请求标识，session_id 在创建时写入，
     * 一次主键查询即可确定归属。</p>
     */
    public long sessionId(String executionId) {
        ExecutionPO po = executionMapper.selectById(numeric(executionId));
        if (po == null || po.getSessionId() == null) {
            throw new IllegalStateException("Unknown execution: " + executionId);
        }
        return po.getSessionId();
    }

    /**
     * 解析执行标识所属的根会话：先回查 execution 表拿会话，再解析该会话的根
     * （{@code root_session_id == 0} 表示自身即根）。供 T06 的 SSE 根会话路由使用。
     */
    public long rootSessionId(String executionId) {
        return rootSessionIdOfSession(sessionId(executionId));
    }

    /** 解析会话的根会话 id，无需执行标识（子会话回指根，根会话返回自身）。 */
    public long rootSessionIdOfSession(long sessionId) {
        Session session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new IllegalStateException("Unknown session: " + sessionId));
        return session.isSubSession() ? session.getRootSessionId() : sessionId;
    }

    /**
     * 会话下最近一次被暂停的执行标识，用于恢复入口；没有挂起执行返回 {@code null}。
     *
     * <p>「无可恢复的执行」是正常业务状态（用户对空闲会话点了恢复），不是系统错误 ——
     * 返回 null 交由调用方决定呈现方式，不在这里抛异常把业务失败顶成 500。</p>
     */
    public String latestSuspendedExecutionId(long sessionId) {
        List<ExecutionPO> list = executionMapper.selectList(Wrappers.<ExecutionPO>lambdaQuery()
                .eq(ExecutionPO::getSessionId, sessionId)
                .eq(ExecutionPO::getStatus, STATUS_SUSPENDED)
                .orderByDesc(ExecutionPO::getId)
                .last("LIMIT 1"));
        return list.isEmpty() ? null : String.valueOf(list.getFirst().getId());
    }

    /** 会话下仍在生命周期内（创建/运行/暂停）的执行标识，用于取消与中断。 */
    public List<String> activeExecutionIds(long sessionId) {
        List<ExecutionPO> list = executionMapper.selectList(Wrappers.<ExecutionPO>lambdaQuery()
                .eq(ExecutionPO::getSessionId, sessionId)
                .in(ExecutionPO::getStatus, STATUS_CREATED, STATUS_RUNNING, STATUS_SUSPENDED));
        return list.stream().map(po -> String.valueOf(po.getId())).toList();
    }

    private static Long numeric(String executionId) {
        try {
            return Long.parseLong(executionId);
        } catch (NumberFormatException e) {
            throw new IllegalStateException("Execution ID must be numeric: " + executionId, e);
        }
    }

    /**
     * 执行标识 → 数值主键；无法解析（框架在 executionId 缺省时回落 UUID）返回 {@code null}。
     *
     * <p>与 {@link #numeric(String)} 的差别是失败语义：这里把「不是数字」当成「归属未知」，
     * 用于**观测落库**这类不得拖垮主链路的场景 —— 拿不到归属就写 NULL，绝不抛异常。</p>
     */
    public static Long numericOrNull(String executionId) {
        if (executionId == null || executionId.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(executionId.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public static long sessionId(Execution execution) {
        return sessionId(execution.getAgentRequest());
    }

    public static long sessionId(AgentRequest request) {
        return sessionId(request.runtimeParametersOrDefault().getAttributes());
    }

    public static long sessionId(ToolExecution tool) {
        return sessionId(tool.getAttributes());
    }

    public static long sessionId(Map<String, Object> attributes) {
        Object value = attributes == null ? null : attributes.get(ExecutionAttributes.SESSION_ID);
        if (value == null) throw new IllegalArgumentException("Missing session ID in execution attributes");
        return Long.parseLong(value.toString());
    }
}
