package com.summit.dp.workflow.infrastructure.tools.file.delete;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.exception.OutWorkSpaceException;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.workflow.infrastructure.tools.arguments.DeleteFileRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.util.Map;

/**
 * 只删单个文件。删除不登记回滚记录：差异重放侧只有「文件内容变化」一种语义，
 * 硬塞一个「文件已删除」的重放口径会让整轮撤销整体失真，宁可先如实不给撤销。
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.DELETE_FILE,
    name = ToolCatalog.DELETE_FILE,
    executor = DeleteFileToolExecutor.class,
    description = "Delete one file from the workspace. Directories are rejected: empty directories would be removed "
            + "as a side effect of the file delete. Fails when the path does not exist, so a typo never reports success.",
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "path", value = @Value(
                type = ValueType.STRING,
                description = "File path: a relative path resolves against the workspace root"))
        },
        required = {"path"}),
    concurrentPolicy = ConcurrentPolicy.SERIAL_MUTATION,
    maxOutput = 200,
    timeout = 30L)
public class DeleteFileToolExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            DeleteFileRequest request = objectMapper.readValue(toolExecution.getArgs(), DeleteFileRequest.class);
            throwIf(request == null, "删除文件参数不能为空");
            throwIf(request.getPath() == null || request.getPath().isBlank(), "删除文件路径不能为空");

            Workspace workspace = toolExecution.getWorkspace();
            // 边界与链接复核交给框架，与 edit/search 同一判据，不能各写一套。
            Path target = AgentAccessMode.from(toolExecution.getAttributes()).allowsOutsideWorkspace()
                    ? workspace.resolve(request.getPath())
                    : workspace.resolveInside(request.getPath());
            WorkspaceFiles files = workspace.bridge().files();
            throwIf(!files.exists(target), "要删除的文件不存在: " + request.getPath());
            
            throwIf(isDirectory(files, target), "删除文件只接受文件，不接受目录: " + request.getPath());
            log.info("删除文件: path={}", target);

            files.deleteFile(target);
            return ToolExecuteResult.success(objectMapper.writeValueAsString(
                    Map.of("path", target.toAbsolutePath().normalize().toString(), "deleted", true)));
        } catch (OutWorkSpaceException outsideWorkspace) {
            return ToolExecuteResult.err("删除文件只能在工作区内进行，删除项目外文件请切换到完全访问档位");
        } catch (Exception e) {
            return ToolExecuteResult.err("删除文件失败: " + e.getMessage());
        }
    }

    /** 判定目录只能用 list：它在文件上抛 NotDirectoryException，在目录上正常返回。 */
    private boolean isDirectory(WorkspaceFiles files, Path target) throws IOException {
        try {
            files.list(target);
            return true;
        } catch (NotDirectoryException expected) {
            return false;
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

}
