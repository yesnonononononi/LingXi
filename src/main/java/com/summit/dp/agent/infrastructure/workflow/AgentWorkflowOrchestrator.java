package com.summit.dp.agent.infrastructure.workflow;


import com.summit.core.agent.Execution;
import com.summit.dp.agent.application.service.impl.RuntimeContext;

/**
 * 执行编排器：创建与执行两个入口，都只接收已 prepare 的 {@link RuntimeContext}。
 *
 * <p><b>为什么把创建与执行拆开</b>：受理事务必须在提交轮次与用户消息的同一事务里创建执行行 ——
 * 否则失败时业务手里没有可收口的执行对象，只能靠一条条件 UPDATE 打补丁。
 * 而创建执行要先解析人设与工具清单，那份解析只在编排器里，所以拆成两步：
 * 受理阶段 {@code createExecution}（只登记不运行），执行阶段 {@code execute}（只分发不查询）。</p>
 */
public interface AgentWorkflowOrchestrator {

    /** 受理阶段：解析人设与工具清单 → 构造 AgentRequest → 交框架创建并保存执行（不运行）。 */
    Execution createExecution(RuntimeContext context);

    /** 执行阶段：把已登记的执行交给对应执行器运行。 */
    Execution execute(RuntimeContext context, Execution execution);
}
