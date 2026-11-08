package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.runtime.loop.CheckPointResult;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.core.runtime.loop.RuntimeBoundaryChecker;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutionContext;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.interceptor.DefaultInterceptorProcessor;
import com.summit.runtime.loop.AgentLoopStepRunner;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.model.DefaultChatModelInvoker;
import com.summit.runtime.tool.DefaultToolExecutionManager;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.ObjectProvider;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** 工具失败必须留在工具消息里，不能阻断当前回复或后续用户输入。 */
class MemoryWikiConversationTest {
    @ParameterizedTest
    @ValueSource(strings = {"{}", "{\"wikiName\":\"project.md\"}"})
    void unselectedProjectDoesNotSuspendTheReplyOrBlockTheNextUserMessage(String arguments) throws Exception {
        @SuppressWarnings("unchecked")
        ObjectProvider<MemoryWikiManager> managers = mock(ObjectProvider.class);
        MemoryWikiLoader loader = new MemoryWikiLoader(new ObjectMapper(), managers);
        ToolDefinition<MemoryWikiLoader> definition = AnnotatedToolTestDefinitions.create(MemoryWikiLoader.class, loader);
        RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
        RuntimeBoundaryChecker boundary = mock(RuntimeBoundaryChecker.class);
        when(boundary.before(any(), any())).thenReturn(CheckPointResult.continueWith());
        when(boundary.after(any(), any())).thenReturn(CheckPointResult.continueWith());
        DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
        AtomicInteger modelCalls = new AtomicInteger();
        AgentRequest request = AgentRequest.builder().toolList(List.of(ToolCatalog.LOAD_MEMORY)).build();
        Execution execution = Execution.builder().id("wiki-conversation")
                .agentRequest(request).tokenUsage(TokenUsageEntity.empty())
                .messages(new ArrayList<Message>(List.of(UserMessageEntity.from("没有选择项目，也可以先聊聊吗？"))))
                .build();
        assertNull(request.getWorkspaceSpec());

        try (DefaultToolExecutionManager tools = new DefaultToolExecutionManager(
                ToolExecutionContext.builder().toolRegistry(new ToolRegistry(List.of(definition)))
                        .runtimeEventPublisher(events).build(), new DefaultInterceptorProcessor<>(List.of()), List.of())) {
            AgentLoopStepRunner runner = new AgentLoopStepRunner(RuntimeContext.builder()
                    // 与框架无项目请求的回落一致，不能因存在进程工作目录而读取其中的 wiki。
                    .workspace(new LocalWorkspace("fallback", System.getProperty("user.dir")))
                    .conversationManager(conversations).toolExecutionManager(tools)
                    .runtimeBoundaryChecker(boundary).runtimeEventPublisher(events)
                    // 框架升级：runner 每轮都要用 ContextUsageReporter 算上下文基线，未注入时 tokenizer 为 null 会 NPE。
                    .usage(new ContextUsageReporter(new DefaultTokenizer(), 100_000, events, 1))
                    .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of()))
                    .invoker(new DefaultChatModelInvoker(command -> {
                        int round = modelCalls.incrementAndGet();
                        assertTrue(round <= 3, "工具失败不能造成反复调用模型");
                        if (round == 1) {
                            return ChatResponseEntity.builder().tokenUsage(TokenUsageEntity.empty())
                                    .aiMessageEntity(AiMessageEntity.builder().text("检查可用项目记忆")
                                            .toolCalls(List.of(new ToolCallRequest("wiki-call", ToolCatalog.LOAD_MEMORY, 0, arguments)))
                                            .build()).build();
                        }
                        List<ToolMessageEntity> failures = command.getMessages().stream()
                                .filter(ToolMessageEntity.class::isInstance).map(ToolMessageEntity.class::cast).toList();
                        assertEquals(1, failures.size());
                        ToolMessageEntity failure = failures.getFirst();
                        assertEquals("wiki-call", failure.getId());
                        assertEquals(ToolCatalog.LOAD_MEMORY, failure.getName());
                        assertTrue(failure.isError());
                        assertTrue(failure.getToolOutput().contains("当前会话未指定项目"));
                        assertTrue(failure.getToolOutput().contains("仍可继续交流"));
                        if (round == 3) {
                            assertEquals("那我们继续讨论设计", command.getMessages().getLast().text());
                        }
                        return ChatResponseEntity.builder().tokenUsage(TokenUsageEntity.empty())
                                .aiMessageEntity(AiMessageEntity.builder().toolCalls(List.of())
                                        .text(round == 2 ? "可以继续交流" : "我们继续讨论设计").build()).build();
                    })).build());

            ExecutionControlSignal firstSignal = new ExecutionControlSignal(execution.getId());
            assertEquals(LoopResult.Status.COMPLETED, runner.run(execution, firstSignal).status());
            assertEquals(2, modelCalls.get());
            assertEquals("可以继续交流", execution.getAiMessage().getText());
            assertFalse(firstSignal.isSuspendRequired());
            assertFalse(firstSignal.isCancelRequired());

            conversations.appendUserMessage(execution, "那我们继续讨论设计");
            assertEquals(LoopResult.Status.COMPLETED,
                    runner.run(execution, new ExecutionControlSignal(execution.getId())).status());
            assertEquals(3, modelCalls.get());
            assertEquals("我们继续讨论设计", execution.getAiMessage().getText());
        }
        verifyNoInteractions(managers);
    }
}
