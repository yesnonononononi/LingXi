/**
 * 后端全部固定工具名的唯一真源（前端枚举）。
 *
 * <p>契约来源（改名时两边一起改）：</p>
 * <ul>
 *   <li>业务常量 {@code com.summit.dp.shared.model.ToolCatalog}：call_sub_agent / create_plan /
 *       send_mail_to_agent / peek_teammate_state / execute_command / read_file / edit_file / search_tool / list_mcp_tools；</li>
 *   <li>各 {@code ToolDefinition} 注册名：{@code FileToolConfiguration}（read_file / edit_file）、
 *       {@code CommandToolConfiguration}（终端工具属性）、{@code ToolConfig}（require_choice）；</li>
 *   <li>框架内核工具：{@code search_tool} / {@code list_mcp_tools}（harness-kernel-tools）、
 *       {@code compact_context}（上下文压缩）、{@code read_skill}（Skill 正文读取）。</li>
 * </ul>
 *
 * <p>前端任何地方都引用这里的成员，不写工具名字面量 —— 名字改动时只改这里，编译器替你找出全部引用点。
 * MCP 工具名是远端下发的动态集合，不入此枚举；线上名为 {@code mcp_<服务名>_<原生名>}
 * （服务名由后端 McpManager 拼进前缀，展示层解析成「服务名 原生名」）。</p>
 *
 * <p>实现用 {@code as const} 对象 + 派生联合类型，而不是 {@code enum}：
 * 前端 tsconfig 开了 {@code erasableSyntaxOnly}，enum 语法直接编译不过。</p>
 */
export const AgentToolName = {
  /** 读文件（可带 1 基的 startLine / endLine 行范围，输出行号: 行内容） */
  ReadFile: 'read_file',
  /** 按内容检索工作区文件（只读，不经终端） */
  SearchFiles: 'search_files',
  /** 项目记忆 wiki */
  LoadMemory: 'load_memory',
  /** 搜索项目 wiki */
  SearchWiki: 'search_wiki',
  /** 读取工作区图片 */
  ReadImage: 'read_image',
  GenerateImage: 'generate_image',
  /** 编辑文件（按锚点局部改动，结果携带 plusLines / minusLines） */
  EditFile: 'edit_file',
  /** 整文件写入（新建 / 全文替换 / 头插 / 追加，不需要锚点） */
  WriteFile: 'write_file',
  /** 删除单个文件（目录一律拒绝） */
  DeleteFile: 'delete_file',
  /** 终端命令 */
  ExecuteCommand: 'execute_command',
  /** 后台命令的查询与停止 */
  ManageCommand: 'manage_command',
  /** 人工选择（PROMISE 卡片） */
  RequireChoice: 'require_choice',
  /** 计划书（PROMISE 卡片） */
  CreatePlan: 'create_plan',
  /** 执行清单：创建（多步任务的待办清单，不是审批计划书） */
  CreateChecklist: 'create_checklist',
  /** 按需查看当前会话完整执行清单 */
  GetCurrentChecklist: 'get_current_checklist',
  /** 按标识审计任意状态（含已软删）的清单历史 */
  GetChecklist: 'get_checklist',
  /** 执行清单：推进单个步骤到终态（完成 / 失败 / 跳过） */
  UpdateChecklistStep: 'update_checklist_step',
  /** 执行清单：修改标题与步骤结构 */
  ModifyChecklist: 'modify_checklist',
  /** 执行清单：软删 */
  DeleteChecklist: 'delete_checklist',
  /** 委派子代理 */
  CallSubAgent: 'call_sub_agent',
  /** Agent 间邮件 */
  SendMailToAgent: 'send_mail_to_agent',
  /** 查看队员运行状态（只读观测，不唤醒） */
  PeekTeammateState: 'peek_teammate_state',
  /** 上下文压缩 */
  CompactContext: 'compact_context',
  /** 工具检索（渐进披露第二级） */
  SearchTool: 'search_tool',
  /** MCP 工具清单（渐进披露第一级） */
  ListMcpTools: 'list_mcp_tools',
  /** MCP 调用网关：远端工具不单独出现在工具表里，模型经它转发调用 */
  CallMcpTool: 'call_mcp_tool',
  /** Skill 正文读取（入口路径由框架的 Skill 提示词下发） */
  ReadSkill: 'read_skill',
} as const;

/** 后端固定工具名的联合类型（即上面任一键的值）。 */
export type AgentToolName = typeof AgentToolName[keyof typeof AgentToolName];
