package com.summit.dp.shared.utils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 路径断言的小工具：比较前先把两侧都规范化。
 *
 * <p><b>为什么不能直接比字符串：</b>同一条路径有多种合法写法——Windows 的 8.3 短名
 * （{@code C:\PROGRA~1} 与 {@code C:\Program Files}）、大小写、{@code .}/{@code ..} 段、
 * 分隔符重复。业务代码把路径写进 JSON 时用的是<b>长名</b>，测试拿到的临时目录却可能是<b>短名</b>
 * （GitHub 的 Windows runner 上 {@code C:\Users\RUNNER~1\AppData\Local\Temp} 对
 * {@code C:\Users\runneradmin\AppData\Local\Temp}），逐字符比字符串必红——而配置其实完全正确。</p>
 *
 * <p><b>为什么比较 {@link Path} 对象而不是先拼成字符串：</b>{@code Path#equals} 是组件级比较，
 * 但<b>不会</b>展开短名、也不会消除 {@code ..}；所以两侧都要先规范化：
 * 能取 {@code toRealPath()}（存在 → 解析短名/符号链接/真实大小写）就取它，取不到
 * （文件还没建出来）退回 {@code toAbsolutePath().normalize()}。</p>
 */
public final class TestPaths {

    private TestPaths() {
    }

    /**
     * 把路径规范化为「同一文件只有一种写法」。
     *
     * @param path 任意路径
     * @return 规范化后的绝对路径
     */
    public static Path canonical(Path path) {
        try {
            return path.toRealPath();
        } catch (IOException notExists) {
            return path.toAbsolutePath().normalize();
        }
    }

    /**
     * 断言两个路径指向同一个位置。
     *
     * @param expected     期望路径
     * @param actual       实际路径
     * @param message      失败时的说明（会附加两侧的规范化结果与原始写法）
     */
    public static void assertSamePath(Path expected, Path actual, String message) {
        Path left = canonical(expected);
        Path right = canonical(actual);
        assertEquals(left, right,
                message + "（原始写法 expected=" + expected + "，actual=" + actual + "）");
    }
}
