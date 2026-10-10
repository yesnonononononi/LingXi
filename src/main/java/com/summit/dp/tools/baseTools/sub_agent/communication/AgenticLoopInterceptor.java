package com.summit.dp.tools.baseTools.sub_agent.communication;

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
 * 每次模型调用前，把「本执行所属 Agent 在本次协作轮次里的邮箱」中的待处理消息注入上下文。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgenticLoopInterceptor implements LoopInterceptor {


    private final EmailService emailService;


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

        // 1, 未绑定 Agent 的裸模型没有邮箱可言，直接跳过
        // 框架已把 LoopContext 由 record 改为 class：attributes/execution 不再直接暴露，
        // 一律经 LoopMessages 取执行，再顺着 agentRequest 的 runtimeParameters 取属性。
        Execution execution = context.getLoopMessages().getExecution();
        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        String executionId = execution.getId();
        Long recipientAgentId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID);
        if (recipientAgentId == null) {
            log.debug("执行 {} 未绑定 Agent，跳过邮箱注入", executionId);
            return InterceptorResult.NONE;
        }

        // 2, 与发信侧同一规则算出邮箱业务键：协作根会话 ID（子执行取 ROOT_SESSION_ID，根执行回落自身 SESSION_ID）
        Long mailboxSessionId = ExecutionAttributes.mailboxSessionId(attributes);
        if (mailboxSessionId == null) {
            log.debug("执行 {} 无法解析协作根会话 ID，跳过邮箱注入", executionId);
            return InterceptorResult.NONE;
        }

        // 3, 只消费该业务键下的待处理消息
        List<EmailMessageVO> data = emailService.consumePending(mailboxSessionId, recipientAgentId).getData();

        // 4, 空收件箱不发任何消息
        if (data == null || data.isEmpty()) {
            return InterceptorResult.NONE;
        }


        // 5, 作为 UserMessage 追加到本次模型上下文末尾
        List<UserMessageEntity> list = data.stream().map(vo -> UserMessageEntity.from(String.format("""
                @%s 给你发送了一个新需求: \n
                %s
                收件对象: @%s
                """, vo.getSenderId(),
                vo.getContent(),
                recipientAgentId
                )
        )).toList();
        context.appendMessage(list);
        return InterceptorResult.NONE;
    }
}
