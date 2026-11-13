import {ref} from 'vue';
import {SkillAPI} from '../services/skill';
import {isOk} from '../utils/api';
import type {SkillVO} from '../types/chat';

/**
 * Skill 清单的加载状态。
 *
 * <p>只负责「取清单」：过滤、搜索框与选中后的填充都在「+」菜单与输入区里，
 * 这里再留一份 isOpen / searchQuery 就会长出第二个技能浮层（历史上正是这样同时弹了两个框）。</p>
 *
 * <p>为什么带请求序号守卫：菜单可以反复开关，慢的旧响应不能覆盖新一次加载的数据。</p>
 */
export function useSkillList() {
  const isLoading = ref(false);
  const loadError = ref('');
  const skills = ref<SkillVO[]>([]);
  let loadSeq = 0;

  const load = async () => {
    const seq = ++loadSeq;
    isLoading.value = true;
    loadError.value = '';
    try {
      const res = await SkillAPI.list();
      if (seq !== loadSeq) return;
      if (isOk(res.code) && res.data) {
        skills.value = res.data;
        loadError.value = '';
      } else {
        skills.value = [];
        loadError.value = res.errMsg || '';
      }
    } catch (err) {
      if (seq !== loadSeq) return;
      skills.value = [];
      loadError.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === loadSeq) isLoading.value = false;
    }
  };

  return { isLoading, loadError, skills, load };
}
