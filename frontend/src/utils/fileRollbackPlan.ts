/**
 * 回滚预览的纯投影：后端给的计划 → 弹窗要显示的分组与默认勾选。
 *
 * <p>为什么单独成模块：三组的划分、默认勾选、以及「全被跳过时不能给确认按钮」都是有对错的判断，
 * 写进 `.vue` 就只能靠点界面来验。后端只给事实，这里只做投影，不重算任何门禁。</p>
 */
import type {FileRollbackItem, FileRollbackPlan} from '../services/fileRollback';

export interface FileRollbackGroups {
  /** 会用基线覆盖回去的文件。 */
  restore: FileRollbackItem[];
  /** 执行期间新建、回滚即删除的文件。 */
  remove: FileRollbackItem[];
  /** 不动的文件，附后端给的原因。 */
  skipped: FileRollbackItem[];
  /** 默认勾选：能执行的全选，跳过的一条都不选（跳过是结论，不是选项）。 */
  defaultSelection: string[];
}

/**
 * 分组 + 默认勾选。
 *
 * <p>按 `action` 分而不是按「有没有 reason」分：reason 只表达原因，action 才是契约。</p>
 */
export function groupRollbackPlan(plan?: FileRollbackPlan | null): FileRollbackGroups {
  const items = plan?.items ?? [];
  const restore: FileRollbackItem[] = [];
  const remove: FileRollbackItem[] = [];
  const skipped: FileRollbackItem[] = [];
  for (const item of items) {
    if (item.action === 'RESTORE') restore.push(item);
    else if (item.action === 'DELETE') remove.push(item);
    else skipped.push(item);
  }
  return {
    restore,
    remove,
    skipped,
    defaultSelection: [...restore, ...remove].map(item => item.filePath)
  };
}

/**
 * 拿「本轮改动」各行共同的执行标识。
 *
 * <p>卡片是按轮次渲染的，而回滚按执行生效；只有当这一轮的所有行都属于同一个执行时才给入口。
 * 出现多个执行标识说明数据本身异常，此时**不猜**：宁可不给按钮，也不要回滚到别人的执行上。</p>
 */
export function resolveRollbackExecutionId(executionIds: Array<string | undefined | null>): string | null {
  const distinct = new Set<string>();
  for (const id of executionIds) {
    if (id === undefined || id === null || id === '') continue;
    distinct.add(String(id));
  }
  return distinct.size === 1 ? [...distinct][0] : null;
}
