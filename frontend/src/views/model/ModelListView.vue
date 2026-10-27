<script setup lang='ts'>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ModelAPI } from '../../services/api';
import { useTheme } from '../../composables/useTheme';
import type { ModelConfigVO } from '../../types/chat';
import { isOk, toPositiveInt } from '../../utils/api';
import { t } from '../../i18n';

const router = useRouter();

// 主题：接入全局共享主题状态（与登录页/聊天页共用偏好）
const { isDark, toggleTheme } = useTheme();

const records = ref<ModelConfigVO[]>([]);
const current = ref(1);
const pageSize = ref(10);
const total = ref(0);
const loading = ref(false);
const errorMsg = ref('');
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

const toast = ref('');
const toastType = ref<'success' | 'error'>('success');
let toastTimer: number | undefined;
const showToast = (text: string, type: 'success' | 'error' = 'success') => {
  toast.value = text;
  toastType.value = type;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = '';
  }, 2500);
};
const load = async () => {
  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await ModelAPI.list(current.value, pageSize.value);
    if (isOk(res.code)) {
      records.value = res.data?.records ?? [];
      // 分页字段解析失败时保持原值，不再二次 `|| 默认值` 兜底
      current.value = toPositiveInt(res.data?.current, current.value);
      pageSize.value = toPositiveInt(res.data?.pageSize, pageSize.value);
      total.value = toPositiveInt(res.data?.total, 0);
    } else {
            errorMsg.value = t('model.loadFailed');
    }
  } catch (err) {
    console.error('[ModelListView] 加载模型列表失败:', err);
    errorMsg.value = t('model.loadFailed');
  } finally {
    loading.value = false;
  }
};
const goPrev = () => {
  if (current.value > 1) {
    current.value -= 1;
    load();
  }
};
const goNext = () => {
  if (current.value < totalPages.value) {
    current.value += 1;
    load();
  }
};

const rootClass = computed(() => [
  'min-h-screen w-screen font-sans',
  isDark.value ? 'bg-[#0b0f17] text-zinc-100' : 'bg-zinc-50 text-gray-900',
]);
const headerClass = computed(() => [
  'sticky top-0 z-20 h-14 px-4 flex items-center justify-between border-b backdrop-blur select-none',
  isDark.value ? 'bg-[#0b0f17]/90 border-[#273043]' : 'bg-white/90 border-gray-200',
]);
const themeBtnClass = computed(() => [
  'p-2 rounded-xl border transition',
  isDark.value ? 'bg-[#161b26] border-[#2d3a54] text-yellow-400 hover:bg-[#202738]' : 'bg-zinc-50 border-gray-200 text-gray-600 hover:bg-zinc-100',
]);
const mutedText = computed(() => (isDark.value ? 'text-xs text-gray-400' : 'text-xs text-gray-500'));
const theadClass = computed(() => (isDark.value ? 'bg-[#121722] text-gray-400' : 'bg-zinc-100 text-gray-500'));
const btnClass = computed(() => [
  'px-3 py-1.5 rounded-lg text-xs border transition disabled:opacity-40 disabled:cursor-not-allowed',
  isDark.value ? 'border-[#2d3a54] text-zinc-300 hover:bg-white/5' : 'border-zinc-300 text-gray-600 hover:bg-black/5',
]);
const cardClass = computed(() => ['rounded-2xl border overflow-hidden', isDark.value ? 'border-[#273043]' : 'border-gray-200']);
const rowClass = computed(() => ['border-t', isDark.value ? 'border-[#273043] hover:bg-[#141a26]' : 'border-zinc-100 hover:bg-zinc-50']);
const modalClass = computed(() => [
  'relative z-50 w-full rounded-2xl border p-5 shadow-2xl',
  isDark.value ? 'bg-[#161b26] border-[#273043] text-gray-200' : 'bg-white border-gray-200 text-gray-800',
]);
const delCardClass = computed(() => [...modalClass.value, 'max-w-sm']);
const toastClass = computed(() => [
  'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl text-xs shadow-lg',
  toastType.value === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white',
]);

// 新增 / 更新分别跳转到独立路由页面
const goAdd = () => router.push('/models/new');
const goEdit = (id: number | string) => router.push(`/models/${id}/edit`);

const deletingId = ref<number | string | null>(null);
const askDelete = (id: number | string) => {
  deletingId.value = id;
};
const cancelDelete = () => {
  deletingId.value = null;
};
const confirmDelete = async () => {
  if (deletingId.value === null) return;
  const id = deletingId.value;
  try {
    const res = await ModelAPI.deleteById(id);
    if (isOk(res.code)) {
      deletingId.value = null;
            showToast(t('model.deleteSuccess'));
      if (records.value.length === 1 && current.value > 1) current.value -= 1;
      await load();
    } else {
      showToast(t('model.deleteFailed'), 'error');
      deletingId.value = null;
    }
  } catch {
    showToast(t('model.deleteFailed'), 'error');
    deletingId.value = null;
  }
};
const goBack = () => router.push('/');

onMounted(load);
</script>

<template>
  <div :class='rootClass'>
    <header :class='headerClass'>
      <div class='flex items-center gap-3'>
                <button @click='goBack' :class='btnClass'>{{ t('model.backToChat') }}</button>
        <h1 class='text-sm font-bold tracking-wide'>{{ t('model.title') }}</h1>
      </div>
      <button @click='toggleTheme' :class='themeBtnClass'>{{ isDark ? '☀️' : '🌙' }}</button>
    </header>

    <main class='max-w-5xl mx-auto px-4 py-6'>
      <div class='flex items-center justify-between mb-4'>
                <div :class='mutedText'>{{ t('model.totalConfigs', { count: total }) }}</div>
        <div class='flex items-center gap-2'>
          <button @click='load' :class='btnClass'>{{ t('common.refresh') }}</button>
          <button @click='goAdd' class='px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition'>{{ t('model.add') }}</button>
        </div>
      </div>

      <p v-if='errorMsg' class='mb-3 text-xs text-red-400'>{{ errorMsg }}</p>

      <div :class='cardClass'>
        <table class='w-full text-sm'>
          <thead :class='theadClass'>
            <tr>
              <th class='text-left px-4 py-3 font-medium w-16'>ID</th>
                            <th class='text-left px-4 py-3 font-medium'>{{ t('model.colName') }}</th>
              <th class='text-left px-4 py-3 font-medium'>Base URL</th>
              <th class='text-left px-4 py-3 font-medium'>API Key</th>
              <th class='text-right px-4 py-3 font-medium w-24'>{{ t('model.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
                        <tr v-if='loading'><td :colspan='5' class='px-4 py-8 text-center text-xs opacity-60'>{{ t('common.loading') }}</td></tr>
            <tr v-else-if='!records.length'><td :colspan='5' class='px-4 py-8 text-center text-xs opacity-60'>{{ t('common.noData') }}</td></tr>
            <tr v-for='row in records' :key='row.id' :class='rowClass'>
              <td class='px-4 py-3 opacity-70'>{{ row.id }}</td>
              <td class='px-4 py-3 font-medium'>{{ row.modelName }}</td>
              <td class='px-4 py-3 text-xs break-all opacity-90'>{{ row.baseUrl }}</td>
              <td class='px-4 py-3 text-xs'>
                                <span v-if='row.credentialConfigured' class='inline-flex items-center px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 font-medium'>{{ t('model.configured') }}</span>
                <span v-else class='inline-flex items-center px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400'>{{ t('model.notConfigured') }}</span>
              </td>
              <td class='px-4 py-3 text-right'>
                <div class='flex items-center justify-end gap-2'>
                                    <button @click='goEdit(row.id!)' :class='btnClass'>{{ t('common.edit') }}</button>
                  <button @click='askDelete(row.id!)' class='px-2.5 py-1 rounded-lg text-xs border border-red-500/40 text-red-400 hover:bg-red-500/10 transition'>{{ t('common.remove') }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class='flex items-center justify-between mt-4'>
                <div :class='mutedText'>{{ t('model.page', { current, total: totalPages }) }}</div>
        <div class='flex gap-2'>
          <button :disabled='current <= 1' @click='goPrev' :class='btnClass'>{{ t('model.prevPage') }}</button>
          <button :disabled='current >= totalPages' @click='goNext' :class='btnClass'>{{ t('model.nextPage') }}</button>
        </div>
      </div>
    </main>

    <div v-if='deletingId !== null' class='fixed inset-0 z-40 flex items-center justify-center p-4'>
      <div class='absolute inset-0 bg-black/40' @click='cancelDelete'></div>
      <div :class='delCardClass'>
                <h3 class='text-sm font-bold mb-2'>{{ t('model.confirmDeleteTitle') }}</h3>
        <p :class='mutedText'>{{ t('model.confirmDeleteContent') }}</p>
        <div class='flex justify-end gap-2 mt-5'>
          <button @click='cancelDelete' :class='btnClass'>{{ t('common.cancel') }}</button>
          <button @click='confirmDelete' class='px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition'>{{ t('common.remove') }}</button>
        </div>
      </div>
    </div>

    <div v-if='toast' :class='toastClass'>{{ toast }}</div>
  </div>
</template>
