package com.summit.dp.device.interfaces.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.interfaces.tool.arguments.DeviceStopArguments;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

/** device_stop：急停，取消后续动作。 */
@Slf4j
@AllArgsConstructor
public class DeviceStopExecutor implements ToolExecutor {

    private final DeviceToolService deviceToolService;
    private final ObjectMapper objectMapper;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            String args = toolExecution == null ? null : toolExecution.getArgs();
            DeviceStopArguments arguments = (args == null || args.isBlank())
                    ? new DeviceStopArguments(null)
                    : objectMapper.readValue(args, DeviceStopArguments.class);
            return ToolExecuteResult.success(deviceToolService.stop(arguments.deviceId()));
        } catch (DeviceUnavailableException e) {
            return ToolExecuteResult.err(e.getMessage());
        } catch (Exception e) {
            log.warn("device_stop 失败: reason={}", e.getMessage());
            return ToolExecuteResult.err("device_stop 执行失败: " + e.getMessage());
        }
    }
}
