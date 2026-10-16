import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useTheme, THEME_STORAGE_KEY } from '../../../composables/useTheme';
import { useUserConfigStore } from '../../../stores/userConfigStore';
import { getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl } from '../../../utils/apiConfig';
import { useI18n } from '../../../i18n';
import type { LocalePreference } from '../../../i18n';

/**
 * 通用设置页。
 *
 * <p>沙箱相关设置（执行环境、沙箱服务、工作空间权限、工具权限）已迁到安全中心，
 * 见 `useSandboxSettings` —— 它们的语义是隔离策略，不属于「通用」。</p>
 */
export function useGeneralTab() {
  const userConfig = useUserConfigStore();
  const { t, preference, setPreference } = useI18n();

  // 主题设置：内存态在 useTheme，落库走 userConfigStore
  const { setTheme } = useTheme();
  const themeMode = ref<'light' | 'dark' | 'system'>('system');

  // 语言设置：偏好与持久化在 i18n 单例，此处仅提供下拉所需的响应式选项
  const isLanguageOpen = ref(false);
  const languageOptions = computed<{ value: LocalePreference; label: string }[]>(() => [
    { value: 'system', label: t('settings.general.langSystem') },
    { value: 'zh-CN', label: t('settings.general.langZh') },
    { value: 'en-US', label: t('settings.general.langEn') },
  ]);
  const currentLanguageLabel = computed(
    () => languageOptions.value.find(o => o.value === preference.value)?.label
      ?? t('settings.general.langSystem'),
  );

  const handleSelectLanguage = (value: LocalePreference) => {
    isLanguageOpen.value = false;
    setPreference(value);
  };

  const toggleLanguageDropdown = (e?: Event) => {
    e?.stopPropagation();
    isLanguageOpen.value = !isLanguageOpen.value;
  };

  const closeGeneralDropdowns = () => {
    isLanguageOpen.value = false;
  };

  const handleDocumentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest('.language-dropdown-container')) {
      isLanguageOpen.value = false;
    }
  };

  const handleSelectTheme = (mode: 'light' | 'dark' | 'system') => {
    themeMode.value = mode;
    if (mode === 'system') {
      // 跟随系统：解析出当前系统主题落到内存与库里。
      // 这样下次打开仍是确定的一个值，不会因为系统主题变了而与库里记录对不上。
      localStorage.removeItem(THEME_STORAGE_KEY);
      mode = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    setTheme(mode);
    const persisted = mode === 'dark' ? 'DARK' : 'LIGHT';
    void userConfig.patch('renderTheme', persisted, { renderTheme: persisted });
  };

  onMounted(async () => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') {
      themeMode.value = saved;
    } else {
      themeMode.value = 'system';
    }

    // 配置真值统一由 store 载入；本页只负责把已载入的 renderTheme 同步到运行时主题。
    if (await userConfig.load()) {
      const remote = userConfig.renderTheme === 'DARK' ? 'dark' : 'light';
      // 本地显式选过就尊重本地（首屏已经按它渲染过了），否则采纳服务端偏好
      if (!saved) {
        setTheme(remote);
        themeMode.value = remote;
      }
    }

    window.addEventListener('click', handleDocumentClick);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('click', handleDocumentClick);
  });

  // 后端服务地址配置 (桌面客户端 / 局域网 / 远程直连)
  const apiBaseUrl = ref(getApiBaseUrl() || 'http://localhost:8088');
  const isApiUrlSaved = ref(false);

  const handleSaveApiUrl = () => {
    setApiBaseUrl(apiBaseUrl.value);
    apiBaseUrl.value = getApiBaseUrl() || 'http://localhost:8088';
    isApiUrlSaved.value = true;
    setTimeout(() => {
      isApiUrlSaved.value = false;
    }, 2000);
  };

  const handleResetApiUrl = () => {
    resetApiBaseUrl();
    apiBaseUrl.value = getApiBaseUrl() || 'http://localhost:8088';
  };

  return {
    themeMode,
    isLanguageOpen,
    languageOptions,
    currentLanguageLabel,
    handleSelectLanguage,
    apiBaseUrl,
    isApiUrlSaved,
    handleSaveApiUrl,
    handleResetApiUrl,
    toggleLanguageDropdown,
    closeGeneralDropdowns,
    handleSelectTheme,
  };
}
