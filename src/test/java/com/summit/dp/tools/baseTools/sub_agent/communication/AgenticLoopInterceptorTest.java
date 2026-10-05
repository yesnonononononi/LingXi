package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.workspace.WorkspaceSpec;
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
import static org.junit.jupiter.api.Assertions.assertThrows;
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

        InterceptorResult result = interceptor.onBeforeModelInvoke(context("900", Map.of(), appended));

        verifyNoInteractions(emailService);
        assertTrue(appended.isEmpty());
        assertTrue(result.shouldContinue(), "跳过注入只是不消费邮箱，不该中断这一轮");
    }

    @Test
    @DisplayName("根执行：没有 ROOT_EXECUTION_ID 属性时取自身执行 ID 作为 workflowExecutionId")
    void rootExecutionUsesItsOwnExecutionId() {
        when(emailService.consumePending(900L, 7L)).thenReturn(Result.success(List.of()));

        interceptor.onBeforeModelInvoke(context("900", Map.of(ExecutionAttributes.AGENT_ID, "7"), new ArrayList<>()));

        verify(emailService).consumePending(900L, 7L);
    }

    @Test
    @DisplayName("子执行：用 ROOT_EXECUTION_ID 属性作为 workflowExecutionId，与根执行同一把业务键")
    void childExecutionUsesRootExecutionAttribute() {
        when(emailService.consumePending(900L, 8L)).thenReturn(Result.success(List.of()));

        interceptor.onBeforeModelInvoke(context("1234",
                Map.of(ExecutionAttributes.AGENT_ID, "8",
                        ExecutionAttributes.ROOT_EXECUTION_ID, "900"), new ArrayList<>()));

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
        interceptor.onBeforeModelInvoke(context("900", Map.of(ExecutionAttributes.AGENT_ID, "7"), appended));

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
        interceptor.onBeforeModelInvoke(context("900", Map.of(ExecutionAttributes.AGENT_ID, "7"), appended));

        assertTrue(appended.isEmpty(),
                "收件箱为空时必须完全静默：任何催办话术都会让模型误以为上一封没发出去，从而重发");
    }

    @Test
    @DisplayName("消费返回 null 数据：同样保持安静，不抛异常")
    void staysSilentWhenConsumeReturnsNullData() {
        when(emailService.consumePending(900L, 7L)).thenReturn(Result.success(null));

        List<Message> appended = new ArrayList<>();
        interceptor.onBeforeModelInvoke(context("900", Map.of(ExecutionAttributes.AGENT_ID, "7"), appended));

        assertTrue(appended.isEmpty());
    }

    @Test
    @DisplayName("取信失败必须向上抛出：消息只消费一次，吞掉等于静默丢弃协作方的新需求")
    void propagatesConsumeFailure() {
        when(emailService.consumePending(900L, 7L)).thenThrow(new IllegalStateException("邮箱不可用"));

        assertThrows(IllegalStateException.class,
                () -> interceptor.onBeforeModelInvoke(
                        context("900", Map.of(ExecutionAttributes.AGENT_ID, "7"), new ArrayList<>())));
    }

    private static LoopContext context(String executionId, Map<String, Object> attributes, List<Message> appended) {
        Execution execution = Execution.builder()
                .id(executionId)
                .agentRequest(AgentRequest.builder().workspaceSpec(TEST_WORKSPACE).build())
                .build();
        return new LoopContext(execution, new ExecutionControlSignal(executionId), 0, attributes, appended::addAll);
    }

    private static final WorkspaceSpec TEST_WORKSPACE = new WorkspaceSpec() {
        @Override
        public String provider() {
            return "test";
        }

        @Override
        public String workDir() {
            return "D:/tmp";
        }
    };

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
