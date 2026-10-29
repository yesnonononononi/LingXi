<!--
  纯令牌背景表面（默认实现）。

  <p>内容与抽取前 `ChatBackground.vue` 里的那一个光晕 div **逐字节等价**：
  类名、定位类、尺寸、模糊档位一个都没改，样式规则也是同一条
  （`linear-gradient` 的两个端点取 `--lx-canvas-glow-from` / `--lx-canvas-glow-via`，
  亮色主题下这两个令牌取 `transparent`，因此亮色天然不可见，不需要任何主题分支）。</p>

  <p><b>为什么类名仍叫 `lx-chat-background__glow`：</b>这是从聊天背景搬出来的同一块 DOM，
      保留原名才能让主题等价门禁把它识别为「整块搬移」而非"删旧加新"，
      视觉基线也因此逐像素不变。改名属于无收益的扩散面扩大。</p>
-->
<template>
  <!-- 顶部环境光晕：暗色为极微弱蓝/靛蓝辉光，亮色下两个令牌皆为 transparent，故天然不可见 -->
  <div class="lx-chat-background__glow pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[360px] blur-3xl"></div>
</template>

<script setup lang="ts">
/**
 * 默认背景表面：只有一个装饰性光晕层。
 *
 * <p>无 props、无状态：明暗差异只由 CSS 变量承担（与 `ChatBackground` 的既有约束一致）。</p>
 */
</script>

<style scoped>
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
