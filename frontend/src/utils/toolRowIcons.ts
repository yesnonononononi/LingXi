/**
 * 工具行类型图标的唯一真源：先按具体工具取图标，其余按分类码兜底。
 *
 * <p>判别（本文件）与绘制（`components/chat/process/ToolRowIcon.vue`）分开：判别是纯函数，
 * 才能在不编译 SFC 的用例里锁住「哪个工具画哪个图标」。</p>
 */
import {AgentToolName} from './toolNames';
import {TOOL_CATEGORY} from './toolMeta';

/** 图标种类（稳定判别码，不是展示文案）。 */
export const TOOL_ROW_ICON = {
  /** 检索：检索文件内容 / 网页搜索 / 检索工具 / 检索记忆 */
  FILE_SEARCH: 'FILE_SEARCH',
  /** 文档：读文件 / 读图 / 读技能 */
  FILE_DOC: 'FILE_DOC',
  /** 文档 + 笔：编辑文件（按锚点局部改动） */
  FILE_EDIT: 'FILE_EDIT',
  /** 文档 + 铅笔：整文件写入 */
  FILE_WRITE: 'FILE_WRITE',
  /** 垃圾桶：删除文件（破坏性动作必须一眼可辨） */
  FILE_DELETE: 'FILE_DELETE',
  /** 读取记忆 */
  MEMORY_READ: 'MEMORY_READ',
  /** 生成图片 */
  IMAGE_GENERATE: 'IMAGE_GENERATE',
  /** 信封：Agent 间邮件 */
  MAIL: 'MAIL',
  /** 清单：执行清单六件套 + MCP 工具清单 */
  CHECKLIST: 'CHECKLIST',
  /** 计划书：日历 + 勾 */
  PLAN: 'PLAN',
  /** 人工选择：问号圈 */
  CHOICE: 'CHOICE',
  /** 委派子代理：人 + 加号 */
  SUB_AGENT: 'SUB_AGENT',
  /** 查看队员状态：眼睛（只读观测） */
  PEEK: 'PEEK',
  /** 上下文压缩 */
  COMPACT: 'COMPACT',
  /** 终端：前台命令 */
  COMMAND: 'COMMAND',
  /** 后台任务查询 / 停止 */
  MANAGE_COMMAND: 'MANAGE_COMMAND',
  /** 思考 */
  THINK: 'THINK',
  /** 兜底齿轮：只给真正未知的工具 */
  DEFAULT: 'DEFAULT',
} as const;

/**
 * 按具体工具指定图标。
 *
 * <p>只有「同一分类里出现两种以上图标」时才需要在这里点明：检索与写入两个分类各自内部
 * 动作差别很大（搜文件 vs 搜记忆、写 vs 改 vs 删），靠分类码根本分不出来。</p>
 */
const TOOL_ICON_BY_NAME: Partial<Record<AgentToolName, string>> = {
  [AgentToolName.SearchFiles]: TOOL_ROW_ICON.FILE_SEARCH,
  // 网页搜索沿用检索图标：都是「按条件找东西」
  [AgentToolName.WebSearch]: TOOL_ROW_ICON.FILE_SEARCH,
  [AgentToolName.SearchTool]: TOOL_ROW_ICON.FILE_SEARCH,
  [AgentToolName.SearchWiki]: TOOL_ROW_ICON.FILE_SEARCH,
  [AgentToolName.WriteFile]: TOOL_ROW_ICON.FILE_WRITE,
  [AgentToolName.EditFile]: TOOL_ROW_ICON.FILE_EDIT,
  [AgentToolName.DeleteFile]: TOOL_ROW_ICON.FILE_DELETE,
  [AgentToolName.LoadMemory]: TOOL_ROW_ICON.MEMORY_READ,
  [AgentToolName.GenerateImage]: TOOL_ROW_ICON.IMAGE_GENERATE,
  [AgentToolName.ManageCommand]: TOOL_ROW_ICON.MANAGE_COMMAND,
};

/** 分类兜底：一个分类一种图标的都在这里，具体工具的差异由上面的名称表先接走。 */
const TOOL_ICON_BY_CATEGORY: Record<string, string> = {
  [TOOL_CATEGORY.READ]: TOOL_ROW_ICON.FILE_DOC,
  [TOOL_CATEGORY.WRITE]: TOOL_ROW_ICON.FILE_DOC,
  [TOOL_CATEGORY.SKILL]: TOOL_ROW_ICON.FILE_DOC,
  [TOOL_CATEGORY.COMMAND]: TOOL_ROW_ICON.COMMAND,
  [TOOL_CATEGORY.THINK]: TOOL_ROW_ICON.THINK,
  [TOOL_CATEGORY.CHECKLIST]: TOOL_ROW_ICON.CHECKLIST,
  // MCP 工具清单也是一串条目，与执行清单同图（用户指定）
  [TOOL_CATEGORY.MCP_LIST]: TOOL_ROW_ICON.CHECKLIST,
  [TOOL_CATEGORY.MAIL]: TOOL_ROW_ICON.MAIL,
  [TOOL_CATEGORY.PLAN]: TOOL_ROW_ICON.PLAN,
  [TOOL_CATEGORY.CHOICE]: TOOL_ROW_ICON.CHOICE,
  [TOOL_CATEGORY.SUB_AGENT]: TOOL_ROW_ICON.SUB_AGENT,
  [TOOL_CATEGORY.PEEK]: TOOL_ROW_ICON.PEEK,
  [TOOL_CATEGORY.COMPACT]: TOOL_ROW_ICON.COMPACT,
};

/** 解析工具行的图标种类；名称命中优先于分类，未知工具落兜底齿轮。 */
export function resolveToolRowIcon(toolName?: string | null, category?: string | null): string {
  const byName = TOOL_ICON_BY_NAME[(toolName ?? '') as AgentToolName];
  if (byName) return byName;
  return TOOL_ICON_BY_CATEGORY[category ?? ''] ?? TOOL_ROW_ICON.DEFAULT;
}
