<script setup lang="ts">
import { ref } from 'vue';
import { AuthAPI } from '../../services/api';

const emit = defineEmits(['loginSuccess', 'toggleTheme']);
defineProps<{ isDark?: boolean }>();

const isRegisterMode = ref(false);
const phone = ref('');
const password = ref('');
const smsCode = ref('');
const errorMsg = ref('');
const isLoading = ref(false);

const handleSubmit = async () => {
  errorMsg.value = '';
  if (!phone.value || !password.value) {
    errorMsg.value = '请填写完整账号和密码';
    return;
  }

  isLoading.value = true;
  try {
    if (isRegisterMode.value) {
      const res = await AuthAPI.register({
        phoneNumber: phone.value,
        password: password.value,
        smsCode: Number(smsCode.value) || 123456
      });
      if (res.code === 200) {
        isRegisterMode.value = false;
        errorMsg.value = '注册成功，请登录';
      } else {
        errorMsg.value = res.errMsg || '注册失败';
      }
    } else {
      const res = await AuthAPI.login({
        phoneNumber: phone.value,
        passWord: password.value
      });
      if (res.code === 200) {
        emit('loginSuccess');
      } else {
        errorMsg.value = res.errMsg || '登录失败';
      }
    }
  } catch (err: any) {
    errorMsg.value = err.message || '网络请求异常';
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-900 text-white p-4">
    <div class="w-full max-w-md bg-gray-800 rounded-2xl shadow-xl p-8 border border-gray-700">
      <div class="text-center mb-8">
        <h2 class="text-3xl font-bold tracking-tight text-white">
          {{ isRegisterMode ? '创建灵犀账号' : '登录灵犀系统' }}
        </h2>
        <p class="text-sm text-gray-400 mt-2">基于 AI 智能交互 Agent 架构</p>
      </div>

      <form @submit.prevent="handleSubmit" class="space-y-5">
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">手机号码</label>
          <input 
            v-model="phone" 
            type="text" 
            placeholder="请输入手机号" 
            class="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">密码</label>
          <input 
            v-model="password" 
            type="password" 
            placeholder="请输入密码" 
            class="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div v-if="isRegisterMode">
          <label class="block text-sm font-medium text-gray-300 mb-1">6位验证码</label>
          <input 
            v-model="smsCode" 
            type="number" 
            placeholder="例如: 123456" 
            class="w-full px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div v-if="errorMsg" class="text-red-400 text-sm font-medium">
          {{ errorMsg }}
        </div>

        <button 
          type="submit" 
          :disabled="isLoading"
          class="w-full py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 font-semibold transition text-white shadow-lg disabled:opacity-50"
        >
          {{ isLoading ? '处理中...' : (isRegisterMode ? '立即注册' : '登 录') }}
        </button>
      </form>

      <div class="mt-6 text-center text-sm text-gray-400">
        <span>{{ isRegisterMode ? '已有账号？' : '还没有账号？' }}</span>
        <button 
          @click="isRegisterMode = !isRegisterMode; errorMsg = ''" 
          class="text-indigo-400 hover:underline ml-1 font-medium"
        >
          {{ isRegisterMode ? '返回登录' : '立即注册' }}
        </button>
      </div>
    </div>
  </div>
</template>
