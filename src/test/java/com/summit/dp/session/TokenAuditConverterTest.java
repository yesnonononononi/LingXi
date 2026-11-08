package com.summit.dp.session;

import com.summit.core.audit.AuditStatus;
import com.summit.core.audit.DocumentElement;
import com.summit.core.audit.token.OtherTokens;
import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.dp.session.application.convert.TokenAuditConverter;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 转换器对 {@code OtherTokens} 两个新归因字段的读取规则。
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

        assertNull(measurement.memoryTokens());
        assertNull(measurement.attachmentTokens());
    }

    @Test
    @DisplayName("元素为 null：两项归因一律 null")
    void nullElementYieldsNull() {
        OtherTokens other = new OtherTokens(null, null, null, null);
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
                element(777, AuditStatus.NO_DATA),
                element(889, AuditStatus.FAILED));
        Measurement measurement = converter.toMeasurement(documentWithOther(other), null);

        assertNull(measurement.memoryTokens(), "NO_DATA 表示框架没给出，必须是未知");
        assertNull(measurement.attachmentTokens(), "FAILED 表示该项审计失败，必须是未知");
    }

    @Test
    @DisplayName("元素成功：两项归因原样透传（0 是真实值，与 null 不同）")
    void successfulElementPassesThrough() {
        OtherTokens other = new OtherTokens(
                element(8200, AuditStatus.SUCCESS),
                element(3100, AuditStatus.SUCCESS),
                element(0, AuditStatus.SUCCESS),
                element(889, AuditStatus.SUCCESS));
        Measurement measurement = converter.toMeasurement(documentWithOther(other), null);

        assertEquals(0, measurement.memoryTokens(), "0 是「确实没有记忆正文」，必须保留为 0");
        assertEquals(889, measurement.attachmentTokens());
        assertEquals(8200, measurement.toolDefinitionTokens());
        assertEquals(3100, measurement.mcpToolDefinitionTokens());
    }

    @Test
    @DisplayName("框架给出负数：按未知处理，不夹成 0 也不抛错")
    void negativeValueTreatedAsUnknown() {
        OtherTokens other = new OtherTokens(null, null,
                element(-5, AuditStatus.SUCCESS), element(-1, AuditStatus.SUCCESS));
        Measurement measurement = converter.toMeasurement(documentWithOther(other), null);

        assertNull(measurement.memoryTokens());
        assertNull(measurement.attachmentTokens());
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
