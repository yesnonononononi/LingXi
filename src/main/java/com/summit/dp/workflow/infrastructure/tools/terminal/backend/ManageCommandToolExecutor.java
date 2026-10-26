package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.StringValue;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** 查询与停止始终使用发起工具调用的会话身份。 */
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.MANAGE_COMMAND,
    name = ToolCatalog.MANAGE_COMMAND,
    executor = ManageCommandToolExecutor.class,
    description = "Manage background commands in the current session. List returns task summaries. Snapshot returns current output immediately. Read waits for completion up to the tool timeout and returns the final status, output and exit code; interrupting the wait does not stop the task. Stop waits for confirmed termination.",
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "action", value = @Value(
                type = ValueType.STRING,
                stringValue = @StringValue(enums = {"list", "read", "stop", "snapshot"}))),
            @ToolProperty(key = "taskId", value = @Value(
                type = ValueType.STRING,
                description = "Exact taskId returned by execute_command; required for read, snapshot and stop."))
        },
        required = {"action"}),
    concurrentPolicy = ConcurrentPolicy.SERIAL_MUTATION,
    maxOutput = 55_000,
    timeout = 300L)
public class ManageCommandToolExecutor implements ToolExecutor {
    private final ObjectMapper mapper;
    private final BackendProcessManager manager;

    @Override public boolean requiresWorkspace() { return false; }

    @Override public ToolExecuteResult execute(ToolExecution execution) {
        try {
            Request request = mapper.readValue(execution.getArgs(), Request.class);
            Long sessionId = ExecutionAttributes.readLong(execution.getAttributes(), ExecutionAttributes.SESSION_ID);
            throwIf(sessionId == null, "后台任务操作缺少会话身份");
            throwIf(request == null || request.action() == null, "请选择后台任务操作");
            Object result;
            if ("list".equals(request.action())) result = manager.listTasks(sessionId);
            else {
                throwIf(request.taskId() == null || request.taskId() <= 0, "任务标识不能为空且必须为正数");
                result = switch (request.action()) {
                    case "snapshot" -> manager.read(sessionId, request.taskId(), false);
                    case "stop" -> manager.stop(sessionId, request.taskId());
                    case "read" -> manager.read(sessionId, request.taskId(), true);
                    default -> throw new ClientException("后台任务操作只支持 list、read、snapshot 或 stop");
                };
            }
            return ToolExecuteResult.success(mapper.writeValueAsString(result));
        } catch (Exception failure) { return ToolExecuteResult.err("后台任务操作失败：" + failure.getMessage()); }
    }
    public record Request(String action, Long taskId) { }
    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
}
