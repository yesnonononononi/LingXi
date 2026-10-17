# MXC 原生平台接入与验证

> 2026-10-15 安全复核：Windows 当前接入存在通用应用包 ACL 带来的额外读取权限，不能作为严格读取白名单验收。原有 30 项定向测试不包含该情形。新增安全回归用于暴露此缺口，详情见[读取边界复核](mxc-windows-read-boundary-audit.zh-CN.md)。本次尚未修复。

当前统一规则：**Windows 使用原生 BaseContainer；Linux 使用 Bubblewrap**。不提供 Windows 到 Linux 的执行路径，不允许 DACL 回退或宿主本地执行降级。

## 部署配置

本机开发资源使用 `cd frontend; npm run sandbox:dev` 准备。该命令保留 `build/runtime` 中已有工具，用锁文件安装 SDK 及依赖到 `build/runtime/mxc/node_modules`（与打包态同构），并加载原生库检查基础能力；已有 Node 必须为 24 及以上，缺少时复制执行该命令的宿主 Node。

后端只接收 `application-directory`（应用安装根目录）和 `state-directory`（可写沙箱状态目录）。开发配置默认以 `${user.dir}` 为仓库根目录，不再写死本机 checkout 或逐项配置 Node、Git、MXC SDK。状态目录默认位于 `${user.home}/.lingxi/sandbox`。

`sandbox:dev` 用于本机开发；`sandbox:runtime` 负责打包：把发行包目录 `frontend/vendor/runtime/<platform>-<arch>/`（Node、Git Bash、SRT、MXC SDK）整棵暂存到 `build/runtime`，写入**包内相对路径**的部署说明，并在打包前（`beforePack`）校验组件齐全，缺资源时拒绝出包。安装包因此自带运行资源，与安装位置无关。

开发资源补齐后，使用该目录的 Node 和 SDK 运行配置及真实隔离测试，5 项通过；其中直接加载 `application-dev.yaml`，不通过命令行补充 Node/SDK 路径。把 Node 路径恢复成目录后，该配置回归按预期失败。桌面启动与部署说明测试另 6 项通过。记录见 `.run/mxc-dev-resources/verified-test.log` 和 `mutation-test.log`。

两侧都需要 Java 21、Node 24 及以上、固定版本 `@microsoft/mxc-sdk@1.0.0`。桌面端把 Node 与 SDK 随安装包发布（见下），自有脚本随框架 JAR 发布；业务不自动安装系统组件。

Windows 需要支持 BaseContainer 的系统版本。本机为 **25H2 / 26200.9278**，精确请求探测确认 `tier=base-container`、`needsDaclAugmentation=false`。执行策略同时设置 `fallback.allowDaclMutation=false`。

```powershell
$env:LINGXI_SANDBOX_APPLICATION_DIRECTORY = 'D:/Apps/LX'
$env:LINGXI_SANDBOX_STATE_DIRECTORY = 'D:/LingXiState/sandbox'
```

Linux 使用相同目录配置，并保留 Bubblewrap、系统 Bash 和非特权命名空间条件。

后端从安装根目录解析 `resources/runtime`；根目录存在 `frontend/package.json` 时使用开发布局 `frontend/build/runtime`，无需等待运行资源准备完才识别开发环境。Node、Git、Bash 和 MXC SDK 路径由后端统一拼接；Windows 默认子进程 PATH 包含随包 Node、`git/cmd`、`git/bin` 和系统 System32，显式配置的 PATH 仍优先。宿主进程 PATH 不被修改。

helpers 写入 `state-directory/helpers`，状态目录应位于项目之外。运行资源目录和状态目录在沙箱策略中保持只读，不把整个开发仓库设为只读。启动与文件操作预算默认 `30s`，可以配置覆盖。

打包产物 `build/runtime/mxc-deployment.json` 写的是**包内相对路径**（相对安装目录的 `resources/runtime`），因此安装包与安装位置无关：

```json
{
  "schemaVersion": 1,
  "backend": "processcontainer",
  "sdkVersion": "1.0.0",
  "nodeExecutable": "node/node.exe",
  "sdkDirectory": "mxc/node_modules/@microsoft/mxc-sdk"
}
```

`electron/backend.cjs` 只传可执行文件所在的安装根目录和 `<userData>/sandbox` 状态目录，开发态传仓库根目录；不再读取部署说明或注入组件路径。部署说明保留用于构建和打包校验，宿主绝对路径会被拒绝。安装后的 `resources/runtime` 同时带 Git Bash（`git/bin/bash.exe`）与 SRT（`srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js`）；Windows MXC 仍使用原生 shell，未切换为 SRT 或 Bash 执行。

Linux 使用 `backend=bubblewrap` 与 `node/node`，并保留 Bubblewrap、Bash 和非特权命名空间条件。

## 业务探测与权限

`GET /sandbox/service/status` 仅查询配置，返回 `ready=false`。它不执行命令。
`POST /sandbox/service/check` 启动一个 Node 进程，检查 Node/SDK 版本、SDK 原生库加载和宿主隔离能力。Windows 要求 BaseContainer 且不需要 DACL 回退；Linux 要求发现 Bubblewrap，忽略与当前禁网模式无关的可选代理告警。

检查不创建状态目录、临时工作区或探针文件，不启动沙箱，不验证具体目录权限、命令启动或工具兼容性。`ready=true` 只表示基础能力可用；实际工作区解析和命令、文件操作仍保留原有校验。

本机检查返回：

```json
{"configured":true,"ready":true,"backend":"BaseContainer","message":"沙箱基础能力可用，项目执行时仍会校验实际权限"}
```

| 模式 | 项目目录 | 额外项目目录 |
| --- | --- | --- |
| READ_ONLY_IN_WORKSPACE | 只读，包括终端写入限制 | 不开放 |
| IN_WORKSPACE | 可读写 | 不开放 |
| OUT_OF_WORKSPACE | 拒绝创建沙箱，提示显式选择本地模式 | 不开放 |

业务 factory 只接收命令环境，项目权限由 `workDir + writable` 生成，不再接收额外目录清单。档位缺省按工作区内修改处理；“完全访问”不会自动降级成本地执行。网络固定拒绝，包括宿主回环。文件操作还校验规范化目标和 junction/符号链接。Linux 的私有临时层写入不等于宿主可写，文件 API 会拒绝未授权的此类操作。

Windows 还会显式开放运行所需目录的只读访问，包括 Node、助手和整个 `SystemRoot`，并非仅 System32。因此 Windows 目录中的文件可能可读；编码异常不能作为拒绝访问的证据。原有 ASCII 对照只确认普通 ACL 的项目外金丝雀被拒绝；新增复核发现，带 `ALL APPLICATION PACKAGES` 只读 ACL 的项目外金丝雀可被文件工具和终端读取。

本次 factory 调整后定向回归 30 项通过、0 跳过，覆盖缺省档位、不同项目路径、只读与可写、Spring 配置、执行快照及原生终端/文件操作。证据见 `.run/mxc-factory-tests/verification.log`。独立源码副本中的三项非等价变异均被回归拦截：将只读变成可写、移除完全访问拦截、恢复项目只读与可写重叠；最后一项重现原生启动错误。记录见同目录 `mutation-results.json`，业务工作树未受变异影响。

框架运行对象保留在 workflow 接入，工作区业务只依赖 SandboxService；没有新增框架工作区缓存或回收器。

## 工具兼容结论

- **CMD：** Windows 默认终端；已验证目录、命令、退出码和中文输出。无控制台时 chcp 不可靠，运行环境按系统 OEM 代码页报告终端编码，UTF-8 区域设置的 cp65001 映射为 UTF-8。外部工具采用其他输出编码时需显式匹配。
- **Node：** 默认提供 preserve-symlinks-main 与 preserve-symlinks，避开入口解析对盘根的依赖。文件助手不接受命令环境中的预加载选项。尚不能据此认定任意 npm 项目构建兼容。
- **PowerShell：** 最小授权下可能无法初始化项目位置，Set-Location 也受限；不能把直接启动成功当作相对路径命令可用。因此当前默认使用 CMD。
- **Maven：** 3.9.16 初始化时真实路径解析失败，递归访问祖先直到空父路径，再被日志未初始化的异常遮盖。不能通过开放整个盘符读取来修复。
- **Maven 可行性实验：** 在独立实验入口中对上述已知初始化失败使用规范化绝对路径作为 CLI 元数据，原版 -version 失败、实验版 -version 和最小 POM 离线 validate 均通过，同时项目外金丝雀读取被拒绝。没有修改已安装 Maven，也没有把该实验入口纳入产品。
- **后续处理：** 优先使用经过实际能力探测的祖先目录仅枚举授权；本机尚不支持。另一条路线是工具上游修复或部署专用 Maven 启动器，需要补齐 -f、多模块、符号链接、插件及真实构建回归。不会自动降低隔离等级。

原生 Windows 使用 Node 初始化所需的 UI 兼容配置，仍禁用剪贴板及输入注入；本次未验证 Win32k 系统调用封锁。更详细的源码分析与实验位置见[框架报告](/D:/Code/starter/lingxi-harness-agent/docs/mxc-native-platform-validation.md)。

## 验证与运行后端

- Windows 全模块 Maven 构建通过；原生适配集成 **8 项通过**。
- Linux 原生 Java 回归通过；MXC 模块 **18 项，16 通过、2 跳过**，跳过项为未配置真实构建和宿主监听参数的用例。Linux 验证宿主使用现有 Ubuntu 环境，不代表产品仍有 Windows 到 Linux 的路由。
- 本轮业务定向 **22 项全部通过**：策略转换、Spring 配置、真实原生沙箱集成、快照 JSON 和分层检查；新增断言确认能力检查不会创建配置的状态目录。
- 桌面脚本 **6 项通过**；TypeScript/Vite 构建及后端 JAR 打包通过。
- 只读权限及桌面平台选择做过非等价变异，预期回归变红，正常实现通过。
- 当前后端：`http://127.0.0.1:18088`，独立数据库及沙箱状态位于 `D:/LingXiMxcNativeValidation`。未操作原 8088 服务，原先的 Linux 传输验证进程已停止。
- 运行 JAR、进程信息和证据在 `.run/mxc-native-adaptation/`，包括 `business-tests.log`、`desktop-tests.log`、`frontend-build.log`、`backend-package.log`、`http-check.json` 以及后端 stdout/stderr。

轻量检查版本的运行包、进程与记录位于 `.run/mxc-health-adaptation/`。Windows 和 Linux 的轻量探测各 2 项通过；将业务检查恢复成旧目录探针后，“状态目录不能被创建”断言按预期失败。前端构建通过。
本机 HTTP 连续 5 次检查为 377、282、316、335、307ms，均返回基础能力可用；期间沙箱状态目录清单及文件修改时间未变化。该测量不包含 JVM 冷启动，也不代表项目执行就绪。

全新的 `final-build` 目录执行 21 项定向测试与打包，见 `verified-package-final.log`；补充代码页修复后再次验证真实集成并强制生成薄 JAR，见 `final-artifact-package.log`。不能依赖 Spring Boot 对已有重打包 JAR 自动刷新本地同版本依赖。`artifact-audit.json` 核对运行包内新模块与已验证框架 JAR 的字节一致，并检查旧模块不存在。

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:18088/sandbox/service/check
```

本次未验证 Windows 真实项目完整构建、完整模型对话或完整 Electron 安装包。之前 Windows 到 Linux 的工作树耗时不能用于评价当前原生实现。
