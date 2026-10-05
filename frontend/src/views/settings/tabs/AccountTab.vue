<script setup lang="ts">
defineProps<{
  isDark?: boolean;
}>();
</script>

<template>
  <div class="space-y-3.5 text-xs">
    <!-- 用户名 -->
    <div class="flex items-center justify-between py-1.5">
      <span class="text-gray-800 dark:text-zinc-200 dark:text-glow-subtle">用户名</span>
      <div class="flex items-center gap-1.5 text-gray-500 dark:text-zinc-300">
        <span>灵犀用户</span>
        <!-- WeChat Icon -->
        <svg class="w-4 h-4 text-[#07c160] inline shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .157-.043l1.908-1.097c.18-.104.394-.132.593-.08a10.027 10.027 0 0 0 2.966.444c.32 0 .633-.017.944-.047a6.837 6.837 0 0 1-.223-1.74c0-3.693 3.447-6.69 7.712-6.69.278 0 .55.013.82.037C17.065 5.568 13.23 2.188 8.691 2.188zm-2.58 4.24a1.06 1.06 0 1 1 0 2.12 1.06 1.06 0 0 1 0-2.12zm5.16 0a1.06 1.06 0 1 1 0 2.12 1.06 1.06 0 0 1 0-2.12zM15.42 10.3c-3.626 0-6.567 2.508-6.567 5.602 0 1.706.897 3.237 2.302 4.269.112.083.178.21.17.35l-.297 1.137c-.015.054-.037.108-.037.164 0 .126.1.227.224.227a.25.25 0 0 0 .12-.033l1.464-.843a.62.62 0 0 1 .454-.061c.69.195 1.43.3 2.167.3 3.626 0 6.567-2.508 6.567-5.602 0-3.094-2.94-5.602-6.567-5.602zm-2.13 2.827a.815.815 0 1 1 0 1.63.815.815 0 0 1 0-1.63zm4.26 0a.815.815 0 1 1 0 1.63.815.815 0 0 1 0-1.63z" />
        </svg>
      </div>
    </div>
    <div class="h-px bg-gray-100 dark:bg-white/10"></div>

    <!-- 邮箱 -->
    <div class="flex items-center justify-between py-1.5">
      <span class="text-gray-800 dark:text-zinc-200 dark:text-glow-subtle">邮箱</span>
      <span class="text-gray-600 dark:text-zinc-300">215*****89@qq.com</span>
    </div>
    <div class="h-px bg-gray-100 dark:bg-white/10"></div>

    <!-- 手机号码 -->
    <div class="flex items-center justify-between py-1.5">
      <span class="text-gray-800 dark:text-zinc-200 dark:text-glow-subtle">手机号码</span>
      <div class="flex items-center gap-2">
        <span class="text-gray-600 dark:text-zinc-300">185******27</span>
        <button class="text-cyan-500 dark:text-cyan-400 hover:underline cursor-pointer">变更</button>
      </div>
    </div>
    <div class="h-px bg-gray-100 dark:bg-white/10"></div>

    <!-- 微信 -->
    <div class="flex items-center justify-between py-1.5">
      <span class="text-gray-800 dark:text-zinc-200 dark:text-glow-subtle">微信</span>
      <div class="flex items-center gap-2">
        <span class="text-gray-600 dark:text-zinc-300">已绑定</span>
        <button class="text-cyan-500 dark:text-cyan-400 hover:underline cursor-pointer">解绑</button>
      </div>
    </div>
    <div class="h-px bg-gray-100 dark:bg-white/10"></div>

    <!-- 未成年人模式 -->
    <div class="flex items-center justify-between py-1.5">
      <span class="text-gray-800 dark:text-zinc-200 dark:text-glow-subtle">未成年人模式</span>
      <div class="flex items-center gap-2">
        <span class="text-gray-600 dark:text-zinc-300">已关闭</span>
        <button class="text-cyan-500 dark:text-cyan-400 hover:underline cursor-pointer">变更</button>
      </div>
    </div>
  </div>
</template>
