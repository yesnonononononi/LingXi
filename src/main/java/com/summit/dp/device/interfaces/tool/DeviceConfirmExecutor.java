package com.summit.dp.device.interfaces.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.interfaces.tool.arguments.DeviceConfirmArguments;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

/** device_confirm：用户对危险动作的答复。 */
@Slf4j
@AllArgsConstructor
public class DeviceConfirmExecutor implements ToolExecutor {

    private final DeviceToolService deviceToolService;
    private final ObjectMapper objectMapper;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            String args = toolExecution == null ? null : toolExecution.getArgs();
            DeviceConfirmArguments arguments = (args == null || args.isBlank())
                    ? new DeviceConfirmArguments(null, null)
                    : objectMapper.readValue(args, DeviceConfirmArguments.class);
            if (arguments.dangerId() == null || arguments.dangerId().isBlank()) {
                return ToolExecuteResult.err("device_confirm 缺少 dangerId");
            }
            if (arguments.approved() == null) {
                // 不默认成"同意"：缺省值必须是最保守的那个
                return ToolExecuteResult.err("device_confirm 缺少 approved（true 才代表用户同意执行）");
            }
            return ToolExecuteResult.success(
                    deviceToolService.confirm(arguments.dangerId(), arguments.approved()));
        } catch (DeviceUnavailableException e) {
            return ToolExecuteResult.err(e.getMessage());
        } catch (Exception e) {
            log.warn("device_confirm 失败: reason={}", e.getMessage());
            return ToolExecuteResult.err("device_confirm 执行失败: " + e.getMessage());
        }
    }
}
