<script setup lang="ts">
import { computed } from 'vue';
import { useModelsTab } from './useModelsTab';
import { useTheme } from '../../../composables/useTheme';

const props = defineProps<{
  isDark?: boolean;
}>();

const { isDark: globalIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? globalIsDark.value);

const emit = defineEmits<{
  (e: 'modelUpdated'): void;
}>();

const {
  modelsList,
  isModelLoading,
  modelErrorMsg,
  isEditingOrAdding,
  addType,
  editingModelId,
  modelForm,
  modelFormError,
  isSubmittingModel,
  showApiKey,
  modelToast,
  providerPresets,
  selectedProvider,
  isProviderDropdownOpen,
  isFetchingRemoteModels,
  isRemoteModelDropdownOpen,
  remoteModelSearch,
  fetchRemoteModelError,
  filteredRemoteModels,
  loadModels,
  handleApplyPreset,
  startAddModel,
  startEditModel,
  cancelModelForm,
  saveModelForm,
  handleDeleteModel,
  handleFetchRemoteModels,
  handleSelectRemoteModel,
} = useModelsTab(() => emit('modelUpdated'));
</script>

<template>
  <div class="space-y-4">
    <!-- Toast 提示 -->
    <div
      v-if="modelToast"
      class="p-2.5 rounded-xl text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all flex items-center justify-between"
    >
      <span>{{ modelToast }}</span>
    </div>

    <!-- 列表模式 (未在编辑或新增时) -->
    <div v-if="!isEditingOrAdding" class="space-y-4">
      <div>
        <h4 class="text-base font-bold tracking-tight" :class="isDark ? 'text-white text-glow-white' : 'text-gray-900'">
          模型
        </h4>
        <p class="text-xs mt-1" :class="isDark ? 'text-zinc-400 text-glow-subtle' : 'text-gray-500'">
          填入各提供方的 API 密钥即可使用其模型。
        </p>
      </div>

      <!-- 加载中 -->
      <div v-if="isModelLoading" class="py-8 text-center text-xs" :class="isDark ? 'text-zinc-500' : 'text-gray-400'">
        正在加载模型配置...
      </div>

      <!-- 加载失败 -->
      <div v-else-if="modelErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ modelErrorMsg }}</p>
        <button
          type="button"
          @click="loadModels"
          class="px-3 py-1 rounded-lg border border-red-300 dark:border-red-800 text-xs hover:bg-red-500/10 cursor-pointer"
        >
          重试
        </button>
      </div>

      <!-- 模型卡片列表 -->
      <div v-else class="space-y-2.5">
        <div
          v-if="modelsList.length === 0"
          class="py-12 text-center text-xs border border-dashed rounded-2xl"
          :class="isDark ? 'border-white/10 text-zinc-500' : 'border-gray-200 text-gray-400'"
        >
          暂未配置模型，请点击下方按钮添加提供方
        </div>

        <!-- 卡片行 (严格还原截图中的圆角卡片，左侧名称+自定义徽章+绿色在线圆点，右侧编辑+删除按钮) -->
        <div
          v-for="item in modelsList"
          :key="item.id"
          :class="[
            'rounded-2xl border px-4 py-3.5 flex items-center justify-between transition-colors',
            isDark
              ? 'bg-black/90 border-white/15 hover:border-white/30 shadow-[0_0_20px_rgba(0,0,0,0.8)]'
              : 'bg-gray-50/70 border-gray-200 hover:border-gray-300'
          ]"
        >
          <!-- 左侧：模型名称 + [自定义] 徽章 + 在线绿点 -->
          <div class="flex items-center gap-2 min-w-0">
            <span class="font-semibold text-sm truncate" :class="isDark ? 'text-white text-glow-white' : 'text-gray-900'">
              {{ item.modelName || '未命名模型' }}
            </span>
            <!-- 提供方由后端下发，不再用 baseUrl 是否含某厂商域名来猜 -->
            <span
              v-if="item.provider === 'CUSTOM'"
              :class="[
                'text-[10px] px-1.5 py-0.5 rounded border tracking-tight shrink-0',
                isDark ? 'border-white/20 text-zinc-300 bg-white/5' : 'border-gray-200 text-gray-500'
              ]"
            >
              自定义
            </span>
            <!-- 状态绿点 -->
            <span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0 ml-0.5" title="服务就绪"></span>
          </div>

          <!-- 右侧：编辑与删除按钮 -->
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              @click="startEditModel(item)"
              :class="[
                'px-3 py-1 rounded-lg border text-xs font-medium transition cursor-pointer',
                isDark
                  ? 'border-white/20 hover:border-white/40 bg-white/[0.06] hover:bg-white/[0.12] text-zinc-100 text-glow-subtle'
                  : 'border-gray-200 hover:bg-gray-50 text-gray-700 shadow-2xs'
              ]"
            >
              编辑
            </button>
            <button
              type="button"
              @click="handleDeleteModel(item)"
              :class="[
                'text-xs px-2 py-1 transition cursor-pointer font-medium',
                isDark ? 'text-rose-400 hover:text-rose-300 drop-shadow-[0_0_8px_rgba(244,63,94,0.5)]' : 'text-red-500 hover:text-red-600'
              ]"
            >
              删除
            </button>
          </div>
        </div>

        <!-- 底部两个虚线添加按钮 (并排平分) -->
        <div class="flex items-center gap-3 pt-1">
          <button
            type="button"
            @click="startAddModel('preset')"
            :class="[
              'flex-1 py-2.5 rounded-2xl border border-dashed flex items-center justify-center gap-1.5 text-xs font-medium transition cursor-pointer',
              isDark
                ? 'border-white/20 hover:border-white/40 text-zinc-200 hover:text-white bg-white/[0.03] hover:bg-white/[0.08] text-glow-subtle'
                : 'border-gray-300 hover:border-gray-400 text-gray-700 hover:bg-gray-50'
            ]"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            <span>添加提供方</span>
          </button>

          <button
            type="button"
            @click="startAddModel('custom')"
            :class="[
              'flex-1 py-2.5 rounded-2xl border border-dashed flex items-center justify-center gap-1.5 text-xs font-medium transition cursor-pointer',
              isDark
                ? 'border-white/20 hover:border-white/40 text-zinc-200 hover:text-white bg-white/[0.03] hover:bg-white/[0.08] text-glow-subtle'
                : 'border-gray-300 hover:border-gray-400 text-gray-700 hover:bg-gray-50'
            ]"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            <span>添加自定义提供方</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 表单模式 (编辑已有模型 或 新增提供方) -->
    <div v-else class="space-y-4">
      <!-- 表单顶部导航栏 -->
      <div class="flex items-center justify-between pb-1 border-b border-gray-100 dark:border-gray-800">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="cancelModelForm"
            :class="[
              'p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition cursor-pointer',
              isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'
            ]"
            title="返回列表"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h4 class="text-sm font-bold tracking-tight text-gray-900 dark:text-white">
            {{ editingModelId !== null ? '编辑模型提供方' : (addType === 'custom' ? '添加自定义提供方' : '添加模型提供方') }}
          </h4>
        </div>
        <span class="text-[11px] text-gray-400">
          {{ editingModelId !== null ? '更新已有配置' : '配置新模型' }}
        </span>
      </div>

      <!-- 模型提供方下拉框 -->
      <div v-if="editingModelId === null && addType === 'preset'" class="provider-dropdown-container relative space-y-1" @click.stop>
        <label class="block text-xs font-medium" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
          模型提供方
        </label>
        <div class="relative">
          <button
            type="button"
            @click="isProviderDropdownOpen = !isProviderDropdownOpen"
            :class="[
              'w-full px-3 py-2 rounded-xl text-xs border flex items-center justify-between transition cursor-pointer select-none',
              isDark
                ? 'bg-black/90 border-white/20 text-zinc-100 hover:border-white/40'
                : 'bg-white border-gray-200 text-gray-900 hover:border-blue-400 shadow-2xs'
            ]"
          >
            <span class="font-medium">{{ selectedProvider || '选择提供方' }}</span>
            <svg
              class="w-3.5 h-3.5 text-gray-400 transition-transform duration-200"
              :class="isProviderDropdownOpen ? 'rotate-180 text-blue-500' : ''"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <!-- 提供方下拉列表 -->
          <transition name="dropdown-down-center">
            <div
              v-if="isProviderDropdownOpen"
              :class="[
                'absolute left-0 right-0 mt-1 rounded-xl border shadow-2xl py-1 z-30 text-xs max-h-56 overflow-y-auto scrollbar-thin origin-top backdrop-blur-xl',
                isDark ? 'bg-black/95 border-white/20 text-zinc-100' : 'bg-white border-gray-200 text-gray-700'
              ]"
            >
              <div
                v-for="preset in providerPresets"
                :key="preset.name"
                @click="handleApplyPreset(preset)"
                :class="[
                  'px-3 py-2 cursor-pointer flex items-center justify-between transition',
                  selectedProvider === preset.name
                    ? (isDark ? 'text-sky-400 text-glow-cyan font-medium bg-white/10' : 'text-blue-500 font-medium bg-blue-50/50')
                    : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-gray-700 hover:bg-gray-100')
                ]"
              >
                <div class="font-medium text-xs">{{ preset.name }}</div>
                <svg v-if="selectedProvider === preset.name" class="w-3.5 h-3.5 text-blue-500 shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          </transition>
        </div>
      </div>

      <!-- 表单输入项 -->
      <div class="space-y-3">
        <!-- 1. 模型名称与获取模型列表按钮 -->
        <div class="model-dropdown-container relative" @click.stop>
          <label class="block text-xs font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
            模型名称 <span class="text-red-500">*</span>
          </label>
          <div class="flex items-center gap-2">
            <input
              v-model="modelForm.modelName"
              placeholder="请输入模型名称"
              :class="[
                'flex-1 min-w-0 px-3 py-2 rounded-xl text-xs border outline-none transition',
                isDark
                  ? 'bg-black/90 border-white/20 text-zinc-100 placeholder-zinc-500 focus:border-cyan-400'
                  : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-blue-500 shadow-2xs'
              ]"
            />
            <button
              type="button"
              :disabled="isFetchingRemoteModels"
              @click="handleFetchRemoteModels"
              :class="[
                'px-3 py-2 rounded-xl text-xs font-medium shrink-0 flex items-center gap-1.5 transition border cursor-pointer select-none',
                isFetchingRemoteModels
                  ? 'opacity-60 cursor-not-allowed border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-black text-gray-400'
                  : (isDark
                      ? 'border-white/20 bg-white/[0.06] text-sky-400 hover:bg-white/[0.12] hover:border-white/40 text-glow-cyan'
                      : 'border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100/80 hover:border-blue-300 shadow-2xs')
              ]"
            >
              <svg
                v-if="isFetchingRemoteModels"
                class="w-3.5 h-3.5 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <svg
                v-else
                class="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{{ isFetchingRemoteModels ? '获取中...' : '获取模型列表' }}</span>
              <svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>

          <!-- 远程模型下拉列表 -->
          <transition name="dropdown-down-center">
            <div
              v-if="isRemoteModelDropdownOpen"
              :class="[
                'absolute left-0 right-0 mt-1 max-h-60 overflow-hidden rounded-xl border shadow-2xl py-1 z-30 flex flex-col text-xs origin-top backdrop-blur-xl',
                isDark ? 'bg-black/95 border-white/20 text-zinc-100' : 'bg-white border-gray-200 text-gray-700'
              ]"
            >
              <!-- 搜索过滤条 -->
              <div class="p-2 border-b" :class="isDark ? 'border-white/10' : 'border-gray-100'">
                <input
                  v-model="remoteModelSearch"
                  placeholder="搜索模型..."
                  :class="[
                    'w-full px-2.5 py-1 rounded-lg text-xs outline-none',
                    isDark ? 'bg-white/5 border border-white/10 text-zinc-100 placeholder-zinc-500' : 'bg-gray-50 border border-gray-200 text-gray-800 placeholder-gray-400'
                  ]"
                  @click.stop
                />
              </div>

              <!-- 加载中 -->
              <div v-if="isFetchingRemoteModels" class="py-4 text-center text-gray-400 flex items-center justify-center gap-2">
                <svg class="w-3.5 h-3.5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>正在获取远程 /models 列表...</span>
              </div>

              <!-- 错误信息 -->
              <div v-else-if="fetchRemoteModelError" class="p-3 text-red-500 dark:text-red-400 break-all space-y-1">
                <div class="font-medium flex items-center gap-1.5">
                  <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>获取失败</span>
                </div>
                <div class="text-[11px] opacity-90">{{ fetchRemoteModelError }}</div>
              </div>

              <!-- 空状态 -->
              <div v-else-if="filteredRemoteModels.length === 0" class="py-4 text-center text-gray-400">
                {{ remoteModelSearch ? '无匹配的模型' : '未获取到任何可用模型' }}
              </div>

              <!-- 模型列表滚动项 -->
              <div v-else class="overflow-y-auto max-h-48 scrollbar-thin py-0.5">
                <div
                  v-for="item in filteredRemoteModels"
                  :key="item.id"
                  @click="handleSelectRemoteModel(item.id)"
                  :class="[
                    'px-3 py-1.5 cursor-pointer flex items-center justify-between transition',
                    modelForm.modelName === item.id
                      ? (isDark ? 'text-sky-400 text-glow-cyan font-medium bg-white/10' : 'text-blue-500 font-medium bg-blue-50/50')
                      : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-gray-700 hover:bg-gray-100')
                  ]"
                >
                  <div class="min-w-0 pr-2">
                    <div class="font-mono text-xs truncate">{{ item.id }}</div>
                    <div v-if="item.owned_by" class="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                      组织/所有者: {{ item.owned_by }}
                    </div>
                  </div>
                  <svg v-if="modelForm.modelName === item.id" class="w-3.5 h-3.5 text-blue-500 shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            </div>
          </transition>
        </div>

        <!-- 2. Base URL -->
        <div>
          <label class="block text-xs font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
            API Base URL <span class="text-red-500">*</span>
          </label>
          <input
            v-model="modelForm.baseUrl"
            placeholder="例如：https://api.deepseek.com/v1"
            :class="[
              'w-full px-3 py-2 rounded-xl text-xs border outline-none transition',
              isDark
                ? 'bg-black/90 border-white/20 text-zinc-100 placeholder-zinc-500 focus:border-cyan-400'
                : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-blue-500 shadow-2xs'
            ]"
          />
        </div>

        <!-- 3. API Key -->
        <div>
          <label class="block text-xs font-medium mb-1" :class="isDark ? 'text-zinc-200 text-glow-subtle' : 'text-gray-700'">
            API Key <span v-if="editingModelId === null" class="text-red-500">*</span>
          </label>
          <div class="relative">
            <input
              v-model="modelForm.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              :placeholder="editingModelId !== null ? '留空保留已有密钥' : '填入您的 API 密钥 (sk-...)'"
              :class="[
                'w-full px-3 py-2 pr-10 rounded-xl text-xs border outline-none transition',
                isDark
                  ? 'bg-black/90 border-white/20 text-zinc-100 placeholder-zinc-500 focus:border-cyan-400'
                  : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-blue-500 shadow-2xs'
              ]"
            />
            <button
              type="button"
              @click="showApiKey = !showApiKey"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer p-1"
              :title="showApiKey ? '隐藏密钥' : '显示密钥'"
            >
              <svg v-if="showApiKey" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
              </svg>
              <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 错误提示 -->
        <div v-if="modelFormError" class="text-xs text-red-500 font-medium">
          {{ modelFormError }}
        </div>
      </div>

      <!-- 底部操作按钮 -->
      <div class="flex items-center justify-end gap-2.5 pt-2">
        <button
          type="button"
          @click="cancelModelForm"
          :class="[
            'px-4 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
            isDark
              ? 'border-white/20 hover:bg-white/10 text-zinc-200 text-glow-subtle'
              : 'border-gray-200 hover:bg-gray-50 text-gray-700'
          ]"
        >
          取消
        </button>

        <button
          type="button"
          @click="saveModelForm"
          :disabled="isSubmittingModel"
          :class="[
            'px-5 py-1.5 rounded-xl text-xs font-medium text-white transition cursor-pointer flex items-center gap-1.5',
            isSubmittingModel ? 'bg-blue-400 cursor-not-allowed' : (isDark ? 'bg-sky-600 hover:bg-sky-500 text-glow-white shadow-[0_0_15px_rgba(56,189,248,0.4)]' : 'bg-blue-600 hover:bg-blue-500 shadow-sm')
          ]"
        >
          <svg v-if="isSubmittingModel" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>{{ isSubmittingModel ? '正在保存...' : '保存' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 下拉菜单向下展开动画 (顶部居中对齐) */
.dropdown-down-center-enter-active {
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top center;
}

.dropdown-down-center-leave-active {
  transition: opacity 0.15s ease-in, transform 0.15s ease-in;
  transform-origin: top center;
}

.dropdown-down-center-enter-from {
  opacity: 0;
  transform: translateY(-8px) scaleY(0.85);
}

.dropdown-down-center-enter-to {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}

.dropdown-down-center-leave-from {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}

.dropdown-down-center-leave-to {
  opacity: 0;
  transform: translateY(-6px) scaleY(0.9);
}
</style>
