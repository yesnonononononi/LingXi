/**
 * 「聚焦聊天输入框」能力的类型化注入。
 *
 * 收敛原因：原 PlanCard 的「去聊天里说」按钮通过 `window.dispatchEvent('focus-chat-input')`
 * + `document.querySelector('textarea')` 实现聚焦——前者全仓无监听者（死事件），
 * 后者是审计 G8 认定的脆弱写法（可能抓错页面首个 textarea）。
 *
 * 现改为**类型化注入**：由 ChatView（provider）注入一个 `() => void`，
 * 卡片类组件（consumer，如 PlanCard）取用；无 provider 时取到 null，
 * 消费方据此不渲染入口（杜绝「点了没反应的死按钮」）。
 *
 * 用法：
 *   // provider（views/chat/ChatView.vue，实施者 B 负责接入）：
 *   import { CHAT_INPUT_FOCUS_KEY } from '../../composables/useChatInputFocus';
 *   const inputAreaRef = ref();
 *   provide(CHAT_INPUT_FOCUS_KEY, () => inputAreaRef.value?.focusInput());
 *   // 或等价写法：provideChatInputFocus(() => inputAreaRef.value?.focusInput());
 *
 *   // consumer（components/chat/PlanCard.vue）：
 *   const focusChatInput = useChatInputFocus();      // 无 provider → null
 *   // 模板：<button v-if="isPending && focusChatInput" @click="focusChatInput">
 */

import { inject, provide, type InjectionKey } from 'vue';

/** 聚焦聊天输入框的能力；由 ChatView 提供，卡片类组件消费。 */
export const CHAT_INPUT_FOCUS_KEY: InjectionKey<() => void> = Symbol('chat-input-focus');

/**
 * provider 侧调用：注册聚焦能力。须在 setup 顶层调用。
 */
export function provideChatInputFocus(focusInput: () => void): void {
  provide(CHAT_INPUT_FOCUS_KEY, focusInput);
}

/**
 * consumer 侧调用：取聚焦能力；无 provider 时返回 null（调用方据此隐藏入口）。
 */
export function useChatInputFocus(): (() => void) | null {
  return inject(CHAT_INPUT_FOCUS_KEY, null);
}
