import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { PersonalizationAPI } from '../../../services/personalization';
import type { PersonalizationDraft, PersonalizationVO, ReplyStyleOption } from '../../../services/personalization';
import { extractErrorMessage } from '../../../utils/error';
import { usePersonalizationCopy } from './personalizationCopy';

export function usePersonalizationTab() {
  const copy = usePersonalizationCopy();
  const config = ref<PersonalizationVO | null>(null);
  const styles = ref<ReplyStyleOption[]>([]);
  const draft = reactive<PersonalizationDraft>({ title: '', commonAgentName: '', replyStyle: '', customInstruction: '' });
  const loading = ref(true);
  const saving = ref(false);
  const error = ref('');
  const saved = ref(false);
  let generation = 0;
  const dirty = computed(() => !!config.value && Object.keys(draft).some(key => {
    const field = key as keyof PersonalizationDraft;
    return draft[field] !== (config.value![field] ?? '');
  }));

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
      Object.assign(draft, { title: current.data.title ?? '', commonAgentName: current.data.commonAgentName ?? '',
        replyStyle: current.data.replyStyle, customInstruction: current.data.customInstruction ?? '' });
    } catch (cause) {
      if (request === generation) error.value = extractErrorMessage(cause);
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  async function save() {
    if (!config.value || !dirty.value || saving.value || loading.value) return;
    const request = generation;
    saving.value = true;
    saved.value = false;
    error.value = '';
    try {
      const result = await PersonalizationAPI.update({ id: config.value.id, ...draft });
      if (request !== generation) return;
      if (result.code !== 1) throw new Error(result.errMsg || copy.value.loadError);
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
  return { copy, config, styles, draft, loading, saving, error, saved, dirty, load, save };
}
