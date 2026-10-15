package com.summit.dp.model;

import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.domain.ModelNoFoundException;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.ChatImageResolver;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.CallSubAgentTool;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentRequestFactory;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import java.util.Map;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class AgentModelConfigurationTest {
    private final ModelService models = mock(ModelService.class);
    private final SettingsProvider settings = mock(SettingsProvider.class);
    private final AgentService agents = mock(AgentService.class);
    private final CallSubAgentTool child = new CallSubAgentTool(new ObjectMapper(), agents, null,
            new SubAgentRequestFactory(null, models, settings, null, new SkillRootResolver(""), new BusinessSystemPromptBuilder("")),
            null, null, null, null, null);
    /** 子模型解析已下沉到请求组装器，这里直接打它，避免再经工具入口绕行。 */
    private final SubAgentRequestFactory childModels = new SubAgentRequestFactory(null, models, settings, null,
            new SkillRootResolver(""), new BusinessSystemPromptBuilder(""));

    @Test void unconfiguredChildFailsBeforeCreatingSessionOrInvokingModel() {
        AgentVO agent = new AgentVO();
        agent.setId(7L);
        when(agents.findById(7L)).thenReturn(Result.success(agent));
        ToolExecution execution = mock(ToolExecution.class);
        when(execution.getArgs()).thenReturn("{\"agentId\":7,\"task\":\"work\",\"workDir\":\"/work\"}");
        // 团队身份随 attributes 流动：等价于根请求携带 TEAM_ID=1（替代旧 ThreadLocal 绑定）。
        when(execution.getAttributes()).thenReturn(Map.of(ExecutionAttributes.TEAM_ID, "1"));
        ToolExecuteResult result = child.execute(execution);
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("子 Agent 未配置模型"));
        verifyNoInteractions(models, settings);
    }

    @Test void missingChildModelNeverFallsBackToSettings() {
        ClientException error = assertThrows(ClientException.class,
                () -> ReflectionTestUtils.invokeMethod(childModels, "resolveChildModel", (Object) null));
        assertTrue(error.getMessage().contains("子 Agent 未配置模型"));
        verifyNoInteractions(models, settings);
    }

    @Test void configuredChildUsesItsOwnIdAndRuntimeSettings() {
        SettingsView selected = new SettingsView(null, null, null, null, 99L, null, 1234, "high", null, 10);
        ModelConfig configured = config("child");
        when(settings.current()).thenReturn(Optional.of(selected));
        when(models.runtimeConfig(7L, selected)).thenReturn(configured);
        AgentVO agent = new AgentVO();
        agent.setId(7L);
        agent.setModelId(7L);
        assertSame(configured, ReflectionTestUtils.invokeMethod(childModels, "resolveChildModel", agent));
        verify(models).runtimeConfig(7L, selected);
        verifyNoMoreInteractions(models);
    }

    @Test void deletedChildPresetModelFailsWithActionableMessage() {
        AgentVO agent = new AgentVO();
        agent.setId(7L);
        agent.setName("评审员");
        agent.setModelId(7L);
        when(settings.current()).thenReturn(Optional.empty());
        when(models.runtimeConfig(7L, null)).thenThrow(new ModelNoFoundException());

        ClientException error = assertThrows(ClientException.class,
                () -> ReflectionTestUtils.invokeMethod(childModels, "resolveChildModel", agent));
        assertTrue(error.getMessage().contains("已被删除"));
        assertTrue(error.getMessage().contains("评审员"));
    }

    @Test void rootResolvesExplicitThenSettingsThenFails() {
        RequestPreparer root = new RequestPreparer(null, null, null, models, null, settings, null,
                null, null, null, null, null, null, new SkillRootResolver(""), new ChatImageResolver(), new BusinessSystemPromptBuilder(""), mock(PersonalizationRepository.class));
        SettingsView selected = new SettingsView(null, null, null, null, 99L, null, 1234, "high", null, 10);
        ModelConfig explicit = config("explicit");
        ModelConfig fallback = config("settings");
        when(models.runtimeConfig(7L, selected)).thenReturn(explicit);
        when(models.runtimeConfig(99L, selected)).thenReturn(fallback);
        // 显式 modelId 优先；未指定时回落单例设置（user_configs.model_id）。
        assertSame(explicit, ReflectionTestUtils.invokeMethod(root, "rootModel", 7L, selected));
        assertSame(fallback, ReflectionTestUtils.invokeMethod(root, "rootModel", null, selected));
        // 无显式、无设置：业务侧不再读 lingxi.agent.model.conf.*，直接报「未配置可用的模型连接」。
        SettingsView unconfigured = new SettingsView(null, null, null, null, null, null, 1000, "low", null, 10);
        ClientException error = assertThrows(ClientException.class,
                () -> ReflectionTestUtils.invokeMethod(root, "rootModel", null, unconfigured));
        assertTrue(error.getMessage().contains("未配置可用的模型连接"));
    }

    private ModelConfig config(String name) {
        return ModelConfig.builder().baseUrl("https://example.invalid").apiKey("test-key").modelName(name).build();
    }
}
