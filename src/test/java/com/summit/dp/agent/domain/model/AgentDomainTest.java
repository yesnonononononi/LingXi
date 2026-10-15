package com.summit.dp.agent.domain.model;

import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code Agent} 领域不变量：变更方法必须「要么改，要么抛」，不得静默丢弃非法输入。
 *
 * <p>静默忽略会让前端以为改成功了、后端却返回成功却没改——所以统一 fail-loud，
 * 抛 {@link ClientException}（全局异常处理器认它，不会退化成 HTTP 500）。</p>
 */
class AgentDomainTest {

    private Agent agent() {
        return Agent.builder().id(1L).build();
    }

    @Test
    @DisplayName("名称空白或超长：抛业务异常，不得静默忽略")
    void rejectsBlankAndOverlongName() {
        assertThrows(ClientException.class, () -> agent().changeName(null));
        assertThrows(ClientException.class, () -> agent().changeName("   "));

        ClientException tooLong = assertThrows(ClientException.class,
                () -> agent().changeName("x".repeat(Agent.NAME_MAX_LENGTH + 1)));
        assertTrue(tooLong.getMessage().contains(String.valueOf(Agent.NAME_MAX_LENGTH)),
                "提示必须带上长度上限，便于定位：" + tooLong.getMessage());
    }

    @Test
    @DisplayName("名称合法：写入并刷新更新时间")
    void acceptsValidName() {
        Agent agent = agent();
        agent.changeName("客服助手");
        assertEquals("客服助手", agent.getName());
        assertNotNull(agent.getUpdateAt());
    }

    @Test
    @DisplayName("模型标识为空：拒绝")
    void rejectsNullModelId() {
        assertThrows(ClientException.class, () -> agent().changeModelId(null));
    }

    @Test
    @DisplayName("提示词空或超长：拒绝；合法则写入")
    void validatesPrompt() {
        assertThrows(ClientException.class, () -> agent().changePrompt(null));
        assertThrows(ClientException.class, () -> agent().changePrompt("  "));
        assertThrows(ClientException.class, () -> agent().changePrompt("p".repeat(Agent.PROMPT_MAX_LENGTH + 1)));

        Agent agent = agent();
        agent.changePrompt("你是助手");
        assertEquals("你是助手", agent.getPrompt());
    }

    @Test
    @DisplayName("描述超长：拒绝；空串可清空")
    void validatesDescription() {
        assertThrows(ClientException.class,
                () -> agent().changeDescription("d".repeat(Agent.DESCRIPTION_MAX_LENGTH + 1)));

        Agent agent = agent();
        agent.changeDescription("描述");
        assertEquals("描述", agent.getDescription());
        agent.changeDescription("");
        assertEquals("", agent.getDescription());
    }

    @Test
    @DisplayName("头像超长：拒绝；空串清空为 null")
    void validatesAvatar() {
        assertThrows(ClientException.class,
                () -> agent().changeAvatar("a".repeat(Agent.AVATAR_MAX_LENGTH + 1)));

        Agent agent = agent();
        agent.changeAvatar("🙂");
        assertEquals("🙂", agent.getAvatar());
        agent.changeAvatar("");
        assertNull(agent.getAvatar());
    }

    @Test
    @DisplayName("工具清单为空引用：拒绝；超量：拒绝；含空白项：拒绝")
    void rejectsInvalidToolList() {
        assertThrows(ClientException.class, () -> agent().changeTools(null));
        assertThrows(ClientException.class, () -> agent().changeTools(overSizedTools()));
        assertThrows(ClientException.class, () -> agent().changeTools(List.of("read_file", " ")));
    }

    @Test
    @DisplayName("工具清单合法：整体替换，空清单是合法结果")
    void acceptsValidToolList() {
        Agent agent = agent();
        agent.changeTools(List.of("read_file", "edit_file"));
        assertEquals(List.of("read_file", "edit_file"), agent.getToolList());

        agent.changeTools(List.of());
        assertEquals(List.of(), agent.getToolList());
    }

    @Test
    @DisplayName("状态变更：写入数值")
    void changesStatus() {
        Agent agent = agent();
        agent.changeStatus(Agent.STATUS_ENABLED);
        assertEquals(Agent.STATUS_ENABLED, agent.getStatus());
    }

    private static List<String> overSizedTools() {
        List<String> tools = new ArrayList<>();
        for (int i = 0; i <= Agent.TOOL_MAX_SIZE; i++) {
            tools.add("tool_" + i);
        }
        return tools;
    }
}
