package com.summit.dp.architecture;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * 恢复门禁目录守卫：挂起门禁必须只有「人的暂停 / 自动轮次上限」与「未决卡片」两类。
 *
 * <p><b>为什么扫源码而不是只测行为</b>：门禁是 Spring 多 bean 注入，各处用例都手工拼自己那条链 ——
 * 新增一个门禁 bean 不会让任何行为用例变红，但会在生产里静默拦住唤醒。曾经那道「等待子代理」门禁
 * 就是这么把「任一子会话终态即唤醒」压成「等最后一个子会话结束」的。</p>
 *
 * <p>扫描器自带同特征金丝雀（含 NUL 字节、放在嵌套目录），扫不到时用例就红。</p>
 */
class SuspensionGateCatalogTest {

    private static final Pattern IMPLEMENTS_GATE =
            Pattern.compile("\\bimplements\\b[^{;]*\\bSuspensionGate\\b");

    /** 允许存在的门禁实现：新增一个必须在此显式登记，并说明它凭什么拦住人的唤醒。 */
    private static final Set<String> ALLOWED = new TreeSet<>(List.of(
            "UserPauseSuspensionGate.java",
            "UnresolvedToolSuspensionGate.java"));

    @Test
    void onlyPauseAndUnresolvedCardGatesExist() throws IOException {
        Set<String> found = findGateImplementations(Path.of("src/main/java"));
        assertEquals(ALLOWED, found,
                "恢复门禁集合被改动：子代理未完成不是恢复准入条件，兄弟子会话在跑不阻止唤醒");
    }

    @Test
    void scannerFindsGateImplementationInNestedFileWithNullByte(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("lifecycle/deep/nested/WaitingGate.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.workflow.application.lifecycle.deep;\n\u0000\n"
                + "class WaitingGate implements SuspensionGate { }\n");
        assertFalse(findGateImplementations(directory).isEmpty(), "扫描器必须在嵌套目录里抓到门禁实现");
    }

    @Test
    void scannerIgnoresMentionsInComments(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("lifecycle/Comment.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.workflow.application.lifecycle;\n"
                + "// class Gone implements SuspensionGate { }\n"
                + "class Comment { List<SuspensionGate> gates; }\n");
        assertEquals(Set.of(), findGateImplementations(directory), "注释与泛型引用不算实现");
    }

    private static Set<String> findGateImplementations(Path root) throws IOException {
        Set<String> found = new TreeSet<>();
        try (Stream<Path> paths = Files.walk(root)) {
            List<Path> sources = paths.filter(path -> path.toString().endsWith(".java")).toList();
            if (sources.isEmpty()) throw new IllegalStateException("门禁目录检查未读到源码");
            for (Path source : sources) {
                Matcher matcher = IMPLEMENTS_GATE.matcher(stripComments(Files.readString(source)));
                if (matcher.find()) found.add(source.getFileName().toString());
            }
        }
        return found;
    }

    /** 注释里的类名不算实现，先剥注释再匹配。 */
    private static String stripComments(String content) {
        return content.replaceAll("(?s)/\\*.*?\\*/|//[^\\r\\n]*", "");
    }
}
