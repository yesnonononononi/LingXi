import {computed, onBeforeUnmount, onMounted, reactive, ref} from 'vue';
import type {PersonalizationDraft, PersonalizationVO, ReplyStyleOption} from '../../../services/personalization';
import {PersonalizationAPI} from '../../../services/personalization';
import {extractErrorMessage} from '../../../utils/error';
import {setGreetingUserName} from '../../../composables/useGreeting';
import {applyShortcutBindings} from '../../../composables/useShortcuts';
import {findShortcutConflicts, normalizeShortcutMap, type ShortcutConflict} from '../../../utils/shortcuts';
import {usePersonalizationCopy} from './personalizationCopy';

export function usePersonalizationTab() {
  const copy = usePersonalizationCopy();
  const config = ref<PersonalizationVO | null>(null);
  const styles = ref<ReplyStyleOption[]>([]);
  const draft = reactive<PersonalizationDraft>({
    title: '', commonAgentName: '', replyStyle: '', customInstruction: '', shortcuts: normalizeShortcutMap(null),
  });
  const loading = ref(true);
  const saving = ref(false);
  const error = ref('');
  const saved = ref(false);
  let generation = 0;

  /**
   * 快捷键冲突：同一组合绑到两个动作时必须拦住保存。
   *
   * <p>不能只靠「后者覆盖前者」的运行时行为兜底 —— 用户会以为两个动作都能用，
   * 结果其中一个永远不触发。这里在保存前把冲突原文（动作名）报出来。</p>
   */
  const shortcutConflicts = computed<ShortcutConflict[]>(() => findShortcutConflicts(draft.shortcuts));
  const shortcutsBlocked = computed(() => shortcutConflicts.value.length > 0);

  const dirty = computed(() => {
    const saved = config.value;
    if (!saved) return false;
    if (draft.title !== (saved.title ?? '')) return true;
    if (draft.commonAgentName !== (saved.commonAgentName ?? '')) return true;
    if (draft.replyStyle !== saved.replyStyle) return true;
    if (draft.customInstruction !== (saved.customInstruction ?? '')) return true;
    return JSON.stringify(draft.shortcuts) !== JSON.stringify(normalizeShortcutMap(saved.shortcuts));
  });

  async function load() {
    const request = ++generation;
    loading.value = true;
    error.value = '';
    try {
      const [current, options] = await Promise.all([PersonalizationAPI.current(), PersonalizationAPI.replyStyles()]);
      if (request !== generation) return;
      if (current.code !== 1) throw new Error(current.errMsg || copy.value.loadError);
      if (options.code !== 1) throw new Error(options.errMsg || copy.value.loadError);
      if (current.data?.id == null || !options.data?.length || !options.data.some(option => option.value === current.data!.replyStyle)) {
        throw new Error(copy.value.contractError);
      }
      config.value = current.data;
      styles.value = options.data;
      Object.assign(draft, {
        title: current.data.title ?? '', commonAgentName: current.data.commonAgentName ?? '',
        replyStyle: current.data.replyStyle, customInstruction: current.data.customInstruction ?? '',
        shortcuts: normalizeShortcutMap(current.data.shortcuts),
      });
    } catch (cause) {
      if (request === generation) error.value = extractErrorMessage(cause);
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  async function save() {
    if (!config.value || !dirty.value || saving.value || loading.value) return;
    if (shortcutsBlocked.value) {
      error.value = `${copy.value.shortcutConflict}：${shortcutConflicts.value.map(item => item.text).join(' / ')}`;
      return;
    }
    const request = generation;
    saving.value = true;
    saved.value = false;
    error.value = '';
    try {
      const result = await PersonalizationAPI.update({ id: config.value.id, ...draft });
      if (request !== generation) return;
      if (result.code !== 1) throw new Error(result.errMsg || copy.value.loadError);
      // 称呼与快捷键都即时生效：模块级缓存的欢迎语、窗口级监听的绑定都不等下一次刷新。
      setGreetingUserName(draft.title);
      applyShortcutBindings(draft.shortcuts);
      await load();
      if (!error.value && request + 1 === generation) saved.value = true;
    } catch (cause) {
      if (request === generation) error.value = extractErrorMessage(cause);
    } finally {
      saving.value = false;
    }
  }

  onMounted(load);
  onBeforeUnmount(() => { generation++; });
  return { copy, config, styles, draft, loading, saving, error, saved, dirty, shortcutConflicts, shortcutsBlocked, load, save };
}
