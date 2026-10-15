package com.summit.dp.workspace.application.vo;

/** ready 只表示基础能力检查通过，不代表具体项目的命令或文件权限已经验证。 */
public record SandboxServiceStatus(boolean configured, boolean ready, String backend, String message) { }
