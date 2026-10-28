package com.summit.dp.model;

import com.summit.dp.model.application.service.ModelServiceImpl;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.harness.springbootautoconfigure.properties.agent.AgentChatProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 专用压缩模型的请求级路由守卫。
 *
 * <p>三个不变量：选中时复用开关**必须**关掉（否则框架根本不会看 compactModel），
 * 未选时**必须**保持复用（否则压缩会去连 yaml 里那套空 base-url），
 * 选中但不可用（被删/缺密钥）时**必须**回落而不是让每一轮对话都失败。</p>
 */
class CompactionModelRoutingTest {

    private static final long CHAT_MODEL_ID = 7L;
    private static final long COMPACT_MODEL_ID = 9L;

    private final ModelConfigRepository repository = mock(ModelConfigRepository.class);
    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
            .withUserConfiguration(ChatPropertiesConfiguration.class)
            .withBean(ModelConfigRepository.class, () -> repository)
            .withBean(ProviderConfigService.class, () -> mock(ProviderConfigService.class))
            .withBean(ModelServiceImpl.class);

    @BeforeEach
    void setUp() {
        when(repository.findById(CHAT_MODEL_ID)).thenReturn(Optional.of(new ModelConfig(CHAT_MODEL_ID,
                "https://chat.invalid/v1", "chat-key", "chat-model", null, false)));
    }

    @Test
    @DisplayName("选中专用压缩模型：关闭复用，压缩连接换成它自己的")
    void dedicatedCompactModelReplacesChatConnectionForSummaries() {
        when(repository.findById(COMPACT_MODEL_ID)).thenReturn(Optional.of(new ModelConfig(COMPACT_MODEL_ID,
                "https://compact.invalid/v1", "compact-key", "compact-model", null, false)));
        contextRunner.run(context -> {
            RuntimeModel runtime = context.getBean(ModelServiceImpl.class)
                    .resolveRuntimeConfig(CHAT_MODEL_ID, settings(COMPACT_MODEL_ID));
            assertEquals("https://chat.invalid/v1", runtime.config().getBaseUrl());
            assertFalse(runtime.config().isReuseModelForCompaction());
            com.summit.core.conf.ModelConfig.CompactModelConfig compact = runtime.config().getCompactModel();
            assertNotNull(compact);
            assertEquals("https://compact.invalid/v1", compact.baseUrl());
            assertEquals("compact-key", compact.apiKey());
            assertEquals("compact-model", compact.modelName());
        });
    }

    @Test
    @DisplayName("未选专用模型：沿用对话模型做摘要")
    void absentSelectionKeepsReusingTheChatModel() {
        contextRunner.run(context -> {
            RuntimeModel runtime = context.getBean(ModelServiceImpl.class)
                    .resolveRuntimeConfig(CHAT_MODEL_ID, settings(null));
            assertTrue(runtime.config().isReuseModelForCompaction());
            assertNull(runtime.config().getCompactModel());
        });
    }

    @Test
    @DisplayName("选中的模型已被删除：回落到对话模型")
    void danglingSelectionFallsBackToTheChatModel() {
        contextRunner.run(context -> {
            RuntimeModel runtime = context.getBean(ModelServiceImpl.class)
                    .resolveRuntimeConfig(CHAT_MODEL_ID, settings(404L));
            assertTrue(runtime.config().isReuseModelForCompaction());
            assertNull(runtime.config().getCompactModel());
        });
    }

    @Test
    @DisplayName("压缩模型缺密钥：回落，且不把空密钥送进请求")
    void incompleteSelectionFallsBackToTheChatModel() {
        when(repository.findById(COMPACT_MODEL_ID)).thenReturn(Optional.of(new ModelConfig(COMPACT_MODEL_ID,
                "https://compact.invalid/v1", "  ", "compact-model", null, false)));
        contextRunner.run(context -> {
            RuntimeModel runtime = context.getBean(ModelServiceImpl.class)
                    .resolveRuntimeConfig(CHAT_MODEL_ID, settings(COMPACT_MODEL_ID));
            assertTrue(runtime.config().isReuseModelForCompaction());
            assertNull(runtime.config().getCompactModel());
        });
    }

    private static SettingsView settings(Long compactModelId) {
        return new SettingsView(null, null, null, null, CHAT_MODEL_ID, null, 1234, null, null, 10, compactModelId);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(AgentChatProperties.class)
    static class ChatPropertiesConfiguration {
    }
}
