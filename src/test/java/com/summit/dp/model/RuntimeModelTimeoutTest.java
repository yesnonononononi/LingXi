package com.summit.dp.model;

import com.summit.dp.model.application.service.ModelServiceImpl;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.harness.springbootautoconfigure.properties.agent.AgentChatProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 请求级模型必须保留配置的超时，防止主会话和子会话落回 SDK 默认值。 */
class RuntimeModelTimeoutTest {
    private final ModelConfigRepository repository = mock(ModelConfigRepository.class);
    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
            .withUserConfiguration(ChatPropertiesConfiguration.class)
            .withBean(ModelConfigRepository.class, () -> repository)
            .withBean(ProviderConfigService.class, () -> mock(ProviderConfigService.class))
            .withBean(ModelServiceImpl.class);

    @ParameterizedTest
    @CsvSource({"120s, 120000", "375ms, 375"})
    void configuredTimeoutReachesRequestsWithAndWithoutUserSettings(String timeout, long expectedMillis) {
        when(repository.findById(7L)).thenReturn(Optional.of(
                new ModelConfig(7L, "https://example.invalid/v1", "test-key", "test-model", null, true)));
        contextRunner.withPropertyValues("lingxi.agent.model.conf.chat.timeout=" + timeout).run(context -> {
            ModelServiceImpl service = context.getBean(ModelServiceImpl.class);
            SettingsView settings = new SettingsView(null, null, null, null, 7L, null, 1234, "high", null, 10);

            RuntimeModel withSettings = service.resolveRuntimeConfig(7L, settings);
            assertEquals(Duration.ofMillis(expectedMillis), withSettings.config().getTimeout());
            assertEquals(Duration.ofMillis(expectedMillis), service.runtimeConfig(7L, null).getTimeout());
            assertEquals("https://example.invalid/v1", withSettings.config().getBaseUrl());
            assertEquals("test-key", withSettings.config().getApiKey());
            assertEquals("test-model", withSettings.config().getModelName());
            assertEquals(1234, withSettings.config().getMaxTokens());
            assertEquals("high", withSettings.config().getReasoningEffort());
            assertTrue(withSettings.vision());
            assertTrue(withSettings.config().isReturnThinking());
            assertTrue(withSettings.config().isSendThinking());
        });
    }

    @Test
    void missingTimeoutUsesTheFrameworkDefault() {
        when(repository.findById(7L)).thenReturn(Optional.of(
                new ModelConfig(7L, "https://example.invalid/v1", "test-key", "test-model", null, false)));
        contextRunner.run(context -> assertEquals(Duration.ofSeconds(60),
                context.getBean(ModelServiceImpl.class).runtimeConfig(7L, null).getTimeout()));
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(AgentChatProperties.class)
    static class ChatPropertiesConfiguration {
    }
}
