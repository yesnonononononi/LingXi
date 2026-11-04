package com.summit.dp.shared.utils;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * {@link TestPaths} 的自证：<b>「去掉规范化就会红」这条必须被测试守住</b>。
 *
 * <p>否则 {@code assertSamePath} 退化成「比字符串」，CI 上的短名/长名差异又会被当成代码缺陷。</p>
 */
class TestPathsTest {

    @TempDir
    Path temporary;

    @Test
    @DisplayName("含 .. 的写法：原样比 Path 不等，规范化后必须相等")
    void dotDotSegmentsAreNormalized() throws Exception {
        Path plain = Files.createDirectories(temporary.resolve("a/b"));
        Path winding = Path.of(temporary.resolve("a").toString(), "b", "..", "b");

        // 前提：不规范化时两者确实不等（否则下面那条断言毫无意义）
        assertNotEquals(plain, winding, "用例前提：未规范化的 Path 必须不等");

        TestPaths.assertSamePath(plain, winding, ".. 段必须被规范化");
    }

    @Test
    @DisplayName("尚未创建的路径：取不到 toRealPath 时退回绝对+normalize，同样要判等")
    void nonExistingPathsFallBackToNormalizedAbsolute() {
        Path expected = temporary.resolve("not-created-yet");
        Path withDotDot = temporary.resolve("not-created-yet").resolve("..").resolve("not-created-yet");

        assertFalse(Files.exists(withDotDot), "用例前提：目标文件不存在（否则走的是 toRealPath 分支）");
        assertNotEquals(expected, withDotDot, "用例前提：未规范化的 Path 必须不等");

        TestPaths.assertSamePath(expected, withDotDot, "不存在的路径也必须按 绝对 + normalize 判等");
    }

    @Test
    @DisplayName("不同目录仍然不等（规范化不能把不等判成等）")
    void differentPathsStillFail() throws Exception {
        Path first = Files.createDirectories(temporary.resolve("x"));
        Path second = Files.createDirectories(temporary.resolve("y"));
        assertThrows(AssertionError.class,
                () -> TestPaths.assertSamePath(first, second, "两个不同目录必须判不等"),
                "规范化不能把真不等变成相等");
    }
}
