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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
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
            assertTrue(withSettings.config().isReuseModelForCompaction());
            // 设置默认 streamChat=true（10 参构造器走 DEFAULT_STREAM_CHAT），连接必须体现流式。
            assertTrue(withSettings.config().isStream());
            assertTrue(service.runtimeConfig(7L, null).isReuseModelForCompaction());
        });
    }

    @Test
    void missingTimeoutUsesTheFrameworkDefault() {
        when(repository.findById(7L)).thenReturn(Optional.of(
                new ModelConfig(7L, "https://example.invalid/v1", "test-key", "test-model", null, false)));
        contextRunner.run(context -> assertEquals(Duration.ofSeconds(60),
                context.getBean(ModelServiceImpl.class).runtimeConfig(7L, null).getTimeout()));
    }

    @Test
    void directCreateWithoutCompactModelHonoursStreamSetting() {
        // 覆盖 7 参 create 重载（无 compactModel）：返回非空且流式跟随设置，
        // 防止该重载被 NullReturnVals 类变异悄悄改成返回 null。
        SettingsView streamOff = new SettingsView(null, null, null, null, null, null, null, null, null, 10,
                null, null, null, false);
        RuntimeModel off = RuntimeModel.create("https://example.invalid/v1", "k", "m", null, false,
                streamOff, Duration.ofSeconds(30));
        assertFalse(off.config().isStream());
        assertTrue(off.config().isReturnThinking());
        assertNull(off.config().getCompactModel());

        SettingsView streamOn = new SettingsView(null, null, null, null, null, null, null, null, null, 10,
                null, null, null, true);
        assertTrue(RuntimeModel.create("https://example.invalid/v1", "k", "m", null, false,
                streamOn, Duration.ofSeconds(30)).config().isStream());
    }

    @Test
    void streamFlagFollowsUserSetting() {
        when(repository.findById(7L)).thenReturn(Optional.of(
                new ModelConfig(7L, "https://example.invalid/v1", "test-key", "test-model", null, false)));
        contextRunner.run(context -> {
            ModelServiceImpl service = context.getBean(ModelServiceImpl.class);
            // streamChat=false → 连接必须关掉流式；returnThinking/sendThinking 仍恒为 true（与流式无关）。
            SettingsView streamOff = new SettingsView(null, null, null, null, 7L, null, null, null, null, 10,
                    null, null, null, false);
            RuntimeModel off = service.resolveRuntimeConfig(7L, streamOff);
            assertFalse(off.config().isStream());
            assertTrue(off.config().isReturnThinking());
            assertTrue(off.config().isSendThinking());

            // streamChat=true → 流式打开。
            SettingsView streamOn = new SettingsView(null, null, null, null, 7L, null, null, null, null, 10,
                    null, null, null, true);
            assertTrue(service.resolveRuntimeConfig(7L, streamOn).config().isStream());
        });
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(AgentChatProperties.class)
    static class ChatPropertiesConfiguration {
    }
}
