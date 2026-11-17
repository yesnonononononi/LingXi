import {onBeforeUnmount, onMounted, ref} from 'vue';
import {PersonalizationAPI} from '../services/personalization';
import {isOk} from '../utils/api';
import {
  DEFAULT_SHORTCUTS,
  GLOBAL_SHORTCUT_ACTIONS,
  formatShortcutLabel,
  matchesShortcut,
  normalizeShortcutMap,
  type GlobalShortcutAction,
  type ShortcutAction,
  type ShortcutKeyEvent,
  type ShortcutMap,
} from '../utils/shortcuts';

/**
 * 运行时快捷键绑定：模块级单例。
 *
 * <p>为什么不是组件内的 ref：窗口级监听、输入框的发送判定、设置页的展示要读**同一份**绑定，
 * 三处各持一份就会出现「设置页显示 Ctrl+B，实际按的还是 Enter」。真源在后端个性化配置
 * （`personalization.json`），这里只是它在本窗口的镜像：{@link loadShortcutBindings} 拉一次，
 * 设置页保存后 {@link applyShortcutBindings} 立刻覆盖。</p>
 */
const bindings = ref<ShortcutMap>({ ...DEFAULT_SHORTCUTS });
/** 是否已从后端读过一次（失败也置 true：回落默认值必须可用，不能卡在未知态）。 */
const ready = ref(false);
let loading: Promise<void> | null = null;

/** 用一份后端配置覆盖当前绑定；未配置或非法的项回落默认值。 */
export function applyShortcutBindings(raw: Partial<Record<string, string>> | null | undefined): void {
  bindings.value = normalizeShortcutMap(raw);
  ready.value = true;
}

/** 从后端拉一次绑定；多处调用只发一个请求。 */
export function loadShortcutBindings(): Promise<void> {
  if (loading) return loading;
  loading = PersonalizationAPI.current()
    .then(result => {
      // 读失败不打扰用户：快捷键回落默认值仍然可用，设置页会各自显示加载失败。
      applyShortcutBindings(isOk(result.code) ? result.data?.shortcuts : null);
    })
    .catch(() => {
      applyShortcutBindings(null);
    });
  return loading;
}

/** 只读视图：`matches` / `label` 按调用时刻的绑定计算，读到的一定是最新值。 */
export function useShortcuts() {
  const matches = (action: ShortcutAction, event: ShortcutKeyEvent): boolean =>
    matchesShortcut(event, bindings.value[action]);
  const label = (action: ShortcutAction, platform?: string): string =>
    formatShortcutLabel(bindings.value[action], platform);
  return { bindings, ready, matches, label };
}

/**
 * 窗口级快捷键分发。
 *
 * <p>只分发 `global` 范围的动作：输入框的发送/换行必须由输入框自己的 keydown 决定，
 * 在这里再拦一次，用户按 Enter 就会发两遍。</p>
 *
 * <p>命中即 `preventDefault` 并返回 —— 一次按键只触发第一个动作。两个动作绑到同一个键时
 * 设置页会拦下；这里是万一存进脏数据时的运行时兜底。</p>
 */
export function useGlobalShortcuts(handlers: () => Record<GlobalShortcutAction, () => void>): void {
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    const current = bindings.value;
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      if (!matchesShortcut(event, current[action])) continue;
      const handler = handlers()[action];
      if (!handler) continue;
      event.preventDefault();
      handler();
      return;
    }
  };
  onMounted(() => window.addEventListener('keydown', onKeydown));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
}
