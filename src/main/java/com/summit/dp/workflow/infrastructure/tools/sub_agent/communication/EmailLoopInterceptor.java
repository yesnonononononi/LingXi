package com.summit.dp.workflow.infrastructure.tools.sub_agent.communication;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 每次模型调用前，把「本执行所属 Agent 在本次协作轮次里的邮箱」中的待处理消息注入上下文。<br/>
 * NOTICE: The email sent by the sender agent will be injected into the target context as a {@link UserMessageEntity}
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class EmailLoopInterceptor implements LoopInterceptor {

    private final EmailService emailService;
    private final MailInputSource inputSource;

    /**
     * 邮箱注入选在业务钩子链路的最前段：注信只改模型上下文、不发布正文增量，
     * 因此与后续任何读取上下文的钩子之间没有「内容先于注入到达」的竞态。
     *
     * <p>响应身份不在这里产生 —— 它是框架的职责（{@code ChatResponseEntity.responseId}），
     * 本类不需要知道本轮身份。</p>
     */
    @Override
    public int order() {
        return -800;
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
        String executionId = execution.getId();
        Long recipientAgentId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID);
        if (recipientAgentId == null) {
            log.debug("跳过邮箱注入: executionId={}, reason=未绑定 Agent", executionId);
            return InterceptorResult.NONE;
        }

        Long mailboxSessionId = ExecutionAttributes.mailboxSessionId(attributes);
        if (mailboxSessionId == null) {
            log.debug("跳过邮箱注入: executionId={}, reason=无法解析协作根会话", executionId);
            return InterceptorResult.NONE;
        }

        List<EmailMessageVO> data = inputSource.pendingItems(execution);

        if (data == null || data.isEmpty()) {
            return InterceptorResult.NONE;
        }

        // 消费同一批查询结果，不能重新查询时顺带吃掉迟到邮件。
        emailService.consumePendingItems(data);

        List<UserMessageEntity> list = data.stream().map(vo -> UserMessageEntity.from(String.format("""
                @%s 发来协作消息: \n
                %s
                收件对象: @%s \n
                注意事项: 此邮件仅补充背景，不替代当前执行的委派任务。处理或回复邮件后，请继续完成当前委派；仅回复邮件不代表委派完成。
                """, vo.getSenderId(),
                vo.getContent(),
                recipientAgentId
                )
        )).toList();
        context.appendMessage(list);
        return InterceptorResult.NONE;
    }
}
