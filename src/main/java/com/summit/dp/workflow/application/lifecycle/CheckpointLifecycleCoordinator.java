package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.dp.workflow.application.input.MailReceiptFlusher;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Objects;

/**
 * 检查点提交的业务承接：邮件回执（事务内）+ 运行登记与终态收口（提交后）。
 *
 * <p>从 {@code LocalExecutionRepository} 挪出来的三件事，顺序与时机一字未改：</p>
 * <ol>
 *   <li><b>事务内</b>：回执 flush。必须与检查点同批提交 —— 回执若在注入时就独立落库，
 *       「已注入、检查点未提交」崩一次就会因回执已存在而永久丢掉这条输入。</li>
 *   <li><b>提交后</b>：{@code recordExecution}（根会话登记本次执行）。</li>
 *   <li><b>提交后</b>：终态收口脚本。必须早于框架发布终态事件，否则界面会先收到终态、
 *       后收到轮次更新 —— 框架的顺序是「save → 返回发布任务 → 调用方 run 它」，业务侧没有排序权。</li>
 * </ol>
 */
@Component
public class CheckpointLifecycleCoordinator implements CheckpointCommitParticipant {

    private final MailReceiptFlusher mailReceipts;
    private final SessionExecutionRegistry executionRegistry;
    /** 投影延迟取用：投影依赖执行仓储，而本类被执行仓储调用，直接注入会成环。 */
    private final ObjectProvider<ExecutionLifecycleProjection> lifecycle;

    /**
     * 构造注入：回执协作方是必需依赖。
     *
     * <p>缺了必须装配失败 —— 否则会退化成「保存成功但输入丢/重放」，
     * 而不是一个能被启动日志发现的问题。</p>
     *
     * @param mailReceipts       邮件回执协作方，不能为空
     * @param executionRegistry  会话执行登记
     * @param lifecycle          业务投影（延迟取用，断开构造期环）
     */
    public CheckpointLifecycleCoordinator(MailReceiptFlusher mailReceipts,
                                          SessionExecutionRegistry executionRegistry,
                                          ObjectProvider<ExecutionLifecycleProjection> lifecycle) {
        this.mailReceipts = Objects.requireNonNull(mailReceipts,
                "邮件回执协作方不能为空：回执必须与检查点同事务落库");
        this.executionRegistry = executionRegistry;
        this.lifecycle = lifecycle;
    }

    @Override
    public void inTransaction(Execution execution) {
        mailReceipts.flush(execution);
    }

    @Override
    public void afterCommit(Execution execution, ExecutionSaveFacts facts) {
        // 顺序就是原仓储里的登记顺序：先登记，再收口。
        executionRegistry.recordExecution(facts.rootSessionId(), facts.sessionId(),
                String.valueOf(facts.executionId()), facts.terminal());
        if (facts.closureDue()) {
            lifecycle.getObject().completeClosure(execution, false);
        }
    }
}
