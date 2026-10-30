package com.summit.dp.execution;

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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 用户现场验收项：<b>512 MiB 受限堆下保存执行检查点不得 OOM</b>。
 *
 * <p>改造前是「整段 String 写库 + 仓储里 {@code Map<String,String>} 整段 JSON 缓存」，
 * 现场在 8 MiB 级执行 JSON、多执行并发保存与会话上下文写入时 OOM。这里把同一个负载搬进
 * 一个 {@code -Xmx512m} 的子 JVM 里跑，用事实（进程不 OOM + 峰值堆）而不是估算来守。</p>
 *
 * <p><b>为什么不改 pom 的 surefire 配置</b>：{@code -Xmx} 只作用于启动期，而全量测试的堆
 * 不该被单个用例拉小；用 {@link ProcessBuilder} 起独立 JVM 才能既压小堆又不影响别人。</p>
 */
class LimitedHeapCheckpointOomTest {

    /** 子进程堆上限：与用户现场一致。 */
    private static final String CHILD_HEAP = "-Xmx512m";
    /**
     * 峰值堆上限（MiB）：取堆上限的一半。
     *
     * <p>定标依据：改造后在 {@code -Xmx512m} 下多次实测峰值 96–128 MiB（夹具单份序列化 12.5 MiB，
     * 负载为单执行 10 轮 + 三执行并发 5 轮 + 40 条历史执行 + 5 轮会话上下文写入）。
     * 256 MiB 留出约 2 倍余量，同时仍能抓住「仓储里又囤起每条执行一份整段 JSON」
     * （40 条 × 约 9.6 MB ≈ 384 MB，会直接撞上 512 MiB 堆上限）。</p>
     */
    private static final long PEAK_HEAP_LIMIT_MB = 256L;
    /** 夹具下限：序列化后必须真的接近现场体积，否则用例是假绿。 */
    private static final long MIN_FIXTURE_BYTES = 7L * 1024 * 1024;
    private static final Pattern PEAK = Pattern.compile("^PEAK_HEAP_MB=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern FIXTURE = Pattern.compile("^FIXTURE_BYTES=(\\d+)$", Pattern.MULTILINE);
    private static final Pattern WHOLE_DOCUMENT =
            Pattern.compile("^CHECKPOINT_WHOLE_DOCUMENT_STRINGS=(\\d+)$", Pattern.MULTILINE);

    @Test
    @Timeout(600)
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

            long peakHeapMb = matchLong(PEAK, log, "峰值堆");
            assertTrue(peakHeapMb <= PEAK_HEAP_LIMIT_MB,
                    () -> "峰值堆 " + peakHeapMb + " MiB 超过上限 " + PEAK_HEAP_LIMIT_MB
                            + " MiB（堆上限 512 MiB），说明堆里又开始囤整段执行 JSON:\n" + log);

            assertEquals(0L, matchLong(WHOLE_DOCUMENT, log, "整段 JSON 字符串次数"),
                    () -> "检查点保存路径产生过整段 JSON 字符串/字节数组（改造前的写法）:\n" + log);

            // 把实测数字打出来，供内存对照报告取用（不做断言，只做记录）。
            System.out.println("[受限堆实测] " + summary(log));
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
                    || line.startsWith("GC_MS=")) {
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
