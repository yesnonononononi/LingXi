# Windows MXC 读取边界复核

2026-10-15，SDK 1.0.0，本机 Windows BaseContainer。**当前接入不能作为严格的文件读取白名单验收；本次是缺口复现，没有完成修复。**

## 已验证的边界

使用独立工作区和新建的纯 ASCII 金丝雀，分别通过当前 Windows launcher 的文件读取操作和终端 `type` 读取。没有读取真实凭据、私人文档或浏览器数据。

| 金丝雀位置 | 普通新建文件 ACL | 仅给测试目录增加 ALL APPLICATION PACKAGES 只读 ACL |
| --- | --- | --- |
| 工作区内 | 两种方式均可读 | 保留为正对照 |
| D 盘未授权目录 | 两种方式均失败 | 两种方式均可读 |
| 用户配置根目录下的独立测试目录 | 两种方式均失败 | 两种方式均可读 |
| 用户临时目录下的独立测试目录 | 两种方式均失败 | 两种方式均可读 |
| ProgramData 下的独立测试目录 | 两种方式均失败 | 两种方式均可读 |
| Public 下的独立测试目录 | 两种方式均失败 | 两种方式均可读 |

因此不能说“所有用户文件都可读”，但已经可以否定“未在策略中授权的文件一定不可读”。现有宿主通用应用包 ACL 能扩大当前沙箱的读取范围。之前只测普通 ACL 的项目外金丝雀，遗漏了这种授权来源。

## 配置和官方支持边界

当前 launcher 的只读清单显式包含整个 `SystemRoot`，本机为 `C:\Windows`，并非只包含 System32。因此 Windows 根目录、其下 .NET 配置和日志可能可读；这与项目外其他路径的环境 ACL 问题需要分别判断。

`USERPROFILE`、`HOME` 等环境变量指向工作区只会影响程序查找默认位置，不会隐藏绝对路径，也不会匿名化允许读取的系统日志。日志包含宿主用户名并不能单独证明该用户的私人目录可读。

独立副本增加 `processContainer.leastPrivilege=true` 后，精确探测拒绝执行，错误为 `DACL fallback required but fallback.allowDaclMutation is false`；该实验没有运行成功，不能视为修复。

官方固定版本说明明确指出：PSEC 不能表达 `leastPrivilege`，请求会继续选择 AppContainer 回退；源码同样以不支持 LPAC token 为由拒绝此组合。参见[系统支持说明](https://github.com/microsoft/mxc/blob/v1.0.0/docs/backends/process-container/os-version-support.md)和[BaseContainer 源码](https://github.com/microsoft/mxc/blob/v1.0.0/src/mxc-sdk/src/backends/process_container/common/base_container_runner.rs)。没有开启 DACL 回退，也没有改变平台路由。

## 回归与结论

新增 `SandboxAmbientReadBoundaryTest`：仅给测试自身创建的独立目录增加通用应用包只读 ACL，其中只放测试 ASCII 文件；先验证项目内正对照可读、普通项目外文件被拒绝，再要求文件工具和终端都拒绝带该 ACL 的未授权文件。当前实现无法满足最后两条断言；应保持暴露该缺口，不能把原有定向测试通过当成读取隔离验收通过。

复现记录在 `.run/mxc-read-audit/`：`audit-results.json`、`ambient-acl-results.json`、`business-security-regression.log`。原有 30 项只证明当时覆盖的路径和权限组合。文件占用、权限拒绝、目标不存在和解码失败也必须分别判断，不能互相替代。

后续需要重新选择能满足读取边界的 Windows 隔离策略，或明确调整产品承诺。仅维护敏感路径黑名单、改环境变量、或为文件工具增加路径检查，都不能覆盖任意终端命令的宿主读取。完成前，不应以当前 Windows 模式执行依赖严格宿主读取隔离的不可信任务。
