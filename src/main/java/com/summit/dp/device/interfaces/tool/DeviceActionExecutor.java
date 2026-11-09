package com.summit.dp.device.interfaces.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.interfaces.tool.arguments.DeviceActionArguments;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

/** device_action：在设备上执行一次动作（可能被危险策略拦下要求确认）。 */
@Slf4j
@AllArgsConstructor
public class DeviceActionExecutor implements ToolExecutor {

    private final DeviceToolService deviceToolService;
    private final ObjectMapper objectMapper;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            String args = toolExecution == null ? null : toolExecution.getArgs();
            if (args == null || args.isBlank()) {
                return ToolExecuteResult.err("device_action 缺少参数：至少需要 kind");
            }
            DeviceActionArguments arguments = objectMapper.readValue(args, DeviceActionArguments.class);
            if (arguments.kind() == null || arguments.kind().isBlank()) {
                return ToolExecuteResult.err("device_action 缺少 kind");
            }
            return ToolExecuteResult.success(deviceToolService.act(arguments.deviceId(), arguments.toRequest()));
        } catch (DeviceUnavailableException e) {
            return ToolExecuteResult.err(e.getMessage());
        } catch (Exception e) {
            log.warn("device_action 失败: reason={}", e.getMessage());
            return ToolExecuteResult.err("device_action 执行失败: " + e.getMessage());
        }
    }
}
