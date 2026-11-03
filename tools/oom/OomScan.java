import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 统一 OOM 扫描器（T05 单元 E，§附录E.3）。
 *
 * <p><b>为什么要一个统一扫描器</b>：历史事故里「退出码」不可信 —— JVM 被 OOM 打死、容器化包装、
 * GC overhead 都可能给出非预期退出码；反过来「进程 0 退出」也不代表没 OOM（错误被捕获后照样走完）。
 * 所以判据是<b>文本证据</b>：控制台、标准错误、H2 的 {@code .trace.db} / {@code .log}。</p>
 *
 * <p><b>口径</b>：只认「异常全名 + 冒号」这一族可判定的写法（{@code java.lang.OutOfMemoryError}、
 * {@code OutOfMemoryError:}、{@code GC overhead limit exceeded}、{@code Java heap space}），
 * 不认单独出现的 {@code oom=false}、{@code OOM 回归}、{@code 无 OOM} —— 这些是结论字段与文案，不是证据。
 * 扫描器<b>必须先自检</b>（正样本判「有」、负样本判「无」）才允许给出「无 OOM」结论。</p>
 *
 * <pre>
 * java tools/oom/OomScan.java --file=&lt;路径&gt; [--file=...] [--dir=&lt;目录&gt;]
 * </pre>
 *
 * <p>输出一行：{@code SCAN verdict=OOM|CLEAN files=N hitLines=M} 与逐条命中（文件:行号:内容）。</p>
 */
public final class OomScan {

    /** 判定「有 OOM」的文本特征；刻意收紧，避免把结论文案当证据。 */
    private static final Pattern OOM_SIGNATURE = Pattern.compile(
            "java\\.lang\\.OutOfMemoryError|OutOfMemoryError:|GC overhead limit exceeded|Java heap space"
                    + "|Native memory allocation \\(malloc\\) failed",
            Pattern.CASE_INSENSITIVE);

    /** 这些行是「结论字段」而不是证据：{@code oom=false}、{@code failure=none}、{@code RESULT ... oom=false}。 */
    private static final Pattern NOT_EVIDENCE = Pattern.compile(
            "(?i)\\boom\\s*=\\s*(false|true)|failure=none|无\\s*OOM|已知含\\s*OOM",
            Pattern.CASE_INSENSITIVE);

    private OomScan() {
    }

    public static void main(String[] args) throws IOException {
        List<Path> targets = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        for (String arg : args) {
            if (arg.startsWith("--file=")) {
                Path path = Path.of(arg.substring("--file=".length()));
                if (Files.isRegularFile(path)) {
                    targets.add(path);
                } else {
                    errors.add("文件不存在: " + path);
                }
            } else if (arg.startsWith("--dir=")) {
                Path directory = Path.of(arg.substring("--dir=".length()));
                if (!Files.isDirectory(directory)) {
                    errors.add("目录不存在: " + directory);
                    continue;
                }
                try (Stream<Path> files = Files.walk(directory)) {
                    files.filter(Files::isRegularFile)
                            .filter(OomScan::isScannable)
                            .sorted()
                            .forEach(targets::add);
                }
            } else {
                errors.add("未知参数: " + arg);
            }
        }
        if (!errors.isEmpty()) {
            errors.forEach(error -> System.out.println("SCAN_ERROR " + error));
            System.out.println("SCAN verdict=ERROR files=0 hitLines=0");
            System.exit(2);
        }
        if (targets.isEmpty()) {
            System.out.println("SCAN verdict=ERROR files=0 hitLines=0 (没有可扫描的文件)");
            System.exit(2);
        }

        int hits = 0;
        Set<String> hitFiles = new LinkedHashSet<>();
        for (Path target : targets) {
            for (String hit : scan(target)) {
                hits++;
                hitFiles.add(target.getFileName().toString());
                System.out.println("HIT " + target.getFileName() + ": " + hit);
            }
        }
        System.out.println("SCAN verdict=" + (hits > 0 ? "OOM" : "CLEAN")
                + " files=" + targets.size() + " hitLines=" + hits
                + " hitFiles=" + hitFiles);
    }

    /** 扫描单个文件，返回命中行（去掉首尾空白，最长 240 字符）。 */
    static List<String> scan(Path file) throws IOException {
        List<String> hits = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            int number = 0;
            while ((line = reader.readLine()) != null) {
                number++;
                if (line.isBlank() || NOT_EVIDENCE.matcher(line).find() && !hasRealSignature(line)) {
                    continue;
                }
                Matcher matcher = OOM_SIGNATURE.matcher(line);
                if (matcher.find()) {
                    String trimmed = line.strip();
                    hits.add(number + ": " + (trimmed.length() <= 240 ? trimmed : trimmed.substring(0, 240)));
                }
            }
        } catch (IOException unreadable) {
            // 控制台/日志可能被写成非 UTF-8：退化为逐字节判定，不能让编码问题掩盖 OOM。
            String raw = new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1);
            if (OOM_SIGNATURE.matcher(raw).find()) {
                hits.add("binary: 命中 OOM 特征（无法按 UTF-8 读取）");
            }
        }
        return hits;
    }

    /** 同一行既出现结论字段又出现真实异常特征时，仍算证据。 */
    private static boolean hasRealSignature(String line) {
        String lower = line.toLowerCase(Locale.ROOT);
        return lower.contains("java.lang.outofmemoryerror")
                || lower.contains("outofmemoryerror:")
                || lower.contains("gc overhead limit exceeded")
                || lower.contains("java heap space");
    }

    /** 只扫文本类文件：H2 的库文件（.mv.db）不扫，避免把二进制噪声当证据。 */
    private static boolean isScannable(Path path) {
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.endsWith(".mv.db") || name.endsWith(".hprof") || name.endsWith(".jar")
                || name.endsWith(".nbcache") || name.endsWith(".cbcache")) {
            return false;
        }
        // 扫描器自己的输出（scan.log / 汇总 markdown）会把命中行抄一遍，不能作为下一轮的证据。
        if (name.startsWith("scan.") || name.endsWith(".md") || name.endsWith(".json")) {
            return false;
        }
        return !name.endsWith(".csv");
    }
}
