import {onMounted, onUnmounted} from 'vue';
import {useUserConfigStore} from '../stores/userConfigStore';
import {onSettingsChanged} from '../services/settingsBroadcast';

/**
 * 把「与后端对齐」接到两个触发点上。
 *
 * <p>各管一种「另一个窗口改过了」：</p>
 * <ul>
 *   <li>窗口获得焦点：另一窗口改完切回来，立刻对齐（不依赖对方广播是否送达）；</li>
 *   <li>收到广播：两个窗口并排可见时不会发生焦点切换，靠广播即时对齐。</li>
 * </ul>
 *
 * <p>只回读、不推送本地值：服务端是唯一真源，前端不参与「谁的值更新」的仲裁。
 * 单独导出成纯函数是为了能在测试里用假窗口验证两个触发点，而不必挂载组件。</p>
 *
 * @returns 解除订阅
 */
export function attachSettingsSync(reconcile: () => void, target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  target.addEventListener('focus', reconcile);
  const offBroadcast = onSettingsChanged(reconcile);
  return () => {
    target.removeEventListener('focus', reconcile);
    offBroadcast();
  };
}

/** 本窗口的设置镜像跟随服务端真值（挂载时接上，卸载时解除）。 */
export function useSettingsSync(): void {
  const userConfig = useUserConfigStore();
  const reconcile = (): void => {
    void userConfig.reconcile();
  };

  let detach: (() => void) | null = null;
  onMounted(() => {
    detach = attachSettingsSync(reconcile, window);
  });
  onUnmounted(() => {
    detach?.();
    detach = null;
  });
}
