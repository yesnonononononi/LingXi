import { onScopeDispose } from 'vue';
import { t } from '../i18n';
import { readSoundPreference } from '../notification/sound';
import { useTheme } from './useTheme';
import {
  isAppInactive,
  onNotificationActivate,
  sendDesktopNotification,
  type NotifyActivation,
  type NotifyKind,
} from '../utils/platform';

/**
 * 同一会话、同一类结果的最小通知间隔。
 *
 * <p>没有这个间隔就会变成轰炸机：一个长任务里每次工具审批都触发 SUSPENDED，
 * 用户只是去泡了杯咖啡，回来能收到十几条「等待你的确认」。</p>
 */
export const SESSION_COOLDOWN_MS = 25_000;

/**
 * 任意两条通知之间的最小间隔。
 *
 * <p>团队模式/子代理并发时，多个会话可能在同一秒内一起结束。逐个弹出来只会
 * 叠成一堆卡片，留一个全局间隔保证它们有先后而不是糊成一坨。</p>
 */
export const GLOBAL_COOLDOWN_MS = 3_000;

/** 计算结果种类：终态三件套 + 挂起等待。 */
export type NotifyOutcome = NotifyKind;

/**
 * 通知闸门：决定「这一刻该不该弹」。
 *
 * <p>抽成独立类而不是塞进 composable，是因为它的判定是通知功能里唯一值得
 * 做变异测试的部分 —— 没有 DOM、没有 Electron，纯时间与状态。</p>
 */
export class NotificationGate {
  /** key = `${sessionId}|${kind}`，值是上次放行的时间戳。 */
  private readonly lastByKey = new Map<string, number>();
  private lastAnyAt = Number.NEGATIVE_INFINITY;
  private readonly sessionCooldownMs: number;
  private readonly globalCooldownMs: number;

  constructor(
    sessionCooldownMs: number = SESSION_COOLDOWN_MS,
    globalCooldownMs: number = GLOBAL_COOLDOWN_MS,
  ) {
    this.sessionCooldownMs = sessionCooldownMs;
    this.globalCooldownMs = globalCooldownMs;
  }

  /**
   * 判定是否放行，放行时**立即记账**（调用方无需再手动登记）。
   *
   * @param sessionKey 归属会话标识；空值时视为「不属于任何会话」，共用同一个 key
   * @param kind 结果种类
   * @param now 当前时间戳（毫秒）
   */
  accept(sessionKey: string | null | undefined, kind: NotifyOutcome, now: number): boolean {
    // 全局间隔先判：并发会话同时结束时只让第一条过
    if (now - this.lastAnyAt < this.globalCooldownMs) return false;

    const key = `${sessionKey ?? '__none__'}|${kind}`;
    const last = this.lastByKey.get(key);
    if (last !== undefined && now - last < this.sessionCooldownMs) return false;

    this.lastByKey.set(key, now);
    this.lastAnyAt = now;
    return true;
  }

  /** 测试与排障用：清空记录。 */
  reset(): void {
    this.lastByKey.clear();
    this.lastAnyAt = Number.NEGATIVE_INFINITY;
  }
}

/** 每种结果对应的 i18n key（标题用会话名，正文用这里的短句）。 */
const BODY_KEYS: Record<NotifyOutcome, string> = {
  completed: 'notify.body.completed',
  failed: 'notify.body.failed',
  cancelled: 'notify.body.cancelled',
  suspended: 'notify.body.suspended',
};

/** 组装通知正文：优先给一句人话，再附上会话标题以外的上下文。 */
function buildBody(kind: NotifyOutcome, detail?: string): string {
  const base = t(BODY_KEYS[kind]);
  const extra = (detail ?? '').trim();
  if (!extra) return base;
  // 正文两行就截断，超出的内容在主进程还会被再切一次
  const clipped = extra.length > 90 ? `${extra.slice(0, 90)}…` : extra;
  return `${base} · ${clipped}`;
}

export interface DesktopNotificationOptions {
  /** 用户点了通知要跳到哪个会话；由宿主决定怎么切。 */
  onActivate?: (payload: NotifyActivation) => void;
}

/**
 * 任务结果的桌面通知。
 *
 * <p>只在应用不在前台时弹（{@link isAppInactive}）—— 用户正盯着会话看的时候
 * 再弹一条「任务已完成」，纯属噪音。</p>
 *
 * <p><b>覆盖边界</b>：本组合式只服务于「用户仍停留在该会话、但窗口在后台」这一种情形。
 * 切走会话后原会话的 SSE 连接会被释放（`SessionEventStream` 的引用计数语义），
 * 完成事件根本收不到，这里也就无从触发 —— 这是订阅模型的限制，不是本模块的缺陷。</p>
 */
export function useDesktopNotification(options: DesktopNotificationOptions = {}) {
  const gate = new NotificationGate();
  // 通知卡片与主应用同主题：深浅两套 Mica 观感差别很大，配色不能各走各的
  const { theme } = useTheme();

  /**
   * 通知一次任务结果。
   *
   * @param sessionId 归属会话，用户点通知时据此跳转
   * @param kind 结果种类
   * @param sessionTitle 会话标题，作为通知标题
   * @param detail 可选的补充说明（如失败原因摘要）
   * @returns 是否真的弹了
   */
  async function notifyOutcome(
    sessionId: string | number | null,
    kind: NotifyOutcome,
    sessionTitle?: string | null,
    detail?: string,
  ): Promise<boolean> {
    if (!isAppInactive()) return false;
    if (!gate.accept(sessionId == null ? null : String(sessionId), kind, Date.now())) return false;

    const title = (sessionTitle ?? '').trim() || t('notify.titleFallback');
    // 每次现读设置：用户刚在设置里改完音效，下一条通知就该生效，不重启、不缓存
    const sound = readSoundPreference();
    return sendDesktopNotification({
      title,
      body: buildBody(kind, detail),
      sessionId: sessionId == null ? null : String(sessionId),
      kind,
      theme: theme.value,
      // 静音就干脆不塞字段：主进程无须理解「关掉」这个状态
      sound: sound === 'none' ? undefined : sound,
    });
  }

  const unsubscribe = onNotificationActivate((payload) => {
    options.onActivate?.(payload);
  });

  onScopeDispose(unsubscribe);

  return { notifyOutcome };
}
 
