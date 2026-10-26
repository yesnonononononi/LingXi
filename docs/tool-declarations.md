# 工具声明方式

每个工具只维护一份权威定义。固定契约放在执行器的 `@Tool` 上，由 Spring 管理执行器；依赖配置生成的契约继续用 `@Bean ToolDefinition`。同 ID 的显式定义 Bean 优先于注解，不能用不同 ID 覆盖同名工具。

| 工具 | 声明方式 | 理由 |
| --- | --- | --- |
| `execute_command`、`manage_command` | 执行器注解 | 名称、schema、输出上限和工具超时固定；终端运行属性仍通过构造器注入。 |
| `read_file`、`edit_file`、`read_image` | 执行器注解 | 文件与图像契约固定；共享记录、缓存和图像依赖继续由容器装配。 |
| `require_choice`、`create_plan` | 执行器注解 | 声明与执行行为一起变化，无配置插值。 |
| `call_sub_agent`、`peek_teammate_state`、`send_mail_to_agent` | 执行器注解 | 协作契约固定，团队与执行身份来自每次工具调用。 |
| `web_search` | 配置 Bean | schema 中的最大结果数来自 `WebSearchToolProperties`，需保留配置生成过程。 |
| 框架 `search_tool` | 条件自动配置 | 有启用开关、超时和匹配上限配置，并需延迟获取注册表以避免循环依赖。 |
| 框架 `list_mcp_tools` | 条件自动配置 | 有启用开关、超时与窗口配置，需支持按 Bean 名替换。 |
| 框架 `read_skill` | 条件自动配置 | 启用开关、输出上限和超时来自配置，需保留校验与替换规则。 |
| 框架 `compact_context` | 条件自动配置 | 工具可禁用，但同一压缩器还承担循环内部压缩职责，不能因执行器存在就自动暴露工具。 |
| 远端 `mcp_*` | 请求级动态定义 | 名称和 schema 由远端发现，每次请求隔离，不能进入全局静态注册表。 |

复杂 schema 使用 `parametersJsonSchema` 原样声明，保留数组、枚举、默认值与约束；不得与 `props`、`others` 同时声明。

启动时先收集显式定义，再注册注解工具，最后校验完整注册表。`StaticToolDeclarationContractTest` 用迁移前的独立快照核对十个工具的契约；`ApplicationContextAssemblyTest` 验证实际装配与 codec 转换。
