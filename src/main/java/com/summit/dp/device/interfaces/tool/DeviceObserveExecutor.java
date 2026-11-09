package com.summit.dp.device.interfaces.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.interfaces.tool.arguments.DeviceObserveArguments;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

/** device_observe：让 agent 看一眼当前界面。 */
@Slf4j
@AllArgsConstructor
public class DeviceObserveExecutor implements ToolExecutor {

    private static final int DEFAULT_MAX_NODES = 80;
    private static final int HARD_MAX_NODES = 120;

    private final DeviceToolService deviceToolService;
    private final ObjectMapper objectMapper;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            String args = toolExecution == null ? null : toolExecution.getArgs();
            DeviceObserveArguments arguments = (args == null || args.isBlank())
                    ? new DeviceObserveArguments(null, null)
                    : objectMapper.readValue(args, DeviceObserveArguments.class);

            int maxNodes = arguments.maxNodes() == null ? DEFAULT_MAX_NODES : arguments.maxNodes();
            if (maxNodes < 1 || maxNodes > HARD_MAX_NODES) {
                return ToolExecuteResult.err("maxNodes 必须在 1~" + HARD_MAX_NODES + " 之间，实际=" + maxNodes);
            }
            return ToolExecuteResult.success(deviceToolService.observe(arguments.deviceId(), maxNodes));
        } catch (DeviceUnavailableException e) {
            return ToolExecuteResult.err(e.getMessage());
        } catch (Exception e) {
            log.warn("device_observe 失败: reason={}", e.getMessage());
            return ToolExecuteResult.err("device_observe 执行失败: " + e.getMessage());
        }
    }
}
