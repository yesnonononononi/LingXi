# SRT 沙箱接入

业务设置中的 `workspaceType=sandbox` 选择 SRT provider，`accessMode` 决定工作区是否可写。
本地模式继续使用原有 local provider，文件和命令工具均通过 WorkspaceBridge 执行。

桌面启动器从 Electron 的 `app.getPath('exe')` 取得可执行文件位置，以其父目录作为安装根目录，
通过启动参数传给 Java；开发态使用项目根目录。`cwd` 是用户数据目录，不能用它推断安装位置。
状态目录自动使用 `<userData>/sandbox-state/`，项目路径来自用户选择的 workspace。
`LINGXI_SANDBOX_APPLICATION_DIRECTORY` 和 `LINGXI_SANDBOX_STATE_DIRECTORY` 可显式覆盖自动目录。

Node 和完整 SRT 运行资源仍由部署方提供，可用 JVM 参数或对应环境变量注入：

```text
lingxi.sandbox.node-exe=<Node 可执行文件>
lingxi.sandbox.srt-cli=<完整 sandbox-runtime 安装中的 dist/cli.js>
```

框架会把 helper 提取到安装目录的 `resources/sandbox-helpers/`。
安装目录只读时应在安装阶段提前提取 helper。独立启动 Java 时还需配置安装目录和可写状态目录。
当前桌面打包脚本只打包 JRE 和后端 jar，尚未包含 Node、SRT 及 helper 预提取步骤。
沙箱需要读取 helper、Node 和请求目录；provider 会生成对应策略并禁止修改 helper 和请求内容。
不使用开发机的全局 npm 路径，也不会自动安装需要管理员权限的 Windows 沙箱组件。
缺少资源或启动检查失败时明确报错，不退回宿主执行；未配置这些路径仍可启动并使用本地模式。

每次请求以当前项目绝对路径和访问档位生成策略快照，文件权限不在 YAML 中配置。
`IN_WORKSPACE` 将当前项目加入 `allowRead` 和 `allowWrite`；
`READ_ONLY_IN_WORKSPACE` 将项目加入 `allowRead` 和 `denyWrite`。
切换项目或档位会生成独立策略，既有请求和审批快照保持原权限。
`OUT_OF_WORKSPACE` 在沙箱中同样允许项目外写入，每次请求枚举当前文件系统的挂载根目录加入 `allowWrite`，
不固化盘符或切换为宿主执行。操作系统自身的访问限制仍然有效；helper 和状态目录继续禁止沙箱写入。
三档均可初始化，不要求后端证明所有项目外路径不可写。Windows SRT 使用追加 ACL，
项目外已有的组写权限可能仍然有效，`allowWrite` 不代表名单外默认拒绝。
只读档禁用编辑工具，保留终端和读取工具；终端仍串行执行，命令写入副作用不在档位保证范围内。
文件工具和 shell 命令均经过 SRT，执行时遵循该后端的显式权限规则。
运行环境的 OS 必须与本地宿主一致。
只读启动检查验证读取和拒绝写入，不要求向只读工作区创建文件。
子 Agent 沿用父请求快照中的访问档位，只读档同样移除其配置中的编辑工具，保留终端；
审批恢复按快照重新解析 workspace。

联网默认沿用业务的开放行为，限制域名可修改 `lingxi.sandbox.allowed-domains`。
执行快照使用框架已有的 BasicWorkspaceSpec；旧 Docker 快照不再作为可执行规格恢复。

可通过 `-Dsandbox.srt.cli=<dist/cli.js>` 和可选的 `-Dsandbox.node.exe=<node>`
运行 `SandboxWorkspaceIntegrationTest`，验证真实文件操作及原始命令的只读限制。
完全访问用例在隔离测试目录中验证项目外文件工具和命令写入，以及 helper 目录的拒绝写入；
测试替换挂载根枚举来源，不对宿主整盘施加 ACL。真实挂载根的动态枚举由单元测试验证。
工作区修改档验证实际项目内写入，只读档验证项目可读且显式禁止修改、创建和删除。
其他系统还验证项目外拒绝；Windows 不对项目外默认拒绝作保证。启动探针仅验证列出的显式规则。
