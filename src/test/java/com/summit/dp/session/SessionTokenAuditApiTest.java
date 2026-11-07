package com.summit.dp.session;

import com.summit.dp.session.application.service.SessionTokenAuditQueryService;
import com.summit.dp.session.api.controller.SessionTokenAuditController;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.model.TokenAuditPersistedState;
import com.summit.dp.session.domain.model.TokenAuditReconciler;
import com.summit.dp.session.domain.model.TokenAuditReconciler.GroupMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.ItemMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Result;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * {@code GET /session/{id}/token-audit} 的契约用例。
 *
 * <p>断言的全是对外承诺，与内部实现无关：四类分项恒 4 条且顺序固定、恒等式
 * {@code total = messages + overhead}、{@code NOT_COLLECTED} / {@code CAPTURING} / {@code FAILED}
 * 三种非正常态的字段形态，以及 U1 的退化规则（实时总量缺失时比率必须为 null、不得出现巨大负残差）。</p>
 */
class SessionTokenAuditApiTest {

    private static final long SESSION_ID = 1827364512093847552L;
    private static final Instant CAPTURED_AT = Instant.parse("2026-11-07T02:15:33.412Z");

    private final SessionTokenAuditRepository auditRepository = mock(SessionTokenAuditRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);

    @Test
    @DisplayName("已采集：四类 4 条固定顺序、恒等式成立、TOOL 下钻含两个工具名")
    void collectedSnapshotShape() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(collected()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(148200L).contextMaxTokens(200000)
                        .build()));

        MockMvc mvc = createMvc();
        mvc.perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.sessionId").value(Long.toString(SESSION_ID)))
                .andExpect(jsonPath("$.data.displayState").value("COLLECTED"))
                .andExpect(jsonPath("$.data.liveTotalTokens").value(148200))
                .andExpect(jsonPath("$.data.liveMaxTokens").value(200000))
                .andExpect(jsonPath("$.data.totalTokens").value(148200))
                .andExpect(jsonPath("$.data.driftTokens").value(0))
                .andExpect(jsonPath("$.data.messages.length()").value(4))
                .andExpect(jsonPath("$.data.messages[0].type").value("SYSTEM"))
                .andExpect(jsonPath("$.data.messages[1].type").value("USER"))
                .andExpect(jsonPath("$.data.messages[2].type").value("AI"))
                .andExpect(jsonPath("$.data.messages[3].type").value("TOOL"))
                .andExpect(jsonPath("$.data.messages[3].expandable").value(true))
                .andExpect(jsonPath("$.data.messages[0].expandable").value(false))
                .andExpect(jsonPath("$.data.messagesTotalTokens").value(133370))
                .andExpect(jsonPath("$.data.reconciliation.totalTokens").value(148200))
                .andExpect(jsonPath("$.data.reconciliation.messagesTokens").value(133370))
                .andExpect(jsonPath("$.data.reconciliation.requestOverheadTokens").value(14830))
                .andExpect(jsonPath("$.data.reconciliation.argumentOverlapTokens").value(5900))
                .andExpect(jsonPath("$.data.reconciliation.toolGroupingDrift").value(-6))
                .andExpect(jsonPath("$.data.tools.tokens").value(63620))
                .andExpect(jsonPath("$.data.tools.mcp.tokens").value(34700))
                .andExpect(jsonPath("$.data.tools.skill.tokens").value(14200))
                .andExpect(jsonPath("$.data.tools.ordinary.tokens").value(14720))
                .andExpect(jsonPath("$.data.tools.ordinary.items.length()").value(2))
                .andExpect(jsonPath("$.data.tools.ordinary.items[0].toolName").value("search_web"))
                .andExpect(jsonPath("$.data.tools.ordinary.items[1].toolName").value("read_file"));
    }

    @Test
    @DisplayName("正在采集：实时总量大于快照总量时 displayState=CAPTURING 且漂移为正")
    void capturingWhenLiveTotalMovesAhead() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(collected()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(150000L).contextMaxTokens(200000)
                        .build()));

        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.displayState").value("CAPTURING"))
                .andExpect(jsonPath("$.data.driftTokens").value(1800))
                .andExpect(jsonPath("$.data.totalTokens").value(148200));
    }

    @Test
    @DisplayName("从未采集：NOT_COLLECTED，四类仍 4 条 0 值，reconciliation 与 tools 为 null")
    void notCollectedShape() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.empty());
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).build()));

        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.displayState").value("NOT_COLLECTED"))
                .andExpect(jsonPath("$.data.messages.length()").value(4))
                .andExpect(jsonPath("$.data.messages[0].tokens").value(0))
                .andExpect(jsonPath("$.data.messages[3].expandable").value(true))
                .andExpect(jsonPath("$.data.reconciliation").doesNotExist())
                .andExpect(jsonPath("$.data.tools").doesNotExist())
                .andExpect(jsonPath("$.data.totalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.liveTotalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.liveRatio").doesNotExist())
                .andExpect(jsonPath("$.data.messages[0].ratio").doesNotExist());
    }

    @Test
    @DisplayName("采集失败：displayState=FAILED，failReason 有值，数值字段一律缺省")
    void failedShape() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(
                SessionTokenAudit.failure(SESSION_ID, 7L, "AUDIT_ERROR: 模型未返回用量", CAPTURED_AT)));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(1000L).contextMaxTokens(200000)
                        .build()));

        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.displayState").value("FAILED"))
                .andExpect(jsonPath("$.data.failReason").value("AUDIT_ERROR: 模型未返回用量"))
                .andExpect(jsonPath("$.data.totalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.reconciliation").doesNotExist())
                .andExpect(jsonPath("$.data.messages.length()").value(4));
    }

    @Test
    @DisplayName("U1：实时总量与上限缺失时比率必须为 null，不得除零或伪造 0")
    void missingLiveUsageKeepsRatioNull() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(collected()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).build()));

        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.liveTotalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.liveRatio").doesNotExist())
                .andExpect(jsonPath("$.data.driftTokens").doesNotExist())
                .andExpect(jsonPath("$.data.displayState").value("COLLECTED"))
                .andExpect(jsonPath("$.data.totalTokens").value(148200));
    }

    private MockMvc createMvc() {
        SessionTokenAuditQueryService service =
                new SessionTokenAuditQueryService(auditRepository, sessionRepository);
        return MockMvcBuilders.standaloneSetup(new SessionTokenAuditController(service))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(
                        new JsonConfig().objectMapper()))
                .build();
    }

    /** 与 {@code TokenAuditReconcilerTest} 同一套自洽数据（新口径：工具总量不含参数）。 */
    private static SessionTokenAudit collected() {
        int ordinary = 9420 + 5300;
        Measurement measurement = new Measurement(12300, 18450, 39000, 63614, 5900, 148200, 200000,
                List.of(new GroupMeasurement(TokenAuditGroupKind.MCP, 34700, 2100, 33000, 12, List.of()),
                        new GroupMeasurement(TokenAuditGroupKind.SKILL, 14200, 800, 13000, 3,
                                List.of()),
                        new GroupMeasurement(TokenAuditGroupKind.ORDINARY, ordinary, 3000,
                                ordinary - 560, 5, List.of(
                                new ItemMeasurement("search_web", 9420, 2100, 8700, 3),
                                new ItemMeasurement("read_file", 5300, 900, 4600, 2)))));
        Result result = TokenAuditReconciler.reconcile(measurement);
        SessionTokenAudit audit = SessionTokenAudit.capture(SESSION_ID, 1L, result, CAPTURED_AT);
        return SessionTokenAudit.restore(SESSION_ID, 1L, TokenAuditPersistedState.COLLECTED,
                audit.getTotalTokens(), audit.getMaxTokens(), audit.getMessagesTokens(),
                audit.getRequestOverheadTokens(), audit.getOverlapTokens(),
                audit.getToolGroupingDrift(), audit.getCapturedAt(), audit.getFailReason(),
                audit.getItems());
    }
}
