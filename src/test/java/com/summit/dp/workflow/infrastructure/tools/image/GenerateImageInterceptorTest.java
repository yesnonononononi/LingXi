package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolResultType;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Arrays;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 多工具、失败结果、快照恢复与新执行必须使用同一配额口径。 */
class GenerateImageInterceptorTest {
    @Test void quotaIsSavedBeforeCallsAndSurvivesJsonRestore() throws Exception {
        ObjectMapper mapper=new ObjectMapper();
        SettingsProvider settings=mock(SettingsProvider.class);
        when(settings.current()).thenReturn(Optional.of(new SettingsView(null,null,null,null,null,null,null,null,null,10,null,9L,1)));
        ExecutionRepository repository=mock(ExecutionRepository.class);
        GenerateImageInterceptor interceptor=new GenerateImageInterceptor(settings,repository,mapper);
        Execution execution=Execution.builder().id("10").agentRequest(AgentRequest.builder()
                .runtimeParameters(AgentRuntimeParameters.builder().build()).build()).build();
        LoopContext context=context(execution,"a","b");
        interceptor.onBeforeToolCall(context);
        Map<String,Object> attributes=execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        assertEquals(1,GenerateImageInterceptor.number(attributes,GenerateImageInterceptor.USED));
        assertEquals(List.of("a"),attributes.get(GenerateImageInterceptor.ALLOWED));
        verify(repository).save(execution);
        AgentRuntimeParameters restored=mapper.readValue(mapper.writeValueAsBytes(execution.getAgentRequest().getRuntimeParameters()),AgentRuntimeParameters.class);
        execution.getAgentRequest().setRuntimeParameters(restored);
        interceptor.onBeforeToolCall(context(execution,"c"));
        assertEquals(List.of(),execution.getAgentRequest().getRuntimeParameters().getAttributes().get(GenerateImageInterceptor.ALLOWED));
        verify(settings,times(1)).current();
        Execution fresh=Execution.builder().id("11").agentRequest(AgentRequest.builder().build()).build();
        interceptor.onBeforeToolCall(context(fresh,"d"));
        assertEquals(List.of("d"),fresh.getAgentRequest().getRuntimeParameters().getAttributes().get(GenerateImageInterceptor.ALLOWED));
    }

    @Test void imageUsageIsIncludedEvenWhenSavingTheFileFailed() {
        GenerateImageInterceptor interceptor=new GenerateImageInterceptor(mock(SettingsProvider.class),mock(ExecutionRepository.class),new ObjectMapper());
        Execution execution=Execution.builder().id("10").agentRequest(AgentRequest.builder().build()).tokenUsage(TokenUsageEntity.of(10,7,3)).build();
        ToolExecuteResult result=ToolExecuteResult.err("write failed",ToolResultType.NORMAL,
                Map.of(GenerateImageInterceptor.USAGE,Map.of("totalTokens",95,"inputTokens",Map.of("inputTokens",15),"outputTokens",Map.of("outputTokens",80))));
        result.setToolSpecification(ToolDefinition.builder().maxOutput(700).timeout(300L)
                .executor(tool -> ToolExecuteResult.success("")).id("image-tool").name(ToolCatalog.GENERATE_IMAGE).build());
        interceptor.onAfterToolCall(context(execution),List.of(result));
        assertEquals(105,execution.getTokenUsage().getTotalTokens());
        assertEquals(22,execution.getTokenUsage().getInputTokens().getInputTokens());
        assertEquals(83,execution.getTokenUsage().getOutputTokens().getOutputTokens());
    }

    private LoopContext context(Execution execution,String...ids) {
        List<ToolCallRequest> calls=Arrays.stream(ids).map(id->new ToolCallRequest(id,ToolCatalog.GENERATE_IMAGE,0,"{}")).toList();
        return LoopContext.builder().loopMessages(LoopMessages.builder().execution(execution).response(ChatResponseEntity.builder()
                .aiMessageEntity(AiMessageEntity.builder().toolCalls(calls).build()).build()).build()).signal(null).consecutiveCompactTurns(() -> 0).appendMessage(ignored->{}).build();
    }
}
