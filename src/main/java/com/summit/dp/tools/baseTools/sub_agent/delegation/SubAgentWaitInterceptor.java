package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 根代理收尾前的驻留判定：委派之后、本轮模型没有工具调用（即「准备结束」）时，只要仍有
 * <b>未处理协作输入</b>（邮件）或<b>未结束子执行</b>，就把执行保留在非终态，而不是迁入终态。
 *
 * <p><b>为什么必须驻留而不是正常收尾</b>：终态执行无法再被 {@code resume}（框架硬校验只放行
 * {@code SUSPENDED}），而子代理的交付邮件只在「本执行存在一个正在跑的 loop」时、于每轮模型调用前
 * 被消费。根一旦 {@code COMPLETED}，子代理的邮件就投进一个再也不会被查询的邮箱，永久停在
 * {@code PENDING} —— 这正是修复前观察到的现象。收尾判定「有未处理邮件」因此与「有未结束子执行」
 * 同等重要，二者任一非空即驻留。</p>
 *
 * <p><b>判定用只读、消费在别处</b>：这里只调 {@link EmailService#hasPending}（不消费），
 * 消费只发生在 {@code AgenticLoopInterceptor.onBeforeModelInvoke}。合并两者会让邮件在还没进入模型
 * 上下文前就被判定掉。</p>
 *
 * <p><b>挂起的是检查点，不是线程</b>：框架不保留挂起线程。这里依赖框架 {@code onBeforeComplete}
 * 的时序 —— 它只在本轮响应无工具调用、且该轮的事件 / 消息 / token 记账 / transcript / 执行检查点
 * 都已落定之后、自然完成之前被调用，执行此时仍是 {@code RUNNING}；返回 suspension 会保留该轮。
 * 恢复后是全新一轮模型请求，其 {@code onBeforeModelInvoke} 会把期间到达的邮件注入上下文。</p>
 *
 * <p><b>唤醒侧</b>：输入驱动挂起时登记保留唤醒（控制槽位释放后立即自我唤醒）；有子执行时改由
 * 「最后一个子执行终结」的结束事实唤醒。两个来源都经 {@link ExecutionResumeCoordinator}。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SubAgentWaitInterceptor implements LoopInterceptor {

    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final EmailService emailService;
    private final ExecutionResumeCoordinator resumeCoordinator;

    /** 排在取信钩子（-800）之后：驻留与注信分处两个阶段，先后不影响语义，只求顺序稳定。 */
    @Override
    public int order() {
        return -700;
    }

    /**
     * 等待判定失败必须让整轮失败，绝不放行收尾。
     *
     * <p>放行收尾 = 根在子执行未结束 / 邮件未处理时提前 {@code COMPLETED}；终态执行无法再
     * {@code resume}，子代理结果与邮件将永久丢失。这属于「会改变业务语义的动作」，按项目约定显式
     * {@code catchErr()} 返回 {@code false}，异常上抛、该轮失败。</p>
     */
    @Override
    public boolean catchErr() {
        return false;
    }

    @Override
    public InterceptorResult onBeforeComplete(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();

        // 1, 只对根执行生效：子执行收尾就是它自己的结束，它不负责等待更下层。这不是失败，直接放行。
        if (ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_EXECUTION_ID) != null) {
            return InterceptorResult.NONE;
        }

        // 2, 解不出会话归属即数据不一致：上抛为失败（catchErr=false），不做降级放行。
        long rootSessionId = ExecutionIdentity.sessionId(execution);

        // 3, 双判据：未处理协作输入（只读） || 未结束子执行。
        Long rootAgentId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID);
        boolean hasInput = rootAgentId != null && emailService.hasPending(rootSessionId, rootAgentId);
        boolean hasChildren = sessionExecutionRegistry.hasUnfinishedChildren(rootSessionId);

        if (!hasInput && !hasChildren) {
            return InterceptorResult.NONE;
        }

        // 4, 有未处理输入：驻留并登记保留唤醒 —— 控制槽位释放后立即自我唤醒，恢复后的新一轮由
        //    AgenticLoopInterceptor 消费邮件。此类挂起依赖自我唤醒，不依赖外部事件。
        if (hasInput) {
            Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
            if (executionId != null) {
                resumeCoordinator.accept(executionId);
            }
            log.info("根执行 {} 收尾前检测到未处理协作输入，驻留并登记唤醒: rootSessionId={}",
                    execution.getId(), rootSessionId);
            return InterceptorResult.of(LoopResult.suspended("pending collaboration input"));
        }

        // 5, 仅剩未结束子执行：驻留等待「最后一个子执行终结」的结束事实唤醒（不自我唤醒）。
        log.info("根执行 {} 收尾前检测到未结束子执行，驻留等待: rootSessionId={}",
                execution.getId(), rootSessionId);
        return InterceptorResult.of(LoopResult.suspended("waiting for sub-agent results"));
    }
}
