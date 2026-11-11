package com.summit.dp.session;

import com.summit.dp.checklist.domain.repository.ChecklistRepository;
import com.summit.dp.execution.application.service.ExecutionSessionCleanupService;
import com.summit.dp.session.application.port.SessionDeletionGuard;
import com.summit.dp.session.application.port.SessionImageCache;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionDataPurger;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.context.ApplicationEventPublisher;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.*;

/**
 * 删会话必须把「属于这个会话的一切」都带走。
 *
 * <p>这类缺陷的表现不在报错，而在磁盘与表缓慢膨胀：漏掉一行删语句，那批数据就再没人回收。
 * 因此每个存储都必须被显式点名验证 —— 少一个就是红。</p>
 */
class SessionDeleteCascadeTest {

    private static final List<Long> TREE = List.of(11L, 12L);

    private final MessageRepository messages = mock(MessageRepository.class);
    private final ChatTurnRepository turns = mock(ChatTurnRepository.class);
    private final TaskRepository tasks = mock(TaskRepository.class);
    private final ChecklistRepository checklists = mock(ChecklistRepository.class);
    private final SessionTokenAuditRepository tokenAudits = mock(SessionTokenAuditRepository.class);
    private final ToolCallRepository toolCalls = mock(ToolCallRepository.class);
    private final ExecutionSessionCleanupService executions = mock(ExecutionSessionCleanupService.class);
    private final ModelContextService contexts = mock(ModelContextService.class);
    private final SessionImageCache images = mock(SessionImageCache.class);

    private final SessionDataPurger purger = new SessionDataPurger(messages, turns, tasks, checklists, tokenAudits,
            toolCalls, executions, contexts, images);

    @Test
    void purgesEveryStoreOwnedByTheSessionTree() {
        purger.purge(TREE);

        verify(messages).batchDelBySessionIds(TREE);
        verify(turns).deleteBySessionIds(TREE);
        verify(tasks).deleteBySessionIds(TREE);
        verify(checklists).deleteBySessionIds(TREE);
        verify(tokenAudits).deleteBySessionIds(TREE);
        verify(toolCalls).deleteByConversationIds(TREE);
        verify(executions).deleteBySessions(TREE);
        verify(contexts).deleteBySessionIds(TREE);
        verify(images).deleteSessions(TREE);
    }

    @Test
    void emptySessionSetTouchesNothing() {
        purger.purge(List.of());

        verifyNoInteractions(messages, turns, tasks, checklists, tokenAudits, toolCalls, executions, contexts,
                images);
    }

    /** 顺序是契约：先解析树、再问执行、然后删行、最后清附属数据。 */
    @Test
    void guardRunsBeforeAnyDeletion() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionDeletionGuard guard = mock(SessionDeletionGuard.class);
        SessionAggregateService aggregate = new SessionAggregateService(sessions, messages, turns, guard, purger,
                mock(ApplicationEventPublisher.class));
        when(sessions.resolveTreeIds(7L)).thenReturn(TREE);

        aggregate.deleteById(7L);

        InOrder order = inOrder(sessions, guard, messages);
        order.verify(sessions).resolveTreeIds(7L);
        order.verify(guard).requireNoRunningExecution(TREE);
        order.verify(sessions).delSessionTreeByRootSId(7L);
        order.verify(messages).batchDelBySessionIds(TREE);
    }

    @Test
    void rejectedDeletionLeavesEverythingInPlace() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionDeletionGuard guard = mock(SessionDeletionGuard.class);
        SessionAggregateService aggregate = new SessionAggregateService(sessions, messages, turns, guard, purger,
                mock(ApplicationEventPublisher.class));
        when(sessions.resolveTreeIds(7L)).thenReturn(TREE);
        doThrow(new ClientException("会话仍在执行中，请先停止后再删除"))
                .when(guard).requireNoRunningExecution(TREE);

        assertThrows(ClientException.class, () -> aggregate.deleteById(7L));

        verify(sessions, never()).delSessionTreeByRootSId(anyLong());
        verify(messages, never()).batchDelBySessionIds(anyList());
        verifyNoInteractions(images, executions, contexts);
    }
}
