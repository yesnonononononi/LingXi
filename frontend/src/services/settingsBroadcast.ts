/**
 * 设置变更的跨窗口广播。
 *
 * <p>设置在服务端只有一份（{@code user_configs} 单例行），但每个窗口各持一份内存镜像。
 * 一个窗口改完，另一个窗口的滑杆就会显示旧值 —— 而真正生效的却是新值。这里只做「通知」，
 * 收到通知的一方仍然回读后端，**不在广播里传值**：传值等于让前端多出一份可漂移的真源。</p>
 *
 * <p>非浏览器环境（Node 跑测试）直接静默降级，避免开出一条让测试进程退不出去的通道。</p>
 */
const CHANNEL_NAME = 'lingxi:user-config';

type Listener = () => void;

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => {
      for (const listener of [...listeners]) listener();
    };
  }
  return channel;
}

/** 通知其它窗口「设置已被改过」，由它们自行回读。 */
export function notifySettingsChanged(): void {
  ensureChannel()?.postMessage({ type: 'changed' });
}

/**
 * 订阅其它窗口的变更通知。
 *
 * @returns 取消订阅函数；重复调用只创建一条通道
 */
export function onSettingsChanged(listener: Listener): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && channel) {
      channel.close();
      channel = null;
    }
  };
}

/** 仅供测试：清掉通道与订阅，避免用例之间互相污染。 */
export function resetSettingsBroadcastForTest(): void {
  channel?.close();
  channel = null;
  listeners.clear();
}
