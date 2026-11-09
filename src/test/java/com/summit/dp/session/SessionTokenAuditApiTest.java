package com.summit.dp.session;

import com.summit.dp.session.application.service.SessionTokenAuditQueryService;
import com.summit.dp.session.api.controller.SessionTokenAuditController;
import com.summit.core.audit.AuditStatus;
import com.summit.core.audit.DocumentElement;
import com.summit.core.audit.token.OtherTokens;
import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.core.audit.token.tool.ToolAuditDocument;
import com.summit.core.audit.token.tool.ToolElement;
import com.summit.dp.session.application.convert.TokenAuditFrameworkViewConverter;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.model.TokenAuditReconciler;
import com.summit.dp.session.domain.model.TokenAuditReconciler.GroupMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.ItemMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Result;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.shared.config.GlobalExceptionHandler;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 守住框架原始计数、比例与采集状态的接口契约。 */
class SessionTokenAuditApiTest {

    private static final long SESSION_ID = 1827364512093847552L;
    private static final Instant CAPTURED_AT = Instant.parse("2026-11-07T02:15:33.412Z");

    private final SessionTokenAuditRepository auditRepository = mock(SessionTokenAuditRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);

    @Test
    @DisplayName("分项与比例取框架原值，不要求分组之和等于工具总量")
    void collectedSnapshotShape() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(collected()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(148200L).contextMaxTokens(200000)
                        .build()));

        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.sessionId").isString())
                .andExpect(jsonPath("$.data.liveTotalTokens").isNumber())
                .andExpect(jsonPath("$.data.messages.length()").value(5))
                .andExpect(jsonPath("$.data.messages[0].tokens").value(12300))
                .andExpect(jsonPath("$.data.messages[0].ratio").value(0.0612345))
                .andExpect(jsonPath("$.data.messages[1].ratio").value(0.0923456))
                .andExpect(jsonPath("$.data.messages[2].type").value("ATTACHMENT"))
                .andExpect(jsonPath("$.data.messages[2].tokens").value(889))
                .andExpect(jsonPath("$.data.messages[2].ratio").value(0.004))
                .andExpect(jsonPath("$.data.messages[3].ratio").value(0.1951234))
                .andExpect(jsonPath("$.data.messages[4].tokens").value(63614))
                .andExpect(jsonPath("$.data.messages[4].ratio").value(0.3181234))
                .andExpect(jsonPath("$.data.tools.tokens").value(63614))
                .andExpect(jsonPath("$.data.tools.ratio").value(0.3181234))
                .andExpect(jsonPath("$.data.tools.mcp.tokens").value(34700))
                .andExpect(jsonPath("$.data.tools.mcp.ratio").value(0.1731234))
                .andExpect(jsonPath("$.data.tools.skill.ratio").value(0.0712345))
                .andExpect(jsonPath("$.data.tools.ordinary.tokens").doesNotExist())
                .andExpect(jsonPath("$.data.tools.ordinary.ratio").doesNotExist())
                .andExpect(jsonPath("$.data.tools.ordinary.items[0].tokens").value(9420))
                .andExpect(jsonPath("$.data.tools.ordinary.items[0].ratio").doesNotExist())
                .andExpect(jsonPath("$.data.messagesTotalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.reconciliation").doesNotExist())
                .andExpect(jsonPath("$.data.contextAttribution.memoryTokens").value(777))
                .andExpect(jsonPath("$.data.contextAttribution.attachmentTokens").doesNotExist());
    }

    @Test
    @DisplayName("工具定义子项比例原样透传，父项金额与框架残差由业务侧补齐")
    void requestOverheadPreservesFrameworkRatios() throws Exception {
        SessionTokenAudit audit = collected();
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(audit));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(148200L).contextMaxTokens(200000)
                        .contextRatio(0.7412345).build()));
        Integer overhead = audit.getRequestOverheadTokens();
        Integer residual = audit.framingResidualTokens();
        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.requestOverhead.tokens").value(overhead))
                .andExpect(jsonPath("$.data.requestOverhead.ratio").value((double) overhead / 200000))
                .andExpect(jsonPath("$.data.requestOverhead.itemCount").value(2))
                .andExpect(jsonPath("$.data.requestOverhead.toolDefinition.tokens").value(8200))
                .andExpect(jsonPath("$.data.requestOverhead.toolDefinition.ratio").value(0.0412345))
                .andExpect(jsonPath("$.data.requestOverhead.mcpToolDefinition.ratio").value(0.0156789))
                .andExpect(jsonPath("$.data.requestOverhead.framingResidualTokens").value(residual))
                .andExpect(jsonPath("$.data.liveRatio").value(0.7412345))
                .andExpect(jsonPath("$.data.remainingTokens").value(51800))
                .andExpect(jsonPath("$.data.remainingRatio").value(1 - 0.7412345));
    }

    @Test
    @DisplayName("恒等式：其他消息父项 = 内核工具定义 + MCP 工具定义 + 框架残差")
    void requestOverheadParentEqualsItsThreeParts() {
        SessionTokenAudit audit = collected();
        Integer overhead = audit.getRequestOverheadTokens();
        Integer kernel = audit.getToolDefinitionTokens();
        Integer mcp = audit.getMcpToolDefinitionTokens();
        Integer residual = audit.framingResidualTokens();
        assertNotNull(overhead, "父项金额必须已知，否则前端只能显示一个 N 项徽标");
        assertNotNull(kernel, "内核工具定义必须已知");
        assertNotNull(mcp, "MCP 工具定义必须已知");
        assertNotNull(residual, "残差必须已知");
        assertEquals(overhead.intValue(), kernel + mcp + residual,
                "父项必须等于三项之和：缺任何一项都会出现「子项大过父项」");
    }

    @Test
    @DisplayName("工具定义全失败时仍下发其他消息父项，整块不得消失")
    void overheadParentSurvivesFailedDefinitions() throws Exception {
        TokenAuditDocument document = frameworkDocument();
        document.otherTokens().toolDefinitionTokens().setStatus(AuditStatus.FAILED);
        document.otherTokens().mcpToolDefinitionTokens().setStatus(AuditStatus.FAILED);
        SessionTokenAudit audit = collected();
        audit.changeFrameworkDocument(TokenAuditFrameworkViewConverter.write(document));
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(audit));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(148200L).contextMaxTokens(200000).build()));
        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.requestOverhead.tokens").value(audit.getRequestOverheadTokens()))
                .andExpect(jsonPath("$.data.requestOverhead.toolDefinition").doesNotExist())
                .andExpect(jsonPath("$.data.requestOverhead.mcpToolDefinition").doesNotExist())
                .andExpect(jsonPath("$.data.messages.length()").value(5));
    }

    @Test
    void failedFrameworkElementsAreRemovedWithoutZeroRows() throws Exception {
        TokenAuditDocument document = frameworkDocument();
        document.systemTokens().setStatus(AuditStatus.FAILED);
        document.otherTokens().attachmentTokens().setStatus(AuditStatus.FAILED);
        document.otherTokens().toolDefinitionTokens().setStatus(AuditStatus.NO_DATA);
        document.userTokens().setTokenMeta(0);
        document.userTokens().setRatio(0);
        SessionTokenAudit audit = collected();
        audit.changeFrameworkDocument(TokenAuditFrameworkViewConverter.write(document));
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(audit));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(Session.builder().id(SESSION_ID).build()));
        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.messages.length()").value(3))
                .andExpect(jsonPath("$.data.messages[0].type").value("USER"))
                .andExpect(jsonPath("$.data.messages[0].tokens").value(0))
                .andExpect(jsonPath("$.data.messages[0].ratio").value(0))
                .andExpect(jsonPath("$.data.requestOverhead.itemCount").value(1))
                .andExpect(jsonPath("$.data.requestOverhead.toolDefinition").doesNotExist());
    }

    @Test
    @DisplayName("历史快照缺少框架原文时，不从旧计数重建比例或分项")
    void legacySnapshotDoesNotInventRatios() throws Exception {
        SessionTokenAudit audit = collected();
        audit.changeFrameworkDocument(null);
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(audit));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(Session.builder().id(SESSION_ID).build()));
        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.messages.length()").value(0))
                .andExpect(jsonPath("$.data.tools").doesNotExist())
                .andExpect(jsonPath("$.data.requestOverhead").doesNotExist())
                .andExpect(jsonPath("$.data.liveRatio").doesNotExist());
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
    @DisplayName("从未采集时不生成零值分项")
    void notCollectedShape() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.empty());
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).build()));

        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.displayState").value("NOT_COLLECTED"))
                .andExpect(jsonPath("$.data.messages.length()").value(0))
                .andExpect(jsonPath("$.data.reconciliation").doesNotExist())
                .andExpect(jsonPath("$.data.tools").doesNotExist())
                .andExpect(jsonPath("$.data.totalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.liveTotalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.liveRatio").doesNotExist());
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
                .andExpect(jsonPath("$.data.messages.length()").value(0));
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

    @Test
    @DisplayName("实时总量：负数按未知、0 是真实 0、超 Integer 饱和，绝不溢出成负数")
    void liveTokensBoundaries() throws Exception {
        when(auditRepository.findBySessionId(SESSION_ID)).thenReturn(Optional.of(collected()));

        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(-1L).build()));
        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.liveTotalTokens").doesNotExist())
                .andExpect(jsonPath("$.data.capturedAt").exists());

        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(0L).build()));
        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.liveTotalTokens").value(0));

        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(SESSION_ID).contextTokenCount(Long.MAX_VALUE).build()));
        createMvc().perform(get("/session/{id}/token-audit", SESSION_ID))
                .andExpect(jsonPath("$.data.liveTotalTokens").value(Integer.MAX_VALUE));
    }

    private MockMvc createMvc() {
        SessionTokenAuditQueryService query = new SessionTokenAuditQueryService(auditRepository, sessionRepository);
        return MockMvcBuilders.standaloneSetup(new SessionTokenAuditController(query))
                .setControllerAdvice(new GlobalExceptionHandler())
                .setMessageConverters(new MappingJackson2HttpMessageConverter(
                        new JsonConfig().objectMapper()))
                .build();
    }

    /** 与 {@code TokenAuditReconcilerTest} 使用同一套结算样例。 */
    private static SessionTokenAudit collected() {
        int ordinary = 9420 + 5300;
        Measurement measurement = new Measurement(12300, 18450, 39000, 63614, 5900, 148200, 200000,
                List.of(new GroupMeasurement(TokenAuditGroupKind.MCP, 34700, 2100, 33000, 12, List.of()),
                        new GroupMeasurement(TokenAuditGroupKind.SKILL, 14200, 800, 13000, 3,
                                List.of()),
                        new GroupMeasurement(TokenAuditGroupKind.ORDINARY, ordinary, 3000,
                                ordinary - 560, 5, List.of(
                                new ItemMeasurement("search_web", 9420, 2100, 8700, 3),
                                new ItemMeasurement("read_file", 5300, 900, 4600, 2)))),
                8200, 3100, 777, 889);
        Result result = TokenAuditReconciler.reconcile(measurement);
        SessionTokenAudit audit = SessionTokenAudit.capture(SESSION_ID, 1L, result, CAPTURED_AT);
        audit.changeFrameworkDocument(TokenAuditFrameworkViewConverter.write(frameworkDocument()));
        return audit;
    }

    static TokenAuditDocument frameworkDocument() {
        return new TokenAuditDocument(amount(39000, 0.1951234), amount(18450, 0.0923456),
                DocumentElement.<ToolAuditDocument>builder().status(AuditStatus.SUCCESS).ratio(0.3181234)
                        .tokenMeta(new ToolAuditDocument(63614,
                                toolElement(34700, 0.1731234), toolElement(14200, 0.0712345),
                                Map.of("search_web", new ToolElement(2100, 8700, 9420)))).build(),
                amount(12300, 0.0612345),
                new OtherTokens(amount(8200, 0.0412345), amount(3100, 0.0156789),
                        amount(777, 0.003), amount(889, 0.004)));
    }

    private static DocumentElement<Integer> amount(int tokens, double ratio) {
        return DocumentElement.<Integer>builder().status(AuditStatus.SUCCESS)
                .tokenMeta(tokens).ratio(ratio).build();
    }

    private static DocumentElement<ToolElement> toolElement(int tokens, double ratio) {
        return DocumentElement.<ToolElement>builder().status(AuditStatus.SUCCESS)
                .tokenMeta(new ToolElement(0, tokens, tokens)).ratio(ratio).build();
    }
}
