package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workspace.application.convert.LingXiWorkspaceSpec;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class MemoryWikiPromptTest {
    @TempDir Path project;
    private final ObjectMapper json = new JsonConfig().objectMapper();
    @SuppressWarnings("unchecked")
    private final ObjectProvider<MemoryWikiManager> managers = mock(ObjectProvider.class);
    private final WorkspaceResolver workspaces = mock(WorkspaceResolver.class);
    private final MemoryWikiIndexCache indexes = new MemoryWikiIndexCache();

    @Test
    void builderLoadsBoundedCatalogIntoTheRequestWithoutChangingMessagesOrRuntimeAttributes() throws Exception {
        Path directory = Files.createDirectories(project.resolve("wiki"));
        for (int index = 0; index < 40; index++) {
            Files.writeString(directory.resolve("module-%02d.md".formatted(index)), "不应进入初始上下文的正文".repeat(1000));
        }
        BusinessSystemPromptBuilder builder = builder();
        List<Message> history = List.of(UserMessageEntity.from("用户任务"));
        String prompt = builder.buildRootPrompt("角色规则", null, spec(project));
        AgentRequest request = AgentRequest.builder().messages(history).systemPrompt(prompt).build();
        assertTrue(prompt.startsWith("固定全局规则\n\n角色规则\n\n"));
        assertTrue(prompt.contains("\"total\":40"));
        assertTrue(prompt.contains("\"returned\":30"));
        assertTrue(prompt.contains("module-29.md"));
        assertFalse(prompt.contains("module-30.md"));
        assertFalse(prompt.contains("不应进入初始上下文的正文"));
        assertTrue(prompt.contains("search_wiki"));
        assertTrue(prompt.contains("load_memory"));
        assertTrue(prompt.contains("模块名.md"));
        assertSame(history, request.getMessages());
        assertTrue(request.runtimeParametersOrDefault().getAttributes().isEmpty());
        Execution restored = json.readValue(json.writeValueAsString(Execution.create(request, "chat")), Execution.class);
        assertEquals(prompt, restored.getAgentRequest().getSystemPrompt());
        verify(managers, times(1)).getObject();
    }

    @Test
    void cachedProjectCatalogsKeepPromptsStableWhenFilesAreAddedOutsideTheIndex() throws Exception {
        Path first = Files.createDirectories(project.resolve("first/wiki"));
        Path second = Files.createDirectories(project.resolve("second/wiki"));
        Files.writeString(first.resolve("first.md"), "甲");
        Files.writeString(second.resolve("second.md"), "乙");
        BusinessSystemPromptBuilder builder = builder();
        String initial = builder.buildRootPrompt("角色规则", null, spec(first.getParent()));
        assertEquals(initial, builder.buildRootPrompt("角色规则", null, spec(first.getParent())));
        String changed = builder.buildRootPrompt("角色规则", null, spec(second.getParent()));
        assertTrue(changed.contains("second.md"));
        assertFalse(changed.contains("first.md"));
        Files.writeString(first.resolve("new.md"), "新模块");
        assertEquals(initial, builder.buildRootPrompt("角色规则", null, spec(first.getParent())));
        verify(managers, times(4)).getObject();
    }

    @Test
    void memberPromptReceivesTheSameRulesAndItsOwnProjectCatalog() throws Exception {
        Files.createDirectories(project.resolve("wiki"));
        Files.writeString(project.resolve("wiki/member.md"), "成员模块");
        AgentVO member = new AgentVO();
        member.setId(6L);
        member.setPrompt("成员职责");
        String prompt = builder().buildMemberPrompt(member, null, "交付任务", spec(project));
        assertTrue(prompt.startsWith("成员职责"));
        assertTrue(prompt.contains("交付任务"));
        assertTrue(prompt.contains("三层记忆规则"));
        assertTrue(prompt.contains("member.md"));
    }

    @Test
    void missingProjectAndDirectoryFailuresRemainNonBlockingDuringPromptConstruction() {
        BusinessSystemPromptBuilder builder = builder();
        String unselected = assertDoesNotThrow(() -> builder.buildRootPrompt("角色规则", null, null));
        assertTrue(unselected.contains("可以继续交流"));
        verifyNoInteractions(managers, workspaces);
        doThrow(new IllegalStateException("目录暂时不可用")).when(workspaces).resolve(any());
        String unavailable = assertDoesNotThrow(() -> builder.buildRootPrompt("角色规则", null, spec(project)));
        assertTrue(unavailable.contains("仍可继续当前任务"));
    }

    private BusinessSystemPromptBuilder builder() {
        doAnswer(invocation -> new MemoryWikiManager("wiki", indexes)).when(managers).getObject();
        doAnswer(invocation -> {
            WorkspaceSpec workspace = invocation.getArgument(0);
            return new LocalWorkspace("bound", workspace.workDir());
        }).when(workspaces).resolve(any());
        return new BusinessSystemPromptBuilder("固定全局规则",
                new MemoryWikiPromptLoader(managers, workspaces, json, "三层记忆规则"));
    }

    private WorkspaceSpec spec(Path root) {
        return new LingXiWorkspaceSpec("local", root.toString(), Map.of());
    }
}
