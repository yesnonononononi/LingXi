import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { PersonalizationAPI } from '../services/personalization';
import { isOk } from '../utils/api';
import { t } from '../i18n';

/** 时段：早上（5–11）、下午（12–17）、其余（18–4）算夜深。 */
export type GreetingBand = 'morning' | 'afternoon' | 'lateNight';

export function greetingBandOf(date: Date): GreetingBand {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'lateNight';
}

const KEY_BY_BAND: Record<GreetingBand, string> = {
  morning: 'chat.welcome.greetingMorning',
  afternoon: 'chat.welcome.greetingAfternoon',
  lateNight: 'chat.welcome.greetingLateNight',
};

/** 个性化里的「对我的称呼」：模块级缓存，切来切去不重复请求。 */
const userName = ref<string | null>(null);
const ready = ref(false);
let loading: Promise<void> | null = null;

function loadUserName(): Promise<void> {
  if (loading) return loading;
  loading = PersonalizationAPI.current()
    .then(res => {
      const title = isOk(res.code) ? res.data?.title?.trim() : '';
      userName.value = title ? title : null;
    })
    .catch(() => {
      // 拿不到称呼不属于致命错误：退回不带名字的问候语。
      userName.value = null;
    })
    .finally(() => {
      ready.value = true;
    });
  return loading;
}

/**
 * 欢迎语：按当前时段取问候语，带上个性化里配置的称呼。
 *
 * <p>每分钟重算一次，页面跨时段挂着也能自动换文案；名字加载完成前 `ready` 为 false，
 * 调用方先不渲染打字机，避免「先打默认句、再整个重打一遍」的闪烁。</p>
 */
export function useGreeting() {  const now = ref(new Date());
  let timer: number | undefined;

  onMounted(() => {
    void loadUserName();
    timer = window.setInterval(() => {
      now.value = new Date();
    }, 60_000);
  });

  onBeforeUnmount(() => {
    if (timer !== undefined) window.clearInterval(timer);
  });

  const text = computed(() => {
    const base = KEY_BY_BAND[greetingBandOf(now.value)];
    const name = userName.value;
    return name ? t(`${base}Named`, { name }) : t(base);
  });

  return { text, ready };
}

/**
 * 设置页保存称呼后同步内存值：否则欢迎语会一直用旧名字（模块级缓存不会自动失效）。
 */
export function setGreetingUserName(name: string | null | undefined) {
  const trimmed = name?.trim();
  userName.value = trimmed ? trimmed : null;
  ready.value = true;
}
