<!--
  主页背景层（可被插件替换的最外层画布）。

  设计约束（见 .lingxi/plan/plugin-frontend-arch.md）：本组件**无 props、无状态**，
  明暗差异 100% 由 CSS 变量承担 —— `--lx-canvas` 与两个光晕令牌在 tokens.css 的
  `:root`（暗色默认）与 `html.light / html[data-theme="light"]`（亮色）两套作用域里各自取值。
  因此这里既不读 useTheme，也不在模板里按主题真假分支渲染：多一条主题通道就多一处与主题同步失配的机会。

  插件扩展点：根元素的 `background-image` 取 `var(--lx-canvas-image, none)`
  （默认 none），换背景图只需有插件给这个变量赋值，模板零改动。
-->
<template>
  <!-- pointer-events-none + absolute inset-0：必须能点穿，绝不能拦住下层交互；aria-hidden：纯装饰 -->
  <div class="lx-chat-background pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
    <!-- 装饰表面：由宿主在 BACKGROUND_SLOTS_KEY 下注册（图片背景 / 令牌背景），未注册则回落内置令牌背景 -->
    <component :is="slotOverrides?.surface ?? TokenBackground" />
  </div>
</template>

<script setup lang="ts">
/**
 * 聊天页唯一背景层（画布根）。
 *
 * <p>刻意不接收任何 props：主题只走 CSS 变量单通道（tokens.css 里两套作用域自切换），
 * 这样插件替换背景层时不需要知道宿主的主题状态模型。</p>
 *
 * <p><b>L2 职责切分：</b>根元素与其底色/背景图样式属于宿主（换肤与插件背景图靠这两个变量），
 * 可替换的只有根元素内部的「装饰表面」。表面来自 inject，本组件只做
 * 「<b>按字段判空</b> + 回落内置实现」两件事，不持有任何状态。</p>
 *
 * <p><b>为什么按字段判空而不能按对象真值判：</b>宿主 provide 一个空对象时对象本身为真，
 * 但 `surface` 仍是 undefined；若写成 `slots ? slots.surface : Default` 就会把 undefined
 * 交给 `<component :is>`，渲染出空占位而不是回落（与 chatMessageSlots.ts 的要求同源）。</p>
 */
import { inject } from 'vue';
import TokenBackground from '../background/TokenBackground.vue';
import { BACKGROUND_SLOTS_KEY } from '../../types/backgroundSlots';
import type { ChatBackgroundSlots } from '../../types/backgroundSlots';

const slotOverrides = inject<ChatBackgroundSlots | undefined>(BACKGROUND_SLOTS_KEY, undefined);
</script>

<style scoped>
/* 底色与可选背景图都走令牌/变量，保证换肤与插件覆盖都不需要改模板 */
.lx-chat-background {
  background-color: var(--lx-canvas);
  background-image: var(--lx-canvas-image, none);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  /* 填充方式由用户偏好在文档根上赋值（铺满 cover / 适应 contain）。未设置时回落 cover，
     与抽取前的 `background-size: cover` 逐像素等价；上面那条 cover 声明是显式兜底。 */
  background-size: var(--lx-canvas-fit, cover);
}
</style>
