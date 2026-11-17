package com.summit.dp.workflow.application.compact;

import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextCompactRequest;
import com.summit.core.compact.ContextCompacter;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionTokenAuditQueryService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ContextCompactionVO;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import com.summit.runtime.audit.ExecutionTokenAuditRecorder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.beans.factory.ObjectProvider;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * 手工压缩（{@code /compact}）的分支契约。
 *
 * <p>重点不在「调没调通」，而在四条一旦搞错就会骗人的规则：</p>
 * <ol>
 *   <li>带正文 / 会话在跑 / 用量不足 20% / 没有可压缩执行 —— 必须在动上下文之前就拒绝；</li>
 *   <li>压缩失败时<b>不能</b>写回上下文、<b>不能</b>假装刷新了审计；</li>
 *   <li>写回上下文必须早于刷新用量：审计落库会重读会话行取实时用量，顺序反了记的是压缩前的值且不报错；</li>
 *   <li>回执里的前后用量取自压缩前后的测量，不能拿同一个值糊两次。</li>
 * </ol>
 */
class ContextCompactionServiceTest {

    private static final long SESSION_ID = 700L;
    private static final String EXECUTION_ID = "2105000000000000007";

    private final com.summit.dp.execution.domain.repository.ExecutionRepository executionRows =
            mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class);
    private final com.summit.core.runtime.loop.ExecutionRepository executionSnapshots =
            mock(com.summit.core.runtime.loop.ExecutionRepository.class);
    private final ContextCompacter modelCompacter = mock(ContextCompacter.class);
    private final ContextUsageReporter usageReporter = mock(ContextUsageReporter.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SessionAggregateService sessionService = mock(SessionAggregateService.class);
    private final SessionTokenAuditQueryService auditQueryService = mock(SessionTokenAuditQueryService.class);
    private final ExecutionTokenAuditRecorder auditRecorder = mock(ExecutionTokenAuditRecorder.class);
    private final ObjectProvider<ExecutionTokenAuditRecorder> auditRecorderProvider = mock(ObjectProvider.class);

    private final Execution execution = mock(Execution.class);
    private final SessionTokenAuditVO auditSnapshot = SessionTokenAuditVO.builder().build();

    private ContextCompactionService service;

    @BeforeEach
    void setUp() {
        when(auditRecorderProvider.getIfAvailable()).thenReturn(auditRecorder);
        when(execution.getId()).thenReturn(EXECUTION_ID);
        when(execution.getMessages()).thenReturn(List.of());
        when(auditQueryService.snapshot(SESSION_ID)).thenReturn(auditSnapshot);
        service = new ContextCompactionService(executionRows, executionSnapshots, modelCompacter, usageReporter,
                modelContextService, sessionService, auditQueryService, auditRecorderProvider);
    }

    @Test
    @DisplayName("带正文直接拒绝，且不碰任何仓储与上下文")
    void rejectsBodyBeforeTouchingAnything() {
        ClientException failure = assertThrows(ClientException.class, () -> service.compact(SESSION_ID, "保留部署相关的部分"));

        assertTrue(failure.getMessage().contains("/compact"));
        verifyNoInteractions(executionRows, executionSnapshots, modelCompacter, modelContextService,
                sessionService, auditQueryService, auditRecorder);
    }

    @Test
    @DisplayName("空白正文不算正文：纯空白与 null 都放行")
    void treatsBlankBodyAsNoBody() {
        givenReadyExecution();
        // 两次调用各消耗一对「压缩前 / 压缩后」测量，所以连续给出四段
        when(usageReporter.report(execution)).thenReturn(
                ContextUsageMetric.of(5000, 10000), ContextUsageMetric.of(2000, 10000),
                ContextUsageMetric.of(5000, 10000), ContextUsageMetric.of(2000, 10000));
        when(modelCompacter.compact(any())).thenReturn(true);

        assertTrue(service.compact(SESSION_ID, "   ").isCompacted());
        assertTrue(service.compact(SESSION_ID, null).isCompacted());
    }

    @Test
    @DisplayName("会话仍在执行中时拒绝受理")
    void rejectsRunningSession() {
        com.summit.dp.execution.domain.model.Execution running =
                mock(com.summit.dp.execution.domain.model.Execution.class);
        when(executionRows.findUnfinishedBySessions(List.of(SESSION_ID))).thenReturn(List.of(running));

        ClientException failure = assertThrows(ClientException.class, () -> service.compact(SESSION_ID, null));

        assertTrue(failure.getMessage().contains("执行中"));
        verify(executionSnapshots, never()).findById(any());
        verify(modelCompacter, never()).compact(any());
    }

    @Test
    @DisplayName("没有终态执行时拒绝：没有可压缩的上下文")
    void rejectsWhenNoTerminalExecution() {
        givenUnfinished(List.of());
        when(executionRows.findRecentBySession(SESSION_ID, 5)).thenReturn(List.of());

        ClientException failure = assertThrows(ClientException.class, () -> service.compact(SESSION_ID, null));

        assertTrue(failure.getMessage().contains("可压缩"));
        verify(modelCompacter, never()).compact(any());
    }

    @Test
    @DisplayName("用量不超过 20% 直接拒绝：压缩只会白烧一次模型调用并打断前缀缓存")
    void rejectsWhenUsageIsAtOrBelowThreshold() {
        givenReadyExecution();
        when(usageReporter.report(execution)).thenReturn(ContextUsageMetric.of(2000, 10000));

        ClientException failure = assertThrows(ClientException.class, () -> service.compact(SESSION_ID, null));

        assertTrue(failure.getMessage().contains("20%"), "拒绝文案要说清门槛，否则用户不知道该等多久");
        verify(modelCompacter, never()).compact(any());
        verify(modelContextService, never()).replace(anyLong(), any());
    }

    @Test
    @DisplayName("模型未配置上下文窗口时拒绝：无法评估用量就不该盲压")
    void rejectsWhenContextCapIsUnknown() {
        givenReadyExecution();
        when(usageReporter.report(execution)).thenReturn(null);

        ClientException failure = assertThrows(ClientException.class, () -> service.compact(SESSION_ID, null));

        assertTrue(failure.getMessage().contains("上下文窗口"));
        verify(modelCompacter, never()).compact(any());
    }

    @Test
    @DisplayName("压缩未产出可用摘要：不写回上下文、不刷新审计、回执不带审计")
    void doesNotTouchAnythingWhenCompactionProducesNoSummary() {
        givenReadyExecution();
        givenUsage(6000, 10000, 6000, 10000);
        when(modelCompacter.compact(any())).thenReturn(false);

        ContextCompactionVO result = service.compact(SESSION_ID, null);

        assertFalse(result.isCompacted());
        assertEquals(6000, result.getTokensBefore());
        assertNull(result.getTokensAfter(), "没压缩就不该给一个「压缩后」数字");
        assertNull(result.getAudit(), "没压缩时下发旧审计会让「压缩完还是这么大」变成合理错觉");
        assertFalse(result.isAuditRefreshed());
        verify(modelContextService, never()).replace(anyLong(), any());
        verify(auditRecorder, never()).record(any());
    }

    @Test
    @DisplayName("压缩成功：写回上下文 → 刷新用量 → 重算审计，顺序不可颠倒")
    void compactsThenPersistsThenRefreshesUsageThenAudits() {
        givenReadyExecution();
        givenUsage(6000, 10000, 1500, 10000);
        when(modelCompacter.compact(any())).thenReturn(true);

        ContextCompactionVO result = service.compact(SESSION_ID, null);

        assertTrue(result.isCompacted());
        assertEquals(6000, result.getTokensBefore());
        assertEquals(1500, result.getTokensAfter());
        assertTrue(result.isAuditRefreshed());
        assertSame(auditSnapshot, result.getAudit());

        InOrder order = inOrder(modelCompacter, modelContextService, sessionService, auditRecorder);
        order.verify(modelCompacter).compact(any(ContextCompactRequest.class));
        order.verify(modelContextService).replace(SESSION_ID, List.of());
        order.verify(sessionService).saveContextUsage(SESSION_ID, 1500L, 10000, 0.15d);
        order.verify(auditRecorder).record(execution);
    }

    @Test
    @DisplayName("框架审计开关关闭时：压缩照常生效，但如实回报审计没刷新")
    void reportsAuditNotRefreshedWhenRecorderIsAbsent() {
        givenReadyExecution();
        givenUsage(6000, 10000, 1500, 10000);
        when(modelCompacter.compact(any())).thenReturn(true);
        when(auditRecorderProvider.getIfAvailable()).thenReturn(null);

        ContextCompactionVO result = service.compact(SESSION_ID, null);

        assertTrue(result.isCompacted());
        assertFalse(result.isAuditRefreshed());
        verify(modelContextService).replace(SESSION_ID, List.of());
        verify(sessionService).saveContextUsage(SESSION_ID, 1500L, 10000, 0.15d);
    }

    @Test
    @DisplayName("取最近一次终态执行：跳过非终态行，取 id 最大的终态那条")
    void picksLatestTerminalExecution() {
        givenUnfinished(List.of());
        com.summit.dp.execution.domain.model.Execution suspended = row(11L, ExecutionStatusCodes.SUSPENDED);
        com.summit.dp.execution.domain.model.Execution older = row(12L, ExecutionStatusCodes.COMPLETED);
        com.summit.dp.execution.domain.model.Execution newer = row(13L, ExecutionStatusCodes.FAILED);
        when(executionRows.findRecentBySession(SESSION_ID, 5)).thenReturn(List.of(suspended, older, newer));
        when(executionSnapshots.findById("13")).thenReturn(Optional.of(execution));
        givenUsage(6000, 10000, 1500, 10000);
        when(modelCompacter.compact(any())).thenReturn(true);

        service.compact(SESSION_ID, null);

        verify(executionSnapshots).findById("13");
        verify(executionSnapshots, never()).findById("12");
    }

    private void givenReadyExecution() {
        givenUnfinished(List.of());
        // 先算好行再交给 thenReturn：在 when(...) 的参数里嵌另一段 when(...) 会触发
        // Mockito 的 UnfinishedStubbingException。
        com.summit.dp.execution.domain.model.Execution completed =
                row(Long.valueOf(EXECUTION_ID), ExecutionStatusCodes.COMPLETED);
        when(executionRows.findRecentBySession(SESSION_ID, 5)).thenReturn(List.of(completed));
        when(executionSnapshots.findById(EXECUTION_ID)).thenReturn(Optional.of(execution));
    }

    private void givenUnfinished(List<com.summit.dp.execution.domain.model.Execution> rows) {
        when(executionRows.findUnfinishedBySessions(List.of(SESSION_ID))).thenReturn(rows);
    }

    /** 压缩前 / 压缩后各一次测量；顺序敏感，用连续返回值表达。 */
    private void givenUsage(int beforeTokens, int beforeMax, int afterTokens, int afterMax) {
        when(usageReporter.report(execution)).thenReturn(
                ContextUsageMetric.of(beforeTokens, beforeMax),
                ContextUsageMetric.of(afterTokens, afterMax));
    }

    private static com.summit.dp.execution.domain.model.Execution row(Long id, int status) {
        com.summit.dp.execution.domain.model.Execution row =
                mock(com.summit.dp.execution.domain.model.Execution.class);
        when(row.getId()).thenReturn(id);
        when(row.getStatus()).thenReturn(status);
        return row;
    }
}
