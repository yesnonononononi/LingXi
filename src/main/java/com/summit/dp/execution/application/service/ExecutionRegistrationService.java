package com.summit.dp.execution.application.service;

/**
 * 写侧入口：登记一条「初始执行」记录。
 *
 * <p><b>为什么需要它：</b>用户消息在 {@code RequestPreparer} 阶段就落库，而框架要到 loop 启动
 * 才第一次保存执行检查点。若中间不登记执行行，就会出现「历史里有一条 USER 消息，
 * 却查不到它属于哪次执行」——用户看到的是一句永远没有回复、也没有任何状态的提问。</p>
 *
 * <p><b>与框架保存逻辑的关系（已核对，非假设）：</b>框架
 * {@code LocalExecutionRepository#save} 只在「状态为 CREATED 且行不存在」时走 insert，
 * 其余一律走条件 update。因此这里先插入 CREATED 行后，框架的首次保存会自然落到 update 分支，
 * <b>不破坏原有的 CREATED 保存语义，也不需要第二套执行注册机制</b>。</p>
 *
 * <p><b>失败收尾：</b>若执行在启动前就失败，行会停在 CREATED；启动收尸钩子
 * （{@code ExecutionMapper#markOrphanRunsFailed}）会在下次启动时把它收口成 FAILED 终态，
 * 不会永久悬空。</p>
 */
public interface ExecutionRegistrationService {

    /**
     * 登记初始执行：状态 CREATED，含会话归属、模型快照与根执行归属。
     *
     * <p>与用户消息在同一个短事务内提交（由调用方保证），使「提问」与「执行」从第一刻起
     * 就共享同一个 {@code executionId}。**不得**在事务内发起模型调用。</p>
     */
    void registerInitial(InitialExecution initial);

    /**
     * 收口「已登记但没能真正开始」的执行：条件更新为失败终态并写结束时间。
     *
     * <p>用在启动失败路径 —— 编排器在框架 loop 起来之前就抛异常（Agent 解析不到、模型配置缺失等），
     * 此时执行行还停在 CREATED，若不收口，历史里会留下一条永远「创建中」、既没有回复也没有失败
     * 提示的记录。</p>
     *
     * <p><b>幂等且安全</b>：只命中 CREATED / RUNNING。已经自己走到 COMPLETED 的执行不会被改写；
     * SUSPENDED 也不在条件内 —— 挂起是可恢复状态，误标失败会让「待恢复」入口消失。
     * 执行行不存在时静默无操作（登记本身就失败了，没有可收口的东西）。</p>
     *
     * @param executionId 执行 id
     * @return 是否真的收口了一行
     */
    boolean markStartupFailed(long executionId);

    /**
     * 初始执行的登记参数。
     *
     * @param executionId     执行 ID（雪花，即用户消息的 {@code execution_id}）
     * @param sessionId       所属会话
     * @param rootExecutionId 所属根执行；主执行为 {@code null}
     * @param modelName       实际解析出的模型名称快照，可为 {@code null}
     * @param modelProvider   模型提供方快照，可为 {@code null}
     */
    record InitialExecution(long executionId, long sessionId, Long rootExecutionId,
                            String modelName, String modelProvider) {
    }
}
