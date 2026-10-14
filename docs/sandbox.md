# SRT 沙箱接入

业务设置中的 `workspaceType=sandbox` 选择 SRT provider，`accessMode` 决定工作区是否可写。
本地模式继续使用原有 local provider，文件和命令工具均通过 WorkspaceBridge 执行。

部署方必须配置三个绝对路径，可用 JVM 参数或对应环境变量注入：

```text
lingxi.sandbox.application-directory=<应用安装根目录>
lingxi.sandbox.node-exe=<Node 可执行文件>
lingxi.sandbox.srt-cli=<完整 sandbox-runtime 安装中的 dist/cli.js>
```

框架会把 helper 提取到安装目录的 `resources/sandbox-helpers/`。
安装目录只读时应提前提取 helper，并将 `lingxi.sandbox.state-directory` 配到可写的部署目录。
沙箱需要读取 helper、Node 和请求目录；provider 会生成对应策略并禁止修改 helper 和请求内容。
不使用开发机的全局 npm 路径，也不会自动安装需要管理员权限的 Windows 沙箱组件。
缺少资源或策略未生效时明确报错，不退回宿主执行；未配置这些路径仍可启动并使用本地模式。

`IN_WORKSPACE` 允许工作区读写；沙箱下 `OUT_OF_WORKSPACE` 沿用原规则降级为该档位。
`READ_ONLY_IN_WORKSPACE` 对工作区生成 `denyWrite`，文件工具和 shell 命令共同受沙箱权限约束。
只读启动检查验证读取和拒绝写入，不要求向只读工作区创建文件。
子 Agent 沿用父请求快照中的访问档位，审批恢复按快照重新解析 workspace。

联网默认沿用业务的开放行为，限制域名可修改 `lingxi.sandbox.allowed-domains`；
额外文件限制使用 `lingxi.sandbox.deny-read` 和 `deny-write`，相对路径以工作区为基准。
执行快照使用框架已有的 BasicWorkspaceSpec；旧 Docker 快照不再作为可执行规格恢复。

可通过 `-Dsandbox.srt.cli=<dist/cli.js>` 和可选的 `-Dsandbox.node.exe=<node>`
运行 `SandboxWorkspaceIntegrationTest`，验证真实文件操作及原始命令的只读限制。
