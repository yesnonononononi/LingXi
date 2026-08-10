<script setup lang="ts">
import { ref } from 'vue';
import { AuthAPI } from '../../services/api';

defineProps<{ isDark?: boolean }>();
const emit = defineEmits(['close', 'toggleTheme', 'clearSessions']);

const oldPassword = ref('');
const newPassword = ref('');
const msg = ref('');
const isSuccess = ref(false);

const handleResetPassword = async () => {
  msg.value = '';
  if (!oldPassword.value || !newPassword.value) {
    msg.value = '请输入原密码与新密码';
    isSuccess.value = false;
    return;
  }
  const res = await AuthAPI.resetPass(oldPassword.value, newPassword.value);
  if (res.code === 200) {
    msg.value = '密码修改成功';
    isSuccess.value = true;
    oldPassword.value = '';
    newPassword.value = '';
  } else {
    msg.value = res.errMsg || '修改密码失败';
    isSuccess.value = false;
  }
};
</script>

<template>
  <div class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
    <div class="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
      <div class="flex justify-between items-center mb-6">
        <h3 class="text-lg font-bold text-white">系统与账号设置</h3>
        <button @click="emit('close')" class="text-gray-400 hover:text-white text-lg">✕</button>
      </div>

      <div class="space-y-4">
        <div class="border-b border-gray-800 pb-4">
          <h4 class="text-sm font-semibold text-gray-300 mb-3">修改登录密码</h4>
          <div class="space-y-3">
            <input 
              v-model="oldPassword" 
              type="password" 
              placeholder="当前旧密码" 
              class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input 
              v-model="newPassword" 
              type="password" 
              placeholder="至少10位新密码" 
              class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button 
              @click="handleResetPassword" 
              class="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold"
            >
              提交修改
            </button>
            <p v-if="msg" :class="['text-xs mt-1 font-medium', isSuccess ? 'text-green-400' : 'text-red-400']">{{ msg }}</p>
          </div>
        </div>

        <div class="flex justify-between items-center py-2">
          <span class="text-sm text-gray-300">清空历史对话记录</span>
          <button @click="emit('clearSessions')" class="px-3 py-1.5 bg-red-950/60 hover:bg-red-900 border border-red-800/50 text-red-300 rounded-lg text-xs">
            清空
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
