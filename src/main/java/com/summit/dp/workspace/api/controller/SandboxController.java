package com.summit.dp.workspace.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.workspace.application.service.SandboxServiceInstaller;
import com.summit.dp.workspace.application.vo.SandboxServiceStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 沙箱服务接口层。
 *
 * <p>Windows 上 SRT 需要先注册系统组件（{@code srt windows-install}）才能跑起沙箱，
 * 这个端点就是那个动作的显式入口 —— 会自动安装的那条路只在启动沙箱模式时走一次。</p>
 */
@RestController
@RequestMapping("/sandbox")
@RequiredArgsConstructor
public class SandboxController {

    private final SandboxServiceInstaller sandboxServiceInstaller;

    /** 沙箱服务状态；只检测文件与平台，不跑任何命令。 */
    @GetMapping("/service/status")
    public Result<SandboxServiceStatus> serviceStatus() {
        return Result.success(sandboxServiceInstaller.inspect());
    }

    /** 安装沙箱服务（Windows 会弹 UAC 授权注册系统组件）；已装过也可重装。 */
    @PostMapping("/service/install")
    public Result<SandboxServiceStatus> installService() {
        return Result.success(sandboxServiceInstaller.install());
    }
}
