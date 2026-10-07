package com.summit.dp.shared.utils;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * {@link CommandDigest#build} 的字段分隔语义。
 *
 * <p>原用例挂在 v2 命令受理测试类里，该类随 v2 链路一并删除；
 * 但字段分隔是 {@code CommandDigest} 自身的契约（工具卡片决策幂等也在用），
 * 任何一处边界消歧失效都会让不同命令误判为重试，故独立保留。</p>
 */
class CommandDigestTest {

    @Test
    @DisplayName("摘要在字段拼接处不产生歧义：ab+c 与 a+bc 必须不同")
    void separatesFieldsAtBoundaries() {
        String shifted = CommandDigest.build("ab", "c");
        String boundaryMoved = CommandDigest.build("a", "bc");

        assertNotEquals(shifted, boundaryMoved, "字段间若无分隔符，ab|c 与 a|bc 会算出同一摘要");
    }

    @Test
    @DisplayName("相同字段序列摘要稳定：同一输入重复计算得同一串")
    void samePartsProduceSameDigest() {
        assertEquals(CommandDigest.build("你好", 1L, true),
                CommandDigest.build("你好", 1L, true));
    }

    @Test
    @DisplayName("空字段与 null 不改变字段数：null 拼成空串但不吞掉分隔")
    void nullPartsKeepFieldCount() {
        assertNotEquals(CommandDigest.build("a", null), CommandDigest.build("a"));
    }
}
