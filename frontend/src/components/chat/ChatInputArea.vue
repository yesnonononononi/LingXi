<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{
  isSending?: boolean;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'sendMessage', text: string, isDeepThink: boolean, isHybridSearch: boolean): void;
  (e: 'stopGeneration'): void;
}>();

const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

// 开关状态
const isDeepThink = ref(true);     // 默认开启深度思考 (R1)
const isHybridSearch = ref(false);  // 默认关闭联网搜索

const adjustHeight = () => {
  if (!textareaRef.value) return;
  textareaRef.value.style.height = 'auto';
  textareaRef.value.style.height = `${Math.min(textareaRef.value.scrollHeight, 180)}px`;
};

watch(inputText, () => {
  nextTick(adjustHeight);
});

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};

const handleSend = () => {
  if (!inputText.value.trim() || props.isSending) return;
  emit('sendMessage', inputText.value.trim(), isDeepThink.value, isHybridSearch.value);
  inputText.value = '';
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
  }
};

// 暴露对外设置输入框方法
defineExpose({
  setInputText: (text: string) => {
    inputText.value = text;
    nextTick(adjustHeight);
  }
});
</script>

<template>
  <div class="w-full max-w-3xl mx-auto px-4 pb-4 pt-2 select-none">
    <!-- Floating Round Card Container -->
    <div
      :class="[
        'relative rounded-2xl border shadow-xl transition-all p-3 flex flex-col gap-2',
        isDark 
          ? 'bg-[#161b26] border-[#273043] focus-within:border-blue-500/60' 
          : 'bg-white border-gray-200 focus-within:border-blue-400'
      ]"
    >
      <!-- Textarea Input -->
      <textarea
        ref="textareaRef"
        v-model="inputText"
        @keydown="handleKeyDown"
        rows="1"
        placeholder="给 灵犀 Agent 发送消息... (Shift+Enter 换行)"
        :class="[
          'w-full bg-transparent outline-none border-none resize-none text-sm leading-relaxed px-1 max-h-44 scrollbar-thin',
          isDark ? 'text-gray-100 placeholder-gray-500' : 'text-gray-800 placeholder-gray-400'
        ]"
      ></textarea>

      <!-- Bottom Toolbar Row -->
      <div class="flex items-center justify-between pt-1">
        <!-- Feature Mode Toggles -->
        <div class="flex items-center gap-2">
          <!-- DeepThink (R1) Toggle -->
          <button
            @click="isDeepThink = !isDeepThink"
            :class="[
              'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition border',
              isDeepThink 
                ? 'bg-blue-600/15 border-blue-500/50 text-blue-400 shadow-sm shadow-blue-500/10' 
                : (isDark ? 'bg-[#1e2638] border-transparent text-gray-400 hover:text-gray-200' : 'bg-gray-100 border-transparent text-gray-600')
            ]"
            title="开启/关闭 DeepThink 深度思考 (R1 推理链)"
          >
            <span>🧠</span>
            <span>深度思考 (R1)</span>
            <span v-if="isDeepThink" class="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
          </button>

          <!-- Web Search Toggle -->
          <button
            @click="isHybridSearch = !isHybridSearch"
            :class="[
              'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition border',
              isHybridSearch 
                ? 'bg-indigo-600/15 border-indigo-500/50 text-indigo-400 shadow-sm' 
                : (isDark ? 'bg-[#1e2638] border-transparent text-gray-400 hover:text-gray-200' : 'bg-gray-100 border-transparent text-gray-600')
            ]"
            title="开启/关闭 联网混合搜索"
          >
            <span>🌐</span>
            <span>联网搜索</span>
            <span v-if="isHybridSearch" class="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
          </button>
        </div>

        <!-- Send / Stop Button -->
        <div>
          <button
            v-if="isSending"
            @click="emit('stopGeneration')"
            class="p-2 rounded-xl bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30 transition flex items-center gap-1 text-xs font-medium"
            title="停止生成"
          >
            <div class="w-2.5 h-2.5 bg-red-400 rounded-sm animate-pulse"></div>
            <span>停止</span>
          </button>

          <button
            v-else
            @click="handleSend"
            :disabled="!inputText.trim()"
            :class="[
              'p-2 rounded-xl transition flex items-center justify-center shadow-md',
              inputText.trim() 
                ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer' 
                : (isDark ? 'bg-[#1e2638] text-gray-600 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
            ]"
            title="发送消息"
          >
            <svg class="w-4 h-4 transform rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19V5m0 0l-7 7m7-7l7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Bottom Notice -->
    <div class="mt-2 text-center text-[11px] text-gray-500 opacity-70 tracking-wide">
      内容由 灵犀 AI 生成，仅供参考，请谨慎甄别
    </div>
  </div>
</template>
