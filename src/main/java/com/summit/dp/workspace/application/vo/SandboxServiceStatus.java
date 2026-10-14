package com.summit.dp.workspace.application.vo;

/**
 * 沙箱服务状态（给界面判断要不要显示「安装沙箱服务」）。
 *
 * @param windows           本机是否 Windows —— 只有 Windows 需要 {@code srt windows-install} 注册系统组件
 * @param srtPackagePresent srt 包是否在位（srt-cli 与 node-exe 两个文件都能找到）
 * @param installedThisCall 本次调用是否真的执行了安装（false 表示本来就可用，或该平台不需要安装）
 * @param message           面向用户的中文说明
 */
public record SandboxServiceStatus(boolean windows, boolean srtPackagePresent,
                                   boolean installedThisCall, String message) {
}
