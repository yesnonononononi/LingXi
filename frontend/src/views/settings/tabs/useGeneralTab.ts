import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useTheme, THEME_STORAGE_KEY } from '../../../composables/useTheme';
import { useUserConfigStore } from '../../../stores/userConfigStore';
import { getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl } from '../../../utils/apiConfig';
import { useI18n } from '../../../i18n';
import type { LocalePreference } from '../../../i18n';
import {
  playNotificationSound,
  readSoundPreference,
  writeSoundPreference,
  DEFAULT_SOUND_ID,
  type SoundId,
} from '../../../notification/sound';
import {
  useBackgroundPreference,
  DEFAULT_BACKGROUND_SCRIM,
  MAX_BACKGROUND_SCRIM,
  MIN_BACKGROUND_SCRIM,
  type BackgroundFit,
} from '../../../composables/useBackgroundPreference';

/** 主页背景填充方式选项；顺序即设置页里的展示顺序。 */
const BACKGROUND_FIT_OPTIONS: { value: BackgroundFit; labelKey: string }[] = [
  { value: 'cover', labelKey: 'settings.general.backgroundFitCover' },
  { value: 'contain', labelKey: 'settings.general.backgroundFitContain' },
];

/** 音效 id 与文案键的映射；顺序即设置页里的展示顺序（静音在最前）。 */
const SOUND_LABEL_KEYS: { id: SoundId; labelKey: string }[] = [
  { id: 'none', labelKey: 'settings.general.soundNone' },
  { id: 'chime', labelKey: 'settings.general.soundChime' },
  { id: 'marimba', labelKey: 'settings.general.soundMarimba' },
  { id: 'bell', labelKey: 'settings.general.soundBell' },
  { id: 'pop', labelKey: 'settings.general.soundPop' },
];

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
  // 提示音下拉的展开态与语言下拉同层管理，点空白处一起收起
  const isSoundOpen = ref(false);
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
    if (isLanguageOpen.value) isSoundOpen.value = false;
  };

  const closeGeneralDropdowns = () => {
    isLanguageOpen.value = false;
    isSoundOpen.value = false;
  };

  const handleDocumentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    // 本页的下拉都挂这个类名：点在任一触发器/面板内就不收起，点别处统一关掉
    if (!target?.closest('.general-dropdown-container')) {
      closeGeneralDropdowns();
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

  // 通知提示音：偏好只在本机，不进后端配置（与主题、语言同属「这台机器的听感」）
  const soundPref = ref<SoundId>(readSoundPreference());
  const soundOptions = SOUND_LABEL_KEYS;
  const currentSoundLabel = computed(
    () => t(SOUND_LABEL_KEYS.find(o => o.id === soundPref.value)?.labelKey
      ?? SOUND_LABEL_KEYS.find(o => o.id === DEFAULT_SOUND_ID)!.labelKey),
  );

  const toggleSoundDropdown = (e?: Event) => {
    e?.stopPropagation();
    isSoundOpen.value = !isSoundOpen.value;
    if (isSoundOpen.value) isLanguageOpen.value = false;
  };

  const handleSelectSound = (id: SoundId) => {
    soundPref.value = id;
    isSoundOpen.value = false;
    writeSoundPreference(id);
    // 选中即试听：改完不用等到真的跑一轮任务才知道是什么声
    playNotificationSound(id);
  };

  // 主页背景：外观偏好，只在本机（与主题 / 语言 / 提示音同属「这台机器长什么样」）。
  // 状态与 DOM 写入全部在 useBackgroundPreference 里，本页只做控件绑定。
  const {
    preference: backgroundPreference,
    hasBackground,
    pickImage: pickBackgroundImage,
    clear: clearBackground,
    setFit: setBackgroundFit,
    setScrim: setBackgroundScrim,
  } = useBackgroundPreference();
  const isBackgroundPicking = ref(false);
  const backgroundFitOptions = BACKGROUND_FIT_OPTIONS;
  /** 滑杆用百分数（0–100），内部状态是 0–1。 */
  const backgroundScrimPercent = computed<number>(() => {
    const scrim = backgroundPreference.value?.scrim ?? DEFAULT_BACKGROUND_SCRIM;
    return Math.round(scrim * 100);
  });

  const handlePickBackground = async (): Promise<void> => {
    if (isBackgroundPicking.value) return;
    isBackgroundPicking.value = true;
    try {
      await pickBackgroundImage();
    } finally {
      isBackgroundPicking.value = false;
    }
  };

  const handleClearBackground = async (): Promise<void> => {
    await clearBackground();
  };

  const handleSelectBackgroundFit = (fit: BackgroundFit): void => {
    setBackgroundFit(fit);
  };

  const handleBackgroundScrimInput = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    const percent = Number(target.value);
    if (!Number.isFinite(percent)) return;
    const clampedPercent = Math.min(MAX_BACKGROUND_SCRIM * 100, Math.max(MIN_BACKGROUND_SCRIM * 100, percent));
    setBackgroundScrim(clampedPercent / 100);
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
    soundPref,
    soundOptions,
    currentSoundLabel,
    isSoundOpen,
    toggleSoundDropdown,
    handleSelectSound,
    backgroundPreference,
    hasBackground,
    isBackgroundPicking,
    backgroundFitOptions,
    backgroundScrimPercent,
    handlePickBackground,
    handleClearBackground,
    handleSelectBackgroundFit,
    handleBackgroundScrimInput,
  };
}
