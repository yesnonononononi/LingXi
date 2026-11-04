package com.summit.dp.workflow.application.chat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「{@link RequestPreparer} 只能经测试侧构造器装配」的棘轮。
 *
 * <p><b>为什么用一条源码扫描测试守这种事：</b>编译期能挡参数类型不匹配，但挡不住
 * 「第 6 位传 null」——那正是本次 CI 红灯的成因（{@code settingsProvider} 被传成 null，
 * 参数个数没变，编译通过，运行期 NPE）。要真正防复发，只能让「按位置传一串 null」这种写法
 * 从代码里消失：新写的一律走 {@link RequestPreparerTestSupport}（命名参数），
 * 存量 9 处列进基线，基线只允许收缩。</p>
 *
 * <p>命中口径：测试源码里出现 {@code new + 类名 + 左括号} 的文件。本类自己不含该字面量
 * （needle 是拼出来的），所以无需把自己排除在外。</p>
 */
class RequestPreparerConstructionRatchetTest {

    /**
     * 允许直接 new 的文件（相对 {@code src/test/java}，正斜杠）。
     *
     * <p>{@code RequestPreparerTestSupport} 是唯一合法的装配点；其余是尚未迁移的存量，
     * 迁移一个就删一行。新增条目等于「又写回位置参数」，评审时应当被拒绝。</p>
     */
    private static final Set<String> ALLOWED = Set.of(
            // 唯一合法装配点
            "com/summit/dp/workflow/application/chat/RequestPreparerTestSupport.java",
            // 存量（技术债：迁移到 RequestPreparerTestSupport 后从本清单删除）
            "com/summit/dp/agent/ChatAdmissionTransactionTest.java",
            "com/summit/dp/model/AgentModelConfigurationTest.java",
            "com/summit/dp/session/SessionTeamBindingTest.java",
            "com/summit/dp/shared/utils/ChatImageResolverTest.java",
            "com/summit/dp/shared/utils/CollaborationToolExposureTest.java",
            "com/summit/dp/shared/utils/RequestPreparerExecutionIdentityTest.java",
            "com/summit/dp/workflow/application/chat/AgentWorkflowOrchestratorPromptTest.java",
            "com/summit/dp/workflow/application/chat/RequestPreparerModelFallbackTest.java",
            "com/summit/dp/workflow/application/chat/RequestPreparerSettingsPropagationTest.java");

    @Test
    @DisplayName("棘轮：只有测试侧构造器可以按位置装配 RequestPreparer")
    void onlyTestSupportConstructsRequestPreparerPositionally() throws IOException {
        Path testRoot = Path.of("src", "test", "java");
        assertTrue(Files.isDirectory(testRoot), "测试源码根目录必须存在（surefire 的工作目录是模块根）: "
                + testRoot.toAbsolutePath());

        // needle 拼出来而不是写字面量：否则本文件自己会被扫成"又一处在 new"
        String needle = "new " + RequestPreparer.class.getSimpleName() + "(";
        Set<String> actual = new TreeSet<>();
        try (Stream<Path> files = Files.walk(testRoot)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                if (Files.readString(file).contains(needle)) {
                    actual.add(testRoot.relativize(file).toString().replace('\\', '/'));
                }
            }
        }

        assertEquals(new TreeSet<>(ALLOWED), actual,
                "RequestPreparer 的构造点集合变了：新增的请改用 RequestPreparerTestSupport.builder()"
                        + "（命名参数，settingsProvider 之类必填依赖不会再被静默传成 null）；"
                        + "如果这次是迁移存量，把对应文件从 ALLOWED 里删掉即可。");
    }
}
