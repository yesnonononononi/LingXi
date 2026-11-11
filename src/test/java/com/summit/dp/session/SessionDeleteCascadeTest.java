package com.summit.dp.session;

import com.summit.dp.checklist.domain.repository.ChecklistRepository;
import com.summit.dp.execution.application.service.ExecutionSessionCleanupService;
import com.summit.dp.session.application.port.SessionDeletionGuard;
import com.summit.dp.session.application.port.SessionImageCache;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionDataPurger;
import com.summit.dp.session.application.service.SessionNodeDeletion;
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
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.lang.reflect.Method;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
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

    /** 顺序是契约：先解析树、再问执行、然后逐会话删行、再清附属数据。 */
    @Test
    void guardRunsBeforeAnyDeletion() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionDeletionGuard guard = mock(SessionDeletionGuard.class);
        SessionAggregateService aggregate = aggregate(sessions, guard);
        when(sessions.resolveTreeIds(7L)).thenReturn(TREE);

        aggregate.deleteById(7L);

        InOrder order = inOrder(sessions, guard, messages);
        order.verify(sessions).resolveTreeIds(7L);
        order.verify(guard).requireNoRunningExecution(TREE);
        order.verify(sessions).deleteByIds(List.of(12L));
        order.verify(messages).batchDelBySessionIds(List.of(12L));
    }

    /**
     * 一个会话一个短事务：整棵树不再打包成一个大事务。
     *
     * <p>子会话（后建、id 更大）先删，根会话最后删 —— 根行一消失，列表里就看不到这棵树，
     * 剩下的子会话也不会在删除中途被人打开。</p>
     */
    @Test
    void deletesEachSessionInItsOwnNodeLeafFirst() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionDeletionGuard guard = mock(SessionDeletionGuard.class);
        SessionAggregateService aggregate = aggregate(sessions, guard);
        when(sessions.resolveTreeIds(7L)).thenReturn(TREE);

        aggregate.deleteById(7L);

        InOrder order = inOrder(sessions, executions);
        order.verify(sessions).deleteByIds(List.of(12L));
        order.verify(executions).deleteBySessions(List.of(12L));
        order.verify(sessions).deleteByIds(List.of(11L));
        order.verify(executions).deleteBySessions(List.of(11L));
        verify(sessions, never()).deleteByIds(TREE);
    }

    /** 反向守护：入口方法自己不能带事务，否则又会退化成「整棵树一个大事务」。 */
    @Test
    void entryPointCarriesNoTransactionOfItsOwn() throws NoSuchMethodException {
        Method entry = SessionAggregateService.class.getMethod("deleteById", Long.class);

        assertNull(AnnotatedElementUtils.findMergedAnnotation(entry, Transactional.class),
                "deleteById 不能自带事务：事务边界必须落在单个会话上");
    }

    /** 反向守护：单会话删除必须是独立新事务，否则仍会被外层事务拉成一个长事务。 */
    @Test
    void singleNodeDeletionRunsInItsOwnTransaction() throws NoSuchMethodException {
        Transactional tx = SessionNodeDeletion.class.getMethod("deleteNode", Long.class)
                .getAnnotation(Transactional.class);

        assertNotNull(tx, "deleteNode 必须声明事务，且是 REQUIRES_NEW");
        assertEquals(Propagation.REQUIRES_NEW, tx.propagation());
    }

    @Test
    void rejectedDeletionLeavesEverythingInPlace() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionDeletionGuard guard = mock(SessionDeletionGuard.class);
        SessionAggregateService aggregate = aggregate(sessions, guard);
        when(sessions.resolveTreeIds(7L)).thenReturn(TREE);
        doThrow(new ClientException("会话仍在执行中，请先停止后再删除"))
                .when(guard).requireNoRunningExecution(TREE);

        assertThrows(ClientException.class, () -> aggregate.deleteById(7L));

        verify(sessions, never()).deleteByIds(anyList());
        verify(messages, never()).batchDelBySessionIds(anyList());
        verifyNoInteractions(images, executions, contexts);
    }

    private SessionAggregateService aggregate(SessionRepository sessions, SessionDeletionGuard guard) {
        return new SessionAggregateService(sessions, messages, turns, guard,
                new SessionNodeDeletion(sessions, purger), mock(ApplicationEventPublisher.class));
    }
}
