package com.summit.dp.session;

import com.summit.core.audit.AuditStatus;
import com.summit.core.audit.DocumentElement;
import com.summit.core.audit.token.OtherTokens;
import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.dp.session.application.convert.TokenAuditConverter;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 转换器对 {@code OtherTokens} 三个归因字段（动态上下文 / 记忆 / 附件）的读取规则。
 *
 * <p>核心承诺只有一条：<b>「未知」必须保持 {@code null}，绝不能用 0 冒充</b>。
 * 0 会让前端画出一条「记忆 / 附件零开销」的假项，而 null 才能让它整块隐藏。</p>
 */
class TokenAuditConverterTest {

    private final TokenAuditConverter converter = new TokenAuditConverter();

    @Test
    @DisplayName("otherTokens 缺失：两项归因一律 null")
    void missingOtherTokensYieldsNull() {
        Measurement measurement = converter.toMeasurement(documentWithOther(null), null);

        assertNull(measurement.dynamicContextTokens());
        assertNull(measurement.memoryTokens());
        assertNull(measurement.attachmentTokens());
    }

    @Test
    @DisplayName("元素为 null：两项归因一律 null")
    void nullElementYieldsNull() {
        OtherTokens other = new OtherTokens(null, null, null, null, List.of(), null);
        Measurement measurement = converter.toMeasurement(documentWithOther(other), null);

        assertNull(measurement.memoryTokens());
        assertNull(measurement.attachmentTokens());
    }

    @Test
    @DisplayName("元素审计失败（NO_DATA / FAILED）：两项归因一律 null，不读 tokenMeta")
    void failedElementYieldsNull() {
        OtherTokens other = new OtherTokens(
                element(100, AuditStatus.FAILED),
                element(200, AuditStatus.FAILED),
                element(555, AuditStatus.NO_DATA),
                element(777, AuditStatus.NO_DATA),
                List.of(),
                element(889, AuditStatus.FAILED));
        Measurement measurement = converter.toMeasurement(documentWithOther(other), null);

        assertNull(measurement.dynamicContextTokens(), "NO_DATA 表示框架没给出，必须是未知");
        assertNull(measurement.memoryTokens(), "NO_DATA 表示框架没给出，必须是未知");
        assertNull(measurement.attachmentTokens(), "FAILED 表示该项审计失败，必须是未知");
    }

    @Test
    @DisplayName("元素成功：两项归因原样透传（0 是真实值，与 null 不同）")
    void successfulElementPassesThrough() {
        OtherTokens other = new OtherTokens(
                element(8200, AuditStatus.SUCCESS),
                element(3100, AuditStatus.SUCCESS),
                element(4500, AuditStatus.SUCCESS),
                element(0, AuditStatus.SUCCESS),
                List.of(),
                element(889, AuditStatus.SUCCESS));
        Measurement measurement = converter.toMeasurement(documentWithOther(other), null);

        assertEquals(4500, measurement.dynamicContextTokens());
        assertEquals(0, measurement.memoryTokens(), "0 是「确实没有记忆正文」，必须保留为 0");
        assertEquals(889, measurement.attachmentTokens());
        assertEquals(8200, measurement.toolDefinitionTokens());
        assertEquals(3100, measurement.mcpToolDefinitionTokens());
    }

    @Test
    @DisplayName("框架给出负数：按未知处理，不夹成 0 也不抛错")
    void negativeValueTreatedAsUnknown() {
        OtherTokens other = new OtherTokens(null, null, element(-3, AuditStatus.SUCCESS),
                element(-5, AuditStatus.SUCCESS), List.of(), element(-1, AuditStatus.SUCCESS));
        Measurement measurement = converter.toMeasurement(documentWithOther(other), null);

        assertNull(measurement.dynamicContextTokens());
        assertNull(measurement.memoryTokens());
        assertNull(measurement.attachmentTokens());
    }

    @Test
    @DisplayName("动态上下文：成功值原样透传，缺失时保持未知（不是 0）")
    void dynamicContextPassesThrough() {
        OtherTokens other = new OtherTokens(null, null, element(4500, AuditStatus.SUCCESS),
                element(777, AuditStatus.SUCCESS), List.of(), element(889, AuditStatus.SUCCESS));

        assertEquals(4500, converter.toMeasurement(documentWithOther(other), null).dynamicContextTokens());
        assertNull(converter.toMeasurement(documentWithOther(null), null).dynamicContextTokens(),
                "otherTokens 缺失时动态上下文是未知，写 0 会画出一条不存在的背景块");
    }

    private static DocumentElement<Integer> element(int tokens, AuditStatus status) {
        return DocumentElement.<Integer>builder()
                .tokenMeta(tokens)
                .status(status)
                .type("int")
                .ratio(0.0)
                .build();
    }

    /** 只关心 {@code otherTokens}：其余角色一律给成功元素，避免干扰。 */
    private static TokenAuditDocument documentWithOther(OtherTokens other) {
        DocumentElement<Integer> zero = element(0, AuditStatus.SUCCESS);
        return new TokenAuditDocument(zero, zero, null, zero, other);
    }
}
