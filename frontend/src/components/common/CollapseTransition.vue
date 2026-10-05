<script setup lang="ts">
/**
 * 平滑折叠展开过渡组件 (Collapse / Accordion Transition)
 * 基于 Vue 原生 Transition 系统与 CSS transition 监听，
 * 动态测量 scrollHeight，实现平滑的高度与透明度渐变。
 */

withDefaults(
  defineProps<{
    duration?: number;
  }>(),
  {
    duration: 250
  }
);

const onBeforeEnter = (el: Element) => {
  const elem = el as HTMLElement;
  elem.dataset.oldPaddingTop = elem.style.paddingTop;
  elem.dataset.oldPaddingBottom = elem.style.paddingBottom;
  elem.style.height = '0px';
  elem.style.opacity = '0';
  elem.style.paddingTop = '0px';
  elem.style.paddingBottom = '0px';
};

const onEnter = (el: Element) => {
  const elem = el as HTMLElement;
  elem.style.paddingTop = elem.dataset.oldPaddingTop || '';
  elem.style.paddingBottom = elem.dataset.oldPaddingBottom || '';
  if (elem.scrollHeight !== 0) {
    elem.style.height = `${elem.scrollHeight}px`;
  } else {
    elem.style.height = '';
  }
  elem.style.opacity = '1';
};

const onAfterEnter = (el: Element) => {
  const elem = el as HTMLElement;
  elem.style.height = '';
  elem.style.opacity = '';
  elem.style.paddingTop = elem.dataset.oldPaddingTop || '';
  elem.style.paddingBottom = elem.dataset.oldPaddingBottom || '';
};

const onBeforeLeave = (el: Element) => {
  const elem = el as HTMLElement;
  elem.dataset.oldPaddingTop = elem.style.paddingTop;
  elem.dataset.oldPaddingBottom = elem.style.paddingBottom;
  elem.style.height = `${elem.scrollHeight}px`;
  elem.style.opacity = '1';
};

const onLeave = (el: Element) => {
  const elem = el as HTMLElement;
  if (elem.scrollHeight !== 0) {
    void elem.offsetHeight; // 强制回流记录当前高度
    elem.style.height = '0px';
    elem.style.opacity = '0';
    elem.style.paddingTop = '0px';
    elem.style.paddingBottom = '0px';
  }
};

const onAfterLeave = (el: Element) => {
  const elem = el as HTMLElement;
  elem.style.height = '';
  elem.style.opacity = '';
  elem.style.paddingTop = elem.dataset.oldPaddingTop || '';
  elem.style.paddingBottom = elem.dataset.oldPaddingBottom || '';
};
</script>

<template>
  <Transition
    name="collapse-transition"
    @before-enter="onBeforeEnter"
    @enter="onEnter"
    @after-enter="onAfterEnter"
    @before-leave="onBeforeLeave"
    @leave="onLeave"
    @after-leave="onAfterLeave"
  >
    <slot />
  </Transition>
</template>

<style>
.collapse-transition-enter-active {
  transition: height 260ms cubic-bezier(0.25, 0.1, 0.25, 1),
              opacity 220ms ease,
              padding-top 260ms ease,
              padding-bottom 260ms ease !important;
  overflow: hidden !important;
}

.collapse-transition-leave-active {
  transition: height 230ms cubic-bezier(0.25, 0.1, 0.25, 1),
              opacity 180ms ease,
              padding-top 230ms ease,
              padding-bottom 230ms ease !important;
  overflow: hidden !important;
}
</style>
