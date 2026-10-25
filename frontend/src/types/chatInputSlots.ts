import type { Component, InjectionKey } from 'vue';
import type { ModelConfig } from './chat';

/**
 * 上下文用量指示器插槽：**零回调**的纯展示边界（对应 ChatInputArea 1537–1573）。
 *
 * <p>「有没有数据」由组件裁决（`contextUsageText` 为空串即不渲染该区域，见 640–645），
 * 消费者的职责只是「有了数据怎么画」，因此这里不给任何行为回调。</p>
 */
export interface ChatInputContextUsageSlotProps {
  readonly isDark: boolean;
  /** 已格式化的人读文本（形如 `12.3% · 24.6K / 200K 上下文已用`）；空串 = 无数据（组件已用 v-if 拦截，防御性保留）。 */
  readonly contextUsageText: string;
  /** 环形进度的 stroke-dasharray 值（已按半径 6 算好，直接绑到 circle 上即可）。 */
  readonly contextRingDash: string;
  /**
   * 悬浮浮层是否显示。
   *
   * <p><b>为什么这个状态必须由组件提供、而不是让默认实现自己监听鼠标</b>：触发区是**外层容器**
   * （`relative inline-flex h-7 …`，28px 高）的属性，容器归组件所有。若把 `mouseenter/mouseleave`
   * 挪进渲染器，触发区会缩到图标本身（18×18），同一位置的悬停行为就变了 —— 那是行为漂移，
   * 不属于「只替换容器内部内容」。</p>
   */
  readonly tooltipVisible: boolean;
}

/** Agent/团队驱动本轮时的「实际生效模型」信息（对应 602–639 的 drivenModel）。 */
export interface ChatInputDrivenModel {
  readonly text: string;
  readonly tip: string;
  /** true = 预设模型未绑定（呈现警示色）。 */
  readonly missing: boolean;
}

/**
 * 模型选择器插槽（对应 **1575–1632 整段**）。
 *
 * <p><b>两个真实生产态由组件决定，不由消费者决定：</b>`drivenModel !== null` ⇒ 本轮由 Agent/团队
 * 驱动，选择器不参与本轮（原 1575–1597 的徽标态）；`drivenModel === null` ⇒ 选择器即权威（原 1599–1632）。</p>
 */
export interface ChatInputModelSelectorSlotProps {
  readonly isDark: boolean;
  readonly models: readonly ModelConfig[];
  readonly selectedModelId?: string | number;
  readonly drivenModel: ChatInputDrivenModel | null;
  /** 唯一模型变更入口（内部 `emit('updateModel', id)`）。消费者不得自行 emit。 */
  readonly onUpdateModel: (modelId: string | number) => void;
  /** 「去改预设」的唯一入口（内部 `emit('openSettingsTab', tab)`，原 1591 传 'agents'）。 */
  readonly onOpenSettingsTab: (tab: string) => void;
  /** 「打开模型编辑器」的唯一入口（内部 `emit('openModelEditor')`）。 */
  readonly onOpenModelEditor: () => void;
}

/** 发送/停止按钮的 5 色（对应 928–965 的 slingColors 计算结果）。 */
export interface ChatInputSendButtonColors {
  readonly padColor: string;
  readonly iconColor: string;
  readonly accentColor: string;
  readonly wellColor: string;
  readonly bandColor: string;
}

/**
 * 发送/停止按钮插槽（对应 1657–1683 的 SlingButton 整体）。
 *
 * <p>发送与停止是**同一个按钮的二态**：组件内 `onSendClick`（966）按 `isSending` 分流
 * `emit('stopGeneration')` / `handleSend()`。因此这里只暴露**一个** `onSend`，
 * 消费者不可能把「发送」与「停止」各接一次而双触发。</p>
 */
export interface ChatInputSendButtonSlotProps {
  readonly isSending: boolean;
  /** `!!isSending || canSend`（926）：false 时应禁用按钮。 */
  readonly armed: boolean;
  readonly isDark: boolean;
  readonly colors: ChatInputSendButtonColors;
  /** 唯一发送/停止入口。 */
  readonly onSend: () => void;
}

/**
 * 宿主可注册的输入区渲染器集合。字段缺省 = 使用内置默认实现。
 *
 * <p>结构刻意与 `ChatMessageSlotOverrides` 同构（只有 `Component` 字段、零事件字段），
 * 见 `types/chatMessageSlots.ts`；两侧**不共享**泛型基座，理由见设计文档 §2.2（J1–J4）。</p>
 */
export interface ChatInputSlotOverrides {
  readonly contextUsage?: Component<ChatInputContextUsageSlotProps>;
  readonly modelSelector?: Component<ChatInputModelSelectorSlotProps>;
  readonly sendButton?: Component<ChatInputSendButtonSlotProps>;
}

/** 能力注入键：由宿主（ChatView）provide，ChatInputArea inject。范式同 FILE_PREVIEW_KEY / CHAT_MESSAGE_SLOTS_KEY。 */
export const CHAT_INPUT_SLOTS_KEY: InjectionKey<ChatInputSlotOverrides> = Symbol('chat-input-slots');
