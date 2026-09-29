<script setup lang="ts">
import { useMcpTab } from './useMcpTab';
import { MCP_TRANSPORTS } from '../../../types/chat';

defineProps<{
  isDark?: boolean;
}>();

const {
  mcpList,
  isMcpLoading,
  mcpErrorMsg,
  isEditingOrAddingMcp,
  editingMcpId,
  mcpFormError,
  isSubmittingMcp,
  mcpToast,
  mcpForm,
  mcpHeadersPristine,
  loadMcp,
  startAddMcp,
  startEditMcp,
  cancelMcpForm,
  handleSaveMcp,
  handleDeleteMcp,
  handleToggleMcp,
  headerCountOf,
} = useMcpTab();
</script>

<template>
  <div class="space-y-4">
    <!-- Toast 提示 -->
    <div
      v-if="mcpToast"
      class="p-2.5 rounded-xl text-xs bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all flex items-center justify-between"
    >
      <span>{{ mcpToast }}</span>
    </div>

    <!-- 列表视图 -->
    <div v-if="!isEditingOrAddingMcp" class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white">
            MCP 服务
          </h4>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            接入 Model Context Protocol 服务，其工具将在每次执行时注入模型可见的工具集。
          </p>
        </div>
        <button
          type="button"
          @click="startAddMcp"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium cursor-pointer shadow-sm transition"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span>新建服务</span>
        </button>
      </div>

      <!-- 加载中 -->
      <div v-if="isMcpLoading" class="py-8 text-center text-xs text-gray-400">
        正在加载 MCP 服务列表...
      </div>

      <!-- 加载失败 -->
      <div v-else-if="mcpErrorMsg" class="py-6 text-center text-xs text-red-400 space-y-2">
        <p>{{ mcpErrorMsg }}</p>
        <button
          type="button"
          @click="loadMcp"
          class="px-3 py-1 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg cursor-pointer"
        >
          重试
        </button>
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="mcpList.length === 0"
        class="py-12 text-center text-xs text-gray-400 dark:text-gray-500 border border-dashed rounded-2xl"
        :class="isDark ? 'border-gray-800' : 'border-gray-200'"
      >
        暂无配置的 MCP 服务，请点击上方「新建服务」进行添加。
      </div>

      <!-- 服务卡片列表 -->
      <div v-else class="space-y-3">
        <div
          v-for="item in mcpList"
          :key="item.id"
          class="p-3.5 rounded-xl border transition-all"
          :class="[
            isDark
              ? 'bg-[#151c2c] border-[#252f44] hover:border-gray-700'
              : 'bg-gray-50/70 border-gray-200 hover:border-gray-300'
          ]"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-semibold text-gray-900 dark:text-white truncate">
                  {{ item.name }}
                </span>
                <!-- 启停状态徽标 -->
                <span
                  class="px-1.5 py-0.5 rounded-md text-[10px] font-medium shrink-0"
                  :class="item.status === 0
                    ? (isDark ? 'bg-gray-700/60 text-gray-400' : 'bg-gray-200 text-gray-500')
                    : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'"
                >
                  {{ item.status === 0 ? '已停用' : '已启用' }}
                </span>
                <!-- 传输方式 -->
                <span
                  class="px-1.5 py-0.5 rounded-md text-[10px] shrink-0"
                  :class="isDark ? 'bg-white/5 text-gray-400' : 'bg-black/5 text-gray-500'"
                >
                  {{ item.transport || 'streamable-http' }}
                </span>
              </div>

              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 break-all font-mono">
                {{ item.url }}
              </p>

              <div class="flex items-center gap-3 mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">
                <span v-if="headerCountOf(item) > 0">
                  {{ headerCountOf(item) }} 个请求头
                </span>
                <span v-if="item.toolNamePrefix">
                  前缀 {{ item.toolNamePrefix }}
                </span>
                <span v-if="item.executionTimeout">
                  超时 {{ Math.round(item.executionTimeout / 1000) }}s
                </span>
                <span v-if="item.maxOutput">
                  输出上限 {{ item.maxOutput }}
                </span>
              </div>
            </div>

            <!-- 操作区 -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                @click="handleToggleMcp(item)"
                :class="[
                  'px-2 py-1 rounded-lg text-[11px] font-medium transition cursor-pointer',
                  isDark
                    ? 'text-gray-300 hover:bg-white/5'
                    : 'text-gray-600 hover:bg-black/5'
                ]"
              >
                {{ item.status === 0 ? '启用' : '停用' }}
              </button>
              <button
                type="button"
                @click="startEditMcp(item)"
                :class="[
                  'px-2 py-1 rounded-lg text-[11px] font-medium transition cursor-pointer',
                  isDark
                    ? 'text-blue-400 hover:bg-white/5'
                    : 'text-blue-600 hover:bg-black/5'
                ]"
              >
                编辑
              </button>
              <button
                type="button"
                @click="handleDeleteMcp(item)"
                :class="[
                  'px-2 py-1 rounded-lg text-[11px] font-medium transition cursor-pointer',
                  isDark
                    ? 'text-red-400 hover:bg-white/5'
                    : 'text-red-500 hover:bg-black/5'
                ]"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑 / 新增表单 -->
    <div v-else class="space-y-4">
      <h4 class="text-base font-bold tracking-tight text-gray-900 dark:text-white">
        {{ editingMcpId ? '编辑 MCP 服务' : '新建 MCP 服务' }}
      </h4>

      <!-- 服务名称 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">服务名称</label>
        <input
          v-model="mcpForm.name"
          type="text"
          placeholder="如 github、filesystem，需全局唯一"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
            isDark
              ? 'bg-[#151c2c] border-[#252f44] text-gray-100 placeholder-gray-600 focus:border-blue-500'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- 传输方式 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">传输方式</label>
        <div class="flex items-center gap-2">
          <button
            v-for="t in MCP_TRANSPORTS"
            :key="t"
            type="button"
            @click="mcpForm.transport = t"
            :class="[
              'px-3 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
              mcpForm.transport === t
                ? 'bg-blue-600 border-blue-600 text-white'
                : (isDark
                    ? 'border-[#252f44] text-gray-400 hover:bg-white/5'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50')
            ]"
          >
            {{ t }}
          </button>
        </div>
      </div>

      <!-- 服务地址 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">服务地址</label>
        <input
          v-model="mcpForm.url"
          type="text"
          placeholder="https://example.com/mcp/"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
            isDark
              ? 'bg-[#151c2c] border-[#252f44] text-gray-100 placeholder-gray-600 focus:border-blue-500'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- 请求头 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">
          请求头
          <span class="text-gray-400 dark:text-gray-500 font-normal">（一行一个，格式 名称: 值）</span>
        </label>
        <textarea
          v-model="mcpForm.headerLines"
          @input="mcpHeadersPristine = false"
          rows="3"
          placeholder="Authorization: Bearer your-token"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition resize-none font-mono',
            isDark
              ? 'bg-[#151c2c] border-[#252f44] text-gray-100 placeholder-gray-600 focus:border-blue-500'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        ></textarea>
        <p
          v-if="mcpHeadersPristine && mcpForm.headerLines"
          class="text-[11px] text-gray-400 dark:text-gray-500"
        >
          已配置的请求头值已脱敏显示；不作修改即保持原值不变。
        </p>
      </div>

      <!-- 工具名前缀 -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-700 dark:text-gray-300">
          工具名前缀
          <span class="text-gray-400 dark:text-gray-500 font-normal">（可留空，默认用服务名）</span>
        </label>
        <input
          v-model="mcpForm.toolNamePrefix"
          type="text"
          placeholder="如 gh_"
          :class="[
            'w-full px-3 py-2 rounded-xl border text-xs outline-none transition font-mono',
            isDark
              ? 'bg-[#151c2c] border-[#252f44] text-gray-100 placeholder-gray-600 focus:border-blue-500'
              : 'bg-white border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        />
      </div>

      <!-- 超时与输出上限 -->
      <div class="grid grid-cols-3 gap-3">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-gray-700 dark:text-gray-300">初始化超时(ms)</label>
          <input
            v-model.number="mcpForm.initializationTimeout"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-[#151c2c] border-[#252f44] text-gray-100 focus:border-blue-500'
                : 'bg-white border-gray-200 text-gray-800 focus:border-blue-500'
            ]"
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-gray-700 dark:text-gray-300">执行超时(ms)</label>
          <input
            v-model.number="mcpForm.executionTimeout"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-[#151c2c] border-[#252f44] text-gray-100 focus:border-blue-500'
                : 'bg-white border-gray-200 text-gray-800 focus:border-blue-500'
            ]"
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-gray-700 dark:text-gray-300">输出上限</label>
          <input
            v-model.number="mcpForm.maxOutput"
            type="number"
            min="1"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-xs outline-none transition',
              isDark
                ? 'bg-[#151c2c] border-[#252f44] text-gray-100 focus:border-blue-500'
                : 'bg-white border-gray-200 text-gray-800 focus:border-blue-500'
            ]"
          />
        </div>
      </div>

      <!-- 启用开关 -->
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input v-model="mcpForm.enabled" type="checkbox" class="w-3.5 h-3.5 cursor-pointer" />
        <span class="text-xs text-gray-700 dark:text-gray-300">启用该服务</span>
      </label>

      <!-- 表单错误 -->
      <div
        v-if="mcpFormError"
        class="p-2.5 rounded-xl text-xs bg-red-500/10 border border-red-500/20 text-red-500 dark:text-red-400"
      >
        {{ mcpFormError }}
      </div>

      <!-- 底部操作按钮 -->
      <div class="flex items-center justify-end gap-2.5 pt-3 border-t" :class="isDark ? 'border-gray-800' : 'border-gray-200'">
        <button
          type="button"
          @click="cancelMcpForm"
          :class="[
            'px-4 py-1.5 rounded-xl border text-xs font-medium transition cursor-pointer',
            isDark
              ? 'border-gray-700 hover:bg-white/5 text-gray-300'
              : 'border-gray-200 hover:bg-gray-50 text-gray-700'
          ]"
        >
          取消
        </button>
        <button
          type="button"
          :disabled="isSubmittingMcp"
          @click="handleSaveMcp"
          class="px-4 py-1.5 rounded-xl text-xs font-medium text-white cursor-pointer transition shadow-sm"
          :class="[
            isSubmittingMcp ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'
          ]"
        >
          {{ isSubmittingMcp ? '正在保存...' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
