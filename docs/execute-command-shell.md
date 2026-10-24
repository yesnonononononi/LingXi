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

## 已知限制：CMD 内置命令输出非 ASCII 会失真

命令文本本身**没有**损坏：cmd 通过 CreateProcessW 以 UTF-16 把命令行交给子进程。实测同一条命令里让 node 回显收到的参数，码点是 `4e2d,6587,1f600`，即完整的 `中文😀`。

失真发生在 cmd 的**内置命令**（`echo` 等）：它们按启动时解析出的 ANSI/OEM 字节输出，而不是按当前代码页。同一台机器的实测：

| 命令 | 输出码点 | 结论 |
| --- | --- | --- |
| `echo 中文😀` | `fffd fffd fffd fffd 3f 3f` | 中文按 GBK 编码、emoji 变成 `?` |
| `chcp 65001>nul & echo 中文😀` | 同上 | 同一 cmd 里 chcp 对内置命令无效 |
| `chcp 65001>nul & node -e ...` | `4e2d,6587,1f600` | 外部程序完全不受影响 |

`chcp` 本身是生效的（`chcp 65001>nul & chcp` 打印 `Active code page: 65001`），差别只在于内置命令不读它。

因此：

- 框架前置的 `chcp 65001` 是为**按控制台代码页输出字节的程序**（git、node、各类 CLI）准备的，不是给 `echo` 用的。
- 需要输出中文/emoji 时让程序或文件产出这些字符，不要依赖 `echo` 之类内置命令。
- 脚本里需要非 ASCII 字面量时用 `shell: "powershell"` 或 `"pwsh"`——脚本经 base64 传递，输出编码也在脚本内显式设定。

`ShellInterpreterEncodingTest` 用三条独立路径钉住上述结论：`type` 读 UTF-8 文件、`node` 回显参数码点、PowerShell/pwsh 的 `[Console]::Write`。
