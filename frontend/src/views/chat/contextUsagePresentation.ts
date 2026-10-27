import { t } from '../../i18n';

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

export function resolveContextRingDash(usage: ContextUsageIndicatorData | null | undefined): string {
  const ratio = usage?.ratio ?? (usage?.maxTokens && usage.maxTokens > 0 && usage.usedTokens != null
    ? usage.usedTokens / usage.maxTokens : null);
  const clamped = ratio != null ? Math.min(Math.max(ratio, 0), 1) : 0;
  const circumference = 2 * Math.PI * 6;
  const arc = clamped * circumference;
  return `${arc} ${circumference - arc}`;
}
