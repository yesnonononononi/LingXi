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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 每次模型调用前，把「本执行所属 Agent 在本次协作轮次里的邮箱」中的待处理消息注入上下文。
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

        // 4, 空收件箱不发任何消息
        if (data == null || data.isEmpty()) {
            return;
        }


        // 6, 作为 UserMessage 追加到本次模型上下文末尾
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
