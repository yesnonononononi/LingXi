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
import com.summit.dp.workspace.application.convert.LingXiWorkspaceSpec;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

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
    void usesIndependentTokenLimitsAndOnlyRemindsAboveTheBoundary() throws IOException {
        write(globalMemory, "a".repeat(6));
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(6));
        MemoryMonitor monitor = monitor();

        List<SystemMessageEntity> projectOnly = monitor.checkMemoryLimits(projectRoot.toString());
        assertEquals(1, projectOnly.size());
        assertTrue(projectOnly.getFirst().text().contains("项目长期记忆文件：" + projectRoot.resolve(PROJECT_MEMORY)));
        assertTrue(projectOnly.getFirst().text().contains("当前估算 12 token，上限 10 token"));

        write(globalMemory, "a".repeat(11));
        assertEquals(2, monitor.checkMemoryLimits(projectRoot.toString()).size());
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(5));
        List<SystemMessageEntity> globalOnly = monitor.checkMemoryLimits(projectRoot.toString());
        assertEquals(1, globalOnly.size());
        assertTrue(globalOnly.getFirst().text().contains("全局长期记忆文件：" + globalMemory));
        write(globalMemory, "a".repeat(10));
        assertTrue(monitor.checkMemoryLimits(projectRoot.toString()).isEmpty());
    }

    @Test
    void missingFilesAndDisabledLimitsDoNotReadContent() throws IOException {
        assertTrue(monitor().checkMemoryLimits(projectRoot.toString()).isEmpty());
        write(globalMemory, "超限".repeat(20));
        write(projectRoot.resolve(PROJECT_MEMORY), "超限".repeat(20));
        MemoryMonitor disabled = new MemoryMonitor(estimator, globalMemory.toString(), 0, PROJECT_MEMORY, -1);
        assertTrue(disabled.checkMemoryLimits(projectRoot.toString()).isEmpty());
        verifyNoInteractions(estimator);
    }

    @Test
    void missingOrRelativeWorkspaceSkipsProjectButStillChecksGlobal() throws IOException {
        write(globalMemory, "a".repeat(11));
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(6));
        for (String workDir : new String[] { null, "", "  ", "relative-project" }) {
            List<SystemMessageEntity> reminders = monitor().checkMemoryLimits(workDir);
            assertEquals(1, reminders.size());
            assertTrue(reminders.getFirst().text().contains("全局长期记忆文件"));
        }
    }

    @Test
    void absoluteAndEscapingProjectConfigurationCannotReadAnotherDirectory() throws IOException {
        Path outside = directory.resolve("outside.md");
        write(outside, "a".repeat(20));
        for (String location : List.of(outside.toString(), "../outside.md")) {
            MemoryMonitor monitor = new MemoryMonitor(estimator, "", 20, location, 10);
            assertTrue(monitor.checkMemoryLimits(projectRoot.toString()).isEmpty());
        }
        verifyNoInteractions(estimator);
    }

    @Test
    void unreadableGlobalContentDoesNotHideTheProjectReminder() throws IOException {
        write(globalMemory, "placeholder");
        Files.write(globalMemory, new byte[] { (byte) 0xc3, 0x28 });
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(6));
        List<SystemMessageEntity> reminders = monitor().checkMemoryLimits(projectRoot.toString());
        assertEquals(1, reminders.size());
        assertTrue(reminders.getFirst().text().contains("项目长期记忆文件"));
    }

    @Test
    void loopHookUsesTheExecutionWorkspaceAndDoesNotAppendAgainOnTheNextRound() throws IOException {
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(6));
        Execution execution = execution(projectRoot);
        AtomicInteger appends = new AtomicInteger();
        LoopContext context = context(execution, appends);
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());

        assertSame(InterceptorResult.NONE, interceptor.onBeforeModelInvoke(context));
        assertEquals(3, execution.getMessages().size());
        assertTrue(execution.getMessages().getLast().text().contains(projectRoot.resolve(PROJECT_MEMORY).toString()));
        interceptor.onBeforeModelInvoke(context);
        assertEquals(1, appends.get());
        assertEquals(3, execution.getMessages().size());
    }

    @Test
    void fileChangesReplaceRemindersAndCompactedFilesRemoveThemWithoutTouchingUserText() throws IOException {
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(6));
        Execution execution = execution(projectRoot);
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());
        LoopContext context = context(execution, new AtomicInteger());
        interceptor.onBeforeModelInvoke(context);
        String first = execution.getMessages().getLast().text();
        UserMessageEntity user = UserMessageEntity.from(first);
        execution.getMessages().add(user);

        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(7));
        interceptor.onBeforeModelInvoke(context);
        assertEquals(4, execution.getMessages().size());
        assertTrue(execution.getMessages().getLast().text().contains("当前估算 14 token"));
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(5));
        interceptor.onBeforeModelInvoke(context);
        assertEquals(3, execution.getMessages().size());
        assertEquals(List.of("业务规则", "用户任务", first), execution.getMessages().stream().map(Message::text).toList());
        assertSame(user, execution.getMessages().getLast());
    }

    @Test
    void checkpointRestoreKeepsDeduplicationAndMissingContextGetsTheReminderAgain() throws IOException {
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(6));
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
    void singletonDoesNotMixDifferentExecutionWorkspaces() throws IOException {
        Path otherRoot = Files.createDirectories(directory.resolve("other-project"));
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(6));
        write(otherRoot.resolve(PROJECT_MEMORY), "c".repeat(3));
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());
        Execution first = execution(projectRoot);
        Execution second = execution(otherRoot);
        interceptor.onBeforeModelInvoke(context(first, new AtomicInteger()));
        interceptor.onBeforeModelInvoke(context(second, new AtomicInteger()));
        assertEquals(3, first.getMessages().size());
        assertEquals(2, second.getMessages().size());

        write(otherRoot.resolve(PROJECT_MEMORY), "c".repeat(8));
        interceptor.onBeforeModelInvoke(context(second, new AtomicInteger()));
        assertEquals(3, second.getMessages().size());
        assertTrue(second.getMessages().getLast().text().contains(otherRoot.resolve(PROJECT_MEMORY).toString()));
        assertTrue(first.getMessages().getLast().text().contains(projectRoot.resolve(PROJECT_MEMORY).toString()));
    }

    @Test
    void loopHookWithoutWorkspaceStillChecksGlobalAndAppendFailureIsNotSwallowed() throws IOException {
        write(globalMemory, "a".repeat(11));
        Execution execution = execution(null);
        MemoryMonitorInterceptor interceptor = new MemoryMonitorInterceptor(monitor());
        interceptor.onBeforeModelInvoke(context(execution, new AtomicInteger()));
        assertEquals(3, execution.getMessages().size());
        assertTrue(execution.getMessages().getLast().text().contains("全局长期记忆文件"));
        assertEquals(-825, interceptor.order());
        assertFalse(interceptor.catchErr());

        Execution fresh = execution(null);
        LoopContext failing = LoopContext.withCompactionCounter(LoopMessages.builder().execution(fresh).build(),
                null, () -> 0, messages -> { throw new IllegalStateException("注入失败"); });
        assertThrows(IllegalStateException.class, () -> interceptor.onBeforeModelInvoke(failing));
    }

    @Test
    void realApplicationYamlWiresMonitorAndRegistersTheLoopExtension() throws IOException {
        write(globalMemory, "a".repeat(1501));
        write(projectRoot.resolve(PROJECT_MEMORY), "b".repeat(1001));
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            for (PropertySource<?> source : new YamlPropertySourceLoader().load("应用配置", new ClassPathResource("application.yaml"))) {
                context.getEnvironment().getPropertySources().addLast(source);
            }
            assertEquals("3000", context.getEnvironment().getProperty("lingxi.memory.project.max-tokens"));
            context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("记忆测试", Map.of(
                    "lingxi.memory.global.location", globalMemory.toString(), "project.root", projectRoot.toString(),
                    "lingxi.memory.project.max-tokens", 2000)));
            context.registerBean(PropertySourcesPlaceholderConfigurer.class);
            context.registerBean(TokenEstimator.class, () -> estimator);
            context.scan("com.summit.dp.workflow.infrastructure.memory");
            context.refresh();

            List<SystemMessageEntity> reminders = context.getBean(MemoryMonitor.class).checkMemoryLimits(projectRoot.toString());
            assertEquals(2, reminders.size());
            assertTrue(reminders.getFirst().text().contains("上限 2000 token"));
            assertTrue(reminders.getLast().text().contains("上限 3000 token"));
            assertEquals(1, context.getBeansOfType(LoopInterceptor.class).size());
            String prompt = context.getEnvironment().getProperty("lingxi.system-prompt");
            assertTrue(prompt.contains(globalMemory.toString()));
            assertTrue(prompt.contains(projectRoot + "/" + PROJECT_MEMORY));
            assertTrue(prompt.contains("项目长期记忆上限 2000 token"));
        }
    }

    private MemoryMonitor monitor() {
        return new MemoryMonitor(estimator, globalMemory.toString(), 20, PROJECT_MEMORY, 10);
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
