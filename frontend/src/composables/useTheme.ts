import { computed, ref, watch } from 'vue';

export type ThemeMode = 'dark' | 'light';

/** 全局统一的主题持久化键，登录页 / 聊天页 / 模型页共用 */
export const THEME_STORAGE_KEY = 'lingxi-theme';

/** 读取初始主题： 1. 优先使用本地已保存的偏好； 2. 未保存时跟随系统 prefers-color-scheme； 3. 兜底为暗色。 */
const getInitialTheme = (): ThemeMode => {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light') return 'light';
    if (saved === 'dark') return 'dark';
  } catch {
    /* ignore */
  }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
  } catch {
    /* ignore */
  }
  return 'dark';
};

// 模块级单例状态：所有页面共享同一份主题，切换后全局一致
const theme = ref<ThemeMode>(getInitialTheme());

/** 将主题同步到文档根节点，支持全局 CSS 与原生控件配色 */
const syncDocumentTheme = (value: ThemeMode) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', value === 'dark');
  root.classList.toggle('light', value === 'light');
  root.dataset.theme = value;
};

syncDocumentTheme(theme.value);

// 主题变化时：持久化 + 同步文档根节点
watch(theme, (value) => {
  syncDocumentTheme(value);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
});

/** 主题组合式函数：返回响应式主题状态与切换方法。 */
export const useTheme = () => {
  const isDark = computed(() => theme.value === 'dark');

  const setTheme = (value: ThemeMode) => {
    theme.value = value;
  };

  const toggleTheme = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  };

  return { theme, isDark, setTheme, toggleTheme };
};
