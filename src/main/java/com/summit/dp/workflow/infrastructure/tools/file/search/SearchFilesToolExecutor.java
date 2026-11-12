package com.summit.dp.workflow.infrastructure.tools.file.search;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.*;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.workflow.infrastructure.tools.arguments.SearchFilesRequest;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

@Slf4j
@Component
@Tool(
    id = ToolCatalog.SEARCH_FILES,
    name = ToolCatalog.SEARCH_FILES,
    executor = SearchFilesToolExecutor.class,
    description = "Search file contents inside the workspace by regular expression and return `path:line: content` hits. "
            + "Read-only and independent of the shell, so it also works in read-only sessions. "
            + "Skips VCS, dependency and build directories; `glob` matches the file name only (e.g. `*.java`). "
            + "When the result reports that the limit was reached, narrow `path` or `glob` instead of raising maxResults.",
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "pattern", value = @Value(
                type = ValueType.STRING,
                description = "Java regular expression matched against each line")),
            @ToolProperty(key = "path", value = @Value(
                type = ValueType.STRING,
                description = "Directory to search, relative to the workspace root; defaults to the whole workspace")),
            @ToolProperty(key = "glob", value = @Value(
                type = ValueType.STRING,
                description = "Optional file name glob such as `*.java`; matched against the name, not the path")),
            @ToolProperty(key = "ignoreCase", value = @Value(
                type = ValueType.BOOLEAN,
                description = "Match case-insensitively; defaults to false")),
            @ToolProperty(key = "maxResults", value = @Value(
                type = ValueType.INTEGER,
                description = "Maximum hits to return, 1-500; defaults to 100",
                integerValue = @IntegerValue(minimum = 1)))
        },
        required = {"pattern"}),
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 4_000,
    timeout = 60L)
public class SearchFilesToolExecutor implements ToolExecutor {
    /** 命中上限的硬顶：再多也只能挤掉后面的上下文，不如让模型收窄范围。 */
    private static final int MAX_RESULTS_LIMIT = 500;
    private static final int DEFAULT_MAX_RESULTS = 100;
    /** 单文件超过这个体积就跳过：编码噪音与压缩产物里的匹配没有检索价值。 */
    private static final int MAX_FILE_BYTES = 1024 * 1024;
    private static final int SNIFF_BYTES = 8 * 1024;
    private static final int MAX_LINE_CHARS = 200;
    /** 依赖、构建与版本库目录：内容不属于本项目源码，扫进来只会灌满上下文。 */
    private static final Set<String> SKIPPED_DIRECTORIES = Set.of(
            ".git", ".svn", ".hg", ".idea", ".vscode", ".mvn", "node_modules", "target", "dist", "build", "out", "logs");

    private final ObjectMapper objectMapper;

    public SearchFilesToolExecutor(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            SearchFilesRequest request = objectMapper.readValue(toolExecution.getArgs(), SearchFilesRequest.class);
            throwIf(request == null, "检索文件参数不能为空");
            throwIf(request.getPattern() == null || request.getPattern().isBlank(), "检索文件的关键字不能为空");
            int maxResults = request.getMaxResults() == null ? DEFAULT_MAX_RESULTS : request.getMaxResults();
            throwIf(maxResults < 1 || maxResults > MAX_RESULTS_LIMIT,
                    "检索文件的返回条数必须在 1 到 " + MAX_RESULTS_LIMIT + " 之间");

            Pattern pattern = compile(request);
            Workspace workspace = toolExecution.getWorkspace();
            Path root = resolveRoot(workspace, request.getPath());
            // 与 edit_file 同一口径：越界读本身就是信息泄露，必须在遍历前拦。
            throwIf(!AgentAccessMode.from(toolExecution.getAttributes()).allowsOutsideWorkspace()
                            && !workspace.encloses(root),
                    "检索文件只能在工作区内进行，检索项目外目录请切换到完全访问档位");
            log.info("检索文件: root={}, pattern={}, glob={}, maxResults={}", root, request.getPattern(), request.getGlob(), maxResults);

            WorkspaceFiles files = workspace.bridge().files();
            PathMatcher nameMatcher = globMatcher(request.getGlob());
            List<WorkspaceFiles.Entry> candidates = files.walk(root, this::isSkippedDirectory);
            candidates.sort((left, right) -> left.path().toString().compareTo(right.path().toString()));

            List<String> hits = new ArrayList<>();
            boolean limitReached = false;
            for (WorkspaceFiles.Entry candidate : candidates) {
                if (hits.size() >= maxResults) {
                    limitReached = true;
                    break;
                }
                if (nameMatcher != null && !nameMatcher.matches(candidate.path().getFileName())) {
                    continue;
                }
                collectHits(files, root, candidate.path(), pattern, maxResults, hits);
            }
            return ToolExecuteResult.success(render(root, request, hits, maxResults, limitReached));
        } catch (PatternSyntaxException e) {
            return ToolExecuteResult.err("检索文件的正则不合法: " + e.getMessage());
        } catch (Exception e) {
            return ToolExecuteResult.err("检索文件失败: " + e.getMessage());
        }
    }

    /** 逐个文件扫行，命中即收：命中数由外层的 maxResults 兜住，不必在这里再判上限。 */
    private void collectHits(WorkspaceFiles files, Path root, Path file, Pattern pattern,
                             int maxResults, List<String> hits) throws Exception {
        byte[] bytes = files.readBytes(file);
        if (bytes.length > MAX_FILE_BYTES || isBinary(bytes)) {
            return;
        }
        // 检索用宽松解码：单个非 UTF-8 文件不该让整次检索失败，替换符也不会命中正常正则。
        String content = new String(bytes, StandardCharsets.UTF_8);
        List<String> lines = content.lines().toList();
        String name = relativize(root, file);
        for (int index = 0; index < lines.size() && hits.size() < maxResults; index++) {
            String line = lines.get(index);
            if (pattern.matcher(line).find()) {
                hits.add(name + ":" + (index + 1) + ": " + abbreviate(line));
            }
        }
    }

    private String render(Path root, SearchFilesRequest request, List<String> hits,
                          int maxResults, boolean limitReached) {
        if (hits.isEmpty()) {
            return "未找到匹配内容: pattern=" + request.getPattern() + ", scope=" + relativize(root, root) + ".";
        }
        StringBuilder output = new StringBuilder(String.join("\n", hits));
        if (limitReached) {
            // 明确说出截断：静默截断会被当成「就这么多」。
            output.append("\n已达返回上限 ").append(maxResults).append(" 条，可能仍有匹配，请收窄 path 或 glob");
        }
        return output.toString();
    }

    private Path resolveRoot(Workspace workspace, String path) {
        return path == null || path.isBlank()
                ? Path.of(workspace.workDir()).toAbsolutePath().normalize()
                : workspace.resolve(path).normalize();
    }

    private Pattern compile(SearchFilesRequest request) {
        int flags = Boolean.TRUE.equals(request.getIgnoreCase()) ? Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE : 0;
        return Pattern.compile(request.getPattern(), flags);
    }

    /** glob 只匹配文件名：跨目录的 `**` 在 Windows 反斜杠路径上没有一致行为，先说清口径。 */
    private PathMatcher globMatcher(String glob) {
        return glob == null || glob.isBlank()
                ? null
                : FileSystems.getDefault().getPathMatcher("glob:" + glob);
    }

    private boolean isSkippedDirectory(Path path) {
        Path name = path.getFileName();
        return name != null && SKIPPED_DIRECTORIES.contains(name.toString());
    }

    private boolean isBinary(byte[] bytes) {
        int limit = Math.min(bytes.length, SNIFF_BYTES);
        for (int index = 0; index < limit; index++) {
            if (bytes[index] == 0) {
                return true;
            }
        }
        return false;
    }

    private String relativize(Path root, Path path) {
        if (root.equals(path)) {
            return ".";
        }
        return root.relativize(path).toString().replace('\\', '/');
    }

    private String abbreviate(String line) {
        return line.length() <= MAX_LINE_CHARS ? line : line.substring(0, MAX_LINE_CHARS) + "…";
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

}
