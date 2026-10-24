import type { Component, InjectionKey } from 'vue';
import type { ChatMessage, ChatTurn } from './chat';
import type { TokenInfo } from './Event';

/** 执行状态摘要（`execStatusMeta` 的对外投影，行 1295–1306）。null = 无轮次摘要。 */
export interface ChatMessageExecStatusMeta {
  readonly text: string;
  readonly running: boolean;
  readonly failed: boolean;
  /** 失败原因全文；非失败态恒为 ''。 */
  readonly errorReason: string;
}

/** 正文插槽 props：只给「渲染正文所必需」的 3 项，不含组件内部状态。 */
export interface ChatMessageBodySlotProps {
  /** 消息本体：渲染器需要 content / isThinking / isExploring / tokenInfo 等，一律从这里取，禁止消费者另行 import 会话状态。 */
  readonly message: ChatMessage;
  readonly isDark: boolean;
  /** = `message.isThinking && !message.isExploring`（与行 539/545 的判定完全同源）。 */
  readonly isThinking: boolean;
}

/** 操作区插槽 props：10 个只读字段 + 1 个回调（共 11 项），全部来自组件内已有的 computed，消费者一律不重算。 */
export interface ChatMessageActionsSlotProps {
  /** 渲染器注册在宿主级（不是每个 item 一份），必须靠它拿到「当前是哪条消息」。 */
  readonly message: ChatMessage;
  readonly isDark: boolean;
  /** 操作区的时机值（外层 v-if 已由组件裁决，这里只用于消费者内部条件渲染）。 */
  readonly isMessageCompleted: boolean;
  readonly execStatusMeta: ChatMessageExecStatusMeta | null;
  readonly showExecutionMeta: boolean;
  readonly tokenUsage: TokenInfo | null;
  /** 组尾所属轮次：默认实现要把它透给 TokenUsagePopover 的 modelName / modelProvider（行 583–584）。 */
  readonly turn: ChatTurn | null;
  readonly displayDuration: string;
  readonly displayTime: string;
  readonly copied: boolean;
  /**
   * 复制行为的**唯一**执行入口。消费者只能"调用"，不能"改成 emit"——
   * 该回调内部即 `void copyContentRaw(props.message.content)`（行 1317），不经 context / 不经 emits，
   * 因此不会出现"同一次点击走两条路径"（论证见 §4.3）。
   */
  readonly copyContent: () => void;
}

/** 宿主可注册的渲染器集合。缺省（undefined / 字段缺省）= 使用内置默认实现。 */
export interface ChatMessageSlotOverrides {
  readonly body?: Component<ChatMessageBodySlotProps>;
  readonly actions?: Component<ChatMessageActionsSlotProps>;
}

/** 能力注入键：由宿主（ChatView）provide，Item inject。沿用 FILE_PREVIEW_KEY 的既有范式（types/filePreview.ts:30）。 */
export const CHAT_MESSAGE_SLOTS_KEY: InjectionKey<ChatMessageSlotOverrides> = Symbol('chat-message-slots');
