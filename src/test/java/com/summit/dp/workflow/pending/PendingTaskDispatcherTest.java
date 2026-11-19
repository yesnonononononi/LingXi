package com.summit.dp.workflow.pending;

import cn.hutool.core.codec.Base64;
import com.summit.core.agent.Image;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.ExecutionContext;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.application.chat.RuntimeContextTestSupport;
import com.summit.dp.workflow.application.pending.PendingTaskAdmission;
import com.summit.dp.workflow.application.pending.PendingTaskBootSweeper;
import com.summit.dp.workflow.application.pending.PendingTaskDispatcher;
import com.summit.dp.workflow.application.pending.PendingTaskService;
import com.summit.dp.workflow.application.pending.PendingTaskSnapshot;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.multipart.MultipartFile;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.*;

/**
 * 接力派发：什么时候发、发什么、以及「行没删掉就不许当它发过了」。
 *
 * <p>这些用例盯的都是**静默**失败的形态：排队消息永远不发出、图片在派发时变成空、
 * 同一句话被发两轮 —— 三者都不会抛异常，只能靠断言钉住。</p>
 */
class PendingTaskDispatcherTest {

    private static final long SESSION = 900L;

    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final PreparedChatExecutor chatExecutor = mock(PreparedChatExecutor.class);
    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();
    private final ExecutionQueryService executionStates = mock(ExecutionQueryService.class);
    private final SessionRepository sessions = mock(SessionRepository.class);
    private final PendingTaskTestSupport.InMemoryRepository rows = new PendingTaskTestSupport.InMemoryRepository();
    private final PendingTaskTestSupport.InMemoryAttachmentStore files = new PendingTaskTestSupport.InMemoryAttachmentStore();
    private final PendingTaskService service = new PendingTaskService(rows, files);
    private final PendingTaskDispatcher dispatcher = new PendingTaskDispatcher(service, files,
            new PendingTaskAdmission(chatExecutor, rows, registry),
            requestPreparer, chatExecutor, registry, executionStates, sessions);

    @BeforeEach
    void idleRootSession() {
        when(executionStates.latestStatesBySession(any())).thenReturn(Map.of());
        when(sessions.findById(SESSION)).thenReturn(Optional.of(
                Session.builder().id(SESSION).rootSessionId(0L).build()));
    }

    private static ChatCommand command(String input, MockMultipartFile... images) {
        List<MultipartFile> attached = new ArrayList<>(List.of(images));
        return new ChatCommand(input, SESSION, 7L, 3L, null, 9L, false, attached, List.of());
    }

    private static MockMultipartFile image(String name, byte[] data) {
        return new MockMultipartFile("image", name, "image/png", data);
    }

    private static RuntimeContext context(String executionId) {
        ExecutionContext executionContext = ExecutionContext.root(SESSION, executionId,
                null, 7L, AgentPermissionMode.FULL_ACCESS);
        return RuntimeContextTestSupport.beforeAdmission(executionContext, null, null,
                SessionVO.builder().id(SESSION).build(), List.of(), null, null,
                AgentPermissionMode.FULL_ACCESS, false, null);
    }

    @Test
    @SuppressWarnings("unchecked")
    void dispatchRebuildsImagesFromDiskAndClearsTheRow() {
        byte[] data = {1, 2, 3, 4};
        service.enqueue(SESSION, command("这两张图有什么区别", image("a.png", data)));
        RuntimeContext prepared = context("e1");
        when(requestPreparer.prepare(any(ChatCommand.class), anyList())).thenReturn(prepared);
        when(chatExecutor.admit(prepared)).thenReturn(prepared.withTurnId(7L));

        dispatcher.relay(SESSION);

        ArgumentCaptor<List<Image>> images = ArgumentCaptor.forClass(List.class);
        verify(requestPreparer).prepare(any(ChatCommand.class), images.capture());
        verify(requestPreparer, never()).prepare(any(ChatCommand.class));
        assertEquals(1, images.getValue().size());
        assertArrayEquals(data, Base64.decode(images.getValue().getFirst().getBase64Data()),
                "派发必须按磁盘上的原字节构造图片，不能退化成只发文本");
        assertEquals("image/png", images.getValue().getFirst().mimeType());

        verify(chatExecutor).submitAsync(prepared.withTurnId(7L));
        assertFalse(service.hasPending(SESSION), "受理成功后再查，任务行必须已经不在了");
        assertEquals(0, files.fileCount(), "轮次已经落库，排队期间的临时附件必须清掉");
    }

    @Test
    void doesNotDispatchWhileTheSessionStillRuns() {
        service.enqueue(SESSION, command("排队"));
        registry.beginRoot(SESSION, "e0");

        dispatcher.relay(SESSION);

        verifyNoInteractions(requestPreparer, chatExecutor);
    }

    @Test
    void legacyPendingRowWaitsForUserInsteadOfAutoDispatching() {
        service.enqueue(SESSION, command("上次进程崩溃前没发出去"));

        new PendingTaskBootSweeper(rows).markLegacyTasks();
        dispatcher.relay(SESSION);

        verifyNoInteractions(requestPreparer, chatExecutor);
        PendingTaskSnapshot snapshot = service.snapshot(SESSION);
        assertEquals(1, snapshot.entries().size());
        assertEquals("AWAITING_CONFIRM", snapshot.entries().getFirst().status(),
                "崩溃遗留必须落成待确认：上下文可能已经变了，不能替用户决定往下跑");
        assertFalse(snapshot.entries().getFirst().dispatching());
    }

    @Test
    void rowDeleteFailureDoesNotSubmitTheTurn() {
        service.enqueue(SESSION, command("只发一次"));
        rows.failOnDelete();
        RuntimeContext prepared = context("e1");
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(prepared);
        when(chatExecutor.admit(prepared)).thenReturn(prepared.withTurnId(7L));

        dispatcher.relay(SESSION);

        verify(chatExecutor, never()).submitAsync(any());
        PendingTaskSnapshot snapshot = service.snapshot(SESSION);
        assertEquals(1, snapshot.entries().size(), "行没删掉就不能当它已经发过了");
        assertEquals("PAUSED", snapshot.entries().getFirst().status());
        assertTrue(snapshot.paused());
    }
}
