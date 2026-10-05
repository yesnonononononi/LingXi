/**
 * 后端全部固定工具名的唯一真源（前端枚举）。
 *
 * <p>契约来源（改名时两边一起改）：</p>
 * <ul>
 *   <li>业务常量 {@code com.summit.dp.shared.model.ToolCatalog}：call_sub_agent / create_plan /
 *       send_mail_to_agent / execute_command / read_file / edit_file / web_search / search_tool / list_mcp_tools；</li>
 *   <li>各 {@code ToolDefinition} 注册名：{@code FileToolConfiguration}（read_file / edit_file）、
 *       {@code CommonToolConfiguration}（execute_command / web_search）、{@code ToolConfig}（require_choice）；</li>
 *   <li>框架内核工具：{@code search_tool} / {@code list_mcp_tools}（harness-kernel-tools）、
 *       {@code compact_context}（上下文压缩）。</li>
 * </ul>
 *
 * <p>前端任何地方都引用这里的成员，不写工具名字面量 —— 名字改动时只改这里，编译器替你找出全部引用点。
 * MCP 工具名是远端下发的动态集合（{@code mcp_} 前缀），不在此枚举内。</p>
 *
 * <p>实现用 {@code as const} 对象 + 派生联合类型，而不是 {@code enum}：
 * 前端 tsconfig 开了 {@code erasableSyntaxOnly}，enum 语法直接编译不过。</p>
 */
export const AgentToolName = {
  /** 读文件（可带 startLine / endLine 行范围） */
  ReadFile: 'read_file',
  /** 编辑文件（结果携带 plusLines / minusLines） */
  EditFile: 'edit_file',
  /** 终端命令 */
  ExecuteCommand: 'execute_command',
  /** 联网检索 */
  WebSearch: 'web_search',
  /** 人工选择（PROMISE 卡片） */
  RequireChoice: 'require_choice',
  /** 计划书（PROMISE 卡片） */
  CreatePlan: 'create_plan',
  /** 委派子代理 */
  CallSubAgent: 'call_sub_agent',
  /** Agent 间邮件 */
  SendMailToAgent: 'send_mail_to_agent',
  /** 上下文压缩 */
  CompactContext: 'compact_context',
  /** 工具检索（渐进披露第二级） */
  SearchTool: 'search_tool',
  /** MCP 工具清单（渐进披露第一级） */
  ListMcpTools: 'list_mcp_tools',
} as const;

/** 后端固定工具名的联合类型（即上面任一键的值）。 */
export type AgentToolName = typeof AgentToolName[keyof typeof AgentToolName];
