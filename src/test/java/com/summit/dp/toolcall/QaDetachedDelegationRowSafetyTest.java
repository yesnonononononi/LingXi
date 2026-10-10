package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.service.ToolCallActionResolver;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 「删掉 {@code ToolCallKind.DELEGATION} 也安全」的证据测试。
 *
 * <p>改造前遗留的委派槽位在 {@code tool_call.content} 里写着 {@code kind:"DELEGATION"}。枚举常量删除后，
 * {@link ToolCallKind#fromName(String)} 对这种取值<b>必须降级为 {@code null}</b>（而不是抛异常），
 * 且该 {@code null} 形态要能一路安全穿过读侧（展示可用性）与规则侧（形态规则），最终落到
 * 「互动数据不可用，请刷新状态」这一既有降级文案上。</p>
 *
 * <p>本类是「删除兼容分支」的唯一真实风险点的护栏：断言必须判到<b>具体文案 / 动作</b>，
 * 不能只断言 {@code assertDoesNotThrow}。</p>
 *
 * <p>注：用例里出现的 {@code "kind":"DELEGATION"} 是<b>模拟改造前的历史数据字面量</b>（生产库里仍存在），
 * 不是对枚举 / 符号的引用 —— 这正是本测试要验证「历史字面量不会让运行时崩」的原因。</p>
 */
class QaDetachedDelegationRowSafetyTest {

    /** 改造前遗留的 DELEGATION 委派槽位：kind=DELEGATION + 子执行关联 + 任务文本。 */
    private static final String LEGACY_DELEGATION_CONTENT =
            "{\"kind\":\"DELEGATION\",\"subExecutionId\":\"7001\",\"text\":\"写代码\"}";
    /** 更早的老数据形态：根本没有 {@code kind} 键。 */
    private static final String NO_KIND_CONTENT = "{\"subExecutionId\":\"7001\",\"text\":\"写代码\"}";

    private final ObjectMapper json = new ObjectMapper();
    private final ToolCallConverter converter = new ToolCallConverter(json);
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final CardAvailabilityPolicy policy =
            new CardAvailabilityPolicy(provider(executions), provider(activity));
    private final ToolCallActionResolver resolver = new ToolCallActionResolver(policy);

    @Test
    @DisplayName("R1-1 遗留 kind=DELEGATION：resolveKind 返回 null，且不抛异常")
    void legacyDelegationKindResolvesToNull() {
        assertNull(converter.resolveKind(LEGACY_DELEGATION_CONTENT));
    }

    @Test
    @DisplayName("R1-2 遗留 DELEGATION 未决槽位：resolveActions 降级为「互动数据不可用」，不抛异常、无动作")
    void legacyDelegationRowDegradesToUnavailableWithoutThrowing() {
        ToolCall row = detachedRow(LEGACY_DELEGATION_CONTENT);

        ToolCallKind kind = converter.resolveKind(row.getContent());
        assertNull(kind, "老数据 kind=DELEGATION 必须解析为 null");
        JsonNode content = converter.parse(row.getContent());

        ToolCallActionResolver.Availability availability = resolver.resolveActions(row, kind, content);

        assertTrue(availability.allowedActions().isEmpty(), "遗留委派槽位不得开放任何人工动作");
        assertEquals("互动数据不可用，请刷新状态", availability.unavailableReason());
        // 降级发生在纯形态判定阶段：不应回查执行表 / 活跃状态。
        verifyNoInteractions(executions, activity);
    }

    @Test
    @DisplayName("R1-3 resolveRule(null) 不抛异常，规则为空动作且无内容要求")
    void resolveRuleNullDegradesToEmptyRule() {
        CardAvailabilityPolicy.KindRule rule = policy.resolveRule(null);

        assertNotNull(rule);
        assertTrue(rule.allowedActions().isEmpty(), "null 形态必须不开放任何动作");
        assertNull(rule.requiredContentKey());
        verifyNoInteractions(executions, activity);
    }

    @Test
    @DisplayName("R1-4 更早老数据（content 无 kind 键）：同样降级不抛异常")
    void contentWithoutKindKeyAlsoDegrades() {
        ToolCall row = detachedRow(NO_KIND_CONTENT);

        assertNull(converter.resolveKind(row.getContent()));
        JsonNode content = converter.parse(row.getContent());

        ToolCallActionResolver.Availability availability = resolver.resolveActions(row, null, content);

        assertTrue(availability.allowedActions().isEmpty());
        assertEquals("互动数据不可用，请刷新状态", availability.unavailableReason());
        verifyNoInteractions(executions, activity);
    }

    private static ToolCall detachedRow(String content) {
        return ToolCall.builder()
                .id("call-detached").conversationId(2L).executionId(3L)
                .toolName("call_sub_agent").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content(content).createdAt(Instant.now()).build();
    }

    private static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
