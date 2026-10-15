# MXC 原生平台接入与验证

当前统一规则：**Windows 使用原生 BaseContainer；Linux 使用 Bubblewrap**。不提供 Windows 到 Linux 的执行路径，不允许 DACL 回退或宿主本地执行降级。

## 部署配置

两侧都需要 Java 21、宿主原生 Node 24 及以上、固定版本 `@microsoft/mxc-sdk@1.0.0`。SDK 与 Node 由部署提供，自有脚本随框架 JAR 发布；业务不自动安装系统组件。

Windows 需要支持 BaseContainer 的系统版本。本机为 **25H2 / 26200.9278**，精确请求探测确认 `tier=base-container`、`needsDaclAugmentation=false`。执行策略同时设置 `fallback.allowDaclMutation=false`。

```powershell
$env:LINGXI_SANDBOX_APPLICATION_DIRECTORY = 'D:/LingXiRuntime/sandbox'
$env:LINGXI_SANDBOX_NODE_EXECUTABLE = 'D:/tools/node/node.exe'
$env:LINGXI_SANDBOX_SDK_DIRECTORY = 'D:/tools/mxc/node_modules/@microsoft/mxc-sdk'
```

以上是部署示例。Linux 使用相同配置名，填写 Linux Node、SDK 与状态目录的绝对路径，并保留 Bubblewrap、Bash 和非特权命名空间条件。

`application-directory` 必须位于可写项目目录之外，避免脚本和控制文件暴露为项目可写资源。启动与文件操作预算默认 `30s`，可以配置覆盖。旧 `distribution` 配置已移除。

桌面部署说明 `frontend/vendor/mxc/mxc-deployment.json` 的 Windows 示例：

```json
{
  "schemaVersion": 1,
  "backend": "processcontainer",
  "sdkVersion": "1.0.0",
  "nodeExecutable": "D:/tools/node/node.exe",
  "sdkDirectory": "D:/tools/mxc/node_modules/@microsoft/mxc-sdk"
}
```

Linux 使用 `backend=bubblewrap` 及 POSIX 路径。构建会拒绝平台后端不匹配和旧发行版字段；资源存在与实际可用性仍由目标后端检查。环境变量可覆盖说明中的资源位置。

## 业务探测与权限

`GET /sandbox/service/status` 仅查询配置，返回 `ready=false`。它不执行命令。
`POST /sandbox/service/check` 使用应用状态目录下的 UUID 临时工作区，实际检查命令、文件写读删、区外访问拒绝；不使用真实项目目录，也不证明任意项目工具都兼容。

本机检查返回：

```json
{"configured":true,"ready":true,"backend":"BaseContainer","message":"沙箱可用：命令执行和文件读写通过，工作区外读写已拒绝"}
```

| 模式 | 项目目录 | 额外部署授权 |
| --- | --- | --- |
| READ_ONLY_IN_WORKSPACE | 只读，包括终端写入限制 | 只读 |
| IN_WORKSPACE | 可读写 | 只读 |
| OUT_OF_WORKSPACE | 可读写 | 仅 readwrite-paths 列出的目录可写 |

项目外修改未配置明确授权时拒绝执行，不自动开放盘根。网络固定拒绝，包括宿主回环。文件操作还校验规范化目标和 junction/符号链接。Linux 的私有临时层写入不等于宿主可写，文件 API 会拒绝未授权的此类操作。

框架运行对象保留在 workflow 接入，工作区业务只依赖 SandboxService；没有新增框架工作区缓存或回收器。

## 工具兼容结论

- **CMD：** Windows 默认终端；已验证目录、命令、退出码和中文输出。无控制台时 chcp 不可靠，运行环境按系统 OEM 代码页报告终端编码。外部工具采用其他输出编码时需显式匹配。
- **Node：** 默认提供 preserve-symlinks-main 与 preserve-symlinks，避开入口解析对盘根的依赖。文件助手不接受命令环境中的预加载选项。尚不能据此认定任意 npm 项目构建兼容。
- **PowerShell：** 最小授权下可能无法初始化项目位置，Set-Location 也受限；不能把直接启动成功当作相对路径命令可用。因此当前默认使用 CMD。
- **Maven：** 3.9.16 初始化时真实路径解析失败，递归访问祖先直到空父路径，再被日志未初始化的异常遮盖。不能通过开放整个盘符读取来修复。
- **Maven 可行性实验：** 在独立实验入口中对上述已知初始化失败使用规范化绝对路径作为 CLI 元数据，原版 -version 失败、实验版 -version 和最小 POM 离线 validate 均通过，同时项目外金丝雀读取被拒绝。没有修改已安装 Maven，也没有把该实验入口纳入产品。
- **后续处理：** 优先使用经过实际能力探测的祖先目录仅枚举授权；本机尚不支持。另一条路线是工具上游修复或部署专用 Maven 启动器，需要补齐 -f、多模块、符号链接、插件及真实构建回归。不会自动降低隔离等级。

原生 Windows 使用 Node 初始化所需的 UI 兼容配置，仍禁用剪贴板及输入注入；本次未验证 Win32k 系统调用封锁。更详细的源码分析与实验位置见[框架报告](/D:/Code/starter/lingxi-harness-agent/docs/mxc-native-platform-validation.md)。

## 验证与运行后端

- Windows 全模块 Maven 构建通过；原生适配集成 **8 项通过**。
- Linux 原生 Java 回归通过；MXC 模块 **18 项，16 通过、2 跳过**，跳过项为未配置真实构建和宿主监听参数的用例。Linux 验证宿主使用现有 Ubuntu 环境，不代表产品仍有 Windows 到 Linux 的路由。
- 业务定向 **21 项全部通过**：策略转换、Spring 配置、真实原生沙箱集成、快照 JSON 和分层检查。
- 桌面脚本 **6 项通过**；TypeScript/Vite 构建及后端 JAR 打包通过。
- 只读权限做过非等价变异，预期断言变红，恢复后通过。
- 当前后端：`http://127.0.0.1:18088`，独立数据库及沙箱状态位于 `D:/LingXiMxcNativeValidation`。原 8088 服务保留，原先的 Linux 传输验证进程已停止。
- 运行 JAR、进程信息和证据在 `.run/mxc-native-adaptation/`，包括 `business-tests.log`、`desktop-tests.log`、`frontend-build.log`、`backend-package.log`、`http-check.json` 以及后端 stdout/stderr。

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:18088/sandbox/service/check
```

本次未验证 Windows 真实项目完整构建、完整模型对话或完整 Electron 安装包。之前 Windows 到 Linux 的工作树耗时不能用于评价当前原生实现。