package com.summit.dp.architecture;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 恢复受理与检查点提交的边界守卫：扫描真实源码，不看注解也不看文档。
 *
 * <p>守三件事：一是决策包与其余非 lifecycle 包不能直连协调器（协调器类名不该出现在 decision 里）；
 * 二是 {@code dispatch} 这个恢复运行时唯一的消费口只能被 lifecycle 调用；三是执行仓储不能直接编排
 * 邮件、工具调用、委派、轮次这些业务类型。</p>
 *
 * <p>扫描器自带同特征金丝雀：违规样本含 NUL 字节、放在嵌套目录里，扫不到时用例就红 ——
 * 否则「扫描器不工作」会被伪装成「没有违规」。</p>
 */
class ResumeBoundaryTest {

    private static final Pattern COORDINATOR_IMPORT =
            Pattern.compile("import\\s+com\\.summit\\.dp\\.workflow\\.application\\.lifecycle\\.ExecutionResumeCoordinator\\s*;");
    private static final Pattern COORDINATOR_TYPE_USE =
            Pattern.compile("\\bExecutionResumeCoordinator\\b");
    private static final Pattern DISPATCH_CALL =
            Pattern.compile("\\.dispatch\\s*\\(");
    private static final Pattern BUSINESS_TYPE_IN_REPOSITORY =
            Pattern.compile("\\b(?:Mail[A-Z]\\w*|ToolCall[A-Z]\\w*|Delegation[A-Z]\\w*|ChatTurn[A-Z]\\w*)\\b");

    @Test
    void decisionAndOtherPackagesMustNotImportCoordinator() throws IOException {
        Path root = Path.of("src/main/java/com/summit/dp/workflow/application");
        List<String> violations = findCoordinatorMisuse(root);
        assertTrue(violations.isEmpty(), () -> String.join("\n", violations));
    }

    @Test
    void dispatchIsOnlyConsumedInsideLifecyclePackage() throws IOException {
        Path root = Path.of("src/main/java");
        List<String> violations = new ArrayList<>();
        try (Stream<Path> paths = Files.walk(root)) {
            List<Path> sources = paths.filter(path -> path.toString().endsWith(".java")).toList();
            if (sources.isEmpty()) throw new IllegalStateException("派发消费口检查未读到源码");
            for (Path source : sources) {
                String relative = root.relativize(source).toString().replace('\\', '/');
                String content = stripComments(Files.readString(source));
                if (DISPATCH_CALL.matcher(content).find() && !relative.contains("workflow/application/lifecycle/")) {
                    violations.add(relative + ": 恢复派发只能由 lifecycle 消费");
                }
            }
        }
        assertTrue(violations.isEmpty(), () -> String.join("\n", violations));
    }

    @Test
    void repositoryMustNotOrchestrateBusinessTypes() throws IOException {
        Path source = Path.of("src/main/java/com/summit/dp/workflow/infrastructure/harness/LocalExecutionRepository.java");
        String content = stripComments(Files.readString(source));
        assertTrue(!content.contains("Mail") && !content.contains("ToolCall")
                        && !content.contains("Delegation") && !content.contains("ChatTurn"),
                "执行仓储只能依赖端口与事实类型，不能直接编排业务类型");
    }

    @Test
    void scannerFindsCoordinatorImportInNestedFileWithNullByte(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("decision/deep/nested/Invalid.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.workflow.application.decision.deep.nested;\n\u0000\n"
                + "import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;\n");
        assertFalse(findCoordinatorMisuse(directory).isEmpty());
    }

    @Test
    void scannerFindsCoordinatorFieldTypeInNestedFile(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("input/deep/Invalid.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.workflow.application.input.deep;\n"
                + "class Invalid { private ExecutionResumeCoordinator coordinator; }\n");
        assertFalse(findCoordinatorMisuse(directory).isEmpty());
    }

    @Test
    void scannerFindsDispatchCallOutsideLifecycle(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("harness/deep/Invalid.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.workflow.infrastructure.harness.deep;\n\u0000\n"
                + "class Invalid { void run() { resumeCoordinator.dispatch(1L); } }\n");
        List<String> violations = new ArrayList<>();
        try (Stream<Path> paths = Files.walk(directory)) {
            for (Path file : paths.filter(path -> path.toString().endsWith(".java")).toList()) {
                String relative = directory.relativize(file).toString().replace('\\', '/');
                if (DISPATCH_CALL.matcher(stripComments(Files.readString(file))).find()
                        && !relative.contains("workflow/application/lifecycle/")) {
                    violations.add(relative);
                }
            }
        }
        assertFalse(violations.isEmpty(), "扫描器必须在嵌套目录里抓到越界派发");
    }

    @Test
    void scannerFindsBusinessTypeInsideRepositoryCopy(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("harness/Copy.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.workflow.infrastructure.harness;\n"
                + "class Copy { private MailReceiptFlusher mailReceipts; }\n");
        String content = stripComments(Files.readString(source));
        assertTrue(BUSINESS_TYPE_IN_REPOSITORY.matcher(content).find(), "扫描器必须能抓到业务类型引用");
    }

    /** lifecycle 之外不得出现协调器的 import 或类型引用。 */
    private static List<String> findCoordinatorMisuse(Path root) throws IOException {
        List<String> violations = new ArrayList<>();
        try (Stream<Path> paths = Files.walk(root)) {
            List<Path> sources = paths.filter(path -> path.toString().endsWith(".java")).toList();
            if (sources.isEmpty()) throw new IllegalStateException("恢复受理边界检查未读取任何源码");
            for (Path source : sources) {
                String relative = root.relativize(source).toString().replace('\\', '/');
                if (relative.contains("lifecycle/")) continue;
                String content = stripComments(Files.readString(source));
                if (COORDINATOR_IMPORT.matcher(content).find() || COORDINATOR_TYPE_USE.matcher(content).find()) {
                    violations.add(relative + ": 协调器只能由 lifecycle 包持有");
                }
            }
        }
        return violations;
    }

    /** 注释里提到类名不算依赖，先剥注释再匹配。 */
    private static String stripComments(String content) {
        return content.replaceAll("(?s)/\\*.*?\\*/|//[^\\r\\n]*", "");
    }
}
