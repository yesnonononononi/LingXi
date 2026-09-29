<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useConfirm } from '../../composables/useConfirm'

const { state, handleConfirm, handleCancel } = useConfirm()

const typeConfig = computed(() => {
  const t = state.value.options.type || 'info'
  switch (t) {
    case 'danger':
      return {
        iconBg: 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400',
        confirmBtn: 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white'
      }
    case 'warning':
      return {
        iconBg: 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400',
        confirmBtn: 'bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white'
      }
    case 'success':
      return {
        iconBg: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400',
        confirmBtn: 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white'
      }
    case 'info':
    default:
      return {
        iconBg: 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400',
        confirmBtn: 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white'
      }
  }
})

const handleKeyDown = (e: KeyboardEvent) => {
  if (!state.value.isOpen) return
  if (e.key === 'Escape') {
    handleCancel()
  } else if (e.key === 'Enter') {
    handleConfirm()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div
        v-if="state.isOpen"
        class="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/45 backdrop-blur-sm transition-all duration-200 select-none"
        @click.self="handleCancel"
      >
        <div
          class="w-full max-w-[360px] bg-white dark:bg-[#1a1c23] rounded-2xl shadow-xl shadow-black/10 border border-gray-100 dark:border-white/10 p-5 sm:p-5.5 flex flex-col gap-4 transform transition-all duration-200"
        >
          <!-- Top: Icon & Text content -->
          <div class="flex items-start gap-3.5">
            <!-- Compact Type Icon -->
            <div
              class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              :class="typeConfig.iconBg"
            >
              <!-- Danger Icon -->
              <svg
                v-if="state.options.type === 'danger'"
                class="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                />
              </svg>

              <!-- Warning Icon -->
              <svg
                v-else-if="state.options.type === 'warning'"
                class="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
              </svg>

              <!-- Success Icon -->
              <svg
                v-else-if="state.options.type === 'success'"
                class="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>

              <!-- Info Icon -->
              <svg
                v-else
                class="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
                />
              </svg>
            </div>

            <!-- Title & Description -->
            <div class="flex-1 min-w-0 pt-0.5">
              <h3 class="text-base font-semibold text-gray-900 dark:text-gray-100">
                {{ state.options.title || '操作确认' }}
              </h3>
              <p class="mt-1 text-xs sm:text-sm text-gray-500 dark:text-gray-400 leading-relaxed break-words whitespace-pre-line">
                {{ state.options.content }}
              </p>
            </div>
          </div>

          <!-- Bottom Action Buttons -->
          <div class="flex items-center justify-end gap-2.5 pt-1">
            <button
              v-if="state.options.showCancel"
              type="button"
              class="px-3.5 py-1.5 text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white bg-gray-100 hover:bg-gray-200/80 dark:bg-white/5 dark:hover:bg-white/10 rounded-xl border border-gray-200/80 dark:border-white/10 transition-colors focus:outline-none cursor-pointer active:scale-95"
              @click="handleCancel"
            >
              {{ state.options.cancelText || '取消' }}
            </button>

            <button
              type="button"
              class="px-4 py-1.5 text-xs sm:text-sm font-medium rounded-xl transition-colors focus:outline-none cursor-pointer active:scale-95 shadow-sm"
              :class="typeConfig.confirmBtn"
              @click="handleConfirm"
            >
              {{ state.options.confirmText || '确定' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
