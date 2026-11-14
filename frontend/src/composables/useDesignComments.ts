import {computed, ref} from 'vue';
import {createLocalId} from '../utils/ids';

export interface DesignCommentItem {
  id: string;
  selector: string;
  elementLabel: string;
  text: string;
  resolved: boolean;
  createdAt: number;
}

/** 管理设计画布上的元素锚定评论：支持攒多条后批量交给 AI 修改。 */
export function useDesignComments() {
  const comments = ref<DesignCommentItem[]>([]);
  const commentMode = ref(false);

  const unresolvedComments = computed(() => comments.value.filter(item => !item.resolved));

  const addComment = (selector: string, elementLabel: string, text: string): DesignCommentItem | null => {
    const cleanText = text.trim();
    const cleanSelector = selector.trim();
    if (!cleanText || !cleanSelector) return null;

    const item: DesignCommentItem = {
      id: createLocalId('cmt'),
      selector: cleanSelector,
      elementLabel: elementLabel.trim() || cleanSelector,
      text: cleanText,
      resolved: false,
      createdAt: Date.now(),
    };
    comments.value.push(item);
    return item;
  };

  const toggleResolve = (id: string): void => {
    const target = comments.value.find(item => item.id === id);
    if (target) target.resolved = !target.resolved;
  };

  const removeComment = (id: string): void => {
    comments.value = comments.value.filter(item => item.id !== id);
  };

  const resolveAll = (): void => {
    comments.value.forEach(item => { item.resolved = true; });
  };

  const clearComments = (): void => {
    comments.value = [];
    commentMode.value = false;
  };

  return {
    comments,
    commentMode,
    unresolvedComments,
    addComment,
    toggleResolve,
    removeComment,
    resolveAll,
    clearComments,
  };
}
