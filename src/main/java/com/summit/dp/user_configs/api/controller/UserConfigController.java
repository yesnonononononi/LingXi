package com.summit.dp.user_configs.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.user_configs.application.command.UserConfigCommand;
import com.summit.dp.user_configs.api.request.UserConfigRequest;
import com.summit.dp.user_configs.application.service.UserConfigService;
import com.summit.dp.user_configs.application.vo.UserConfigVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * UserConfig 接口层。
 *
 * <p><b>本地单实例（HC-1）</b>：设置是进程级单例，读写入口不带用户参数，
 * 服务端按单例行定位。端点路径保持 {@code /config/current} 与 {@code /config/current/update}。</p>
 */
@RestController
@RequestMapping({"/config"})
@RequiredArgsConstructor
public class UserConfigController {
    private final UserConfigService service;

    /** 当前实例的通用配置（工作空间类型等）；无配置行时返回默认视图。 */
    @GetMapping("/current")
    public Result<UserConfigVO> current() {
        return service.current();
    }

    /** 更新当前实例的通用配置（无需传 id，服务端按单例行定位）。 */
    @PostMapping("/current/update")
    public Result<Void> updateCurrent(@RequestBody UserConfigRequest request) {
        return service.update(toCommand(request));
    }

    private UserConfigCommand toCommand(UserConfigRequest request) {

        return new UserConfigCommand(
                request.getId(),
                request.getCommandApprovalPolicy(),
                request.getAccessMode(),
                request.getPlanMaxReminders(),
                request.getModelId(),
                request.getAgentId(),
                request.getType(),
                request.getMaxTokens(),
                request.getReasoningEffort()
        );
    }
}
