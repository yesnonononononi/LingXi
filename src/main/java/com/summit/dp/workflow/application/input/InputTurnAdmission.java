package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 新轮、已投递邮件回执和旧任务回执一起提交，重复检查不能创建第二轮。
 *
 * <h2>事务边界（本条是完成态跨轮的正确性核心）</h2>
 *
 * <p>三件事必须在<b>同一个事务</b>里：创建新执行、把这一批邮件的回执落库、把任务回执写回旧执行。
 * 分开提交会出现「轮次建好了但回执没写」或反过来 —— 前者导致下一轮把同一批邮件再注入一次，
 * 后者导致创建失败时输入被静默吞掉。</p>
 *
 * <p>回执由 {@code LocalExecutionRepository#save} 的 flush 在本次事务内补写，
 * 因此本方法只做「登记已投递」这一内存动作，不自己写库。</p>
 *
 * <h2>顺序不可调换</h2>
 *
 * <p>所有属性/上下文就绪动作必须早于任何一次 {@code save}：检查点一旦落库就是持久事实，
 * 之后补写属性只能靠「下一次保存碰巧发生」来兜底。上一版正是先 {@code save(admitted)}
 * 后搬游标，新执行的检查点里没有游标，于是每轮都把历史邮件重放一遍。</p>
 *
 * <p>幂等由两道判据共同保证：进入时 {@code findByCommandId} 判重（同一批输入只建一轮），
 * 以及回执表本身（同一封邮件只被认领一次）。因此重复调用 {@code admit} 只会返回
 * {@code null}，不会再建一轮。</p>
 */
@Component
@RequiredArgsConstructor
public class InputTurnAdmission {
    private final PreparedChatExecutor executor;
    private final ChatTurnRepository turns;
    private final ObjectProvider<ExecutionRepository> executions;
    private final MailInputChannel mailChannel;
    private final BackgroundTaskChannel taskChannel;

    @Transactional
    public RuntimeContext admit(RuntimeContext context, Execution previous, String commandId,
                                List<EmailMessageVO> mail, List<Task> tasks) {
        if (turns.findByCommandId(commandId).isPresent()) return null;
        RuntimeContext admitted = executor.admit(context, commandId);
        // 属性就绪必须在保存之前：新轮次的自动接续计数要随这份检查点一起落库。
        InputAutomationPolicy.putAttribute(admitted.execution(), InputAutomationPolicy.AUTO_ROUNDS,
                InputAutomationPolicy.autoRounds(previous) + 1);
        // 登记「本批已投递」：回执由保存路径在同一事务里落库，这里不独立提交。
        // 也不再需要「回滚时恢复内存属性」的补偿 —— 权威事实在库里，内存里没有可被半途弄脏的事实。
        mailChannel.markConsumed(previous, mail);
        taskChannel.markConsumed(previous, tasks);
        executions.getObject().save(admitted.execution());
        if (!mail.isEmpty() || !tasks.isEmpty()) {
            // 旧执行的回执清单必须落库：否则下一轮会把同一批再注入一次。
            executions.getObject().save(previous);
        }
        return admitted;
    }
}

