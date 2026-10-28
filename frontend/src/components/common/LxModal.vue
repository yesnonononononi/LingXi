<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

/**
 * 通用弹窗外壳（遮罩 + 面板 + 关闭策略 + 无障碍语义）。
 *
 * 存在的理由：此前 WorkspaceModal / TeamModal / SettingsModal / ConfirmModal 各写一套遮罩 div，
 * 关闭策略（点遮罩、Esc）散落在各个模板里靠人肉记忆，结果是「这个能点遮罩、那个不能」全靠运气，
 * 并且嵌套浮层的 Esc 会冒泡到 window，连坐关掉外层弹窗（设置面板就踩过这个坑）。
 *
 * 关闭策略是**显式契约**，不是隐含默认：
 * | 场景              | closeOnBackdrop | closeOnEsc |
 * |-------------------|-----------------|------------|
 * | 危险/确认类小弹窗   | true            | true       |
 * | 含未保存表单的面板  | false           | false      |
 *
 * 约定：遮罩必须由调用方给出 z-* 与底色/模糊/入场动画（见 overlayClass），
 * 面板尺寸与配色由调用方给出（见 panelClass）——外壳不猜业务样式。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 点击遮罩是否关闭（默认 true） */
    closeOnBackdrop?: boolean;
    /** 按 Esc 是否关闭（默认 true）；关闭时**不注册**任何 window 监听 */
    closeOnEsc?: boolean;
    /** 遮罩层附加类：必须自带 z-* / 底色 / 模糊 / 入场动画 */
    overlayClass?: string;
    /** 面板类：尺寸、圆角、内边距、主题配色 */
    panelClass?: string;
    /** 对话框可访问名称；缺省时读屏只报「对话框」 */
    ariaLabel?: string;
    /** 过渡名（如 'lx-modal'）；留空表示不加过渡 */
    transitionName?: string;
    /**
     * 是否 Teleport 到 body（默认 true）。
     * 置 false 时原样在父级内渲染——给「定位容器已被 transform/overflow 框住」的场景留出口
     * （例如视觉基线把弹窗塞进一个 position:relative; transform 的 section 里截图）。
     */
    teleport?: boolean;
  }>(),
  {
    closeOnBackdrop: true,
    closeOnEsc: true,
    overlayClass: '',
    panelClass: '',
    ariaLabel: '',
    transitionName: '',
    teleport: true,
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const close = (source: 'backdrop' | 'esc') => {
  // 弹窗已关闭仍可能收到点击（过渡动画期间遮罩还在 DOM 里），这里兜一层避免重复 emit
  if (!props.open) return;
  if (source === 'backdrop' && !props.closeOnBackdrop) return;
  // Esc 的闸门只有一个：监听器是否存在（见 syncKeydown）。这里不再重复判断，
  // 否则两处守卫互相兜底，任何一处单独失效都无法通过行为测试暴露出来。
  emit('close');
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') close('esc');
};

const listening = ref(false);
/** 只在「打开且允许 Esc」时挂监听：监听器本身就是一种契约，不需要时不该存在 */
const syncKeydown = () => {
  const shouldListen = props.open && props.closeOnEsc;
  if (shouldListen === listening.value) return;
  listening.value = shouldListen;
  if (shouldListen) window.addEventListener('keydown', handleKeydown);
  else window.removeEventListener('keydown', handleKeydown);
};

watch(() => [props.open, props.closeOnEsc] as const, syncKeydown, { immediate: true });

onBeforeUnmount(() => {
  if (listening.value) window.removeEventListener('keydown', handleKeydown);
  listening.value = false;
});
</script>

<template>
  <Teleport to="body" :disabled="!teleport">
    <Transition :name="transitionName">
      <div
        v-if="open"
        class="fixed inset-0 flex items-center justify-center p-4"
        :class="overlayClass"
        @click.self="close('backdrop')"
      >
        <div
          role="dialog"
          aria-modal="true"
          :aria-label="ariaLabel || undefined"
          :class="panelClass"
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* transitionName="lx-modal" 时生效；不传则该过渡不会被使用 */
.lx-modal-enter-active,
.lx-modal-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.lx-modal-enter-from,
.lx-modal-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
