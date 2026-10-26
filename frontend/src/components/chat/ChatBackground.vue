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
    <!-- 顶部环境光晕：暗色为极微弱蓝/靛蓝辉光，亮色下两个令牌皆为 transparent，故天然不可见 -->
    <div class="lx-chat-background__glow pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[360px] blur-3xl"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * 聊天页唯一背景层。
 *
 * <p>刻意不接收任何 props：主题只走 CSS 变量单通道（tokens.css 里两套作用域自切换），
 * 这样插件替换背景层时不需要知道宿主的主题状态模型。</p>
 */
</script>

<style scoped>
/* 底色与可选背景图都走令牌/变量，保证换肤与插件覆盖都不需要改模板 */
.lx-chat-background {
  background-color: var(--lx-canvas);
  background-image: var(--lx-canvas-image, none);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

/* 光晕色取自令牌：亮色主题下取值为 transparent，等价于原来「亮色不渲染光晕」的视觉结果 */
.lx-chat-background__glow {
  background-image: linear-gradient(
    to bottom,
    var(--lx-canvas-glow-from),
    var(--lx-canvas-glow-via),
    transparent
  );
}
</style>
