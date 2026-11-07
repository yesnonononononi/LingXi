package com.summit.dp.session.application.port;

import com.summit.dp.shared.vo.SessionTokenAuditVO;

/**
 * 审计快照的实时推送端口（依赖倒置：业务侧只认这个接口，不认具体传输实现）。
 *
 * <p><b>为什么需要它</b>：SSE 推送实现 {@code com.summit.dp.workflow.infrastructure.stream.SseEventPublisher}
 * 位于工作流模块，而 {@code WorkflowDependencyTest#businessModulesMustNotDependOnWorkflow} 明确禁止
 * 业务模块（{@code com.summit.dp.session}）反向依赖工作流。业务侧要「采集完推一帧」，却不能不认工作流，
 * 因此把动作抽象成本接口，由工作流侧提供实现（与 {@code TurnViewBroadcaster} 同思路：
 * 业务提供纯装配能力，工作流负责投递）。</p>
 *
 * <p><b>没有实现也能跑</b>：{@code SessionTokenAuditCollector} 通过 {@code ObjectProvider} 软依赖本接口，
 * 容器里没有实现时跳过推送、只记一条 debug —— 落库早已完成，前端下次 GET 仍能拿到同一份数据。
 * 因此本接口缺失只影响「实时性」，不影响「正确性」。</p>
 */
public interface TokenAuditBroadcaster {

    /**
     * SSE 业务事件名（设计 §5.1）：payload 与 {@code GET /session/{id}/token-audit} 的 {@code data} 同构。
     *
     * <p>事件名属于「传输契约」，因此和工作流侧的推送实现放在一起，而不是留在业务服务里 ——
     * 业务侧只负责「算出来、存下去、喊一声」，喊什么都由实现方定义。</p>
     */
    String EVENT_NAME = "token_audit_snapshot";

    /**
     * 推送一帧最新审计快照。
     *
     * <p><b>调用约束</b>：必须在快照<b>落库提交之后</b>调用，且不可抛异常（实现方自行吞掉并记日志）：
     * 推送是旁路观测动作，失败不该把一次模型调用或一次采集结果顶成错误。</p>
     *
     * @param rootSessionId 推送路由用的根会话（子会话的审计帧也推给订阅根会话的流）；为 {@code null} 时实现方应跳过
     * @param payload       与 {@code GET /session/{id}/token-audit} 的 {@code data} 同构的快照视图
     */
    void publishSnapshot(Long rootSessionId, SessionTokenAuditVO payload);
}