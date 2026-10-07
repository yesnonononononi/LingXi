/**
 * 「聚焦聊天输入框」能力的类型化注入。
 *
 * <p>由 ChatView（provider）注入一个 `() => void`，需要「去聊天里说」这类入口的
 * 组件（consumer）取用；无 provider 时取到 null，消费方据此不渲染入口，
 * 避免出现点了没反应的死按钮。</p>
 *
 * 用法：
 *   // provider（views/chat/ChatView.vue）：
 *   provideChatInputFocus(() => inputAreaRef.value?.focusInput());
 *   // consumer：
 *   const focusChatInput = useChatInputFocus();      // 无 provider → null
 *   // 模板：<button v-if="focusChatInput" @click="focusChatInput">
 */

import { inject, provide, type InjectionKey } from 'vue';

/** 聚焦聊天输入框的能力；由 ChatView 提供，消费方取用。 */
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
