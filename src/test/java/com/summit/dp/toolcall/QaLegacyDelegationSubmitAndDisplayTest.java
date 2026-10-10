package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.service.ToolCallActionResolver;
import com.summit.dp.toolcall.application.service.impl.CommandApprovalExecutor;
import com.summit.dp.toolcall.application.service.impl.ToolCallDecisionService;
import com.summit.dp.toolcall.application.service.impl.ToolCallServiceImpl;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 独立验证（QA）：历史遗留 {@code kind="DELEGATION"} 槽位在<b>提交侧</b>与<b>展示侧</b>的安全性。
 *
 * <p>改造前遗留数据在 {@code tool_call.content} 里写着 {@code kind:"DELEGATION"}（生产库里仍存在）。
 * 枚举常量删除后，读侧（{@link ToolCallConverter#resolveKind}）对该取值返回 {@code null}。
 * 本类断言这个 {@code null} 不会：
 * <ul>
 *   <li>让提交决策（{@link ToolCallServiceImpl#decide}）抛 {@code NullPointerException} 或写坏状态；</li>
 *   <li>让卡片装配（{@link ToolCallConverter#toVO}）抛异常而非降级为「不可用」。</li>
 * </ul>
 * 断言必须判到<b>具体文案 / 动作</b>与「无写操作」，不能只判 {@code assertDoesNotThrow}。</p>
 */
class QaLegacyDelegationSubmitAndDisplayTest {

    private static final String LEGACY_CONTENT =
            "{\"kind\":\"DELEGATION\",\"subExecutionId\":\"7001\",\"text\":\"写代码\"}";
    private static final String UNRECOGNIZED_MESSAGE = "互动内容不可识别，请刷新后重试";
    private static final String UNAVAILABLE_REASON = "互动数据不可用，请刷新状态";
    private static final String UNCONFIRMED_REASON = "互动状态尚未确认";

    private final ObjectMapper json = new ObjectMapper();

    @Test
    @DisplayName("B2 遗留 DELEGATION 未决槽位提交决策：被干净拒绝（ClientException），不 NPE、不写状态")
    void legacyDelegationSlotIsRejectedCleanlyOnSubmit() {
        ToolCallRepository repository = mock(ToolCallRepository.class);
        CommandApprovalExecutor commandExecutor = mock(CommandApprovalExecutor.class);
        ToolCallDecisionService decisionService = mock(ToolCallDecisionService.class);
        SseEventPublisher sse = mock(SseEventPublisher.class);
        ExecutionIdentity identity = mock(ExecutionIdentity.class);
        ToolCallConverter converter = new ToolCallConverter(json);

        ToolCall legacy = legacyRow();
        when(repository.findById(legacy.getId())).thenReturn(Optional.of(legacy));

        ToolCallServiceImpl service = new ToolCallServiceImpl(repository, converter,
                mock(TransactionTemplate.class), commandExecutor, decisionService,
                new CardAvailabilityPolicy(provider(mock(ExecutionRepository.class)),
                        provider(mock(ExecutionActivity.class))),
                sse, identity);

        ClientException failure = assertThrows(ClientException.class,
                () -> service.decide(2L, legacy.getId(), true, "批准"),
                "遗留不可识别形态必须被干净拒绝，而不是 NPE");

        assertEquals(UNRECOGNIZED_MESSAGE, failure.getMessage());
        // 未进入命令执行 / 决策落库分支，也未推送 SSE；状态未被改写。
        verifyNoInteractions(commandExecutor, decisionService, sse);
        verify(repository, never()).updateById(any());
    }

    @Test
    @DisplayName("B3 遗留 DELEGATION 行经卡片装配：不抛，降级为「互动数据不可用」，无动作")
    void legacyDelegationRowDegradesToUnavailableOnCardAssembly() {
        ToolCallConverter converter = new ToolCallConverter(json);
        CardAvailabilityPolicy policy = new CardAvailabilityPolicy(
                provider(mock(ExecutionRepository.class)), provider(mock(ExecutionActivity.class)));
        ReflectionTestUtils.setField(converter, "actionResolver", new ToolCallActionResolver(policy));

        ToolCallVO vo = converter.toVO(legacyRow());

        assertEquals("PROMISE", vo.getType());
        assertEquals("pending", vo.getStatus());
        assertTrue(vo.isPending(), "未决槽位 pending 仍为 true（未终结，不代表可审批）");
        assertFalse(vo.getAllowedActions() == null || !vo.getAllowedActions().isEmpty(),
                "遗留形态不得下发任何可审批动作");
        assertEquals(UNAVAILABLE_REASON, vo.getUnavailableReason(), "降级原因必须精确等于既有文案");
        // 原始 content 原样下发，前端据 kind 自判降级（保证不丢消息）。
        assertEquals("DELEGATION", vo.getContent().path("kind").asText());
    }

    @Test
    @DisplayName("B3 无 actionResolver 时（bootstrap 早期）遗留行同样不抛，降级为「互动状态尚未确认」")
    void legacyRowWithoutResolverStillSafe() {
        ToolCallConverter converter = new ToolCallConverter(json);

        ToolCallVO vo = converter.toVO(legacyRow());

        assertEquals(UNCONFIRMED_REASON, vo.getUnavailableReason());
        assertTrue(vo.getAllowedActions().isEmpty());
        assertTrue(vo.isPending());
    }

    @Test
    @DisplayName("B3 遗留行 kind 解析为 null（删除枚举后的降级入口）")
    void legacyKindResolvesToNull() {
        assertNull(new ToolCallConverter(json).resolveKind(LEGACY_CONTENT));
    }

    /** 改造前遗留的 DELEGATION 委派槽位：kind=DELEGATION + 子执行关联 + 任务文本。 */
    private static ToolCall legacyRow() {
        return ToolCall.builder()
                .id("call-child").conversationId(2L).executionId(3L)
                .toolName("call_sub_agent").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content(LEGACY_CONTENT).createdAt(Instant.now()).build();
    }

    private static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
