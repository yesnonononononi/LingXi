package com.summit.dp.session;

import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 会话创建与团队换绑的写路径回归：initialize 落库的会话元数据契约，以及
 * {@code bindTeam} 的「换绑 / 解绑 / 目标团队校验」语义。
 *
 * <p>「新会话即空闲」不再以会话字段承载——会话聚合已不持有执行状态，运行态由
 * {@code ExecutionQueryService} 查询时组合（见 {@code SessionViewRunStatusTest}）。
 * 本测试只守护与状态无关的写契约：团队绑定随会话落库、可变。</p>
 */
class SessionInitializeStatusTest {

    private static final long SESSION_ID = 100L;
    private static final long TEAM_ID = 3L;
    private static final long OTHER_TEAM_ID = 9L;

    private final SessionAggregateService aggregate = mock(SessionAggregateService.class);
    private final TeamService teamService = mock(TeamService.class);

    private SessionServiceImpl service() {
        return new SessionServiceImpl(aggregate, mock(WorkspaceService.class),
                mock(SessionRepository.class), mock(SessionMessageQueryService.class),
                mock(ExecutionQueryService.class), teamService, mock(AgentRepository.class),
                mock(ChatTurnService.class), new ChatTurnConverter(), mock(TurnViewService.class));
    }

    @Test
    @DisplayName("initialize 首轮绑定团队：teamId 非空时随会话落库")
    void initializeBindsTeamIdOnCreation() {
        when(aggregate.save(any(Session.class))).thenReturn(SESSION_ID);

        service().initialize("你好，帮我看看这个报错", null, TEAM_ID);

        ArgumentCaptor<Session> captured = ArgumentCaptor.forClass(Session.class);
        verify(aggregate).save(captured.capture());
        assertEquals(TEAM_ID, captured.getValue().getTeamId());
    }

    @Test
    @DisplayName("bindTeam 换绑：目标团队存在时写入新绑定并落库（前端下拉框选中的落点）")
    void bindTeamRebindsExistingSession() {
        Session session = boundSession(TEAM_ID);
        when(aggregate.requireOwned(SESSION_ID)).thenReturn(session);
        when(teamService.findById(OTHER_TEAM_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(
                        TeamVO.builder().id(OTHER_TEAM_ID).name("新团队").commanderAgentId(7L).build()));

        service().bindTeam(SESSION_ID, OTHER_TEAM_ID);

        assertEquals(OTHER_TEAM_ID, session.getTeamId(), "领域方法 changeTeam 改写了绑定");
        verify(aggregate).save(session);
    }

    @Test
    @DisplayName("bindTeam 传 null：解绑回非团队会话（下拉框清空即解绑）")
    void bindTeamWithNullUnbinds() {
        Session session = boundSession(TEAM_ID);
        when(aggregate.requireOwned(SESSION_ID)).thenReturn(session);

        service().bindTeam(SESSION_ID, null);

        assertNull(session.getTeamId(), "解绑后回到非团队会话");
        verify(teamService, never()).findById(anyLong());
        verify(aggregate).save(session);
    }

    @Test
    @DisplayName("bindTeam 目标团队不存在：拒绝换绑，不落库")
    void bindTeamRejectsUnknownTeam() {
        Session session = boundSession(TEAM_ID);
        when(aggregate.requireOwned(SESSION_ID)).thenReturn(session);
        when(teamService.findById(OTHER_TEAM_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(null));

        org.junit.jupiter.api.Assertions.assertThrows(
                com.summit.dp.shared.exception.ClientException.class,
                () -> service().bindTeam(SESSION_ID, OTHER_TEAM_ID));

        assertEquals(TEAM_ID, session.getTeamId(), "校验失败不得改动原绑定");
        verify(aggregate, never()).save(any(Session.class));
    }

    private static Session boundSession(Long teamId) {
        return Session.builder().id(SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID)
                .name("团队会话").teamId(teamId).build();
    }
}
