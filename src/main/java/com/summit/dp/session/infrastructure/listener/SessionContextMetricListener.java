package com.summit.dp.session.infrastructure.listener;

import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.domain.model.Session;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Objects;

/**
 * 会话上下文用量回写：订阅执行生命周期端口，把框架 loop 结束填充的
 * {@code Execution.contextUsageMetric} 落到 {@code session} 表。
 *
 * <p><b>解决什么问题</b>：前端的「上下文用量」指示器实时口径来自 {@code CONTEXT_UPDATE} 事件，
 * 但事件只在 loop 运行期间发布——**加载历史会话（刷新页面 / 切换会话）时没有任何 loop 在跑，
 * 永远等不到事件**。本监听器在每次执行终结时把当时的用量快照落库，
 * 随 {@code /session/tree} 接口下发，指示器在无事件的空窗里也有权威数据可渲染。</p>
 *
 * <p><b>为什么挂这个端口而不是终态事件</b>：框架在 loop 的 finally 里
 * {@code fillContextUsage} → {@code clear()} 落快照 → {@code unregister} 时广播本端口 ——
 * 到达这里时 {@link Execution} 对象连同 metric 已在内存中（广播点刚 {@code findById} 读回），
 * 不必再反序列化一次 LONGTEXT snapshot。「取消挂起中的执行」路径不经 loop，metric 为 null，
 * 本监听器按降级跳过：不猜、不写 0，保留上一次已知值。</p>
 *
 * <p><b>不自行兜异常</b>：广播方 {@code LocalExecutionRepository} 已逐监听器捕获并继续，
 * 这里再包一层只是重复隔离。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SessionContextMetricListener implements ExecutionLifecycleListener {

    private static final String LOG_PREFIX = "【session-context】";

    private final SessionAggregateService sessionAggregateService;

    @Override
    public void onExecutionSuspended(String executionId, Execution execution) {
        // 挂起不是终态：用量快照以终结时的为准（挂起期间的实时口径由 CONTEXT_UPDATE 事件承担）。
    }

    @Override
    public void onExecutionFinished(String executionId, Execution execution) {
        ContextUsageMetric metric = execution == null ? null : execution.getContextUsageMetric();
        if (metric == null) {
            // 取消挂起中的执行等不经 loop 的路径：没有采集，降级跳过。
            return;
        }
        Long sessionId = resolveSessionId(execution);
        if (sessionId == null) {
            log.warn("{} 终结执行缺少会话归属，用量快照丢弃: executionId={}", LOG_PREFIX, executionId);
            return;
        }
        Session session = sessionAggregateService.requireOwned(sessionId);
        session.changeContextUsage((long) metric.tokenCount(), metric.maxTokens(), metric.ratio());
        sessionAggregateService.save(session);
    }

    /** 执行归属的会话 id：业务身份在请求属性里（与执行建行时同一来源）。 */
    private static Long resolveSessionId(Execution execution) {
        Map<String, Object> attributes = execution.getAgentRequest() == null
                ? Map.of()
                : execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        // 防御：属性缺失时不可能有正确归属，宁可不写也不能写错会话。
        return Objects.requireNonNullElse(sessionId, null);
    }
}
