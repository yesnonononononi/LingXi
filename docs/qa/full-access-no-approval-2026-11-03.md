# 完全放行免审批回归（2026-11-03）

## 当前规则

按用户后续明确要求，完全放行对所有命令免审批，不再保留高危命令例外。命令通过自定义禁止检查后直接跳过风险分类与审批登记。

- 复合脚本、重定向、清理命令、磁盘操作、系统删除、提权及 WSL 管理操作均不发起审批。
- 自定义 `DENY` 仍直接拒绝；内置预设和 `ASK` 不会在完全放行下触发审批。
- 参数校验、沙箱权限保持原样；危险拦截和逐条确认仍执行既有风险判定。
- 操作系统按进程已有权限控制命令执行，不能保证拦截破坏性操作。

## 验证证据

```powershell
mvn -o -q '-Dtest=CommandPolicyConfigTest,CommandRiskClassifierTest,TerminalSecurityPolicyTest,SecurityRuleServiceTest,CommandToolDefinitionExecutorTest,CommandShellTest,CommandApprovalExecutorTest,RequestPreparerExecutionIdentityTest' test
```

183 条通过，0 失败、0 错误、0 跳过。`CommandPolicyConfigTest` 包含 26 条，覆盖用户提供的复合命令结构、高危命令免审批、自定义禁止、无效解释器及其他档位。所有脚本仅作为审批策略测试文本，不会实际执行删除、磁盘或提权操作。

前端 `npx vue-tsc -b` 通过，中文及英文权限说明已同步。

回退验证在独立输出目录运行：用旧 `CommandPolicyConfig` 替换测试目录中的类后，8 条高危免审批断言失败；换回新实现，同组 26 条测试全部通过。工作树源码与主构建目录未回退。

修改文件逐个核对 mtime，并在正对照确认扫描器有效后检查修改行规范及完整 UTF-8 字节；`git diff --check` 通过。

本次为源码提交及本地验证。后端重启后生效；前端说明需刷新，安装包未重新打包。
