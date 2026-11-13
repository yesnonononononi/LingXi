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
  /** 文档 + 放大镜：检索文件内容与网页搜索共用 */
  FILE_SEARCH: 'FILE_SEARCH',
  /** 文档：其余读写类工具 */
  FILE_DOC: 'FILE_DOC',
  /** 垃圾桶：删除文件（破坏性动作必须一眼可辨） */
  FILE_DELETE: 'FILE_DELETE',
  /** 文档 + 铅笔：整文件写入 */
  FILE_WRITE: 'FILE_WRITE',
  /** 信封：Agent 间邮件 */
  MAIL: 'MAIL',
  /** 清单：执行清单六件套 */
  CHECKLIST: 'CHECKLIST',
  /** 终端 */
  COMMAND: 'COMMAND',
  /** 思考 */
  THINK: 'THINK',
  /** 兜底齿轮 */
  DEFAULT: 'DEFAULT',
} as const;

/** 按具体工具指定图标：同分类里动作语义不同的几个必须单独指认。 */
const TOOL_ICON_BY_NAME: Partial<Record<AgentToolName, string>> = {
  [AgentToolName.SearchFiles]: TOOL_ROW_ICON.FILE_SEARCH,
  // 网页搜索沿用「检索文件」的图标：两者都是「按条件找东西」
  [AgentToolName.WebSearch]: TOOL_ROW_ICON.FILE_SEARCH,
  [AgentToolName.WriteFile]: TOOL_ROW_ICON.FILE_WRITE,
  [AgentToolName.DeleteFile]: TOOL_ROW_ICON.FILE_DELETE,
};

/** 分类兜底：写入与读取共用文档图标，具体工具的差异由上面的名称表先接走。 */
const TOOL_ICON_BY_CATEGORY: Record<string, string> = {
  [TOOL_CATEGORY.READ]: TOOL_ROW_ICON.FILE_DOC,
  [TOOL_CATEGORY.WRITE]: TOOL_ROW_ICON.FILE_DOC,
  [TOOL_CATEGORY.COMMAND]: TOOL_ROW_ICON.COMMAND,
  [TOOL_CATEGORY.THINK]: TOOL_ROW_ICON.THINK,
  [TOOL_CATEGORY.CHECKLIST]: TOOL_ROW_ICON.CHECKLIST,
  [TOOL_CATEGORY.MAIL]: TOOL_ROW_ICON.MAIL,
};

/** 解析工具行的图标种类；名称命中优先于分类，未知工具落兜底齿轮。 */
export function resolveToolRowIcon(toolName?: string | null, category?: string | null): string {
  const byName = TOOL_ICON_BY_NAME[(toolName ?? '') as AgentToolName];
  if (byName) return byName;
  return TOOL_ICON_BY_CATEGORY[category ?? ''] ?? TOOL_ROW_ICON.DEFAULT;
}
