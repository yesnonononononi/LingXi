import {nextTick, ref, type Ref} from 'vue';

/**
 * 单值「就地重命名」编辑态：双击进入，Enter / 失焦提交，Esc 取消。
 *
 * <p>提交目标是**进入编辑那一刻**的快照：编辑期间用户切了会话或换了条目，
 * 失焦提交也不会写到新目标上。写入动作由调用方持有（唯一写入路径），本模块只管编辑态。</p>
 */
export interface InlineRenameOptions<T> {
  /** 进入编辑时的初值。 */
  readValue: () => string;
  /** 提交目标；返回 null 表示当前没有可改对象。 */
  readTarget: () => T | null;
  /** 真正写入。 */
  commit: (value: string, target: T) => void | Promise<void>;
  /** 是否允许进入编辑；省略即恒可编辑。 */
  canEdit?: () => boolean;
  /** 输入框元素引用：模板用字符串 ref 绑定时由调用方注入，省略则内部自建。 */
  inputRef?: Ref<HTMLInputElement | null>;
}

export interface InlineRename {
  editing: Ref<boolean>;
  draft: Ref<string>;
  inputRef: Ref<HTMLInputElement | null>;
  start: () => void;
  commitEdit: () => void;
  cancel: () => void;
  handleKeydown: (event: KeyboardEvent) => void;
}

export function useInlineRename<T>(options: InlineRenameOptions<T>): InlineRename {
  const {readValue, readTarget, commit, canEdit} = options;

  const editing = ref(false);
  const draft = ref('');
  const inputRef = options.inputRef ?? ref<HTMLInputElement | null>(null);

  /** 进入编辑时的目标与初值快照，提交只认它们。 */
  let target: T | null = null;
  let initialValue = '';

  const start = (): void => {
    if (canEdit && !canEdit()) return;
    const nextTarget = readTarget();
    if (nextTarget == null) return;
    target = nextTarget;
    initialValue = readValue();
    draft.value = initialValue;
    editing.value = true;
    // 双击语义是「整段替换」：输入框渲染出来后再聚焦并全选。
    void nextTick(() => {
      inputRef.value?.focus();
      inputRef.value?.select();
    });
  };

  const commitEdit = (): void => {
    // Enter 提交后输入框卸载会再触发一次 blur：只认第一次，否则重复调接口。
    if (!editing.value) return;
    editing.value = false;
    const value = draft.value.trim();
    const writeTarget = target;
    target = null;
    // 空标题与「没改过」都不写库：改名请求没必要为一个空操作跑一趟。
    if (writeTarget == null || !value || value === initialValue) return;
    void commit(value, writeTarget);
  };

  const cancel = (): void => {
    editing.value = false;
    target = null;
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    // 输入法候选框里的 Enter 属于组合输入，不能当提交。
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  return {editing, draft, inputRef, start, commitEdit, cancel, handleKeydown};
}
