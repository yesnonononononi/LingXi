<script setup lang="ts">
/**
 * 过程段详情编排层。
 *
 * <p>职责只剩三件：① 建一个覆盖本段所有思考步骤的贴底 API；② 按注册表把每个过程项分发到对应
 * renderer（`:key="item.id"` 保持实例身份，折叠态与复制反馈都依赖它）；③ 向上透传
 * `selectSubSession`。</p>
 *
 * <p>拆分契约：renderer 的根元素就是原来那一层元素、class 逐字复制，故 `data-testid` 与 DOM
 * 嵌套层级与拆分前等价（由 `tests/processDetailsSplit.test.cjs` 断言）。</p>
 */
import { computed } from 'vue';
import type { ChatMessage, SubSessionVO } from '../../types/chat';
import type { ImageProcessItem } from '../../utils/readImageTools';
import { useStreamStickyScroll } from '../../composables/useStreamStickyScroll';
import type { ProcessRendererSpec, RendererContext, ThinkingScrollApi } from './process/processRenderers';
import { resolveRenderer } from './process/processRenderers';

const props = defineProps<{
  items: ImageProcessItem[];
  isDark: boolean;
  sessionId?: string | number;
  /** 消息上的权威编辑记录（工具行 diff 统计的最后一路数据源）。 */
  fileEdits?: ChatMessage['fileEdits'];
  /** 消息原始完成标记：`false` 才允许「运行中的思考默认展开」。 */
  isMessageComplete?: boolean;
  messageIsSuspended: boolean;
  /** 轮次是否仍在运行（`turn.status === 'RUNNING'`，无 turn 时取 `isComplete !== true`）。 */
  isRunningTurn: boolean;
  subSessions?: SubSessionVO[];
}>();
const emit = defineEmits<{ (e: 'selectSubSession', id: string | number): void }>();

// 思考内容展开框的流式贴底：判定规则与实现见 composables/useStreamStickyScroll.ts。
// 指纹覆盖**全部**思考步骤 —— 只盯「当前 running 的那一段」会漏：上一段没收到完成通知时
// 会一直占着 running，新一段的增量就再也触发不了贴底。
// 因此它必须留在编排层（只看得到自己那一步的 renderer 无法覆盖整段）。
const streamScroll = useStreamStickyScroll({
  streamSignature: () => {
    const steps = props.items.flatMap(item => item.step ? [item.step] : []);
    if (!steps.length) return '';
    return steps.map(step => `${step.id}:${step.content?.length ?? 0}`).join('|');
  },
  boxIds: () => props.items.flatMap(item => item.step ? [String(item.step.id)] : []),
  // 只有还在跑的思考才从贴底开始：已定型的思考一旦展开，应当从头读，
  // 也不能被别处的增量顶到底部。
  shouldStickOnMount: id => props.items
    .flatMap(item => item.step ? [item.step] : [])
    .some(step => String(step.id) === id && step.status === 'running'),
});

/** 下推给思考 renderer 的贴底 API（形状即 `StreamStickyScroll`）。 */
const scroll: ThinkingScrollApi = {
  setBoxRef: streamScroll.setBoxRef,
  handleScroll: streamScroll.handleScroll,
  isFollowing: streamScroll.isFollowing,
  scrollToBottom: streamScroll.scrollToBottom,
};

const context = computed<RendererContext>(() => ({
  isDark: props.isDark,
  sessionId: props.sessionId,
  fileEdits: props.fileEdits,
  // 编排层只在可见时挂载（父级 `v-if="visible && expanded"`），故恒为 true。
  visible: true,
}));

/** 一行的渲染描述：renderer 组件 + 该 renderer 真正读取的窄 props（显式白名单）。 */
interface ProcessRow {
  key: string;
  spec: ProcessRendererSpec;
  props: Record<string, unknown>;
}

/** 按 renderer 类型组装 props：只给对应 renderer 真正读的字段，禁止整包透传上下文。 */
function buildRowProps(spec: ProcessRendererSpec, item: ImageProcessItem): Record<string, unknown> {
  switch (spec.name) {
    case 'thought':
      return {
        item,
        isDark: props.isDark,
        isRunningTurn: props.isRunningTurn,
        isMessageComplete: props.isMessageComplete,
        messageIsSuspended: props.messageIsSuspended,
        scroll,
      };
    case 'sub_agent':
      return {
        item,
        isDark: props.isDark,
        subSessions: props.subSessions,
        onSelectSubSession: (id: string | number) => emit('selectSubSession', id),
      };
    case 'image_group':
      return { item, isDark: props.isDark, sessionId: props.sessionId };
    case 'tool':
      return {
        item,
        isDark: props.isDark,
        sessionId: props.sessionId,
        fileEdits: props.fileEdits,
      };
    default:
      return { item };
  }
}

const rows = computed<ProcessRow[]>(() => props.items.map(item => {
  const spec = resolveRenderer(item, context.value);
  return { key: item.id, spec, props: buildRowProps(spec, item) };
}));
</script>

<template>
<div class="space-y-2.5">
  <component v-for="row in rows" :key="row.key" :is="row.spec.component" v-bind="row.props" />
</div>
</template>
