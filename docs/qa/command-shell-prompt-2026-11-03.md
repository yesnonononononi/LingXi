# 终端工具解释器提示词回归（2026-11-03）

## 调整

`execute_command` 的工具描述及 `command`、`shell` 参数说明统一要求每次显式选 shell，包括同一批次的后续调用。说明独立进程不会继承上次 shell 或目录切换，省略时取工作空间默认值。

Windows 下区分 PowerShell 的 `Set-Location`、`;` 与 CMD 的 `cd /d`、命令连接。强调 `node -e` 引号内的 JavaScript 不决定外层解释器，并提供 PowerShell 和 CMD 两份完整 JSON 示例。解析或路径语法报错时，先核对失败调用本身的 shell 参数。

只修改模型可见提示词，参数结构和执行代码保持原样，`shell` 仍为可选参数；完全放行的免审批行为保持原样。

## 验证

```powershell
mvn -o -q '-Dtest=ToolDefinitionSchemaContractTest,StaticToolDeclarationContractTest,ToolDefinitionSchemaGateTest,CommandShellTest,CommandToolDefinitionExecutorTest,CommandPolicyConfigTest' test
```

51 条通过，0 失败、0 错误、0 跳过。新增守卫读取真实注解生成的工具定义及 codec 输出，校验逐次选择规则、示例 JSON 和示例对应的 Windows shell。

在独立目录编译旧工具类，回退后 4 条契约断言失败，包含两条新增守卫；换回新工具类，同组 5 条测试通过。主工作树及主构建目录没有回退。

用正对照验证扫描器后按明确文件清单检查完整字节与修改行；额外比对确认执行类方法体及工具参数结构与 HEAD 相同，`git diff --check` 通过。

本次未进行真实模型调用成功率评测。后端重启后新请求可使用更新的工具描述，安装包未重新打包。
