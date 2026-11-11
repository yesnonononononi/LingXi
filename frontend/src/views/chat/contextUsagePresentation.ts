import {t} from '../../i18n';

export interface ContextUsageIndicatorData {
  usedTokens?: number | null;
  maxTokens?: number | null;
  ratio?: number | null;
  phase?: string;
  band?: string;
}

const formatContextTokens = (count: number): string => count >= 1000 ? `${(count / 1000).toFixed(1)}K` : `${count}`;

/** 输入区和子会话必须使用同一统计口径与压缩文案。 */
export function resolveContextUsageText(usage: ContextUsageIndicatorData | null | undefined): string {
  const used = usage?.usedTokens;
  if (used == null || used <= 0) return '';
  const max = usage?.maxTokens ?? null;
  const ratio = usage?.ratio ?? (max && max > 0 ? used / max : null);
  const percent = ratio != null && ratio >= 0 ? `${(ratio * 100).toFixed(1)}%` : null;
  const amount = `${formatContextTokens(used)}${max && max > 0 ? ` / ${formatContextTokens(max)}` : ''}`;
  const compressing = usage?.phase === 'SQUEEZE_STARTED' && usage?.band !== 'PRUNE';
  const label = compressing ? t('chat.input.contextCompressing') : t('chat.input.contextUsed');
  return percent ? `${percent} · ${amount} ${label}` : `${amount} ${label}`;
}

/**
 * 浮层文案：**永不为空**。
 *
 * <p>为什么不能直接用 {@link resolveContextUsageText}：框架按 `usageReportInterval`（默认 5 个模型轮次）
 * 节流汇报用量，会话头几轮根本没有 `CONTEXT_UPDATE`；模型未配上下文窗口时采集结果本身就是 null。
 * 环必须常驻（否则用户会看到图标凭空消失），常驻就得有话说 —— 未采集时给占位文案，
 * 而不是让浮层空着或渲染器自己编一句。</p>
 */
export function resolveContextUsageTip(usage: ContextUsageIndicatorData | null | undefined): string {
  return resolveContextUsageText(usage) || t('chat.input.contextUsagePending');
}

export function resolveContextRingDash(usage: ContextUsageIndicatorData | null | undefined): string {
  const ratio = usage?.ratio ?? (usage?.maxTokens && usage.maxTokens > 0 && usage.usedTokens != null
    ? usage.usedTokens / usage.maxTokens : null);
  const clamped = ratio != null ? Math.min(Math.max(ratio, 0), 1) : 0;
  const circumference = 2 * Math.PI * 6;
  const arc = clamped * circumference;
  return `${arc} ${circumference - arc}`;
}
