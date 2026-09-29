package com.summit.dp.tools.baseTools.sub_agent.result;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 结果渲染的回归守卫：返回给指挥者的必须永远是「非空、可读」的文本，
 * 且成功时取的是子 Agent 的<b>最终答复</b>（最后一条 AI 消息）。
 */
class SubAgentResultRendererTest {

    private final SubAgentResultRenderer renderer = new SubAgentResultRenderer();

    @Test
    @DisplayName("成功：取最后一条 AI 消息的正文，而非更早的中间轮次")
    void takesLastAiMessage() {
        Execution execution = mock(Execution.class);
        when(execution.getExecutionState()).thenReturn(ExecutionState.COMPLETED);
        when(execution.getMessages()).thenReturn(List.of(
                UserMessageEntity.from("委派的任务"),
                new AiMessageEntity("中间轮次：我先看看代码", null, null),
                new AiMessageEntity("最终答复：方案是 A", null, null)));

        assertEquals("最终答复：方案是 A", renderer.render(execution));
    }

    @Test
    @DisplayName("成功但全是非 AI 消息：退化为末条消息的文本，不返回空")
    void fallsBackToLastMessageText() {
        Execution execution = mock(Execution.class);
        when(execution.getExecutionState()).thenReturn(ExecutionState.COMPLETED);
        when(execution.getMessages()).thenReturn(List.of(UserMessageEntity.from("只有用户消息")));

        assertEquals("只有用户消息", renderer.render(execution));
    }

    @Test
    @DisplayName("成功但没有消息：给出可读提示而不是 null")
    void completedWithoutMessagesYieldsReadableHint() {
        Execution execution = mock(Execution.class);
        when(execution.getExecutionState()).thenReturn(ExecutionState.COMPLETED);
        when(execution.getMessages()).thenReturn(List.of());

        assertEquals("agent已完成任务，但未返回文本结果", renderer.render(execution));
    }

    @Test
    @DisplayName("失败：优先取执行自带错误信息（不触碰请求对象）")
    void failedPrefersExecutionError() {
        Execution execution = Execution.builder()
                .executionState(ExecutionState.FAILED)
                .errorMessage("模型调用超时")
                .build();

        assertEquals("模型调用超时", renderer.render(execution));
    }

    @Test
    @DisplayName("失败且无错误信息：用任务原文兜底，保证文本非空")
    void failedWithoutErrorFallsBackToTask() {
        Execution execution = Execution.builder()
                .executionState(ExecutionState.FAILED)
                .agentRequest(AgentRequest.builder().task(List.of("评估方案")).build())
                .build();

        String rendered = renderer.render(execution);

        assertTrue(rendered.contains("评估方案"), "兜底文案必须带上任务原文");
        assertTrue(rendered.contains("未能执行成功"));
    }

    @Test
    @DisplayName("失败且连请求对象都没有：仍返回可读文案，不抛 NPE")
    void failedWithoutRequestDoesNotThrow() {
        Execution execution = Execution.builder()
                .executionState(ExecutionState.FAILED)
                .build();

        String rendered = renderer.render(execution);

        assertTrue(rendered.contains("未能执行成功"));
    }

    @Test
    @DisplayName("执行对象为空：返回可读提示，不抛 NPE")
    void nullExecutionYieldsReadableHint() {
        assertEquals("agent的任务未能执行成功: 未返回执行结果", renderer.render(null));
    }
}
