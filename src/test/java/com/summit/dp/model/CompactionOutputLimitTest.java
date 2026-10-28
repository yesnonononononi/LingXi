package com.summit.dp.model;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.compact.ContextCompactRequest;
import com.summit.core.compact.Tokenizer;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.SensitiveDataProvider;
import com.summit.core.conf.SensitiveDataSpec;
import com.summit.core.conversation.ConversationManager;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.ModelProvider;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.config.CompactionModelConfiguration;
import com.summit.dp.model.Infrastructure.config.CompactionProperties;
import com.summit.dp.model.api.controller.SettingsController;
import com.summit.dp.model.application.service.ModelService;
import com.summit.harness.springbootautoconfigure.config.ConversationConfig;
import com.summit.runtime.compact.DefaultContextPruner;
import com.summit.runtime.compact.DefaultModelCompacter;
import com.summit.runtime.compact.RequestCompactModelResolver;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.control.InMemoryActiveExecutionRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class CompactionOutputLimitTest {
    private final List<ModelConfig> selected = new ArrayList<>();
    private final List<Integer> versions = new ArrayList<>();
    private final ModelConfig original = ModelConfig.builder().baseUrl("https://chat.invalid/v1")
            .apiKey("chat-key").modelName("chat").provider("default-streaming")
            .timeout(Duration.ofSeconds(120)).maxTokens(102400).reuseModelForCompaction(true).build();
    private final ModelConfig dedicated = original.toBuilder().reuseModelForCompaction(false)
            .compactModel(new ModelConfig.CompactModelConfig("https://compact.invalid/v1", "compact-key", "summary"))
            .build();

    private ApplicationContextRunner contextRunner() {
        ModelProviderRegistry<ChatModel> providers = new ModelProviderRegistry<>();
        for (String name : List.of("default", "default-compact")) {
            providers.register(new ModelProvider<ChatModel>() {
                public String name() { return name; }
                public ChatModel create(ModelConfig config) {
                    selected.add(config);
                    return request -> ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder()
                            .text("{\"summary\":\"有效摘要\"}").build()).build();
                }
            });
        }
        return new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(ConversationConfig.class))
                .withUserConfiguration(CompactionModelConfiguration.class, CompactionProperties.class,
                        RevisionConfiguration.class)
                .withPropertyValues("lingxi.agent.model.conf.compact.max-tokens=4096")
                .withBean("chatModelConfig", ModelConfig.class, () -> original)
                .withBean(ModelProviderRegistry.class, () -> providers)
                .withBean("defaultContextCompactModel", ChatModel.class,
                        () -> request -> { throw new AssertionError("不能使用应用级压缩连接"); })
                .withBean("contextPruner", DefaultContextPruner.class, () -> mock(DefaultContextPruner.class))
                .withBean(ConversationManager.class, () -> new DefaultConversationManager(ContextAttachmentProvider.NONE))
                .withBean(Tokenizer.class, DefaultTokenizer::new)
                .withBean(ContextUsageReporter.class, () -> new ContextUsageReporter(new DefaultTokenizer(),
                        102400, new RuntimeEventPublisher(List.of()), 1))
                .withBean(ExecutionRepository.class, InMemoryActiveExecutionRegistry::new)
                .withBean(RevisionSource.class, () -> new RevisionSource((id, version) -> {
                    assertEquals(7L, id.longValue());
                    versions.add(version);
                    return version == 1 ? original : version == 2 ? dedicated : null;
                }));
    }

    @Test
    void automaticAndToolCompactionUseTheDisplayedLimitWithoutChangingChatRevisions() {
        contextRunner().run(context -> {
            assertNull(context.getStartupFailure());
            assertEquals(1, context.getBeansOfType(RequestCompactModelResolver.class).size());
            DefaultModelCompacter compacter = context.getBean(DefaultModelCompacter.class);
            Execution execution = Execution.create(request(2), "test");
            execution.setMessages(new ArrayList<>(List.of(UserMessageEntity.from("历史内容"))));
            context.getBean(ExecutionRepository.class).save(execution);

            assertTrue(compacter.compact(new ContextCompactRequest(execution)));
            assertTrue(compacter.execute(ToolExecution.builder().executionId(execution.getId())
                    .args("历史内容").build()).isSuccess());

            int displayedLimit = new SettingsController(mock(ModelService.class),
                    context.getBean(CompactionProperties.class)).compaction().getData().compactMaxTokens();
            assertEquals(4096, displayedLimit);
            assertEquals(2, selected.size());
            for (ModelConfig compact : selected) {
                assertNull(compact.getReasoningEffort());
                assertEquals(displayedLimit, compact.getMaxTokens());
                assertEquals("https://compact.invalid/v1", compact.getBaseUrl());
                assertEquals("compact-key", compact.getApiKey());
                assertEquals("summary", compact.getModelName());
            }
            assertEquals(102400, dedicated.getMaxTokens());
            assertEquals(102400, original.getMaxTokens());
            assertEquals(List.of(2, 2), versions);
        });
    }

    @Test
    void reusedChatConnectionAndLegacyRequestsAlsoUseTheCompactionLimit() {
        contextRunner().run(context -> {
            RequestCompactModelResolver resolver = context.getBean(RequestCompactModelResolver.class);
            resolver.resolve(request(1));
            resolver.resolve(AgentRequest.builder().build());
            assertEquals(2, selected.size());
            for (ModelConfig compact : selected) {
                assertEquals(4096, compact.getMaxTokens());
                assertEquals("chat-key", compact.getApiKey());
                assertEquals("default", compact.getProvider());
            }
            assertEquals(102400, original.getMaxTokens());
            assertTrue(original.isReuseModelForCompaction());
            assertEquals(List.of(1), versions);
        });
    }

    @Test
    void unavailableRevisionStillFailsInsteadOfBorrowingAnotherConnection() {
        contextRunner().run(context -> {
            assertThrows(IllegalStateException.class,
                    () -> context.getBean(RequestCompactModelResolver.class).resolve(request(99)));
            assertTrue(selected.isEmpty());
            assertEquals(List.of(99), versions);
        });
    }

    private AgentRequest request(int version) {
        return AgentRequest.builder().messages(List.of(UserMessageEntity.from("历史内容")))
                .modelConfigSpec(new SensitiveDataSpec(7L, version)).build();
    }

    /** 保留泛型信息，确保测试与实际配置提供器按同一类型注入。 */
    @Configuration(proxyBeanMethods = false)
    static class RevisionConfiguration {
        @Bean
        SensitiveDataProvider<ModelConfig> modelRevisions(RevisionSource source) {
            return source.provider();
        }
    }

    private record RevisionSource(SensitiveDataProvider<ModelConfig> provider) {
    }
}
