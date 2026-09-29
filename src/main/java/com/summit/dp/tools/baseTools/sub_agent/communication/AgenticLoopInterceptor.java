package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.summit.core.conversation.message.UserMessageEntity;
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
 *
 * <p>业务键与发信侧完全同源：{@code workflowExecutionId} 由
 * {@link ExecutionAttributes#workflowExecutionId(Map, String)} 算出（根执行取自身、子执行取
 * {@code ROOT_EXECUTION_ID} 属性），{@code recipientAgentId} 取当前执行的 {@code AGENT_ID} 属性。
 * 两者都来自受控上下文，因此只消费「这一轮协作发给这个 Agent 角色」的消息——
 * 不再用 execution ID 去 OR 命中 root/target 两列。裸模型未绑定 Agent 时不查邮箱。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgenticLoopInterceptor implements LoopInterceptor {

    private final EmailService emailService;

    @Override
    public void onBeforeModelInvoke(LoopContext context) {

        // 1, 未绑定 Agent 的裸模型没有邮箱可言，直接跳过
        Map<String, Object> attributes = context.attributes();
        Long recipientAgentId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID);
        if (recipientAgentId == null) {
            log.debug("Execution {} has no bound Agent ID, skip mailbox", context.executionId());
            return;
        }

        // 2, 与发信侧同一规则算出协作根执行 ID：根执行取自身，子执行取 ROOT_EXECUTION_ID 属性
        Long workflowExecutionId = ExecutionAttributes.workflowExecutionId(attributes, context.executionId());
        if (workflowExecutionId == null) {
            log.debug("Execution {} has no resolvable workflow execution id, skip mailbox", context.executionId());
            return;
        }

        // 3, 只消费该业务键下的待处理消息
        List<EmailMessageVO> data = emailService.consumePending(workflowExecutionId, recipientAgentId).getData();
        if (data == null || data.isEmpty()) {
            return;
        }

        // 4, 作为 UserMessage 追加到本次模型上下文末尾
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
    }
}
