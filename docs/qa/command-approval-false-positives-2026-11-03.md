# 完全放行命令审批误报回归（2026-11-03）

## 范围与边界

- WSL 状态、版本、发行版查询及普通 Linux 命令不再一律判为高危。
- WSL 内的实际命令继续走风险判定；注销发行版、停机、挂卸磁盘和未识别管理选项仍需审批。
- WSL 的 `/mnt/<盘符>/` 系统目录与 Windows 宿主路径采用相同保护边界；项目子目录清理仍可放行。
- 系统命令的 `--help`、`/?`、`-?` 不再触发高危审批；`shutdown -h now` 仍判为停机。
- `Start-Process` 按 `-Verb RunAs`、`-Verb:RunAs`、`-Verb: RunAs` 判定提权，普通参数值 `RunAs` 不再误报。
- 自定义禁止和逐条确认继续生效；默认档位仍叠加既有终端预设。本次没有修改沙箱权限。

## 验证

后端命令：

```powershell
mvn -o -q '-Dtest=CommandRiskClassifierTest,CommandPolicyConfigTest,TerminalSecurityPolicyTest,SecurityRuleServiceTest,CommandToolDefinitionExecutorTest,CommandShellTest,CommandApprovalExecutorTest,RequestPreparerExecutionIdentityTest' test
```

结果：167 条通过，0 失败、0 错误、0 跳过。危险命令只作为分类及模拟审批输入，没有执行实际破坏操作。

前端：`npx vue-tsc -b` 通过。

回退验证：将 HEAD 中的旧分类器编译到独立测试目录，运行新增后的分类器及审批策略测试，共 32 条断言失败；已逐项确认包含 WSL 查询、系统帮助、普通 `RunAs` 参数三类误报。换回修复后的分类器，同一组 119 条测试全部通过。主工作树源码及主测试输出目录未被回退。

提交前按明确文件清单读取完整字节，并用正对照验证扫描器后检查修改行规范；`git diff --check` 通过。

本次为源码修改及本地测试，后端重启后生效；前端说明需刷新，安装包未重新打包。
