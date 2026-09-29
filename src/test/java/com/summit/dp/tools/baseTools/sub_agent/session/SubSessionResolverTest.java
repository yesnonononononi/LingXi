package com.summit.dp.tools.baseTools.sub_agent.session;

import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.TokenUsage;
import com.summit.dp.session.domain.repo.SessionRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 「按 {@code (root_session_id, agent_id)} 优先复用已有子会话」的回归守卫。
 *
 * <p>核心契约两条：命中时<b>不再新建 session 行</b>（否则同一次协作会在列表里堆出重复子会话），
 * 且把该子会话的既有 {@code session_context} 作为本次执行的历史一并交给子 Agent
 * （{@code AgentRequest.messages} 是执行期历史的唯一来源，不交出去模型就「失忆」）。</p>
 */
class SubSessionResolverTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long CHILD_AGENT_ID = 7L;
    private static final long EXISTING_SUB_SESSION_ID = 555L;

    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);

    private final SubSessionResolver resolver = new SubSessionResolver(sessionRepository, modelContextService);

    private AgentVO childAgent() {
        AgentVO agent = new AgentVO();
        agent.setId(CHILD_AGENT_ID);
        agent.setName("架构师");
        return agent;
    }

    private Session existingSubSession() {
        return Session.builder()
                .id(EXISTING_SUB_SESSION_ID)
                .rootSessionId(ROOT_SESSION_ID)
                .agentId(CHILD_AGENT_ID)
                .name("架构师")
                .tokenUsage(TokenUsage.empty())
                .build();
    }

    @Test
    @DisplayName("命中已有子会话：复用其 id 并带上既有历史")
    void reusesExistingSubSessionWithHistory() {
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.of(existingSubSession()));
        List<Message> prior = List.of(UserMessageEntity.from("上次的任务"));
        when(modelContextService.find(EXISTING_SUB_SESSION_ID)).thenReturn(Optional.of(prior));

        SubSessionTarget target = resolver.resolve(ROOT_SESSION_ID, childAgent());

        assertTrue(target.reused(), "命中必须标记为复用");
        assertEquals(String.valueOf(EXISTING_SUB_SESSION_ID), target.subSessionId());
        assertEquals(EXISTING_SUB_SESSION_ID, target.numericSubSessionId());
        assertEquals(prior, target.priorMessages(), "历史必须一并带出，否则子 Agent 失忆");
        // 解析阶段只读：建行时机由调用方在取消校验之后决定
        verify(sessionRepository, never()).saveAndReturnId(any());
    }

    @Test
    @DisplayName("未命中：派生新 id，且不动会话表")
    void derivesFreshIdWhenNoneExists() {
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.empty());

        SubSessionTarget target = resolver.resolve(ROOT_SESSION_ID, childAgent());

        assertFalse(target.reused(), "未命中不是复用");
        assertNotEquals(String.valueOf(EXISTING_SUB_SESSION_ID), target.subSessionId());
        assertTrue(target.priorMessages().isEmpty(), "首派上下文只有本次任务，不带历史");
        assertTrue(Long.parseLong(target.subSessionId()) > 0L, "派生 id 必须是可用的雪花值");
    }

    @Test
    @DisplayName("已有子会话但上下文已丢失：复用不失败，退化为空历史（绝不回退成派生）")
    void degradesToEmptyHistoryWhenContextMissing() {
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.of(existingSubSession()));
        when(modelContextService.find(EXISTING_SUB_SESSION_ID)).thenReturn(Optional.empty());

        SubSessionTarget target = resolver.resolve(ROOT_SESSION_ID, childAgent());

        assertTrue(target.reused(), "上下文缺失也必须复用同一子会话，不得另派生");
        assertEquals(String.valueOf(EXISTING_SUB_SESSION_ID), target.subSessionId());
        assertTrue(target.priorMessages().isEmpty());
    }

    @Test
    @DisplayName("根会话 id 为空：无法建立复用键，直接派生且不查库")
    void derivesWhenRootSessionMissing() {
        SubSessionTarget target = resolver.resolve(null, childAgent());

        assertFalse(target.reused());
        verifyNoInteractions(sessionRepository, modelContextService);
    }

    @Test
    @DisplayName("首次委派落库：写入复用键两半（root_session_id + agent_id）与截断后的会话名")
    void createSubSessionWritesReuseKey() {
        resolver.createSubSession(999L, ROOT_SESSION_ID, 42L, childAgent(), "任意任务");

        ArgumentCaptor<Session> captor = ArgumentCaptor.forClass(Session.class);
        verify(sessionRepository).saveAndReturnId(captor.capture());
        Session saved = captor.getValue();
        assertEquals(999L, saved.getId());
        assertEquals(ROOT_SESSION_ID, saved.getRootSessionId());
        assertEquals(CHILD_AGENT_ID, saved.getAgentId(), "agent_id 是复用键的另一半，必须写入");
        assertEquals(42L, saved.getWorkspaceId());
        assertEquals("架构师", saved.getName());
    }

    @Test
    @DisplayName("无根会话时落库：root_session_id 写 0 表示自身即根，不写 null")
    void createSubSessionFallsBackToSelfRoot() {
        resolver.createSubSession(999L, null, null, childAgent(), "任意任务");

        ArgumentCaptor<Session> captor = ArgumentCaptor.forClass(Session.class);
        verify(sessionRepository).saveAndReturnId(captor.capture());
        assertEquals(Session.ROOT_SESSION_ID, captor.getValue().getRootSessionId());
    }

    @Test
    @DisplayName("子代理无名时退化用任务摘要，超长会话名按码点截断到上限")
    void subSessionNameFallsBackToTaskAndTruncates() {
        AgentVO nameless = new AgentVO();
        nameless.setId(CHILD_AGENT_ID);

        resolver.createSubSession(1L, ROOT_SESSION_ID, null, nameless, "  写  一份  报告  ");
        ArgumentCaptor<Session> first = ArgumentCaptor.forClass(Session.class);
        verify(sessionRepository).saveAndReturnId(first.capture());
        assertEquals("写 一份 报告", first.getValue().getName(), "空白需归一化");

        String longTask = "任".repeat(Session.MAX_SESSION_NAME_LENGTH + 50);
        resolver.createSubSession(2L, ROOT_SESSION_ID, null, nameless, longTask);
        ArgumentCaptor<Session> second = ArgumentCaptor.forClass(Session.class);
        verify(sessionRepository, org.mockito.Mockito.times(2)).saveAndReturnId(second.capture());
        assertEquals(Session.MAX_SESSION_NAME_LENGTH, second.getAllValues().get(1).getName().length());
    }
}
