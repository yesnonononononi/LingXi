package com.summit.dp.workflow.infrastructure.tools.sub_agent.communication;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.application.input.InputInjectionStage;
import com.summit.dp.workflow.application.input.MailInputChannel;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 每次模型调用前，把「本执行所属 Agent 在本次协作轮次里的邮箱」中的待处理消息注入上下文。<br/>
 * NOTICE: The email sent by the sender agent will be injected into the target context as a {@link
 * com.summit.core.conversation.message.UserMessageEntity}
 *
 * <p>本类只声明框架契约（顺序、失败语义），查询/格式化/消费全在 {@link MailInputChannel}，
 * 与终态跨轮次续跑共用同一份文本与同一份消费判据。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class EmailLoopInterceptor implements LoopInterceptor {

    private final MailInputChannel channel;

    /**
     * 邮箱注入选在业务钩子链路的最前段：注信只改模型上下文、不发布正文增量，
     * 因此与后续任何读取上下文的钩子之间没有「内容先于注入到达」的竞态。
     *
     * <p>响应身份不在这里产生 —— 它是框架的职责（{@code ChatResponseEntity.responseId}），
     * 本类不需要知道本轮身份。</p>
     */
    @Override
    public int order() {
        return MailInputChannel.ORDER;
    }

    /**
     * 取信失败必须让整轮失败。收件箱里的消息只消费一次，吞掉异常等于让协作方的新需求
     * 被静默丢弃：模型会以为没人找它，继续按旧目标跑完这一轮。
     */
    @Override
    public boolean catchErr() {
        return false;
    }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        // 框架已把 LoopContext 由 record 改为 class：attributes/execution 不再直接暴露，
        // 一律经 LoopMessages 取执行，再顺着 agentRequest 的 runtimeParameters 取属性。
        Execution execution = context.getLoopMessages().getExecution();
        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        if (ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID) == null
                || ExecutionAttributes.mailboxSessionId(attributes) == null) {
            log.debug("跳过邮箱注入: executionId={}, reason=未绑定 Agent 或无法解析协作根会话",
                    execution.getId());
            return InterceptorResult.NONE;
        }
        List<EmailMessageVO> data = channel.pollPendingItems(execution);
        if (data.isEmpty()) {
            return InterceptorResult.NONE;
        }
        context.appendMessage(channel.toModelMessages(execution, data, InputInjectionStage.LOOP));
        // 只登记「已投递」：回执必须与检查点同一事务落库（MailReceiptFlusher），
        // 在这里独立提交会造成「回执已落库、检查点没落库」的永久丢输入窗口。
        channel.markConsumed(execution, data);
        return InterceptorResult.NONE;
    }
}

