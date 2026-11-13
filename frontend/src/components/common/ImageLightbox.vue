<script setup lang="ts">
import {nextTick, ref, watch} from 'vue';
import {t} from '../../i18n';

/**
 * 图片放大预览对话框 —— 全站唯一实现。
 *
 * <p>为什么必须只有这一份：原生 `<dialog>` + `showModal()` 自带焦点陷阱、Esc 关闭，且关闭时
 * 浏览器会把焦点还给触发元素；各写一份迟早走偏。消息气泡（`MessageImage`）与输入区附件 chip
 * 都指到这里，不要再手写第二套遮罩/关闭逻辑。</p>
 */

const props = withDefaults(defineProps<{
  /** 是否显示（受控）：本组件只发 `close`，状态始终由宿主持有。 */
  open: boolean;
  /** 大图地址；关闭后宿主可继续保留，dialog 元素因此不重建（焦点回收要靠它）。 */
  src: string;
  /** 可读名称（文件名或图片说明），用于对话框 `aria-label` 与标题行。 */
  name: string;
  /** 追加在 dialog 元素上的类名，供既有样式钩子沿用时使用。 */
  dialogClass?: string;
  /** dialog 的 `data-testid`；缺省不渲染该属性。 */
  testId?: string | null;
}>(), {
  dialogClass: '',
  testId: null,
});

const emit = defineEmits<{(event: 'close'): void}>();

const dialogRef = ref<HTMLDialogElement | null>(null);

/** 请求关闭：只发意图，受控状态归宿主。 */
const requestClose = (): void => {
  emit('close');
};

/**
 * 把 `open` 同步到原生 dialog。
 *
 * <p>没有 `showModal` 的环境（组件测试的内存渲染器没有 UA）直接跳过：那里宿主状态就是事实，
 * 强行调用只会抛 TypeError。</p>
 */
const syncDialog = (open: boolean): void => {
  const dialog = dialogRef.value;
  if (!dialog) return;
  if (open) {
    if (!dialog.open && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
    return;
  }
  if (dialog.open) {
    dialog.close();
  }
};

watch(() => props.open, async (open: boolean) => {
  // 首帧元素还没挂上（immediate），等一次渲染再同步。
  await nextTick();
  syncDialog(open);
}, {immediate: true});

/**
 * Esc 关闭。
 *
 * <p>原生 modal 在 Esc 时会派 `cancel`（模板里也接了同一条路径），但内存渲染器没有 UA 行为，
 * 显式处理同一意图才能让「Esc 一定能关」被守护。`stopPropagation` 防止冒泡去关掉外层浮层。</p>
 */
const handleKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  requestClose();
};
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialogRef"
      class="lx-image-lightbox"
      :class="dialogClass"
      :data-testid="testId"
      :data-open="open ? '' : undefined"
      :aria-label="t('chat.message.previewImage', {path: name})"
      @close="requestClose"
      @cancel.prevent="requestClose"
      @click.self="requestClose"
      @keydown="handleKeydown"
    >
      <div class="lx-image-lightbox__toolbar">
        <span class="lx-image-lightbox__name text-lx-fs-lg">{{ name }}</span>
        <button
          type="button"
          autofocus
          class="lx-image-lightbox__close"
          :aria-label="t('common.close')"
          :title="t('common.close')"
          @click.stop="requestClose"
        >×</button>
      </div>
      <img
        v-if="open"
        class="lx-image-lightbox__image"
        :src="src"
        :alt="name"
        decoding="async"
      />
    </dialog>
  </Teleport>
</template>

<style scoped>
/* 尺寸/圆角/配色只走语义令牌：换肤时这里不需要再改一次。 */
.lx-image-lightbox {
  margin: auto;
  padding: 1rem;
  width: fit-content;
  max-width: 94vw;
  max-height: 94vh;
  border: 1px solid var(--lx-border-default);
  border-radius: var(--lx-radius-md);
  background: var(--lx-surface-elevated);
  box-shadow: var(--lx-shadow-3);
  color: var(--lx-text-secondary);
}

.lx-image-lightbox::backdrop {
  background: var(--lx-overlay);
}

.lx-image-lightbox__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.lx-image-lightbox__name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.lx-image-lightbox__close {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border: 0;
  border-radius: var(--lx-radius-sm);
  background: transparent;
  color: inherit;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.lx-image-lightbox__close:hover {
  background: var(--lx-surface-hover);
}

.lx-image-lightbox__close:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}

.lx-image-lightbox__image {
  display: block;
  max-width: 100%;
  max-height: 78vh;
  margin: auto;
  object-fit: contain;
}

/* 过渡动画只在用户没有要求「减少动态效果」时生效。 */
@media (prefers-reduced-motion: no-preference) {
  .lx-image-lightbox[open] {
    animation: lx-image-lightbox-in 160ms cubic-bezier(0.23, 1, 0.32, 1) both;
  }
}

@keyframes lx-image-lightbox-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>