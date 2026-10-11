import { computed, ref } from 'vue';
import { SkillAPI } from '../services/skill';
import { isOk } from '../utils/api';
import type { SkillVO } from '../types/chat';

/**
 * /skill 浮层菜单的状态与加载逻辑。
 *
 * <p>为什么带请求序号守卫：浮层可以反复开关，慢的旧响应不能覆盖新一次加载的数据，
 * 否则用户会看到上一次请求的过期清单。</p>
 */
export function useSkillMenu() {
  const isOpen = ref(false);
  const isLoading = ref(false);
  const loadError = ref('');
  const searchQuery = ref('');
  const skills = ref<SkillVO[]>([]);
  let loadSeq = 0;

  const filteredSkills = computed<SkillVO[]>(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return skills.value;
    return skills.value.filter(s =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  });

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

  const open = () => {
    isOpen.value = true;
    searchQuery.value = '';
    void load();
  };

  const close = () => {
    if (!isOpen.value) return;
    isOpen.value = false;
    searchQuery.value = '';
  };

  return { isOpen, isLoading, loadError, searchQuery, skills, filteredSkills, open, close };
}
