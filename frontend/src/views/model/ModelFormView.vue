<script setup lang='ts'>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ModelAPI } from '../../services/api';
import { useTheme } from '../../composables/useTheme';
import { useConfirm } from '../../composables/useConfirm';
import type { OpenAIModelItem } from '../../types/chat';
import { extractOpenAIError, parseOpenAIModelList } from '../../utils/openaiModels';
import { isOk } from '../../utils/api';

const route = useRoute();
const router = useRouter();
const { confirm } = useConfirm();

// 主题：接入全局共享主题状态（与聊天页共用偏好）
const { isDark, toggleTheme } = useTheme();

// 有 :id 参数为更新模式，否则为新增模式
const modelId = computed(() => String(route.params.id ?? ''));
const isEdit = computed(() => modelId.value !== '');

const form = ref({ modelName: '', baseUrl: '', apiKey: '' });
const formError = ref('');
const loading = ref(false);
const submitting = ref(false);
/** 编辑模式下后端反馈的密钥配置状态（三态展示：已配置 / 未配置） */
const credentialConfigured = ref(false);
const clearing = ref(false);
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

// 更新模式：进入页面时按 id 回填
const loadDetail = async () => {
  if (!isEdit.value) return;
  loading.value = true;
  formError.value = '';
  try {
    const res = await ModelAPI.findById(modelId.value);
    if (isOk(res.code) && res.data) {
      form.value = {
        modelName: res.data.modelName ?? '',
        baseUrl: res.data.baseUrl ?? '',
        // 掩码值不回填输入框：留空 = 保留（三态语义），避免把掩码当成新密钥提交
        apiKey: ''
      };
      credentialConfigured.value = res.data.credentialConfigured ?? false;
    } else {
      formError.value = '加载模型配置失败，请稍后重试';
    }
  } catch {
    formError.value = '加载模型配置失败，请稍后重试';
  } finally {
    loading.value = false;
  }
};

const validate = () => {
  if (!form.value.modelName.trim() || !form.value.baseUrl.trim()) {
    formError.value = '模型名称、Base URL 均为必填项';
    return false;
  }
  // 三态语义（§6-6）：新增必须提供密钥；编辑留空 = 保留已有密钥（不发送 apiKey 字段）
  if (!isEdit.value && !form.value.apiKey.trim()) {
    formError.value = '新增模型需要填写 API Key';
    return false;
  }
  return true;
};

const submit = async () => {
  formError.value = '';
  if (!validate()) return;
  submitting.value = true;
  try {
    const key = form.value.apiKey.trim();
    // apiKey 留空时不携带该字段（「保留」），带值即替换（「新增/替换」）；清除走 clearKey
    const payload: { modelName: string; baseUrl: string; apiKey?: string } = {
      modelName: form.value.modelName.trim(),
      baseUrl: form.value.baseUrl.trim()
    };
    if (key) payload.apiKey = key;
    const res = isEdit.value
      ? await ModelAPI.update({ id: modelId.value, ...payload })
      : await ModelAPI.add(payload);
    if (isOk(res.code)) {
      showToast(isEdit.value ? '保存成功' : '新增成功');
      window.setTimeout(() => router.push('/models'), 600);
    } else {
      formError.value = isEdit.value ? '保存失败，请稍后重试' : '新增失败，请稍后重试';
    }
  } catch {
    formError.value = `${isEdit.value ? '保存失败' : '新增失败'}，请稍后重试`;
  } finally {
    submitting.value = false;
  }
};

/** 清除已配置密钥（三态之「清除」，独立端点，禁用空值表达） */
const clearKey = async () => {
  const ok = await confirm({
    title: '清除密钥',
    content: '确定要清除该模型已配置的密钥吗？清除后该模型无法调用，直到重新配置。',
    type: 'warning',
    confirmText: '清除'
  });
  if (!ok) return;
  clearing.value = true;
  try {
    const res = await ModelAPI.clearCredential(modelId.value);
    if (isOk(res.code)) {
      credentialConfigured.value = false;
      form.value.apiKey = '';
      showToast('密钥已清除');
    } else {
      showToast('清除失败，请稍后重试', 'error');
    }
  } catch {
    showToast('清除失败，请稍后重试', 'error');
  } finally {
    clearing.value = false;
  }
};

const goBack = () => router.push('/models');

const rootClass = computed(() => [
  'min-h-screen w-screen font-sans',
  isDark.value ? 'bg-[#0b0f17] text-gray-100' : 'bg-gray-50 text-gray-900',
]);
const headerClass = computed(() => [
  'sticky top-0 z-20 h-14 px-4 flex items-center justify-between border-b backdrop-blur select-none',
  isDark.value ? 'bg-[#0b0f17]/90 border-[#273043]' : 'bg-white/90 border-gray-200',
]);
const themeBtnClass = computed(() => [
  'p-2 rounded-xl border transition',
  isDark.value ? 'bg-[#161b26] border-[#2d3a54] text-yellow-400 hover:bg-[#202738]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100',
]);
const mutedText = computed(() => (isDark.value ? 'mt-1 text-xs text-gray-400' : 'mt-1 text-xs text-gray-500'));
const btnClass = computed(() => [
  'px-3 py-1.5 rounded-lg text-xs border transition disabled:opacity-40 disabled:cursor-not-allowed',
  isDark.value ? 'border-[#2d3a54] text-gray-300 hover:bg-white/5' : 'border-gray-300 text-gray-600 hover:bg-black/5',
]);
const cardClass = computed(() => ['rounded-2xl border overflow-hidden', isDark.value ? 'border-[#273043] bg-[#0f1420]' : 'border-gray-200 bg-white']);
const dividerClass = computed(() => (isDark.value ? 'border-[#273043]' : 'border-gray-200'));
const labelClass = computed(() => (isDark.value ? 'text-xs text-gray-400' : 'text-xs text-gray-500'));
const inputClass = computed(() => [
  'w-full px-3 py-2 rounded-lg text-xs outline-none border transition',
  isDark.value ? 'bg-[#161b26] border-[#2d3a54] text-gray-100 placeholder-gray-500 focus:border-blue-500/60' : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-400',
]);
const toastClass = computed(() => [
  'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl text-xs shadow-lg',
  toastType.value === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white',
]);

const isFetchingRemoteModels = ref(false);
const remoteModelList = ref<OpenAIModelItem[]>([]);
const isRemoteModelDropdownOpen = ref(false);
const remoteModelSearch = ref('');
const fetchRemoteModelError = ref('');

const filteredRemoteModels = computed(() => {
  const q = remoteModelSearch.value.trim().toLowerCase();
  if (!q) return remoteModelList.value;
  return remoteModelList.value.filter(m =>
    m.id.toLowerCase().includes(q) || (m.owned_by && m.owned_by.toLowerCase().includes(q))
  );
});

const handleFetchRemoteModels = async (e?: Event) => {
  e?.stopPropagation();
  if (!form.value.baseUrl?.trim()) {
    formError.value = '请先填写 API Base URL';
    return;
  }

  const base = form.value.baseUrl.trim();
  const url = base.replace(/\/+$/, '') + '/models';

  isFetchingRemoteModels.value = true;
  fetchRemoteModelError.value = '';
  isRemoteModelDropdownOpen.value = true;
  remoteModelSearch.value = '';

  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    const key = form.value.apiKey?.trim();
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
      headers['apikey'] = key;
      headers['api-key'] = key;
    }

    const res = await fetch(url, {
      method: 'GET',
      headers
    });

    if (!res.ok) {
      let errJson: unknown = null;
      try {
        errJson = await res.json();
      } catch (err) {
        console.warn('[fetchRemoteModels] 错误响应体不是合法 JSON:', err);
      }
      throw new Error(extractOpenAIError(errJson, `HTTP ${res.status}: ${res.statusText}`));
    }

    const json = await res.json();
    // 各厂商 /v1/models 响应结构不一致（外部契约），解析收敛到 utils/openaiModels
    const validItems: OpenAIModelItem[] = parseOpenAIModelList(json);

    remoteModelList.value = validItems;
    if (validItems.length === 0) {
      fetchRemoteModelError.value = '未获取到任何可用模型';
    }
  } catch (err: any) {
    console.error('获取模型列表失败:', err);
    fetchRemoteModelError.value = err.message || '获取模型列表失败，请检查 Base URL 与 API Key 或网络跨域';
  } finally {
    isFetchingRemoteModels.value = false;
  }
};

const handleSelectRemoteModel = (name: string) => {
  form.value.modelName = name;
  isRemoteModelDropdownOpen.value = false;
  formError.value = '';
};

const handleDocumentClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest('.model-dropdown-container')) {
    isRemoteModelDropdownOpen.value = false;
  }
};

onMounted(() => {
  loadDetail();
  window.addEventListener('click', handleDocumentClick);
});

onBeforeUnmount(() => {
  window.removeEventListener('click', handleDocumentClick);
  if (toastTimer) window.clearTimeout(toastTimer);
});
</script>

<template>
  <div :class='rootClass'>
    <header :class='headerClass'>
      <div class='flex items-center gap-3'>
        <button @click='goBack' :class='btnClass'>← 返回列表</button>
        <h1 class='text-sm font-bold tracking-wide'>{{ isEdit ? '编辑模型' : '新增模型' }}</h1>
      </div>
      <button @click='toggleTheme' :class='themeBtnClass'>{{ isDark ? '☀️' : '🌙' }}</button>
    </header>

    <main class='max-w-2xl mx-auto px-4 py-6'>
      <div :class='cardClass'>
        <div class='px-5 py-4 border-b' :class='dividerClass'>
          <h2 class='text-sm font-semibold'>{{ isEdit ? '更新模型配置' : '添加自定义模型' }}</h2>
          <p :class='mutedText'>{{ isEdit ? `模型 ID：${modelId}` : '填写模型名称、Base URL 与 API Key 以创建配置' }}</p>
        </div>

        <div v-if='loading' class='px-5 py-10 text-center text-xs opacity-60'>加载中...</div>

        <div v-else class='px-5 py-5 space-y-4'>
          <div class='model-dropdown-container relative space-y-1.5' @click.stop>
            <label :class='labelClass'>模型名称 <span class='text-red-400'>*</span></label>
            <div class='flex items-center gap-2'>
              <input v-model='form.modelName' :class='[inputClass, "flex-1 min-w-0"]' />
              <button
                type='button'
                :disabled='isFetchingRemoteModels'
                @click='handleFetchRemoteModels'
                class='px-3 py-2 rounded-lg text-xs font-medium shrink-0 flex items-center gap-1.5 transition border cursor-pointer select-none bg-blue-600/10 border-blue-500/30 text-blue-500 hover:bg-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed'
              >
                <svg v-if='isFetchingRemoteModels' class='w-3.5 h-3.5 animate-spin' fill='none' viewBox='0 0 24 24'>
                  <circle class='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' stroke-width='4'></circle>
                  <path class='opacity-75' fill='currentColor' d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'></path>
                </svg>
                <svg v-else class='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15' />
                </svg>
                <span>{{ isFetchingRemoteModels ? '获取中...' : '获取模型列表' }}</span>
                <svg class='w-3 h-3 text-gray-400' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7' />
                </svg>
              </button>
            </div>

            <!-- 下拉列表 -->
            <div
              v-if='isRemoteModelDropdownOpen'
              :class="['absolute left-0 right-0 mt-1 max-h-60 overflow-hidden rounded-xl border shadow-xl py-1 z-30 flex flex-col text-xs', isDark ? 'bg-[#161b26] border-[#2d3a54]' : 'bg-white border-gray-200']"
            >
              <div v-if='remoteModelList.length > 5' class='p-2 border-b' :class='dividerClass'>
                <input
                  v-model='remoteModelSearch'
                  placeholder='搜索模型...'
                  :class='[inputClass, "w-full py-1 text-xs"]'
                  @click.stop
                />
              </div>
              <div v-if='isFetchingRemoteModels' class='py-4 text-center text-gray-400 flex items-center justify-center gap-2'>
                <svg class='w-3.5 h-3.5 animate-spin text-blue-500' fill='none' viewBox='0 0 24 24'>
                  <circle class='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' stroke-width='4'></circle>
                  <path class='opacity-75' fill='currentColor' d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'></path>
                </svg>
                <span>正在请求远程 /models 列表...</span>
              </div>
              <div v-else-if='fetchRemoteModelError' class='p-3 text-red-400 break-all space-y-1'>
                <div class='font-medium flex items-center gap-1.5'>
                  <svg class='w-3.5 h-3.5 shrink-0' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                    <path stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' />
                  </svg>
                  <span>获取失败</span>
                </div>
                <div class='text-[11px] opacity-90'>{{ fetchRemoteModelError }}</div>
              </div>
              <div v-else-if='filteredRemoteModels.length === 0' class='py-4 text-center text-gray-400'>
                {{ remoteModelSearch ? '无匹配的模型' : '未获取到任何可用模型' }}
              </div>
              <div v-else class='overflow-y-auto max-h-48 scrollbar-thin py-0.5'>
                <div
                  v-for='item in filteredRemoteModels'
                  :key='item.id'
                  @click='handleSelectRemoteModel(item.id)'
                  :class="[
                    'px-3 py-1.5 cursor-pointer flex items-center justify-between transition',
                    isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100',
                    form.modelName === item.id ? 'text-blue-500 font-medium bg-blue-500/10' : ''
                  ]"
                >
                  <div class='min-w-0 pr-2'>
                    <div class='font-mono text-xs truncate'>{{ item.id }}</div>
                    <div v-if='item.owned_by' class='text-[10px] text-gray-400 truncate'>
                      组织/所有者: {{ item.owned_by }}
                    </div>
                  </div>
                  <svg v-if='form.modelName === item.id' class='w-3.5 h-3.5 text-blue-500 shrink-0 ml-2' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                    <path stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M5 13l4 4L19 7' />
                  </svg>
                </div>
              </div>
            </div>
          </div>
          <div class='space-y-1.5'>
            <label :class='labelClass'>Base URL <span class='text-red-400'>*</span></label>
            <input v-model='form.baseUrl' :class='inputClass' placeholder='Base URL，如 https://api.example.com/v1' />
          </div>
          <div class='space-y-1.5'>
            <div class='flex items-center justify-between gap-2'>
              <label :class='labelClass'>API Key <span v-if='!isEdit' class='text-red-400'>*</span></label>
              <span
                v-if='isEdit && credentialConfigured'
                class='inline-flex items-center px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 text-[11px] font-medium'
              >已配置密钥</span>
              <span
                v-else-if='isEdit'
                class='inline-flex items-center px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400 text-[11px]'
              >未配置</span>
            </div>
            <input
              v-model='form.apiKey'
              :class='inputClass'
              :placeholder='isEdit
                ? (credentialConfigured ? "留空表示保留已配置的密钥" : "填写 API Key 以配置密钥")
                : "API Key"'
              autocomplete='off'
            />
            <button
              v-if='isEdit && credentialConfigured'
              type='button'
              :disabled='clearing'
              @click='clearKey'
              class='text-[11px] text-red-400 hover:text-red-500 transition cursor-pointer disabled:opacity-50'
            >{{ clearing ? '清除中...' : '清除已配置的密钥' }}</button>
          </div>

          <p v-if='formError' class='text-[11px] text-red-400'>{{ formError }}</p>

          <div class='flex justify-end gap-2 pt-2'>
            <button @click='goBack' :class='btnClass'>取消</button>
            <button :disabled='submitting' @click='submit' class='px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition disabled:opacity-50'>{{ submitting ? '提交中...' : (isEdit ? '保存修改' : '确认新增') }}</button>
          </div>
        </div>
      </div>
    </main>

    <div v-if='toast' :class='toastClass'>{{ toast }}</div>
  </div>
</template>
