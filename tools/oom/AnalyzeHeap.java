import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 把一组的采样文件折算成数据表的一行（T05 单元 E，§附录E.5）。
 *
 * <p>输入：{@code heap.csv}（10ms 堆采样）、{@code gc.log}（{@code -Xlog:gc*}）、
 * {@code ws.csv}（100ms 工作集采样）、{@code console.log}（{@code RESULT ...} 行）。
 * 输出：制表符分隔的一行，字段顺序与附录 E.5 的模板一致。</p>
 *
 * <p><b>为什么不只看峰值</b>：峰值堆说明当次占用，Full GC 次数与最长停顿说明「是不是靠 GC 硬撑」，
 * 工作集说明「换库有没有把压力挪到 JVM 外」，吞吐说明「是不是靠拖慢换来的」。</p>
 */
public final class AnalyzeHeap {

    /** 统一日志里的一次 GC 停顿：{@code GC(12) Pause Full (...) 500M->200M(512M) 1234.567ms}。 */
    private static final Pattern GC_PAUSE = Pattern.compile(
            "GC\\(\\d+\\)\\s+(Pause\\s+(?:Full|Young|remark|cleanup)[^0-9]*)\\s+.*?([0-9]+[.,][0-9]+)ms");

    private AnalyzeHeap() {
    }

    public static void main(String[] args) throws IOException {
        String group = arg(args, "group", "unknown");
        String scenario = arg(args, "scenario", "unknown");
        int heapMiB = Integer.parseInt(arg(args, "heap", "0"));
        Path directory = Path.of(arg(args, "dir", "."));

        long peakHeapBytes = peakOfCsv(directory.resolve("heap.csv"), 1);
        long peakWorkingSetBytes = peakOfCsv(directory.resolve("ws.csv"), 1);
        long fullGc = 0;
        double longestPauseMillis = 0;
        int gcCount = 0;
        Path gcLog = directory.resolve("gc.log");
        if (Files.isRegularFile(gcLog)) {
            for (String line : Files.readAllLines(gcLog, StandardCharsets.ISO_8859_1)) {
                Matcher matcher = GC_PAUSE.matcher(line);
                if (!matcher.find()) {
                    continue;
                }
                gcCount++;
                double pause = Double.parseDouble(matcher.group(2).replace(',', '.'));
                longestPauseMillis = Math.max(longestPauseMillis, pause);
                if (matcher.group(1).toLowerCase().contains("full")) {
                    fullGc++;
                }
            }
        }
        String result = lastLineStartingWith(directory.resolve("console.log"), "RESULT ");
        long saved = numberIn(result, "saved=(\\d+)");
        long elapsedMillis = numberIn(result, "elapsedMillis=(\\d+)");
        double throughput = elapsedMillis > 0 ? saved * 1000.0 / elapsedMillis : 0;
        String failure = result != null && result.contains("failure=")
                ? result.substring(result.indexOf("failure=") + "failure=".length()).strip()
                : "未取到 RESULT 行";
        // GC 后存活量：只看这条判泄漏（峰值会被一次性缓冲带偏）。
        long[] live = liveStats(directory.resolve("live.csv"));
        String categories = extract(result, "categories=([^,]+)");
        String retained = numberInText(result, "cacheEntries=(\\d+)");
        String h2Version = firstLineContaining(directory.resolve("console.log"), "H2_VERSION=");
        h2Version = h2Version == null ? "?" : h2Version.replace("H2_VERSION=", "").strip();
        // 扫描器结论与退出码由调用方传入：本行就是最终数据表的一行，列序与表头逐字对应。
        String verdict = arg(args, "verdict", "-");
        String exitCode = arg(args, "exit", "-");

        System.out.println(String.join("\t",
                group,
                scenario,
                String.valueOf(heapMiB),
                String.format("%.1f", peakHeapBytes / 1048576.0),
                heapMiB > 0 ? String.format("%.1f%%", peakHeapBytes / 1048576.0 / heapMiB * 100) : "-",
                String.valueOf(fullGc),
                String.format("%.1f", longestPauseMillis),
                String.format("%.1f", peakWorkingSetBytes / 1048576.0),
                String.format("%.2f", throughput),
                String.format("%.1f", elapsedMillis / 1000.0),
                String.valueOf(gcCount),
                failure,
                verdict,
                exitCode,
                String.format("%.1f", live[0] / 1048576.0),
                String.format("%.1f", live[1] / 1048576.0),
                String.format("%.1f", live[2] / 1048576.0),
                String.format("%+.1f", (live[2] - live[0]) / 1048576.0),
                categories,
                retained,
                h2Version));
    }

    /** live.csv → {首个, 峰值, 末个} 的 GC 后已用堆（字节）。 */
    private static long[] liveStats(Path csv) throws IOException {
        long first = 0;
        long max = 0;
        long last = 0;
        if (!Files.isRegularFile(csv)) {
            return new long[] {first, max, last};
        }
        List<String> lines = Files.readAllLines(csv, StandardCharsets.UTF_8);
        for (int index = 1; index < lines.size(); index++) {
            String[] cells = lines.get(index).split(",");
            if (cells.length < 3) {
                continue;
            }
            long used;
            try {
                used = Long.parseLong(cells[2].strip());
            } catch (NumberFormatException ignored) {
                continue;
            }
            if (first == 0) {
                first = used;
            }
            last = used;
            max = Math.max(max, used);
        }
        return new long[] {first, max, last};
    }

    private static String extract(String text, String regex) {
        if (text == null) {
            return "-";
        }
        Matcher matcher = Pattern.compile(regex).matcher(text);
        return matcher.find() ? matcher.group(1).strip() : "-";
    }

    private static String numberInText(String text, String regex) {
        if (text == null) {
            return "-";
        }
        Matcher matcher = Pattern.compile(regex).matcher(text);
        return matcher.find() ? matcher.group(1) : "-";
    }

    private static String firstLineContaining(Path file, String needle) throws IOException {
        if (!Files.isRegularFile(file)) {
            return null;
        }
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            if (line.contains(needle)) {
                return line;
            }
        }
        return null;
    }

    private static long peakOfCsv(Path csv, int column) throws IOException {
        if (!Files.isRegularFile(csv)) {
            return 0L;
        }
        long peak = 0L;
        boolean first = true;
        for (String line : Files.readAllLines(csv, StandardCharsets.UTF_8)) {
            if (first) {
                first = false;
                continue;
            }
            String[] cells = line.split(",");
            if (cells.length <= column) {
                continue;
            }
            try {
                peak = Math.max(peak, Long.parseLong(cells[column].strip()));
            } catch (NumberFormatException ignored) {
                // 采样被中断时可能留下半行，跳过。
            }
        }
        return peak;
    }

    private static String lastLineStartingWith(Path file, String prefix) throws IOException {
        if (!Files.isRegularFile(file)) {
            return null;
        }
        List<String> lines = new ArrayList<>(Files.readAllLines(file, StandardCharsets.UTF_8));
        for (int index = lines.size() - 1; index >= 0; index--) {
            if (lines.get(index).startsWith(prefix)) {
                return lines.get(index);
            }
        }
        return null;
    }

    private static long numberIn(String text, String regex) {
        if (text == null) {
            return 0L;
        }
        Matcher matcher = Pattern.compile(regex).matcher(text);
        return matcher.find() ? Long.parseLong(matcher.group(1)) : 0L;
    }

    private static String arg(String[] args, String key, String fallback) {
        for (String arg : args) {
            if (arg.startsWith("--" + key + "=")) {
                return arg.substring(key.length() + 3);
            }
        }
        return fallback;
    }
}
