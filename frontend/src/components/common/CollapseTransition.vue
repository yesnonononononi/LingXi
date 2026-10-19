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
/* 裁剪一律用 clip-path 而不是 overflow: hidden。
   overflow: hidden 会让折叠块在动画期间变成 BFC，块内子元素的上下 margin 不再塌陷：
   onEnter 量到的 scrollHeight 因此比展开结束后的稳态高度多出这些 margin（实测多 16px），
   动画走完、Transition 类被移除的瞬间高度回落 —— 展开等于先撑高再缩回，就是那个「弹跳」；
   leave 方向同理，收起开始时块内内容会先整体下移一次。
   clip-path 只裁剪绘制、不建立 BFC，动画期间与稳态的盒模型完全一致，两个方向都不再有跳变。 */
.collapse-transition-enter-active {
  transition: height 260ms cubic-bezier(0.25, 0.1, 0.25, 1),
              opacity 220ms ease,
              padding-top 260ms ease,
              padding-bottom 260ms ease !important;
  clip-path: inset(0) !important;
}

/* leave 方向在 clip-path 之外还必须加 overflow: clip。
   只靠 clip-path 时，动画把元素高度缩到 0，但子树仍是自然高度 —— clip-path 只裁绘制、
   不参与祖先的滚动溢出计算，子树会一直撑着滚动容器的 scrollHeight；等 Transition 结束、
   Vue 摘掉元素的那一刻，这份溢出瞬间消失（实测单帧掉 128px），吸底逻辑同帧跟着拽
   scrollTop，整条消息列表就是「瞬一下」。overflow: clip 把子树挡进元素的溢出裁剪区，
   scrollHeight 跟着动画平滑下降，摘元素时不再有突降。
   ⚠️ 必须是 clip 而不是 hidden：hidden 会建 BFC，块内 margin 不再塌陷（实测内部溢出
   从 244px 变 252px），收起开始时内容会先位移、底部还被裁掉一截；clip 不建 BFC，
   实测内部溢出与不写 overflow 完全一致。 */
.collapse-transition-leave-active {
  transition: height 230ms cubic-bezier(0.25, 0.1, 0.25, 1),
              opacity 180ms ease,
              padding-top 230ms ease,
              padding-bottom 230ms ease !important;
  clip-path: inset(0) !important;
  overflow: clip;
}
</style>
