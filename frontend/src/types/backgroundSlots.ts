import type { Component, InjectionKey } from 'vue';

/**
 * 主页背景「表面」（decoration surface）契约。
 *
 * <p><b>可替换的只是装饰层内容，不是画布根：</b>`ChatBackground.vue` 继续充当画布根，
 * 它的 `.lx-chat-background` 上的 `background-color: var(--lx-canvas)` 与
 * `background-image: var(--lx-canvas-image, none)` 属于**宿主职责**（换肤与插件背景图都靠这两个变量），
 * 因此不在本契约里；本契约只决定根元素内部渲染哪个装饰表面。</p>
 *
 * <p>没有 `props`：表面实现**不得**依赖宿主的主题状态模型 —— 明暗差异 100% 由 tokens.css 的
 * 两套 CSS 变量作用域承担（与 `ChatBackground` 的既有约束一致，禁止 `isDark` / 主题分支渲染）。</p>
 */
export interface ChatBackgroundSlots {
  /**
   * 绘制在画布根内部的装饰表面。缺省（`undefined` / 字段缺省）= 使用内置的令牌背景实现
   * （`components/background/TokenBackground.vue`），即与抽取前的渲染结果一致。
   */
  surface?: Component;
}

/**
 * 能力注入键：由宿主（`ChatView.vue`，**唯一注册点**）provide，`ChatBackground` inject。
 * 沿用 `CHAT_MESSAGE_SLOTS_KEY`（types/chatMessageSlots.ts）的既有范式。
 *
 * <p><b>消费端必须按字段判空，不能按对象真值判：</b>宿主 provide 一个空对象（`{}`）时对象本身为真，
 * 但 `surface` 仍是 `undefined`。若写成 `slots ? slots.surface : Default` 就会把 `undefined`
 * 交给 `<component :is>`，渲染出一个空占位而不是回落到内置实现 —— 这条约束与
 * `chatMessageSlots.ts` 的字段级判空要求同源。</p>
 */
export const BACKGROUND_SLOTS_KEY: InjectionKey<ChatBackgroundSlots> = Symbol('chat-background-slots');
