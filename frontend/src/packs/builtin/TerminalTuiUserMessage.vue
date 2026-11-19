<script setup lang="ts">
import {computed, ref} from 'vue';
import type {ChatMessage} from '../../types/chat';
import type {PastedDocument} from '../../utils/pastedDocument';
import {t} from '../../i18n';

const props = defineProps<{
  message: ChatMessage;
  isDark: boolean;
  parsedText: string;
  documents: readonly PastedDocument[];
  imageUrls: readonly string[];
  displayTime: string;
  copied: boolean;
  canResend: boolean;
  resendTitle: string;
  copyContent: () => void;
  onResendUnsent: () => void;
  onEditResend: () => void;
  onPreviewImage: (url: string, index: number) => void;
  onPreviewDocument: (doc: PastedDocument) => void;
}>();

const compactMode = ref(false);
const charCount = computed(() => props.parsedText.length);
const lineCount = computed(() => (props.parsedText ? props.parsedText.split('\n').length : 0));
</script>

<!--
  棱镜指令胶囊（内置 Slot 极限）：把用户气泡复刻成一段终端会话。
  设计取向是「真终端」而不是「终端配色卡片」：等宽字形、提示符、行号 gutter、
  底部遥测脚注都属于终端的原生语汇，装饰性渐变与彩色胶囊一律不要。
-->
<template>
  <div
    data-slot="user-message-bubble"
    data-testid="user-message-bubble"
    class="tui-prompt group/card relative w-full overflow-hidden transition-colors duration-200"
    :style="{
      backgroundColor: 'color-mix(in srgb, var(--lx-canvas-subtle) 94%, var(--lx-accent) 6%)',
      borderColor: 'color-mix(in srgb, var(--lx-accent) 34%, var(--lx-border-default))',
      color: 'var(--lx-text-primary)',
    }"
  >
    <!-- 标题条：终端窗口的三个按钮 + 会话标识 -->
    <div
      class="tui-bar flex items-center justify-between gap-2 px-3 py-1"
      :style="{ borderColor: 'var(--lx-border-subtle)', backgroundColor: 'var(--lx-surface-sunken)' }"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="flex items-center gap-1 shrink-0" aria-hidden="true">
          <i class="tui-dot" :style="{ backgroundColor: 'var(--lx-danger)' }" />
          <i class="tui-dot" :style="{ backgroundColor: 'var(--lx-warning)' }" />
          <i class="tui-dot" :style="{ backgroundColor: 'var(--lx-success)' }" />
        </span>
        <span class="tui-tag truncate" :style="{ color: 'var(--lx-text-muted)' }">
          user@lingxi<span :style="{ color: 'var(--lx-text-faint)' }">:~$</span>
        </span>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <button
          v-if="charCount > 120"
          type="button"
          class="tui-btn"
          @click="compactMode = !compactMode"
        >{{ compactMode ? 'expand' : 'collapse' }}</button>
        <button
          type="button"
          data-testid="user-message-copy"
          class="tui-btn"
          :data-active="props.copied ? 'true' : 'false'"
          @click="props.copyContent"
        >
          <svg v-if="props.copied" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <svg v-else class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="9" y="9" width="13" height="13" rx="1" />
            <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
          </svg>
          <span>{{ props.copied ? t('common.copied') : 'copy' }}</span>
        </button>
        <button
          v-if="!props.message.unsent && !props.message.isResumeSupplement && props.message.turnId"
          type="button"
          data-testid="edit-resend"
          class="tui-btn"
          :disabled="!props.canResend || !props.message.serverMessageId"
          :title="props.resendTitle"
          @click="props.onEditResend"
        >
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="m16 4 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z" />
          </svg>
          <span>edit</span>
        </button>
      </div>
    </div>

    <!-- 提示符行 + 正文 -->
    <div class="px-3 py-2.5">
      <div v-if="props.imageUrls.length" class="mb-2 flex flex-wrap gap-2" data-testid="user-images">
        <img
          v-for="(imageUrl, index) in props.imageUrls"
          :key="index"
          :src="imageUrl"
          :alt="t('chat.message.userUploadIndex', { index: index + 1 })"
          class="max-h-44 w-auto cursor-pointer border object-contain transition-opacity hover:opacity-90"
          :style="{ borderColor: 'var(--lx-border-default)', borderRadius: '2px' }"
          @click="props.onPreviewImage(imageUrl, index)"
        />
      </div>

      <div v-if="props.documents.length" class="mb-2 flex flex-wrap gap-1.5" data-testid="user-message-documents">
        <button
          v-for="doc in props.documents"
          :key="doc.id"
          type="button"
          class="tui-file"
          @click="props.onPreviewDocument(doc)"
        >
          <span :style="{ color: 'var(--lx-accent)' }">▤</span>
          <span class="max-w-[180px] truncate">{{ doc.title || doc.id }}</span>
        </button>
      </div>

      <div v-if="props.parsedText" class="flex min-w-0 items-start gap-2">
        <span class="tui-prompt-mark select-none shrink-0" aria-hidden="true">$</span>
        <div
          data-testid="user-message-text"
          class="tui-body min-w-0 flex-1 whitespace-pre-wrap"
          :class="compactMode ? 'line-clamp-3' : ''"
        >{{ props.parsedText }}</div>
      </div>
    </div>

    <!-- 遥测脚注：时间 / 行数 / 字数，全部等宽小号 -->
    <div
      class="tui-foot flex items-center justify-between gap-2 px-3 py-1"
      :style="{ borderColor: 'var(--lx-border-subtle)', color: 'var(--lx-text-faint)' }"
    >
      <span class="truncate">
        <span :style="{ color: 'var(--lx-text-muted)' }">exit 0</span>
        <span class="tui-sep">·</span>{{ lineCount }} lines
        <span class="tui-sep">·</span>{{ charCount }} chars
      </span>
      <span class="shrink-0 tabular-nums">{{ props.displayTime }}</span>
    </div>

    <div
      v-if="props.message.unsent"
      class="tui-foot flex items-center justify-between gap-2 px-3 py-1.5"
      :style="{ borderColor: 'var(--lx-border-subtle)', backgroundColor: 'var(--lx-warning-soft)' }"
    >
      <span data-testid="unsent-badge" class="tui-tag" :style="{ color: 'var(--lx-warning)' }">
        ! delivery_failed
      </span>
      <button type="button" class="tui-btn" @click="props.onResendUnsent">{{ t('chat.message.resend') }}</button>
    </div>
  </div>
</template>

<style scoped>
.tui-prompt {
  border: 1px solid;
  border-radius: 4px;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
.tui-prompt::after {
  /* 左侧 2px 强调导轨是终端窗口的「当前焦点」暗示，只在悬停时点亮 */
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 2px;
  background: var(--lx-accent);
  opacity: 0.35;
  transition: opacity 0.2s ease;
}
.tui-prompt:hover::after { opacity: 1; }

.tui-bar { border-bottom: 1px solid; }
.tui-dot { display: block; width: 6px; height: 6px; border-radius: 999px; opacity: 0.75; }
.tui-tag { font-size: 10px; letter-spacing: 0.06em; }
.tui-sep { opacity: 0.45; padding-inline: 4px; }

.tui-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: 10px;
  color: var(--lx-text-muted);
  background: transparent;
  border: 1px solid var(--lx-border-subtle);
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.tui-btn:hover:not(:disabled) { color: var(--lx-accent); border-color: var(--lx-accent); }
.tui-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.tui-btn[data-active='true'] { color: var(--lx-success); border-color: var(--lx-success); }

.tui-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--lx-text-secondary);
  background: var(--lx-surface-sunken);
  border: 1px solid var(--lx-border-subtle);
  border-radius: 3px;
  cursor: pointer;
}
.tui-file:hover { border-color: var(--lx-accent); }

.tui-prompt-mark {
  font-size: 13px;
  line-height: 1.6;
  color: var(--lx-accent);
}
.tui-body {
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tui-foot { border-top: 1px solid; font-size: 10px; letter-spacing: 0.04em; }
</style>
