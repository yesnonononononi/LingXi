# `execute_command` 的 `shell` 参数

`execute_command` 支持可选参数 `shell`，用来指定本次命令由哪个解释器执行。

## 取值

| 平台 | 可选值 | 默认 |
|---|---|---|
| Windows | `cmd`、`pwsh`、`powershell` | `cmd` |
| Linux | `bash`、`sh`、`pwsh` | `bash` |

- 省略 `shell` 时使用工作空间默认解释器。
- 传入当前平台不支持的值（例如 Windows 上的 `bash`）会直接失败，错误信息里带上允许的取值。**不会**静默换成另一个解释器。
- 解释器缺失或沙箱策略拒绝时同样明确失败，不会绕回 CMD 包装。

## 一次解析，全程一致

「用哪个 shell 执行」只在 `CommandShell.resolve` 里解析一次，参数校验、安全检查（`CommandGuard`）、审批快照、审批恢复和真正的进程启动都使用同一个结果。

- 审批卡里的 `shell` 记录的是**本次实际要用的**解释器，不是工作空间默认值。
- 恢复执行时用快照里的参数重新解析并比对：不一致即「命令执行环境已变化，请重新发起审批」，绝不换成默认 shell 放行。
- 快照里的 `shell` 是小写 id（`cmd` / `pwsh` / `bash`…）。历史快照记录的是枚举名（`CMD` / `BASH`），比较不区分大小写，旧卡仍然可用。

## 启动参数由框架构造

业务侧只传原始脚本文本，不拼 `-Command` / `/c` / `-c` 之类的启动参数：

- `ShellType` 负责把脚本变成 argv；本地执行与 MXC 沙箱共用同一份 argv，沙箱启动器只负责在沙箱内解析 `argv[0]` 的真实路径。
- `pwd`、引号、管道、多行脚本都按原样交给解释器，框架不做分词。

## 输出编码

宿主统一按 UTF-8 解码，各解释器在启动时自行把输出切到 UTF-8：

- CMD：`chcp 65001>nul & ` 前置在脚本前（输出代码页是进程级状态，必须在同一个 cmd 里切）。
- PowerShell / pwsh：脚本前拼 `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)` 再用 `-EncodedCommand` 传入（顺便避免 Windows 命令行解析吃掉脚本引号）。
- bash / sh：环境已由调用方约定为 UTF-8。

截断按 char 预算，不会切断多字节字符，也不会在 emoji 的代理对中间切开。

## 已知限制：CMD 的命令行文本不能承载非 ASCII

`cmd.exe` 用系统 OEM 代码页解析自己的命令行，非 ASCII 字符会在执行前就被破坏（实测：`echo 中文😀` 输出为 `??????`，而读取同一个 UTF-8 文件的 `type file` 完全正常）。

因此：

- CMD 下需要输出中文/emoji 时，让**程序或文件**产出这些字符，而不是把字面量写进命令文本。
- 命令文本本身需要非 ASCII 时，用 `shell: "powershell"` 或 `shell: "pwsh"`——它们的脚本经 base64 传递，不受命令行代码页影响。

`ShellInterpreterEncodingTest` 覆盖了三种解释器的中文、emoji、标准错误与截断行为。
