package com.summit.dp.shared.utils;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「{@code @Timeout} 只用来防挂死、不许当性能断言」的棘轮（照着
 * {@code RequestPreparerConstructionRatchetTest} 的写法做的源码扫描型测试）。
 *
 * <p><b>为什么需要这条棘轮：</b>本次 CI 红灯的成因不是代码坏，而是
 * {@code ExecutionCleanupFileStorageTest} 上的 {@code @Timeout(60)} 把「机器多快」写死成了断言 ——
 * 同一份 diff，前一次 run 用 30.16s 绿，后一次 60.05s 红（runner 整体慢 1.32×，DB 重的类慢到 1.96×）。
 * 把 29 处字面量收成 {@link TestTimeouts} 常量只解决了「现在」；只要还有人能随手写回
 * {@code @Timeout(<数字>)}，这类红灯就会重新出现。所以这里同时守三件事：</p>
 *
 * <ol>
 *   <li>{@code src/test/**} 里<b>禁止</b>出现 {@code @Timeout(<数字>)} 字面量（只允许引用常量），
 *       命中即红并点名「文件:行号」；</li>
 *   <li>常量<b>不许被调小</b>：{@code HANG_GUARD >= 240s}、{@code LONG_HANG_GUARD >= HANG_GUARD}
 *       —— 否则「为了让测试变绿把闸门调小」正是本次缺陷的翻版；</li>
 *   <li>引用常量的闸门数<b>只增不减</b>（改造时 29 处）：有人把闸门整条删掉（等于取消防挂死）
 *       也会被抓到。</li>
 * </ol>
 *
 * <p>扫描器会先剥掉注释与字符串/字符/文本块字面量，所以「注释里讨论旧写法」不算违规
 * （本文件自己的 javadoc 与自证用例里就带着 {@code @Timeout(60)} 这种示例文本）。</p>
 */
class TestTimeoutRatchetTest {

    /** 改造时 13 个类共 29 处引用；棘轮只增不减。 */
    private static final int MIN_CONSTANT_REFERENCES = 29;

    /** 防挂死闸门的下限（秒）：低于它就说明有人把常量往小里改。 */
    private static final long MIN_HANG_GUARD_SECONDS = 240L;

    /** 允许的参数前缀：只认常量引用，任何别的写法（数字、value=数字、混合公式）都算违规。 */
    private static final String ALLOWED_ARGUMENT_PREFIX = "TestTimeouts.";

    @Test
    @DisplayName("棘轮：src/test/** 禁止 @Timeout(<数字>) 字面量，只许引用 TestTimeouts 常量")
    void noAbsoluteTimeoutLiteralInTestSources() throws IOException {
        Path testRoot = Path.of("src", "test");
        assertTrue(Files.isDirectory(testRoot), "测试源码根目录必须存在（surefire 的工作目录是模块根）: "
                + testRoot.toAbsolutePath());

        List<String> violations = new ArrayList<>();
        for (Path file : testSources(testRoot)) {
            String source = stripCommentsAndLiterals(Files.readString(file));
            for (int line : literalTimeoutLines(source)) {
                violations.add(relative(testRoot, file) + ":" + line);
            }
        }

        assertTrue(violations.isEmpty(), () ->
                "发现「绝对秒数当性能闸门」，这种写法会把 runner 快慢写死成断言（细节见 TestTimeouts 类头部）：\n  "
                        + String.join("\n  ", violations)
                        + "\n改法：@Timeout(TestTimeouts.HANG_GUARD)；限堆/子进程类用 "
                        + "@Timeout(TestTimeouts.LONG_HANG_GUARD)。如果确实需要更长的防挂死窗口，"
                        + "往 TestTimeouts 里加常量，别退回字面量。");
    }

    @Test
    @DisplayName("棘轮：防挂死常量不许调小（HANG_GUARD ≥ 240s，LONG_HANG_GUARD ≥ HANG_GUARD）")
    void hangGuardConstantsStayGenerous() {
        assertTrue(TestTimeouts.HANG_GUARD >= MIN_HANG_GUARD_SECONDS,
                "TestTimeouts.HANG_GUARD 被调小到 " + TestTimeouts.HANG_GUARD + "s（下限 "
                        + MIN_HANG_GUARD_SECONDS + "s）：为了让测试变绿而收窄防挂死闸门，正是本次缺陷的翻版");
        assertTrue(TestTimeouts.LONG_HANG_GUARD >= TestTimeouts.HANG_GUARD,
                "TestTimeouts.LONG_HANG_GUARD(" + TestTimeouts.LONG_HANG_GUARD
                        + "s) 不得小于 HANG_GUARD(" + TestTimeouts.HANG_GUARD + "s)：限堆/子进程用例只会更慢");
    }

    @Test
    @DisplayName("棘轮：引用常量的闸门数只增不减（至少 29 处）")
    void constantReferenceCountNeverShrinks() throws IOException {
        Path testRoot = Path.of("src", "test");
        assertTrue(Files.isDirectory(testRoot), "测试源码根目录必须存在: " + testRoot.toAbsolutePath());

        int references = 0;
        for (Path file : testSources(testRoot)) {
            String source = stripCommentsAndLiterals(Files.readString(file));
            for (TimeoutSite site : findTimeoutSites(source)) {
                if (site.argument().startsWith(ALLOWED_ARGUMENT_PREFIX)) {
                    references++;
                }
            }
        }

        assertTrue(references >= MIN_CONSTANT_REFERENCES,
                "引用 TestTimeouts 常量的闸门只有 " + references + " 处，少于改造时的 "
                        + MIN_CONSTANT_REFERENCES + " 处：有人把防挂死闸门删了或被注释掉了。"
                        + "闸门只增不减 —— 需要新增用例就照抄 @Timeout(TestTimeouts.HANG_GUARD)。");
    }

    @Test
    @DisplayName("扫描器自证：注释/字符串里的示例不算违规，真字面量必须被抓到并给出行号")
    void scannerIgnoresCommentsAndStringLiterals() {
        String sample = String.join("\n",
                "// 行注释里讨论旧写法 @Timeout(60) 不算违规",
                "/* 块注释里的 @Timeout(60) 也不算 */",
                "class Sample {",
                "  @Timeout(120)",
                "  void slow() {}",
                "  @Timeout(value = 30, unit = java.util.concurrent.TimeUnit.SECONDS)",
                "  void viaValue() {}",
                "  @Timeout(TestTimeouts.HANG_GUARD)",
                "  void ok() {}",
                "  String message = \"@Timeout(60) 只是文案\";",
                "  String textBlock = \"\"\"",
                "      @Timeout(90)",
                "      \"\"\";",
                "}");

        assertEquals(List.of(4, 6), literalTimeoutLines(stripCommentsAndLiterals(sample)),
                "扫描器必须只抓真正的注解字面量：第 4 行 @Timeout(120)、第 6 行 @Timeout(value = 30…) 是违规；"
                        + "注释、普通字符串、文本块里的示例文本都不算");
    }

    /** 剥掉注释与字面量后的源码里，仍以「非 TestTimeouts 常量」形式出现的 @Timeout 所在行号。 */
    private static List<Integer> literalTimeoutLines(String strippedSource) {
        List<Integer> lines = new ArrayList<>();
        for (TimeoutSite site : findTimeoutSites(strippedSource)) {
            if (!site.argument().startsWith(ALLOWED_ARGUMENT_PREFIX)) {
                lines.add(site.line());
            }
        }
        return lines;
    }

    /**
     * 找出所有 {@code @Timeout(} 出现的「行号 + 括号后的参数前缀」。
     *
     * @param strippedSource 已剥掉注释与字面量的源码（长度与换行位置保持不变，行号因此可信）
     */
    private static List<TimeoutSite> findTimeoutSites(String strippedSource) {
        List<TimeoutSite> sites = new ArrayList<>();
        String needle = "@Timeout";
        int from = 0;
        while (true) {
            int at = strippedSource.indexOf(needle, from);
            if (at < 0) {
                return sites;
            }
            int cursor = at + needle.length();
            // 允许 @Timeout (…) 这种中间带空白的写法
            while (cursor < strippedSource.length() && Character.isWhitespace(strippedSource.charAt(cursor))) {
                cursor++;
            }
            if (cursor < strippedSource.length() && strippedSource.charAt(cursor) == '(') {
                cursor++;
                while (cursor < strippedSource.length() && Character.isWhitespace(strippedSource.charAt(cursor))) {
                    cursor++;
                }
                sites.add(new TimeoutSite(lineOf(strippedSource, at), strippedSource.substring(
                        cursor, Math.min(strippedSource.length(), cursor + ALLOWED_ARGUMENT_PREFIX.length()))));
                from = cursor;
            } else {
                from = at + needle.length();
            }
        }
    }

    private static int lineOf(String source, int index) {
        int line = 1;
        for (int i = 0; i < index; i++) {
            if (source.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }

    /**
     * 把注释与字符串/字符/文本块字面量替换成空格，<b>保留换行</b>，因此行号与原文一致。
     *
     * <p>为什么必须这么做：注释里出现 {@code @Timeout(60)}（讨论历史写法）、字符串里出现
     * 「这里是 @Timeout(60)」的断言消息都是合法的，把它们算成违规会让棘轮自己假红
     * —— 上一轮 RequestPreparer 棘轮就踩过「needle 出现在自己的 javadoc 里」这种坑。</p>
     */
    static String stripCommentsAndLiterals(String source) {
        StringBuilder out = new StringBuilder(source.length());
        int index = 0;
        int length = source.length();
        while (index < length) {
            char current = source.charAt(index);
            char next = index + 1 < length ? source.charAt(index + 1) : '\0';
            if (current == '/' && next == '/') {
                while (index < length && source.charAt(index) != '\n') {
                    out.append(' ');
                    index++;
                }
            } else if (current == '/' && next == '*') {
                while (index < length && !(source.charAt(index) == '*' && index + 1 < length
                        && source.charAt(index + 1) == '/')) {
                    out.append(source.charAt(index) == '\n' ? '\n' : ' ');
                    index++;
                }
                for (int i = 0; i < 2 && index < length; i++) {
                    out.append(' ');
                    index++;
                }
            } else if (current == '"' && source.startsWith("\"\"\"", index)) {
                out.append("   ");
                index += 3;
                while (index < length && !source.startsWith("\"\"\"", index)) {
                    out.append(source.charAt(index) == '\n' ? '\n' : ' ');
                    index++;
                }
                for (int i = 0; i < 3 && index < length; i++) {
                    out.append(' ');
                    index++;
                }
            } else if (current == '"' || current == '\'') {
                char quote = current;
                out.append(' ');
                index++;
                while (index < length) {
                    char inner = source.charAt(index);
                    if (inner == '\\' && index + 1 < length) {
                        out.append("  ");
                        index += 2;
                    } else if (inner == quote) {
                        out.append(' ');
                        index++;
                        break;
                    } else {
                        out.append(inner == '\n' ? '\n' : ' ');
                        index++;
                    }
                }
            } else {
                out.append(current);
                index++;
            }
        }
        return out.toString();
    }

    private static List<Path> testSources(Path testRoot) throws IOException {
        try (Stream<Path> files = Files.walk(testRoot)) {
            return files.filter(path -> path.toString().endsWith(".java")).sorted().toList();
        }
    }

    private static String relative(Path root, Path file) {
        return root.relativize(file).toString().replace('\\', '/');
    }

    /** 一处 @Timeout 注解：行号 + 括号后的参数前缀（够用来判定「是不是常量引用」）。 */
    private record TimeoutSite(int line, String argument) {
    }
}