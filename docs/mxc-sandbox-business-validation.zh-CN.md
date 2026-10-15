# MXC 沙箱业务接入与验证

本次移除 `harness-local-sandbox` 依赖及 SRT 安装流程，接入 `harness-sandbox-mxc:1.1.6`。
框架源码锁定为 `06f249bbfaa52cf755237f72c2e7ffda903368fb`。本地已构建安装，尚未推送框架提交或发布 Maven 新版本。

## 运行条件与配置

- Linux：Node 24 及以上、Linux 安装的 `@microsoft/mxc-sdk@1.0.0`、可用的 Bubblewrap。
- Windows：在指定 WSL 发行版内提供上述资源。Windows Node 和 Windows 安装的 npm 原生依赖不能替代它们。
- 本版支持 Linux 以及 Windows 到 WSL；不支持原生 Windows、macOS、PTY、交互式 stdin 或按域名放行网络。沙箱内网络全部拒绝。
- MXC SDK、Linux Node 和 Bubblewrap 由部署准备；框架 JAR 只携带自有脚本，不自动下载 SDK，也不发起提权安装。
- `application-directory` 存放控制文件和脚本，必须位于项目可写目录之外，且能被对应 Linux/WSL 文件系统访问。

独立后端可通过环境变量配置：

```powershell
$env:LINGXI_SANDBOX_APPLICATION_DIRECTORY = 'D:/LingXiRuntime/sandbox'
$env:LINGXI_SANDBOX_DISTRIBUTION = 'Ubuntu'
$env:LINGXI_SANDBOX_NODE_EXECUTABLE = '/opt/lingxi-mxc/node/bin/node'
$env:LINGXI_SANDBOX_SDK_DIRECTORY = '/opt/lingxi-mxc/node_modules/@microsoft/mxc-sdk'
```

这些 Linux 路径是部署示例，需替换为已安装资源。原生 Linux 不需要 `distribution`。
业务默认给终端设置 `PATH=<node 所在目录>:/usr/bin:/bin`，可通过 `lingxi.sandbox.environment` 显式覆盖。
`startup-timeout` 与 `file-timeout` 默认均为 `30s`，支持 Spring 配置覆盖。

桌面打包时，向 `frontend/vendor/mxc/mxc-deployment.json` 提供说明，或通过
`LINGXI_RUNTIME_SOURCE` 指定其目录：

```json
{
  "schemaVersion": 1,
  "backend": "bubblewrap",
  "sdkVersion": "1.0.0",
  "distribution": "Ubuntu",
  "nodeExecutable": "/opt/lingxi-mxc/node/bin/node",
  "sdkDirectory": "/opt/lingxi-mxc/node_modules/@microsoft/mxc-sdk"
}
```

构建脚本校验并暂存部署说明；目标机器仍需具备资源。Electron 读取说明并允许上述环境变量覆盖。
真实可用性由后端检查确认，不能由说明文件存在推断。

## 权限与接口

| 访问模式 | 项目目录 | 部署额外授权 |
| --- | --- | --- |
| `READ_ONLY_IN_WORKSPACE` | 只读，包括终端命令 | 只读 |
| `IN_WORKSPACE` | 可读写 | 只读 |
| `OUT_OF_WORKSPACE` | 可读写 | 仅 `readwrite-paths` 明确列出的目录可写 |

项目外写入模式未配置 `readwrite-paths` 时拒绝执行，不自动授权整块磁盘。
文件写入、建目录、删除操作在运行前核对明确授权，符号链接按实际路径处理。
Bubblewrap 的私有临时层可能允许命令在结构目录创建临时文件；这不表示对应宿主路径获得写入权限。
运行时资源及控制文件不能与可写目录重叠。

- `GET /sandbox/service/status`：只查询配置，返回 `ready=false`，不启动沙箱。
- `POST /sandbox/service/check`：实际运行命令、文件写读删及工作区外拒绝检查；通过后返回 `ready=true`。
- 原 `POST /sandbox/service/install` 已删除，运行后端实测返回 HTTP 404。
- 未配置 MXC 不妨碍本地模式启动；选择沙箱执行时明确报错，不降级到宿主执行。

框架运行对象接入位于 `workflow.infrastructure.config`，工作区业务通过 `SandboxService` 查询检查结果。
没有加入框架工作区缓存、回收器或外部环境生命周期管理。

## 本次证据

| 验证 | 实际结果 |
| --- | --- |
| 框架 Maven 构建与测试 | 369 项，366 通过、3 跳过，0 失败；已安装本地 Maven 缓存 |
| 业务定向测试 | 21 项全部通过，含真实 WSL 沙箱集成、策略转换、JSON 往返、分层检查 |
| 桌面启动及部署脚本测试 | 6 项全部通过 |
| 前端 TypeScript 与 Vite 构建 | 通过 |
| 业务 Spring Boot JAR 打包 | 通过 |
| 后端 HTTP 真实检查 | `configured=true, ready=true, backend=WSL/Bubblewrap` |
| 真实 `D:/Code/LingXi` 工作树 | Node 24、Git、Java 命令成功，POM 可读，只读终端写入拒绝，独立后端数据库不可见 |
| 真实工作树首次解析 | 最近一次 4460ms，单次观测，不代表分位数或所有项目 |
| 产物核对 | 运行 JAR 内无旧模块，新模块字节与本次验证的框架 JAR 一致 |

业务测试为 `WorkspaceConverterTest`、`SandboxConfigurationTest`、`SandboxWorkspaceIntegrationTest`、
`WorkflowDependencyTest`、`ExecutionJsonTest`，真实集成用例本次未跳过。
框架跳过项分别为内核已有条件用例、未配置宿主网络监听的用例和未配置真实构建参数的用例；不能据此声称本轮又做了真实项目 Maven 构建。
本轮未跑业务全量测试、完整 Electron 安装包或完整模型对话。

回归断言做过非等价变异：去掉只读策略、去掉部署 SDK 版本检查分别触发预期断言失败；
框架只读授权变异也触发失败并恢复为绿。文件 API 的项目外写入问题先复现为红，再由明确写授权检查修复。

## 当前验证后端与记录

- 地址：`http://127.0.0.1:18088`，仅监听本机；原 8088 后端保留。
- 独立状态目录：`D:/LingXiMxcValidation-06f249b`，数据库、Java home、沙箱脚本均与项目目录分离。
- 本机 Node：`/home/summit/mxc-validation-20261015/runtime/bin/node`，版本 24.20.0。
- 本机 SDK：`/home/summit/mxc-validation-20261015/node_modules/@microsoft/mxc-sdk`，版本 1.0.0。
- 运行 JAR：`.run/mxc-adaptation/running/app-mxc.jar`。
- 日志与证据：`.run/mxc-adaptation/` 下的 `business-final-tests.log`、`desktop-tests.log`、
  `frontend-build.log`、`backend-final-package.log`、`real-worktree-probe.log`、`artifact-audit.json`、
  `http-check-active.json`、`backend-active-stdout.log` 与 `backend-active-stderr.log`。
- 运行 JAR SHA-256：`7905efb00c0bb42db3268d5d9f7205df8fd20317fd7aafb1bfb53cf592dfc07b`。

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:18088/sandbox/service/check
```

本次新建隔离数据库时，已有 MCP 启动查询先于 H2 建表执行，首次启动失败。
仅对独立验证数据库使用 Spring SQL 初始化后，再去掉初始化参数正常启动；未修改这处业务启动顺序，也未使用用户数据库。
另外，本机一次 Windows 用户目录创建的验证路径在 WSL 中不可见，原因未定位；当前改用已证实双方可见的 D 盘独立目录。

依赖下载类构建仍需提前准备依赖并显式授权缓存目录，不能把禁网沙箱当作可联网开发环境。
