package com.summit.dp.workspace.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.workspace.application.service.SandboxService;
import com.summit.dp.workspace.application.vo.SandboxServiceStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 状态查询不启动进程，真实检查由用户显式触发。
 */
@RestController
@RequestMapping("/sandbox")
@RequiredArgsConstructor
public class SandboxController {

    private final SandboxService sandboxService;

    /** 沙箱服务状态；只检测文件与平台，不跑任何命令。 */
    @GetMapping("/service/status")
    public Result<SandboxServiceStatus> serviceStatus() {
        return Result.success(sandboxService.inspect());
    }

    /** 检查真实命令和文件隔离，不安装系统组件。 */
    @PostMapping("/service/check")
    public Result<SandboxServiceStatus> checkService() {
        return Result.success(sandboxService.check());
    }
}
