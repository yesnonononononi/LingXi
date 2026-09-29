package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.execution.ExecutionAttributes;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 循环拦截器的收件范围回归：它必须用与发信侧相同的规则算出 {@code workflowExecutionId}，
 * 并且只消费 {@code (workflowExecutionId, recipientAgentId)} 这一把业务键。
 *
 * <p>历史缺陷：拦截器拿自己的 execution ID 去做 {@code root = ? OR target = ?} 查询，
 * 同一个执行 ID 命中任一列就会放行整封邮箱；现在不再有这条路径。</p>
 */
class AgenticLoopInterceptorTest {

    private final EmailService emailService = mock(EmailService.class);
    private final AgenticLoopInterceptor interceptor = new AgenticLoopInterceptor(emailService);

    @Test
    @DisplayName("裸模型未绑定 Agent：不查邮箱、不追加消息")
    void skipsMailboxWhenNoAgentBound() {
        List<Message> appended = new ArrayList<>();
        LoopContext context = new LoopContext("900", Map.of(), appended::addAll);

        interceptor.onBeforeModelInvoke(context);

        verifyNoInteractions(emailService);
        assertTrue(appended.isEmpty());
    }

    @Test
    @DisplayName("根执行：没有 ROOT_EXECUTION_ID 属性时取自身执行 ID 作为 workflowExecutionId")
    void rootExecutionUsesItsOwnExecutionId() {
        when(emailService.consumePending(900L, 7L)).thenReturn(Result.success(List.of()));

        interceptor.onBeforeModelInvoke(new LoopContext("900",
                Map.of(ExecutionAttributes.AGENT_ID, "7"), messages -> { }));

        verify(emailService).consumePending(900L, 7L);
    }

    @Test
    @DisplayName("子执行：用 ROOT_EXECUTION_ID 属性作为 workflowExecutionId，与根执行同一把业务键")
    void childExecutionUsesRootExecutionAttribute() {
        when(emailService.consumePending(900L, 8L)).thenReturn(Result.success(List.of()));

        interceptor.onBeforeModelInvoke(new LoopContext("1234",
                Map.of(ExecutionAttributes.AGENT_ID, "8",
                        ExecutionAttributes.ROOT_EXECUTION_ID, "900"), messages -> { }));

        verify(emailService).consumePending(900L, 8L);
        verify(emailService, never()).consumePending(1234L, 8L);
    }

    @Test
    @DisplayName("消费到的消息以 UserMessage 追加到模型上下文末尾")
    void appendsConsumedMessagesAsUserMessages() {
        when(emailService.consumePending(900L, 7L)).thenReturn(Result.success(List.of(
                message(1L, 100L, "请处理甲"),
                message(2L, 101L, "请处理乙"))));

        List<Message> appended = new ArrayList<>();
        interceptor.onBeforeModelInvoke(new LoopContext("900",
                Map.of(ExecutionAttributes.AGENT_ID, "7"), appended::addAll));

        assertEquals(2, appended.size());
        assertTrue(appended.get(0) instanceof UserMessageEntity);
        assertTrue(((UserMessageEntity) appended.get(0)).text().contains("请处理甲"));
        assertTrue(((UserMessageEntity) appended.get(0)).text().contains("100"));
        assertTrue(((UserMessageEntity) appended.get(1)).text().contains("请处理乙"));
    }

    @Test
    @DisplayName("空收件箱：保持安静，不注入任何话术")
    void staysSilentWhenInboxEmpty() {
        when(emailService.consumePending(900L, 7L)).thenReturn(Result.success(List.of()));

        List<Message> appended = new ArrayList<>();
        interceptor.onBeforeModelInvoke(new LoopContext("900",
                Map.of(ExecutionAttributes.AGENT_ID, "7"), appended::addAll));

        assertTrue(appended.isEmpty(),
                "收件箱为空时必须完全静默：任何催办话术都会让模型误以为上一封没发出去，从而重发");
    }

    @Test
    @DisplayName("消费返回 null 数据：同样保持安静，不抛异常")
    void staysSilentWhenConsumeReturnsNullData() {
        when(emailService.consumePending(900L, 7L)).thenReturn(Result.success(null));

        List<Message> appended = new ArrayList<>();
        interceptor.onBeforeModelInvoke(new LoopContext("900",
                Map.of(ExecutionAttributes.AGENT_ID, "7"), appended::addAll));

        assertTrue(appended.isEmpty());
    }

    private static EmailMessageVO message(Long id, Long senderId, String content) {
        return EmailMessageVO.builder()
                .id(id)
                .emailId(900L)
                .senderId(senderId)
                .content(content)
                .status(EmailMessage.EMStatus.CONSUMED)
                .createAt(Instant.now())
                .build();
    }
}
