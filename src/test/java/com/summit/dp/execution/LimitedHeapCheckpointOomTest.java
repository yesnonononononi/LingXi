package com.summit.dp.execution;

import com.summit.dp.shared.utils.TestTimeouts;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 用户现场验收项：<b>512 MiB 受限堆下保存执行检查点不得 OOM</b>。
 *
 * <p>改造前是「整段 String 写库 + 仓储里 {@code Map<String,String>} 整段 JSON 缓存」，
 * 现场在 8 MiB 级执行 JSON、多执行并发保存与会话上下文写入时 OOM。这里把同一个负载搬进
 * 一个 {@code -Xmx512m} 的子 JVM 里跑，用事实（进程不 OOM + 堆里留下了什么）而不是估算来守。</p>
 *
 * <p><b>为什么不改 pom 的 surefire 配置</b>：{@code -Xmx} 只作用于启动期，而全量测试的堆
 * 不该被单个用例拉小；用 {@link ProcessBuilder} 起独立 JVM 才能既压小堆又不影响别人。</p>
 *
 * <h2>内存判据为什么从「峰值 used 堆」改成「满 GC 后的活集合」</h2>
 *
 * <p>原来这里断言 {@code PEAK_HEAP_MB <= 360}。它是「10ms 采样看到的最大已用堆」，其中包含
 * <b>还没来得及回收的垃圾</b>：机器一忙、GC 线程被饿住，这个数就往上爬，而代码一行没变。
 * 现场就这么红过：全量跑 49.73s 时峰值 376 MiB（超上限 4.4%），同一天单独跑 3 次（15.6/16.0/14.9s）
 * 全部通过，且三次的确定性判据（整段 JSON 次数 = 0、流式写入 = 65）全都正常。</p>
 *
 * <p><b>实测分布</b>（同一份代码、{@code -Xmx512m}、19 次采样：8 次单独跑 + 9 次「三实例并发」
 * 模拟全量跑的争用 + 1 次 surefire 单跑 + 1 次真正的全量 {@code npm run backend:test}；单位 MiB，
 * 同时记录满 GC 后的活集合与采样点数）：</p>
 *
 * <pre>
 *   上下文              PEAK_HEAP_MB                          HEAP_RETAINED_MB   PEAK_HEAP_SAMPLES
 *   单独跑 x8           226 287 313 315 326 340 354 373       28 或 33（7/8=33）  905~1956
 *   三实例并发 x9       234 264 270 278 313 334 347 348 412   全部 33            1713~2610
 *   surefire 单跑       448                                   33                 934
 *   全量 backend:test   342                                   33                 887
 *   ---------------------------------------------------------------- 分布统计
 *   min / median / max  226 / 326 / 448                       28 / 33 / 33
 *   极差 max/min        1.98 倍                               1.18 倍
 *   变异系数 CV         16.9%                                 3.4%
 * </pre>
 *
 * <p>结论两条，都直接决定阈值怎么取：</p>
 * <ol>
 *   <li><b>「实测 max + 20%」这条路走不通</b>：448 × 1.2 = 537 MiB，已经超过 512 MiB 的堆上限，
 *       不可能再要求「显著低于 512」。更糟的是合法的 448 已经越过了历史「整段 JSON 回退」实测带的
 *       下限（438 / 476 MiB）—— <b>两个区间重叠 ⇒ 这个指标在本堆尺寸下没有区分力</b>，
 *       任何常数要么随机红，要么恒真。</li>
 *   <li><b>活集合有区分力</b>：满 GC 后只剩 <b>28~33 MiB</b>（CV 3.4%，19 次里 18 次就是 33），
 *       而「正文被囤在堆里」的回归会让这个数直接翻几倍（M2 变异实测 +100 MiB 留存 ⇒ 134 MiB）。
 *       它与 GC 在什么时刻跑无关，所以跨机器、跨负载可比。</li>
 * </ol>
 *
 * <p>峰值并没有被丢掉：{@code PEAK_HEAP_MB} 仍然打印在摘要里，作为「这次跑得有多挤」的诊断数字，
 * 但<b>不再当断言</b>——把它当断言就是把 GC 时序写死成代码正确性（和上一轮 {@code @Timeout(60)}
 * 同一个病）。真正守「正文不许囤在堆里」的是下面几条，第一条是确定性的：</p>
 *
 * <ul>
 *   <li>{@code CHECKPOINT_WHOLE_DOCUMENT_STRINGS == 0} —— 保存路径不许出现整段 JSON 字符串/字节数组（确定性，主力）。</li>
 *   <li>{@code CHECKPOINT_STREAM_WRITES > 0} —— 金丝雀：计数器必须活着，否则上一条是空话。</li>
 *   <li>{@code HEAP_RETAINED_MB <= }{@link #RETAINED_HEAP_LIMIT_MB} —— 兜底：计数器没接上流程时，
 *       仍然抓得住「仓储级整段缓存」这类把正文钉在堆上的回退。</li>
 * </ul>
 */
class LimitedHeapCheckpointOomTest {

    /** 子进程堆上限：与用户现场一致。 */
    private static final String CHILD_HEAP = "-Xmx512m";
    /**
     * 满 GC 后「活集合」上限（MiB）—— 兜底判据，只在保存路径绕开计数器时才会用到。
     *
     * <p><b>取值依据（上面那张 19 次分布表的实测值）</b>：合法负载满 GC 后是 28~33 MiB（CV 3.4%），
     * 取 <b>96 MiB ≈ 实测 max 的 2.9 倍</b>：既给不同 JDK/H2 布局留足余量（活集合主要是 24 段正文
     * 加上真实文件库与 mapper 的常驻开销），又远低于「正文被囤住」的区间 —— M2 变异实测额外留存
     * 100 MiB 就到 134 MiB（超上限 39%），而整段 JSON 回退（历史实测 438~476 MiB 峰值、保留型直接 OOM）
     * 更是数量级的差距。这个数也远低于 512 MiB 堆上限，所以不存在「贴近上限就恒真」的问题。</p>
     */
    private static final long RETAINED_HEAP_LIMIT_MB = 96L;
    /** 夹具下限：序列化后必须真的接近现场体积，否则用例是假绿。 */
    private static final long MIN_FIXTURE_BYTES = 7L * 1024 * 1024;
    private static final Pattern PEAK = Pattern.compile("^PEAK_HEAP_MB=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern RETAINED = Pattern.compile("^HEAP_RETAINED_MB=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern BASELINE = Pattern.compile("^HEAP_BASELINE_MB=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern SAMPLES = Pattern.compile("^PEAK_HEAP_SAMPLES=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern FIXTURE = Pattern.compile("^FIXTURE_BYTES=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern WHOLE_DOCUMENT =
            Pattern.compile("^CHECKPOINT_WHOLE_DOCUMENT_STRINGS=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern STREAM_WRITES =
            Pattern.compile("^CHECKPOINT_STREAM_WRITES=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern SAME_CONTEXT =
            Pattern.compile("^SAME_CONTEXT_ROUNDS=(\\d+)$", Pattern.MULTILINE);

    @Test
    @Timeout(TestTimeouts.LONG_HANG_GUARD)
    void savingLargeCheckpointsUnderA512MiBHeapNeitherOomsNorRetainsWholeDocuments() throws Exception {
        Path dataDir = Files.createTempDirectory("lingxi-heap-test-");
        Path output = Files.createTempFile("lingxi-heap-test-", ".log");
        try {
            int exitCode = runChild(dataDir, output);
            String log = Files.readString(output, StandardCharsets.UTF_8);

            assertEquals(0, exitCode, () -> "子进程在 " + CHILD_HEAP + " 下没有正常结束（疑似 OOM）:\n" + log);
            assertFalse(log.contains("OutOfMemoryError"), () -> "子进程 OOM:\n" + log);
            assertTrue(log.contains("RESULT=OK"), () -> "子进程没有跑完负载:\n" + log);

            long fixtureBytes = matchLong(FIXTURE, log, "夹具序列化体积");
            assertTrue(fixtureBytes >= MIN_FIXTURE_BYTES,
                    () -> "夹具体积不足，用例会假绿: " + fixtureBytes + " bytes\n" + log);

            // —— 确定性判据：保存路径不许出现整段 JSON 字符串/字节数组（改造前的写法）——
            assertEquals(0L, matchLong(WHOLE_DOCUMENT, log, "整段 JSON 字符串次数"),
                    () -> "检查点保存路径产生过整段 JSON 字符串/字节数组（改造前的写法）:\n" + log);

            // 金丝雀：计数器必须是活的 —— 否则「整段转换 0 次」是一句空话，
            // 计数器没接上流程时它永远是 0。
            assertTrue(matchLong(STREAM_WRITES, log, "流式写入次数") > 0,
                    () -> "计数 mapper 没有记录到任何流式写入，说明它在链路上失效了:\n" + log);

            // 复核 R5 要求补的压力场景：同一个大上下文连续更新，不能被「5 个不同会话」替代。
            assertTrue(matchLong(SAME_CONTEXT, log, "同一上下文连续更新轮数") >= 5,
                    () -> "同一大上下文连续更新 5 轮的压力场景没有跑:\n" + log);

            // —— 兜底判据：满 GC 之后堆里还留着什么（与 GC 时序无关，跨机器可比）——
            // 为什么不是 PEAK_HEAP_MB：峰值含未回收垃圾，实测 226~448 MiB（2 倍极差），
            // 而合法负载已经能到 448 MiB，与历史「整段 JSON 回退」的 438~476 MiB 区间重叠，
            // 没有区分力；把它当断言就是把 GC 时序写成代码正确性（见类注释的分布表）。
            long retainedHeapMb = matchLong(RETAINED, log, "满 GC 后的活集合");
            long baselineHeapMb = matchLong(BASELINE, log, "起始活集合");
            long peakHeapMb = matchLong(PEAK, log, "峰值堆（诊断用）");
            long peakSamples = matchLong(SAMPLES, log, "峰值采样点数");
            assertTrue(retainedHeapMb <= RETAINED_HEAP_LIMIT_MB,
                    () -> "满 GC 后仍有 " + retainedHeapMb + " MiB 被活对象占着（上限 " + RETAINED_HEAP_LIMIT_MB
                            + " MiB，起始 " + baselineHeapMb + " MiB），说明正文被囤在堆里了"
                            + "（计数器没接上流程时，这条兜底仍然要抓住「仓储级整段缓存」这类回退）:\n" + log);

            // 把实测数字打出来，供内存对照报告取用（不做断言，只做记录）。
            System.out.println("[受限堆实测] retainedMiB=" + retainedHeapMb + " baselineMiB=" + baselineHeapMb
                    + " peakMiB=" + peakHeapMb + " peakSamples=" + peakSamples + " " + summary(log));
        } finally {
            Files.deleteIfExists(output);
            deleteRecursively(dataDir);
        }
    }

    private static int runChild(Path dataDir, Path output) throws IOException, InterruptedException {
        List<String> command = new ArrayList<>();
        command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        command.add(CHILD_HEAP);
        // 子进程的中文输出必须固定 UTF-8，否则父进程按 UTF-8 读会被 GBK 字节打断。
        command.add("-Dfile.encoding=UTF-8");
        command.add("-Dstdout.encoding=UTF-8");
        command.add("-Dstderr.encoding=UTF-8");
        // surefire 里 java.class.path 可能是一个带 Class-Path 清单的 booter jar，直接透传即可。
        command.add("-cp");
        command.add(System.getProperty("java.class.path"));
        command.add(LimitedHeapCheckpointHarness.class.getName());
        command.add(dataDir.toString());

        ProcessBuilder builder = new ProcessBuilder(command);
        builder.redirectErrorStream(true);
        builder.redirectOutput(output.toFile());
        Process process = builder.start();
        if (!process.waitFor(540, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IllegalStateException("受限堆子进程超时未结束");
        }
        return process.exitValue();
    }

    /** 一行摘要：只取需要进报告的数字，避免把整段子进程日志刷进构建输出。 */
    private static String summary(String log) {
        StringBuilder text = new StringBuilder();
        for (String line : log.split("\\R")) {
            if (line.startsWith("FIXTURE_BYTES=") || line.startsWith("MAX_HEAP_MB=")
                    || line.startsWith("PEAK_HEAP_MB=") || line.startsWith("SAVE_MS=")
                    || line.startsWith("RESTORE_MS=") || line.startsWith("HISTORY_EXECUTIONS=")
                    || line.startsWith("CONTEXT_ROUNDS=") || line.startsWith("CHECKPOINT_WHOLE_DOCUMENT_STRINGS=")
                    || line.startsWith("SINGLE_ROUNDS=") || line.startsWith("CONCURRENT_ROUNDS=")
                    || line.startsWith("SAME_CONTEXT_ROUNDS=") || line.startsWith("CHECKPOINT_STREAM_WRITES=")
                    || line.startsWith("LIVE_REFS=") || line.startsWith("GC_MS=")) {
                text.append(line).append(' ');
            }
        }
        return text.toString().trim();
    }

    private static long matchLong(Pattern pattern, String log, String what) {        Matcher matcher = pattern.matcher(log);
        assertTrue(matcher.find(), () -> "子进程没有输出" + what + ":\n" + log);
        return Long.parseLong(matcher.group(1));
    }

    private static void deleteRecursively(Path directory) {
        try (java.util.stream.Stream<Path> paths = Files.walk(directory)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // 系统临时目录由系统兜底清理，不掩盖断言失败。
                }
            });
        } catch (IOException ignored) {
            // 同上。
        }
    }
}
