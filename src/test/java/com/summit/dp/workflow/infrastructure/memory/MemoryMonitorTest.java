package com.summit.dp.workflow.infrastructure.memory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.adapter.TokenEstimator;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workspace.application.convert.LingXiWorkspaceSpec;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class MemoryMonitorTest {
    private static final String PROJECT_MEMORY = ".lingxi/memory/consistent/memory.md";

    @TempDir
    Path directory;
    private Path globalMemory;
    private Path projectRoot;
    private TokenEstimator estimator;

    @BeforeEach
    void setUp() throws IOException {
        globalMemory = directory.resolve("global/memory.md");
        projectRoot = Files.createDirectories(directory.resolve("project"));
        estimator = mock(TokenEstimator.class);
        when(estimator.estimateText(anyString())).thenAnswer(invocation -> invocation.<String>getArgument(0).length() * 2);
    }

    @Test
    void userLimitOnlyRemindsAboveTheBoundary() throws IOException {
        write(globalMemory, "a".repeat(10));
        assertTrue(monitor().checkMemoryLimits().isEmpty());
        write(globalMemory, "a".repeat(11));
        List<SystemMessageEntity> reminders = monitor().checkMemoryLimits();
        assertEquals(1, reminders.size());
        assertTrue(reminders.getFirst().text().contains("用户长期记忆文件：" + globalMemory));
        assertTrue(reminders.getFirst().text().contains("当前估算 22 token，上限 20 token"));
    }

    @Test
    void missingFilesAndDisabledLimitsDoNotReadContent() throws IOException {
        assertTrue(monitor().checkMemoryLimits().isEmpty());
        write(globalMemory, "超限".repeat(20));
        write(projectRoot.resolve(PROJECT_MEMORY), "超限".repeat(20));
        MemoryMonitor disabled = new MemoryMonitor(estimator, globalMemory.toString(), 0);
        assertTrue(disabled.checkMemoryLimits().isEmpty());
        verifyNoInteractions(estimator);
    }

    @Test
    void legacyProjectFileAndWikiBodiesAreNotLoadedByTheUserMemoryMonitor() throws IOException {
        write(projectRoot.resolve(PROJECT_MEMORY), "旧单文件".repeat(1000));
        write(projectRoot.resolve(".lingxi/memory/wiki/storage.md"), "模块正文".repeat(1000));
        assertTrue(monitor().checkMemoryLimits().isEmpty());
        verifyNoInteractions(estimator);
    }



    @Test
    void unreadableUserMemoryDoesNotBlockTheConversation() throws IOException {
        write(globalMemory, "placeholder");
        Files.write(globalMemory, new byte[] { (byte) 0xc3, 0x28 });
        assertTrue(monitor().checkMemoryLimits().isEmpty());
    }

    @Test
    void loopHookChecksUserMemoryAndDoesNotAppendAgainOnTheNextRound() throws IOException {
        write(globalMemory, "b".repeat(11));
        Execution execution = execution(projectRoot);
        AtomicInteger appends = new AtomicInteger();
        LoopContext context = context(execution, appends);
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());

        assertSame(InterceptorResult.NONE, interceptor.onBeforeModelInvoke(context));
        assertEquals(3, execution.getMessages().size());
        assertTrue(execution.getMessages().getLast().text().contains(globalMemory.toString()));
        interceptor.onBeforeModelInvoke(context);
        assertEquals(1, appends.get());
        assertEquals(3, execution.getMessages().size());
    }

    @Test
    void fileChangesReplaceRemindersAndCompactedFilesRemoveThemWithoutTouchingUserText() throws IOException {
        write(globalMemory, "b".repeat(11));
        Execution execution = execution(projectRoot);
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());
        LoopContext context = context(execution, new AtomicInteger());
        interceptor.onBeforeModelInvoke(context);
        String first = execution.getMessages().getLast().text();
        UserMessageEntity user = UserMessageEntity.from(first);
        execution.getMessages().add(user);

        write(globalMemory, "b".repeat(12));
        interceptor.onBeforeModelInvoke(context);
        assertEquals(4, execution.getMessages().size());
        assertTrue(execution.getMessages().getLast().text().contains("当前估算 24 token"));
        write(globalMemory, "b".repeat(10));
        interceptor.onBeforeModelInvoke(context);
        assertEquals(3, execution.getMessages().size());
        assertEquals(List.of("业务规则", "用户任务", first), execution.getMessages().stream().map(Message::text).toList());
        assertSame(user, execution.getMessages().getLast());
    }

    @Test
    void checkpointRestoreKeepsDeduplicationAndMissingContextGetsTheReminderAgain() throws IOException {
        write(globalMemory, "b".repeat(11));
        Execution execution = execution(projectRoot);
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());
        interceptor.onBeforeModelInvoke(context(execution, new AtomicInteger()));
        ObjectMapper mapper = new JsonConfig().objectMapper();
        Execution restored = mapper.readValue(mapper.writeValueAsString(execution), Execution.class);
        AtomicInteger appends = new AtomicInteger();
        MemoryMonitorInterceptor resumed = new MemoryMonitorInterceptor(monitor());
        resumed.onBeforeModelInvoke(context(restored, appends));
        assertEquals(0, appends.get());
        assertEquals(3, restored.getMessages().size());

        restored.setMessages(new ArrayList<>(restored.getMessages().subList(0, 2)));
        resumed.onBeforeModelInvoke(context(restored, appends));
        assertEquals(1, appends.get());
        assertEquals(3, restored.getMessages().size());
    }



    @Test
    void loopHookWithoutWorkspaceStillChecksGlobalAndAppendFailureIsNotSwallowed() throws IOException {
        write(globalMemory, "a".repeat(11));
        Execution execution = execution(null);
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());
        interceptor.onBeforeModelInvoke(context(execution, new AtomicInteger()));
        assertEquals(3, execution.getMessages().size());
        assertTrue(execution.getMessages().getLast().text().contains("用户长期记忆文件"));
        assertEquals(-825, interceptor.order());
        assertFalse(interceptor.catchErr());

        Execution fresh = execution(null);
        LoopContext failing = LoopContext.withCompactionCounter(LoopMessages.builder().execution(fresh).build(),
                null, () -> 0, messages -> { throw new IllegalStateException("注入失败"); });
        assertThrows(IllegalStateException.class, () -> interceptor.onBeforeModelInvoke(failing));
    }

    @Test
    void realYamlSeparatesThreeMemoryLayersAndRemovesTheOldProjectFileConfiguration() throws IOException {
        write(globalMemory, "a".repeat(1501));
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            for (PropertySource<?> source : new YamlPropertySourceLoader().load("应用配置", new ClassPathResource("application.yaml"))) {
                context.getEnvironment().getPropertySources().addLast(source);
            }
            assertEquals("3000", context.getEnvironment().getProperty("lingxi.memory.user.max-tokens"));
            assertEquals(".lingxi/memory/wiki", context.getEnvironment().getProperty("lingxi.memory.wiki.relative-location"));
            assertEquals(".lingxi/memory/work", context.getEnvironment().getProperty("lingxi.memory.work.relative-location"));
            assertTrue(context.getEnvironment().getProperty("lingxi.memory.user.location").endsWith("/.lingxi/memory/user/memory.md"));
            assertNull(context.getEnvironment().getProperty("lingxi.memory.project.relative-location"));
            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("记忆测试", Map.of(
                    "lingxi.memory.user.location", globalMemory.toString(), "lingxi.memory.user.max-tokens", 2000)));
            context.registerBean(PropertySourcesPlaceholderConfigurer.class);
            context.registerBean(TokenEstimator.class, () -> estimator);
            context.scan("com.summit.dp.workflow.infrastructure.memory");
            context.refresh();
            List<SystemMessageEntity> reminders = context.getBean(MemoryMonitor.class).checkMemoryLimits();
            assertEquals(1, reminders.size());
            assertTrue(reminders.getFirst().text().contains("上限 2000 token"));
            assertEquals(1, context.getBeansOfType(LoopInterceptor.class).size());
            String instructions = context.getEnvironment().getProperty("lingxi.memory.instructions");
            assertTrue(instructions.contains(globalMemory.toString()));
            assertTrue(instructions.contains("模块名.md"));
            assertTrue(instructions.contains(".lingxi/memory/wiki"));
            assertTrue(instructions.contains(".lingxi/memory/work/yyyy-MM-dd.md"));
            assertTrue(instructions.contains("search_wiki"));
            assertTrue(instructions.contains("load_memory"));
            assertTrue(instructions.contains("最多提供 30 条"));
        }
    }

    private MemoryMonitor monitor() {
        return new MemoryMonitor(estimator, globalMemory.toString(), 20);
    }

    private Execution execution(Path root) {
        AgentRequest request = AgentRequest.builder().workspaceSpec(root == null ? null
                : new LingXiWorkspaceSpec("local", root.toString(), Map.of())).build();
        return Execution.builder().id("101").agentRequest(request).messages(new ArrayList<>(List.of(
                SystemMessageEntity.builder().text("业务规则").build(), UserMessageEntity.from("用户任务")))).build();
    }

    private LoopContext context(Execution execution, AtomicInteger appends) {
        return LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(), null, () -> 0,
                messages -> {
                    appends.incrementAndGet();
                    execution.getMessages().addAll(messages);
                });
    }

    private void write(Path file, String text) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, text);
    }
}
