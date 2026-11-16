package com.summit.dp.workflow.infrastructure.tools.file.read;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.*;
import com.summit.core.exception.OutWorkSpaceException;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;

@Slf4j
@Component
@Tool(
    id = ToolCatalog.READ_FILE,
    name = ToolCatalog.READ_FILE,
    executor = ReadFileToolExecutor.class,
    description = "Read a UTF-8 text file. Each returned line is prefixed with its 1-based line number as `N: content`, "
            + "and those numbers are what startLine/endLine accept, so the output can be re-read by range. "
            + "Binary files are rejected fast (use read_image for pictures); when the result ends with "
            + "`...[OUTPUT_TRUNCATED]...`, continue from the last visible line number with a startLine argument.",
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "path", value = @Value(
                type = ValueType.STRING,
                description = "File path it is a required parameter")),
            @ToolProperty(key = "startLine", value = @Value(
                type = ValueType.INTEGER,
                description = "1-based first line to return, inclusive. Defaults to 1. Omit both bounds to read the entire file.",
                integerValue = @IntegerValue(minimum = 0))),
            @ToolProperty(key = "endLine", value = @Value(
                type = ValueType.INTEGER,
                description = "1-based last line to return, inclusive. Must not precede startLine. Defaults to the last line.",
                integerValue = @IntegerValue(minimum = 0)))
        },
        required = {"path"}),
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 3_000,
    timeout = 30L)
public class ReadFileToolExecutor implements ToolExecutor {
    /** 超过这个体积的文本一律拒绝：一次读进上下文既撑爆预算，也读不完。 */
    private static final int MAX_BYTES = 4 * 1024 * 1024;
    /** 只看开头这一段判二进制，避免为判定扫全文件。 */
    private static final int SNIFF_BYTES = 8 * 1024;

    private final ObjectMapper objectMapper;

    public ReadFileToolExecutor(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            ReadFileRequest request = objectMapper.readValue(toolExecution.getArgs(), ReadFileRequest.class);
            throwIf(request == null, "读取文件参数不能为空");
            throwIf(request.getPath() == null || request.getPath().isBlank(), "读取文件路径不能为空");
            int start = Objects.requireNonNullElse(request.getStartLine(), 1);
            int requestedEnd = Objects.requireNonNullElse(request.getEndLine(), Integer.MAX_VALUE);
            throwIf(start < 1, "读取文件的行号从 1 开始");
            throwIf(start > requestedEnd, "读取文件的起始行不能大于结束行");

            Workspace workspace = toolExecution.getWorkspace();
            // 越界读不需要任何能力，只有完全访问档例外；链接逃逸由框架 resolveInside 一并复核。
            Path path = AgentPermissionMode.from(toolExecution.getAttributes()).allowsOutsideWorkspace()
                    ? workspace.resolve(request.getPath())
                    : workspace.resolveInside(request.getPath());
            log.info("读取文件: path={}, startLine={}, endLine={}", path, request.getStartLine(), request.getEndLine());

            WorkspaceFiles files = workspace.bridge().files();
            // 字节读一次、判定一次，再解码：读两次会把同一份 IO 成本摊到每个文本文件上。
            byte[] bytes = files.readBytes(path);
            throwIf(isBinary(bytes), "这是二进制文件，不能按文本读取: path=" + request.getPath());
            throwIf(bytes.length > MAX_BYTES,
                    "文件过大，无法整体读取: path=" + request.getPath() + ", 大小=" + bytes.length + " 字节，请用 startLine/endLine 分段读取");
            List<String> lines = decodeUtf8(bytes, request.getPath()).lines().toList();
            if (lines.isEmpty()) {
                return ToolExecuteResult.success("");
            }
            throwIf(start > lines.size(), "读取文件的起始行超出文件范围: 文件共 " + lines.size() + " 行");

            int end = Math.min(requestedEnd, lines.size());
            StringBuilder numbered = new StringBuilder();
            for (int line = start; line <= end; line++) {
                if (!numbered.isEmpty()) {
                    numbered.append('\n');
                }
                // 行号与正文成对输出：模型据此改写 oldText 或带 startLine 回读，不必自己数行。
                numbered.append(line).append(": ").append(lines.get(line - 1));
            }
            return ToolExecuteResult.success(numbered.toString());
        } catch (OutWorkSpaceException outsideWorkspace) {
            return ToolExecuteResult.err("读取文件只能在工作区内进行，读取项目外文件请切换到完全访问档位");
        } catch (Exception e) {
            return ToolExecuteResult.err("读取文件失败: " + e.getMessage());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

    /** 含 NUL 的按二进制处理：UTF-8 解码器对这种内容要么抛错，要么吐出满屏替换符。 */
    private boolean isBinary(byte[] bytes) {
        int limit = Math.min(bytes.length, SNIFF_BYTES);
        for (int index = 0; index < limit; index++) {
            if (bytes[index] == 0) {
                return true;
            }
        }
        return false;
    }

    /** 严格解码：非 UTF-8 的字节必须报错，不能被静默替换成满屏问号再交给模型。 */
    private String decodeUtf8(byte[] bytes, String path) {
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            return decoder.decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new ClientException("文件不是 UTF-8 文本，请确认编码: path=" + path);
        }
    }

}

