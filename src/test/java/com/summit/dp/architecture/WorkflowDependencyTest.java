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

/** 用真实源码守住依赖方向，嵌套目录和零字节不能让违规文件漏检。 */
class WorkflowDependencyTest {
    private static final Pattern WORKFLOW_REFERENCE = Pattern.compile("com\\.summit\\.dp\\.workflow\\.");
    private static final Pattern RUNTIME_REFERENCE = Pattern.compile("com\\.summit\\.(core\\.runtime|runtime)\\.");

    @Test
    void businessModulesMustNotDependOnWorkflow() throws IOException {
        List<String> violations = findViolations(Path.of("src/main/java/com/summit/dp"));
        assertTrue(violations.isEmpty(), () -> String.join("\n", violations));
    }

    @Test
    void scannerFindsReverseDependencyInNestedFileWithNullByte(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("agent/application/deep/Invalid.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.agent.application.deep;\n\u0000\n"
                + "import com.summit.dp.workflow.application.chat.ChatService;\n");
        assertFalse(findViolations(directory).isEmpty());
    }

    @Test
    void scannerFindsRuntimeDependencyInsideDomain(@TempDir Path directory) throws IOException {
        Path source = directory.resolve("agent/domain/deep/Invalid.java");
        Files.createDirectories(source.getParent());
        Files.writeString(source, "package com.summit.dp.agent.domain.deep;\n"
                + "import com.summit.core.runtime.loop.ExecutionControl;\n");
        assertFalse(findViolations(directory).isEmpty());
    }

    private static List<String> findViolations(Path directory) throws IOException {
        List<String> violations = new ArrayList<>();
        try (Stream<Path> paths = Files.walk(directory)) {
            List<Path> sources = paths.filter(path -> path.toString().endsWith(".java")).toList();
            if (sources.isEmpty()) throw new IllegalStateException("依赖检查未读取任何源码");
            for (Path source : sources) {
                String relative = directory.relativize(source).toString().replace('\\', '/');
                String content = Files.readString(source).replaceAll("(?s)/\\*.*?\\*/|//[^\\r\\n]*", "");
                if (!relative.startsWith("workflow/") && WORKFLOW_REFERENCE.matcher(content).find()) {
                    violations.add(relative + ": 业务模块不能依赖工作流");
                }
                if (relative.contains("/domain/") && RUNTIME_REFERENCE.matcher(content).find()) {
                    violations.add(relative + ": 领域层不能依赖运行时");
                }
            }
        }
        return violations;
    }
}
