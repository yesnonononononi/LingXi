<script setup lang="ts">
defineProps<{
  content: string;
  recipientName?: string;
  isDark: boolean;
}>();
</script>

<template>
  <section class="w-full min-w-0 space-y-4" data-testid="delegated-task">
    <p
      class="text-[15px] leading-7 break-words"
      :class="isDark ? 'text-zinc-200' : 'text-[#33473e]'"
    >@{{ recipientName }}，你有一条待处理任务，请查收</p>

    <details open class="group/task">
      <summary
        class="flex w-fit items-center gap-1.5 text-xs leading-6 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden"
        :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-[#8a9690] hover:text-[#53665a]'"
      >
        <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 4l3 3 3-3M7 7h10a3 3 0 013 3v5a3 3 0 01-3 3H7a3 3 0 01-3-3v-5a3 3 0 013-3zM8 11h.01M16 11h.01M9 15h6M8 18l-2 3M16 18l2 3" />
        </svg>
        <span>下发任务详情</span>
        <svg class="h-3 w-3 transition-transform group-open/task:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <div
        class="mt-2 max-h-72 overflow-y-auto overscroll-contain rounded-[20px] px-5 py-4 scrollbar-thin"
        :class="isDark ? 'bg-[#171e1b] text-zinc-200' : 'bg-[#f5f8f5] text-[#263d32]'"
        tabindex="0"
        aria-label="下发任务详情"
        data-testid="delegated-task-content"
      >
        <div class="whitespace-pre-wrap break-words font-mono text-sm leading-7 select-text">{{ content }}</div>
      </div>
    </details>
  </section>
</template>
