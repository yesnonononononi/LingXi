package com.summit.dp.execution;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * 挂起执行的恢复闸门与恢复动作；人工决策、命令审批、委派回填三条路径共用。
 *
 * <p><b>为什么单独成类</b>：恢复的前置条件（无未决槽位 + 停在挂起点）与恢复动作
 * （补会话属性 → resume → 回写模型上下文）在三条路径里逐行相同，合成一处后
 * 「恢复口径」只有一个定义点，改闸门条件不会再漏掉某条路径。</p>
 *
 * <p><b>恢复不经过 RequestPreparer</b>，所以会话级业务属性（团队绑定）必须由
 * {@link SessionAttributeRestorer} 补回，否则恢复后的委派工具解析不到团队、
 * 子 Agent 起不来。补回的属性随恢复过程的检查点落库，快照因此自愈。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SuspendedExecutionResumer {

    private final ToolCallRepository toolCallRepository;
    private final SessionAttributeRestorer sessionAttributeRestorer;
    private final ModelContextService modelContextService;
    private final ObjectProvider<ExecutionControl> executionControl;

    /**
     * 该执行是否还有未落定的槽位。
     *
     * <p>准备中、执行中、委派等待都算未决 —— 只看 {@code pending} 会漏掉它们，
     * 在这些状态下恢复会让 loop 拿到一个还没写回结论的槽位。</p>
     */
    public boolean hasUnresolvedSlot(Long executionIdNumber) {
        return !toolCallRepository.listUnresolvedByExecutionId(executionIdNumber).isEmpty();
    }

    /** 执行是否停在可接受决策的挂起点。 */
    public boolean isSuspended(Execution execution) {
        return execution != null && execution.getExecutionState() == ExecutionState.SUSPENDED;
    }

    /**
     * 恢复并回写模型上下文。
     *
     * <p>三条恢复路径统一走这里、都回写上下文：恢复已改为异步派发，worker 真正跑 loop
     * 时读到的消息集合可能比「落定事务里写过的那一份」更新（含恢复后新追加的消息），
     * 不整体替换会让模型上下文停在恢复前的旧状态。重复写同一份内容是幂等的，
     * 代价远小于上下文停在旧状态。</p>
     *
     * <p><b>本方法抛出的异常不都是「启动失败」，判责在调用方</b>：这里既可能在 loop 起步前
     * 抛（补会话属性失败、框架 register/save 失败），也可能是 loop 已经跑完、仅在回写上下文
     * 时抛。两者处置相反，只能由调用方重读落库状态与控制槽位来区分 —— 见
     * {@code ExecutionResumeCoordinator#handleStartupFailure}。不要在这里「简化」成
     * 一律按失败处理。</p>
     */
    public void resume(Execution execution, Long conversationId) {
        sessionAttributeRestorer.restore(execution, conversationId);
        Execution resumed = executionControl.getObject().resume(execution);
        modelContextService.replace(conversationId, resumed.getMessages());
    }
}
