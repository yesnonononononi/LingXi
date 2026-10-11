/**
 * i18n 运行时。
 *
 * <p>与 {@link ../composables/useTheme.ts} 同风格：模块级单例 ref + localStorage 持久化，
 * 所有页面共享同一份语言状态。切换语言时，任何读取 {@link t} / {@link locale} 的渲染都会自动重算。</p>
 */
import { ref, watch } from 'vue';
import { messages } from './messages';
import type { MessageDict } from './messages';

/** 受支持的具体语言。 */
export type Locale = 'zh-CN' | 'en-US';

/** 用户可选的语言偏好：显式语言，或「跟随系统」。 */
export type LocalePreference = 'system' | Locale;

/** 全局统一的语言持久化键。 */
export const LOCALE_STORAGE_KEY = 'lingxi-locale';

const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en-US'];

/** 缺省与回退语言。 */
const FALLBACK_LOCALE: Locale = 'zh-CN';

/**
 * 依据浏览器语言探测系统语言：以 `zh` 开头视为简体中文，其余一律英文。
 *
 * @returns 探测到的具体语言。
 */
const detectSystemLocale = (): Locale => {
  try {
    const language = typeof navigator !== 'undefined' && navigator.language ? navigator.language : '';
    if (language.toLowerCase().startsWith('zh')) {
      return 'zh-CN';
    }
  } catch {
    /* navigator 不可用时按英文处理 */
  }
  return 'en-US';
};

/**
 * 读取本地已保存的语言偏好。
 *
 * @returns 合法偏好；无有效记录时返回 'system'。
 */
const readStoredPreference = (): LocalePreference => {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === 'system') {
      return 'system';
    }
    if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) {
      return saved as Locale;
    }
  } catch {
    /* localStorage 不可用时走默认值 */
  }
  return 'system';
};

/** 把语言偏好解析为具体语言。 */
const resolveLocale = (value: LocalePreference): Locale =>
  value === 'system' ? detectSystemLocale() : value;

// 模块级单例状态：所有页面共享同一份语言，切换后全局一致
const preference = ref<LocalePreference>(readStoredPreference());
const locale = ref<Locale>(resolveLocale(preference.value));

// 偏好变化时：重算具体语言 + 持久化
watch(preference, (value) => {
  locale.value = resolveLocale(value);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
});

/**
 * 在嵌套字典中按点分 key 下钻取值。
 *
 * @param dict 语言字典根。
 * @param key 形如 `settings.general.theme` 的点分 key。
 * @returns 命中的字符串；未命中或非叶子时返回 undefined。
 */
const lookup = (dict: MessageDict, key: string): string | undefined => {
  let node: string | MessageDict | undefined = dict;
  for (const segment of key.split('.')) {
    if (node === undefined || typeof node === 'string') {
      return undefined;
    }
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
};

/**
 * 用命名参数替换模板中的 `{name}` 占位符；缺失参数时保留原占位符。
 *
 * @param template 已取到的文案模板。
 * @param params 命名参数。
 * @returns 插值后的字符串。
 */
const interpolate = (template: string, params?: Record<string, string | number>): string => {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
};

/** t() 的命名参数类型。 */
export type TranslateParams = Record<string, string | number>;

/**
 * 响应式翻译函数。
 *
 * <p>实现要点：函数体内读取 `locale.value`，因此在组件渲染 / computed 中调用时会自动建立
 * 对语言的响应式依赖；语言一变，调用处即重算。缺失 key 时依次回退到中文兜底，最终返回 key 本身，
 * 保证不抛错、不渲染空白。</p>
 *
 * @param key 点分 key，如 `settings.general.theme`。
 * @param params 可选的命名插值参数。
 * @returns 当前语言下的文案。
 */
export const t = (key: string, params?: TranslateParams): string => {
  const active = locale.value;
  const raw = lookup(messages[active], key) ?? lookup(messages[FALLBACK_LOCALE], key) ?? key;
  return interpolate(raw, params);
};

/**
 * 设置语言偏好并持久化。
 *
 * @param value 'system' 或受支持的具体语言；非法值将被忽略。
 */
export const setPreference = (value: LocalePreference): void => {
  if (value === 'system' || SUPPORTED_LOCALES.includes(value)) {
    preference.value = value;
  }
};

/**
 * i18n 组合式函数，返回响应式语言状态与翻译函数。
 *
 * @returns { t, locale, preference, setPreference }。
 */
export const useI18n = () => {
  return { t, locale, preference, setPreference };
};
