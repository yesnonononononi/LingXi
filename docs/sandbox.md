# SRT 沙箱接入

> 遗留文档。`workspaceType=sandbox` 当前由 MXC 提供（Windows BaseContainer / Linux Bubblewrap），
> 见 [MXC 原生平台接入与验证](mxc-sandbox-business-validation.zh-CN.md)。本文保留供回溯 SRT 时期的接入细节。
> 其中「把 node/srt/git 从发行包目录拷进 `build/runtime`」的动作仍然成立，
> 但已由 `scripts/build-sandbox-runtime.mjs` 统一承担，并额外随包 MXC SDK。

业务设置中的 `workspaceType=sandbox` 选择 SRT provider，`accessMode` 决定工作区是否可写。
本地模式继续使用原有 local provider，文件和命令工具均通过 WorkspaceBridge 执行。

桌面启动器从 Electron 的 `app.getPath('exe')` 取得可执行文件位置，以其父目录作为安装根目录，
通过启动参数传给 Java；开发态使用项目根目录。`cwd` 是用户数据目录，不能用它推断安装位置。
状态目录自动使用 `<userData>/sandbox-state/`，项目路径来自用户选择的 workspace。
`LINGXI_SANDBOX_APPLICATION_DIRECTORY` 和 `LINGXI_SANDBOX_STATE_DIRECTORY` 可显式覆盖自动目录。

运行资源由构建输入提供；启动器自动使用打包态 `process.resourcesPath/runtime/`，
开发态使用 `frontend/build/runtime/`。也可用 JVM 参数或对应环境变量覆盖：

```text
lingxi.sandbox.node-exe=<Node 可执行文件>
lingxi.sandbox.srt-cli=<完整 sandbox-runtime 安装中的 dist/cli.js>
lingxi.sandbox.bash-exe=<完整 Git 包中的 bin/bash.exe>
```

框架会把 helper 提取到安装目录的 `resources/sandbox-helpers/`。
后端构建会从本次 Boot jar 中提前提取 helper，随安装包部署，首次运行无需写安装目录。
独立启动 Java 时仍需配置安装目录和可写状态目录。
桌面包通过 `extraResources` 带入完整运行资源和 helper，均位于 ASAR 外。
沙箱需要读取 helper、Node 和请求目录；provider 会生成对应策略并禁止修改 helper 和请求内容。
不使用开发机的全局 npm 路径，也不会自动安装需要管理员权限的 Windows 沙箱组件。
缺少资源或启动检查失败时明确报错，不退回宿主执行；未配置这些路径仍可启动并使用本地模式。

## 准备与构建

将与构建机器平台、架构一致的发行包解压到以下目录（Windows x64 示例）：

```text
frontend/vendor/runtime/win32-x64/
  node/node.exe
  srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js
  git/bin/bash.exe
  git/cmd/git.exe
  git/usr/bin/msys-2.0.dll
```

Node 使用[官方完整发行包](https://nodejs.org/en/download)，Git 使用[完整 PortableGit](https://git-scm.com/install/windows)，保留其 DLL、工具和许可证。
SRT 保留整个 npm 安装目录，包括依赖、vendor 及原生组件。已验证的 SRT 版本为 0.0.79，
可在 frontend 中准备：

```powershell
npm install --prefix vendor/runtime/win32-x64/srt --ignore-scripts --omit=dev --no-audit --no-fund --save-exact @anthropic-ai/sandbox-runtime@0.0.79
npm run sandbox:runtime
npm run app:build:dir
```

发行包目录不入 Git。CI 同样需要提供这个目录，可由构建资产解压得到；
`LINGXI_RUNTIME_SOURCE` 或 `sandbox:runtime -- --source=<目录>` 可指定另一份包含 node、srt、git 的源目录。
重复构建复用源目录的 package.json/package-lock.json，并通过 npm ci 准备 SRT，避免依赖漂移。
构建校验 Node 版本和架构、SRT 依赖/CLI、Git/Bash 运行能力；缺资源时拒绝打包。
`beforePack` 覆盖快速构建及直接调用 electron-builder 的入口，避免静默漏包。
构建只执行版本和 Bash 检查，不安装 Windows 系统组件。
锁定的框架提交须先推送到源码仓库，CI 和干净环境才能取得对应实现。

Windows 首次使用还需显式安装 SRT 账户和 WFP 组件（可能触发 UAC），运行一次：

```powershell
& "<资源目录>/runtime/node/node.exe" "<资源目录>/runtime/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" windows-install
```

框架接收 Bash 路径后自动选择 Bash；业务执行器仍只传原始命令。
启动器仅给应用子进程补充 Node/Git 的 PATH，不修改系统全局环境。

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
