<script setup lang="ts">
/**
 * 【B-1 真实替换实现】消息操作栏的替换版：保留默认实现的 5 个元素，并追加「复制为引用」。
 *
 * <p><b>为什么复用 `MessageActionsBar` 而不是复制一份 markup：</b>默认操作栏里的复制 / 执行状态 /
 * 用量 / 耗时 / 时间戳共 5 个元素，任何一处样式或文案调整都必须对两个实现同时生效。
 * 复制一份等于埋下「两份实现慢慢漂移」的定时炸弹；这里只做 `<MessageActionsBar v-bind="props" />`
 * 的整段委托，等价于「默认实现 + 追加一个按钮」。</p>
 *
 * <p><b>为什么走 `props.copyText` 而不是自己调浏览器剪贴板 API：</b>宿主的
 * `copyText` 与默认复制按钮共用同一个 `useCopyFeedback` 实例，反馈状态同源；
 * 若此处另起一条剪贴板写入路径，就会出现「同一份剪贴板、两套成功/失败判定」的分裂。</p>
 *
 * <p><b>本组件是多根（fragment）：</b>外层容器（`flex flex-wrap items-center gap-4 …`）
 * 与出现时机（`isMessageCompleted && isGroupTail !== false`）仍由 `ChatMessageItem` 拥有，
 * 因此这里不设包裹元素、也不设 `inheritAttrs` 透传目标 —— 排版类一律由宿主容器决定。</p>
 */
import { computed, ref } from 'vue';
import MessageActionsBar from '../../components/chat/MessageActionsBar.vue';
import { t } from '../../i18n';
import type { ChatMessageActionsSlotProps } from '../../types/chatMessageSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<ChatMessageActionsSlotProps>();

/** 本按钮自己的「已复制」短反馈时长（毫秒）。与宿主的 2s 反馈独立，避免互相提前清零。 */
const FEEDBACK_MS = 1600;

/** 引用按钮的独立反馈态：只影响本按钮的图标与 title。 */
const quoteCopied = ref<boolean>(false);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把正文转成 Markdown 引用块：逐行加 `> ` 前缀，块尾补一个换行。
 *
 * <p>逐行加前缀（而不是整段加一次）是引用语法要求：多行正文若有空行，只加一次前缀会让
 * 第二行起脱离引用块，粘贴后排版散架。空行按 `> ` 处理后仍属同一引用块，符合 CommonMark。</p>
 *
 * @param content 原始正文
 * @returns Markdown 引用文本；空/纯空白正文返回空串（调用方据此禁用按钮）
 */
const toQuoteText = (content: string): string => {
  const trimmed = content.trim();
  if (trimmed === '') return '';
  // 统一换行符后再拆行，避免 CRLF 行尾让 `> ` 出现在 `\r` 之后
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  return `${lines.map((line) => `> ${line}`).join('\n')}\n`;
};

/** 引用文本；空串表示不可引用（正文为空/纯空白）⇒ 按钮禁用，绝不写入空串。 */
const quoteText = computed<string>(() => toQuoteText(props.message.content));

const isDisabled = computed<boolean>(() => quoteText.value === '');

const buttonTitle = computed<string>(() => {
  if (quoteCopied.value) return t('chat.message.quoteCopied');
  return t('chat.message.quoteTip');
});

/**
 * 点击：交给宿主的唯一写入路径，并在本按钮上给一次短反馈。
 *
 * <p>先判空再写入是硬约束：正文为空白时按钮虽已 `disabled`，但 `disabled` 只在 DOM 层拦截，
 * 键盘 / 程序化触发仍可能进入处理器，因此这里必须再守一道。</p>
 *
 * @returns 无
 */
const onQuoteClick = (): void => {
  if (isDisabled.value) return;
  props.copyText(quoteText.value);
  quoteCopied.value = true;
  if (feedbackTimer !== null) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    quoteCopied.value = false;
    feedbackTimer = null;
  }, FEEDBACK_MS);
};
</script>

<template>
  <!-- 原有 5 个元素：整段委托默认实现，禁止在此复制 markup -->
  <MessageActionsBar v-bind="props" />

  <!-- 新增：复制为引用（差异点；删掉 ChatView 里的注册即回到默认操作栏） -->
  <button
    type="button"
    data-quote-action="1"
    class="hover:text-lx-secondary transition p-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
    :disabled="isDisabled"
    :title="buttonTitle"
    :aria-label="buttonTitle"
    @click="onQuoteClick"
  >
    <!-- 引用/引号样式图标：两条引号 + 承托线，风格与相邻 4 个图标按钮一致（内联 SVG，无新依赖） -->
    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.8"
        d="M9.5 7.5H7a2 2 0 00-2 2v2a2 2 0 002 2h1.5a1 1 0 011 1V16a3 3 0 01-3 3M17.5 7.5H15a2 2 0 00-2 2v2a2 2 0 002 2h1.5a1 1 0 011 1V16a3 3 0 01-3 3"
      />
    </svg>
  </button>
</template>
