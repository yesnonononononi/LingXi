import type {OfficialPackDefinition} from '../types';
import GlassContextBadge from './GlassContextBadge.vue';

/**
 * 霓虹玻璃输入栏（输入框扩展包）：
 * 改造输入卡片为半透明毛玻璃容器 + 聚焦流光外框（不改列宽 max-w-lx-chat），
 * 并替换 CHAT_INPUT_SLOTS_KEY.contextUsage 为胶囊进度徽标。
 */
export const glassInputPack: OfficialPackDefinition = {
  id: 'glass-input',
  slots: {
    chatInput: {
      contextUsage: GlassContextBadge,
    },
  },
  cssText: `
[data-slot="chat-input-card"] {
  --pb-radius: 22px;
  border-radius: 22px !important;
  background: color-mix(in srgb, var(--lx-surface-elevated) 76%, transparent) !important;
  backdrop-filter: blur(18px) saturate(140%);
  border: 1px solid var(--lx-border-default) !important;
  box-shadow: var(--lx-shadow-2);
  transition: border-color 200ms ease, box-shadow 220ms ease, background-color 200ms ease;
}

[data-slot="chat-input-card"]:focus-within {
  border-color: var(--lx-accent) !important;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--lx-accent) 20%, transparent), var(--lx-shadow-2);
}
`,
};
