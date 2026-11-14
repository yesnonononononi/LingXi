package com.summit.dp.session;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.summit.core.audit.AuditStatus;
import com.summit.core.audit.DocumentElement;
import com.summit.core.audit.token.OtherTokens;
import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.core.audit.token.tool.ToolAuditDocument;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.application.convert.TokenAuditConverter;
import com.summit.dp.session.application.convert.TokenAuditFrameworkViewConverter;
import com.summit.dp.session.application.port.TokenAuditBroadcaster;
import com.summit.dp.session.application.service.SessionTokenAuditCollector;
import com.summit.dp.session.application.service.SessionTokenAuditQueryService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.TokenAuditDisplayState;
import com.summit.dp.session.domain.model.TokenAuditPersistedState;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * 采集器（{@link SessionTokenAuditCollector}）的纯单测：归属解析、覆盖裁决、失败不覆盖、广播载荷。
 *
 * <p>本类<b>不</b>证明「谁来调用它」—— 那是统一 listener 的接线职责（见交付说明的接线待办）。
 * 它只锁住 collector 自己的四条契约：</p>
 * <ol>
 *   <li>归属解析元数据优先、定位器兜底，解析不到就静默丢弃（不抛异常打断执行流）；</li>
 *   <li>更早的采集不得覆盖更新的快照；</li>
 *   <li>已有 {@code COLLECTED} 时失败只记日志，不改库、不广播；</li>
 *   <li>采集成功后按<b>根会话</b>广播，载荷与 GET 同构。</li>
 * </ol>
 */
class SessionTokenAuditCollectorTest {

    private static final long SESSION_ID = 700001L;
    private static final long ROOT_SESSION_ID = 700000L;

    private final SessionTokenAuditRepository auditRepository = mock(SessionTokenAuditRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ExecutionLocator executionLocator = mock(ExecutionLocator.class);
    private final SessionTokenAuditQueryService queryService = mock(SessionTokenAuditQueryService.class);
    private final TokenAuditBroadcaster publisher = mock(TokenAuditBroadcaster.class);
    private final ObjectProvider<TokenAuditBroadcaster> broadcasters = broadcasterProvider(publisher);

    private final SessionTokenAuditCollector collector = new SessionTokenAuditCollector(auditRepository,
            sessionRepository, executionLocator, new TokenAuditConverter(), queryService, broadcasters);

    @BeforeEach
    void acceptSnapshots() {
        when(auditRepository.replaceSnapshot(any())).thenReturn(true);
    }

    @Test
    void collectionPreservesOriginalFrameworkDocument() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        collector.collect("1", SessionTokenAuditApiTest.frameworkDocument(), metadata(), Instant.now());
        ArgumentCaptor<SessionTokenAudit> captor = ArgumentCaptor.forClass(SessionTokenAudit.class);
        verify(auditRepository).replaceSnapshot(captor.capture());
        assertEquals(0.0412345, TokenAuditFrameworkViewConverter.read(captor.getValue().getFrameworkDocument())
                .getRequestOverhead().getToolDefinition().getRatio());
    }

    @Test
    void settlesAttachmentsAndTheFrameworkToolTotalExactlyOnce() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        TokenAuditDocument document = SessionTokenAuditApiTest.frameworkDocument();
        ToolAuditDocument tools = document.toolTokens().getTokenMeta();
        document.toolTokens().setTokenMeta(new ToolAuditDocument(64000, tools.mcpDetail(),
                tools.skillDetail(), tools.tokenDetails()));

        collector.collect("1", document, metadata(), Instant.now());

        ArgumentCaptor<SessionTokenAudit> captor = ArgumentCaptor.forClass(SessionTokenAudit.class);
        verify(auditRepository).replaceSnapshot(captor.capture());
        SessionTokenAudit stored = captor.getValue();
        // 系统 12300 + 动态上下文 4500 + 用户 18450 + AI 39000 + 工具 64000 + 附件 889
        assertEquals(139139, stored.getMessagesTokens());
        assertEquals(148200 - 139139, stored.getRequestOverheadTokens(),
                "背景块必须留在消息合计里，不能被挤进请求开销");
        assertEquals(148200, stored.getTotalTokens());
        assertEquals(64000, stored.toolTokens());
    }

    @Test
    @DisplayName("采集成功：落 COLLECTED 快照并按根会话广播与 GET 同构的载荷")
    void collectStoresAndBroadcasts() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.empty());
        SessionTokenAuditVO payload = SessionTokenAuditVO.builder()
                .sessionId(SESSION_ID).displayState(TokenAuditDisplayState.COLLECTED.name()).build();
        when(queryService.snapshot(SESSION_ID)).thenReturn(payload);

        collector.collect("1", null, metadata(), Instant.now());

        ArgumentCaptor<SessionTokenAudit> captor = ArgumentCaptor.forClass(SessionTokenAudit.class);
        verify(auditRepository).replaceSnapshot(captor.capture());
        SessionTokenAudit stored = captor.getValue();
        assertEquals(SESSION_ID, stored.getSessionId());
        assertEquals(TokenAuditPersistedState.COLLECTED, stored.getState());
        assertEquals(4, stored.getItems().size(), "空审计文档仍然落 4 条消息行");
        assertNotNull(stored.getCapturedAt());
        verify(publisher).publishSnapshot(ROOT_SESSION_ID, payload);
    }

    @Test
    @DisplayName("更早的采集不得覆盖更新的快照")
    void staleCollectionIsSkipped() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        when(auditRepository.replaceSnapshot(any())).thenReturn(false);

        collector.collect("1", null, metadata(), Instant.now());

        verifyNoInteractions(publisher);
    }

    @Test
    @DisplayName("已有 COLLECTED 时失败只记日志：不改库、不广播（硬规则）")
    void failureKeepsCollectedSnapshot() {
        SessionTokenAudit collected = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.COLLECTED, 100, 200, 90, 10, 0, 0, null, null, null, null, Instant.now(),
                null, List.of());
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(collected));

        collector.markFailed("1", "AUDIT_ERROR", "偶发失败", metadata());

        verify(auditRepository, never()).markFailed(anyLong(), any(), anyString());
        verifyNoInteractions(publisher);
        verifyNoInteractions(sessionRepository);
    }

    @Test
    @DisplayName("无成功快照时失败落 FAILED，原因拼成「类型: 消息」并广播")
    void failurePersistsWhenNothingCollected() {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.empty());
        when(queryService.snapshot(SESSION_ID)).thenReturn(
                SessionTokenAuditVO.builder().sessionId(SESSION_ID).displayState("FAILED").build());

        collector.markFailed("1", "AUDIT_ERROR", "模型未返回用量", metadata());

        verify(auditRepository).markFailed(SESSION_ID, 1L, "AUDIT_ERROR: 模型未返回用量");
        verify(publisher).publishSnapshot(eq(ROOT_SESSION_ID), any());
    }

    @Test
    @DisplayName("归属解析：元数据缺失时用 ExecutionLocator 兜底，解析不到则静默丢弃")
    void ownershipResolution() {
        when(executionLocator.sessionId("42")).thenReturn(SESSION_ID);
        when(executionLocator.resolveRootSessionId(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.empty());
        when(queryService.snapshot(SESSION_ID)).thenReturn(
                SessionTokenAuditVO.builder().sessionId(SESSION_ID).build());

        collector.collect("42", null, null, Instant.now());

        ArgumentCaptor<SessionTokenAudit> captor = ArgumentCaptor.forClass(SessionTokenAudit.class);
        verify(auditRepository).replaceSnapshot(captor.capture());
        assertEquals(42L, captor.getValue().getExecutionId(), "执行标识必须落库");
        verify(publisher).publishSnapshot(eq(ROOT_SESSION_ID), any());

        ExecutionLocator failing = mock(ExecutionLocator.class);
        when(failing.sessionId("99")).thenThrow(new IllegalStateException("执行不存在"));
        SessionTokenAuditCollector isolated = new SessionTokenAuditCollector(auditRepository,
                sessionRepository, failing, new TokenAuditConverter(), queryService, broadcasters);
        isolated.collect("99", null, null, Instant.now());
        isolated.markFailed("99", "AUDIT_ERROR", "x", null);
    }

    @Test
    @DisplayName("广播失败不影响采集结果：数据已落库，异常被吞掉")
    void broadcastFailureIsSwallowed() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.empty());
        when(queryService.snapshot(SESSION_ID)).thenThrow(new IllegalStateException("会话刚被删除"));

        collector.collect("1", null, metadata(), Instant.now());

        verify(auditRepository).replaceSnapshot(any());
    }

    @Test
    @DisplayName("记忆正文大于动态上下文：只记告警，快照照常落库且数值不被改写")
    void memoryExceedingDynamicContextWarnsWithoutTouchingNumbers() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        ListAppender<ILoggingEvent> appender = attachCollectorAppender();
        try {
            collector.collect("1", documentWithAttribution(200, 100), metadata(), Instant.now());
        } finally {
            detachCollectorAppender(appender);
        }

        assertTrue(appender.list.stream().anyMatch(event -> event.getLevel() == Level.WARN
                        && event.getFormattedMessage().contains("记忆归因超出动态上下文")),
                "倒挂必须留下告警：否则口径漂移只能等用户自己发现「子项比父项大」");
        ArgumentCaptor<SessionTokenAudit> captor = ArgumentCaptor.forClass(SessionTokenAudit.class);
        verify(auditRepository).replaceSnapshot(captor.capture());
        assertEquals(200, captor.getValue().getMemoryTokens(), "告警不改数，落库仍是框架原值");
    }

    @Test
    @DisplayName("记忆正文小于动态上下文：不告警（常态不得刷日志）")
    void memoryInsideDynamicContextDoesNotWarn() {
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        ListAppender<ILoggingEvent> appender = attachCollectorAppender();
        try {
            collector.collect("1", documentWithAttribution(100, 200), metadata(), Instant.now());
        } finally {
            detachCollectorAppender(appender);
        }

        assertFalse(appender.list.stream().anyMatch(event -> event.getFormattedMessage()
                        .contains("记忆归因超出动态上下文")),
                "记忆是动态上下文的一部分，正常情况下不该出现这条告警");
        verify(auditRepository).replaceSnapshot(any());
    }

    private static ListAppender<ILoggingEvent> attachCollectorAppender() {
        Logger logger = (Logger) LoggerFactory.getLogger(SessionTokenAuditCollector.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        return appender;
    }

    private static void detachCollectorAppender(ListAppender<ILoggingEvent> appender) {
        ((Logger) LoggerFactory.getLogger(SessionTokenAuditCollector.class)).detachAppender(appender);
    }

    /** 只构造归因两项：其余角色给 0，避免干扰告警判定。 */
    private static TokenAuditDocument documentWithAttribution(int memoryTokens, int dynamicContextTokens) {
        DocumentElement<Integer> zero = auditElement(0);
        return new TokenAuditDocument(zero, zero, null, zero,
                new OtherTokens(auditElement(0), auditElement(0), auditElement(dynamicContextTokens),
                        auditElement(memoryTokens), auditElement(0)));
    }

    private static DocumentElement<Integer> auditElement(int tokens) {
        return DocumentElement.<Integer>builder()
                .tokenMeta(tokens)
                .status(AuditStatus.SUCCESS)
                .type("int")
                .ratio(0.0)
                .build();
    }

    private static Session session() {
        return Session.builder().id(SESSION_ID).contextTokenCount(148200L).contextMaxTokens(200000)
                .build();
    }

    /**
     * 构造一个「容器里有实现」的 {@link ObjectProvider} 桩。
     *
     * <p>{@code ObjectProvider} 的 {@code ifAvailable} 是接口默认方法，Mockito 默认不会执行默认实现，
     * 因此显式把消费动作转发给 mock，采集器才会真的调用到 {@link TokenAuditBroadcaster}。</p>
     */
    @SuppressWarnings("unchecked")
    private static ObjectProvider<TokenAuditBroadcaster> broadcasterProvider(
            TokenAuditBroadcaster broadcaster) {
        ObjectProvider<TokenAuditBroadcaster> provider = mock(ObjectProvider.class);
        doAnswer(invocation -> {
            Consumer<TokenAuditBroadcaster> consumer = invocation.getArgument(0);
            consumer.accept(broadcaster);
            return null;
        }).when(provider).ifAvailable(any());
        return provider;
    }

    private static Map<String, Object> metadata() {
        return ExecutionEventMetadata.of(ROOT_SESSION_ID, SESSION_ID, null, null, 1L);
    }
}
