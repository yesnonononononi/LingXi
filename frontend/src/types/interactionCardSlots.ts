import type {Component, InjectionKey} from 'vue';
import type {PromptCardData} from './chat';

/** 审批卡片 / 计划卡片插槽统一 props（默认实现 ApprovalCard / PlanCard 与扩展实现共用）。 */
export interface InteractionCardSlotProps {
  readonly promptCard: PromptCardData;
  readonly sessionId?: string | number;
  readonly isDark?: boolean;
  /** 是否停靠在底部输入区上方的 Dock 容器内（扩展实现可据此隐藏外层重复边框）。 */
  readonly docked?: boolean;
}

/** 宿主可注册的互动卡片渲染器集合。缺省（undefined / 字段缺省）= 使用内置默认实现。 */
export interface InteractionCardSlotOverrides {
  readonly approvalCard?: Component<InteractionCardSlotProps>;
  readonly planCard?: Component<InteractionCardSlotProps>;
}

/** 能力注入键：由宿主（ChatView）provide，PromptCard inject。 */
export const INTERACTION_CARD_SLOTS_KEY: InjectionKey<InteractionCardSlotOverrides> = Symbol('interaction-card-slots');
