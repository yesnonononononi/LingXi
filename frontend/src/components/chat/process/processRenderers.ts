/**
 * 过程项 → renderer 的优先级注册表。
 *
 * <p>顺序敏感：`image_group` 必须排在 `tool` 之前（读图项同时带 `type === 'tool'`），否则读图组会被
 * 普通工具行抢走；`sub_agent` 也必须排在 `tool` 之前（协同条取代单个委派工具行）。</p>
 *
 * <p>`resolveRenderer` 永远返回一个 renderer —— 未命中落到 `unknown` 兜底，禁止返回 `undefined`
 * （原模板的 v-else-if 链末端没有 else，未知项会静默白屏）。</p>
 */
import type { Component } from 'vue';
import type { ImageProcessItem } from '../../../utils/readImageTools';
import type { ChatMessage } from '../../../types/chat';
import type { StreamStickyScroll } from '../../../composables/useStreamStickyScroll';
import ThoughtStepRenderer from './ThoughtStepRenderer.vue';
import SubAgentMembersRenderer from './SubAgentMembersRenderer.vue';
import ReadImageGroupRenderer from './ReadImageGroupRenderer.vue';
import ToolCallRenderer from './ToolCallRenderer.vue';
import UnknownItemRenderer from './UnknownItemRenderer.vue';

/** 思考贴底 API（`useStreamStickyScroll` 的返回结构，由编排层一次性创建并下推）。 */
export type ThinkingScrollApi = StreamStickyScroll;

/** 注册表判定需要的上下文（只收判定真正读的字段）。 */
export interface RendererContext {
  isDark: boolean;
  sessionId?: string | number;
  fileEdits?: ChatMessage['fileEdits'];
  /**
   * 段级可见性。
   *
   * <p>`ProcessDetails` 只在可见时挂载（父级 `v-if="visible && expanded"`），因此这里恒为 true；
   * 字段保留是为了让判定函数将来在「可见性会影响分发」时不必改签名。</p>
   */
  visible?: boolean;
}

export type ProcessRendererName = 'thought' | 'sub_agent' | 'image_group' | 'tool' | 'unknown';

export interface ProcessRendererSpec {
  /** 稳定标识：进单测断言与 dev 排查，不允许按需改名。 */
  name: ProcessRendererName;
  match: (item: ImageProcessItem, ctx: RendererContext) => boolean;
  component: Component;
}

/** 兜底 renderer：永远命中，放在数组末尾。 */
const UNKNOWN_RENDERER: ProcessRendererSpec = {
  name: 'unknown',
  match: () => true,
  component: UnknownItemRenderer,
};

export const PROCESS_RENDERERS: readonly ProcessRendererSpec[] = Object.freeze([
  {
    name: 'thought',
    match: item => item.type === 'thought' && !!item.step,
    component: ThoughtStepRenderer,
  },
  {
    name: 'sub_agent',
    match: item => item.type === 'sub_agent' && !!item.subAgents?.length,
    component: SubAgentMembersRenderer,
  },
  {
    // 读图组：必须在 tool 之前（读图项同时是 tool，且 images 非空才合并成组）。
    name: 'image_group',
    match: (item, ctx) => !!item.images?.length && !!ctx.sessionId,
    component: ReadImageGroupRenderer,
  },
  {
    name: 'tool',
    match: item => item.type === 'tool' && !!item.tool,
    component: ToolCallRenderer,
  },
  UNKNOWN_RENDERER,
]);

/**
 * 按优先级挑一个 renderer。
 *
 * @param item 过程项
 * @param ctx 判定上下文
 * @returns 命中的 renderer；未命中时返回 `unknown`（永不 undefined）
 */
export function resolveRenderer(item: ImageProcessItem, ctx: RendererContext): ProcessRendererSpec {
  const matched = PROCESS_RENDERERS.find(spec => spec.match(item, ctx));
  return matched ?? UNKNOWN_RENDERER;
}
