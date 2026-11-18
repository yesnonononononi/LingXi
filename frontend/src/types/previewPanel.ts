import type {InjectionKey} from 'vue';
import type {PromptCardData} from './chat';

export type PreviewTabKind = 'file' | 'page' | 'design' | 'plan' | 'new';

export interface UnifiedPreviewTab {
  /** 全局唯一 Tab 键：`<kind>:<targetId>` */
  key: string;
  kind: PreviewTabKind;
  targetId: string;
  title: string;
  /** 仅 page 类型可能携带 */
  url?: string;
  favicon?: string;
  isLoading?: boolean;
}

export interface DesignPreviewTab {
  id: string;
  title: string;
  initialContent?: string;
  initialFileName?: string;
}

export interface PlanPreviewTab {
  id: string;
  title: string;
  promptCard: PromptCardData;
  sessionId?: string | number;
}

export interface NewPreviewTab {
  id: string;
  title: string;
}

export const PLAN_PREVIEW_KEY: InjectionKey<(tab: PlanPreviewTab) => void> = Symbol('planPreview');

