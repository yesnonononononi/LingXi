# 工具声明方式

每个工具只维护一份权威定义。固定契约放在执行器的 `@Tool` 上，由 Spring 管理执行器；依赖配置生成的契约继续用 `@Bean ToolDefinition`。同 ID 的显式定义 Bean 优先于注解，不能用不同 ID 覆盖同名工具。

| 工具 | 声明方式 | 理由 |
| --- | --- | --- |
| `execute_command`、`manage_command` | 执行器注解 | 名称、schema、输出上限和工具超时固定；终端运行属性仍通过构造器注入。 |
| `read_file`、`edit_file`、`write_file`、`read_image` | 执行器注解 | 文件与图像契约固定；共享记录、缓存和图像依赖继续由容器装配。 |
| `require_choice`、`create_plan` | 执行器注解 | 声明与执行行为一起变化，无配置插值。 |
| `create_checklist`、`update_checklist_step`、`delete_checklist` | 执行器注解 | 参数是扁平标量/标量数组，契约固定；会话归属与 Agent 身份来自每次工具调用。 |
| `modify_checklist` | 执行器注解 + `parametersJsonSchema` | 补丁参数是「对象数组 + 嵌套对象」，注解只表达标量与标量数组，必须写显式 schema。 |
| `call_sub_agent`、`peek_teammate_state`、`send_mail_to_agent` | 执行器注解 | 协作契约固定，团队与执行身份来自每次工具调用。 |
| 框架 `search_tool` | 条件自动配置 | 有启用开关、超时和匹配上限配置，并需延迟获取注册表以避免循环依赖。 |
| 框架 `list_mcp_tools` | 条件自动配置 | 有启用开关、超时与窗口配置，需支持按 Bean 名替换。 |
| 框架 `read_skill` | 条件自动配置 | 启用开关、输出上限和超时来自配置，需保留校验与替换规则。 |
| 框架 `compact_context` | 条件自动配置 | 工具可禁用，但同一压缩器还承担循环内部压缩职责，不能因执行器存在就自动暴露工具。 |
| 框架 `call_mcp_tool` | 条件自动配置 | 远端工具的唯一调用入口：静态 schema 固定，`SERIAL_MUTATION` 让批里不并发；属内核工具，框架默认注册并恒准入。 |

框架内核工具（`search_tool`、`list_mcp_tools`、`call_mcp_tool`、`read_skill`、`compact_context`）由框架默认注册到工具表并恒准入，业务侧**不再写进 `toolList`**：跑循环就需要压缩、检索、调用与读技能，靠调用方逐个记住只会静默丢功能。要关掉某个内核工具，用它自己的 `lingxi.agent.runtime.tool.*.enabled` 开关。

MCP 远端工具**从不进入模型工具表**：`list_mcp_tools` 列清单、`search_tool` 取 schema、`call_mcp_tool` 转发调用，三级各是一个静态名字，谁都不隐含谁。工具表因此跨轮不变，提供方的前缀缓存与 thinking 签名不会因「查了一个工具」而失效；代价是远端 schema 只活在检索结果里，历史被剪掉后模型要重新查一次。

十三个固定工具使用 `parameters = @ObjectValue(...)`：根节点固定为 object，属性通过 `ValueType` 选择标量或标量数组，必填项在根节点统一声明。约束只填写到对应类型中；`OptionalBoolean.UNSET` 表示省略，`FALSE` 表示显式 false。

嵌套对象、嵌套数组等复杂 schema 继续使用 `parametersJsonSchema`；不得与结构化约束混用。`@Tool` 不再提供旧的 `props`、`others`、`type` 属性。当前唯一使用该形式的是 `modify_checklist`：它的补丁是「对象数组 + 嵌套对象」，注解无法表达。

启动时先收集显式定义，再注册注解工具，最后校验完整注册表。`StaticToolDeclarationContractTest` 用迁移前的独立快照核对十个工具的契约；`ApplicationContextAssemblyTest` 验证实际装配与 codec 转换；`ChecklistToolSchemaTest` 让四个清单工具过同一个门禁。

## 执行清单（checklist）与审批计划（plan）的边界

`create_plan` 会把计划书交给用户审批，产生审批卡片并让执行停下等待；本清单<b>不产生审批卡片、不阻塞任何执行</b>，它只是 Agent 自己维护的待办事实，用来在收尾时回答「还剩哪几步没做」。两者可以在同一任务里分别使用，没有互斥关系；清单也不能替代审批或绕过业务前置条件。

使用时机：多步任务才建清单，单步任务不要建（建了只会白占「每会话一份 ACTIVE」的额度）。清单只在具备 `update_checklist_step` 的执行里参与收尾提醒；没有这个工具的执行不会消费提醒额度。

提醒按执行与进展版本关联，只有执行检查点中的服务端标记和对应提醒消息都存在，才能认定该执行已经收到提醒。未确认投递时重放；其他执行仍在运行或挂起时不接管。步骤实际推进后清空数据库中的提醒归属，重复提交相同终态不增加进展。

