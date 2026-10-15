package com.summit.dp.workspace.application.vo;

/** ready 只表示本次真实检查通过，configured 不代表后端可运行。 */
public record SandboxServiceStatus(boolean configured, boolean ready, String backend, String message) { }
