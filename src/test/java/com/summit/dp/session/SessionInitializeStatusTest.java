package com.summit.dp.session;

import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 会话创建挂点回归：initialize 落库的会话元数据契约。
 *
 * <p>「新会话即空闲」不再以会话字段承载——会话聚合已不持有执行状态，运行态由
 * {@code ExecutionQueryService} 查询时组合（见 {@code SessionViewRunStatusTest}）。
 * 本测试只守护与状态无关的创建契约：首轮团队绑定随会话落库。</p>
 */
class SessionInitializeStatusTest {

    @Test
    @DisplayName("initialize 首轮绑定团队：teamId 非空时随会话落库")
    void initializeBindsTeamIdOnCreation() {
        SessionAggregateService aggregate = mock(SessionAggregateService.class);
        when(aggregate.save(any(Session.class))).thenReturn(100L);
        SessionServiceImpl service = new SessionServiceImpl(aggregate, mock(WorkspaceService.class),
                mock(SessionRepository.class), mock(SessionMessageQueryService.class),
                mock(SettingsProvider.class), mock(ExecutionQueryService.class));

        service.initialize("你好，帮我看看这个报错", null, 3L);

        ArgumentCaptor<Session> captured = ArgumentCaptor.forClass(Session.class);
        verify(aggregate).save(captured.capture());
        assertEquals(3L, captured.getValue().getTeamId());
    }
}
