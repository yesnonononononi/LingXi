/**
 * 提供商图标：内置品牌图标 key 清单 + 判定工具。
 *
 * <p>图标字段是「内置 key / emoji / 图片 URL」三选一，不做成枚举——
 * 用户新增提供商时可以直接填 emoji 或自己的图片地址，无需等我们加图标。</p>
 */

export const PROVIDER_ICON_OPTIONS = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'google', label: 'Google' },
  { key: 'meta', label: 'Meta' },
  { key: 'qwen', label: 'Qwen' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'mistral', label: 'Mistral' },
  { key: 'xai', label: 'xAI' },
  { key: 'groq', label: 'Groq' },
  { key: 'azure', label: 'Azure' },
  { key: 'ollama', label: 'Ollama' },
  { key: 'custom', label: '自定义' },
] as const;

export type ProviderIconKey = (typeof PROVIDER_ICON_OPTIONS)[number]['key'];

const ICON_KEY_SET: ReadonlySet<string> = new Set(PROVIDER_ICON_OPTIONS.map(option => option.key));

/** 是否为内置图标 key（大小写不敏感，写入时统一小写）。 */
export function isBuiltInProviderIcon(icon: string | null | undefined): boolean {
  return !!icon && ICON_KEY_SET.has(icon.trim().toLowerCase());
}

/** 是否为可直接 <img> 的图片地址。 */
export function isImageProviderIcon(icon: string | null | undefined): boolean {
  return !!icon && /^(https?:|data:|blob:|file:)/i.test(icon.trim());
}
