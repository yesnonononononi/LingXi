/**
 * 卡片视觉 token 的唯一定义处（状态色 / 图标 / 容器样式）。
 *
 * <p>为什么集中：三类卡片（PLAN / CHOICE / COMMAND）此前各写一套状态徽标与容器样式，
 * 导致 light 主题下出现 `text-emerald-500`/`text-amber-500` 这类低对比度（≈2.1–3.9:1，低于 WCAG AA 4.5:1）
 * 的写法，且内边距 / 圆角 / 阴影三处漂移。这里收成一套：light 用 `*-50 底 + *-700 字 + *-200/60 边框`，
 * dark 用 `*-950/30 底 + *-400 字`，与 COMMAND 卡已确立的正确写法对齐。</p>
 */

/** 卡片状态语义色（由 outcome / pending 派生）。 */
export type CardTone = 'approved' | 'rejected' | 'pending' | 'unknown';

/** 由卡片展示数据派生状态语义色：待决策 → pending；已决按 outcome 归类（未知不臆断成功）。 */
export function resolveCardTone(card: { pending?: boolean; outcome?: string }): CardTone {
  if (card.pending === true) return 'pending';
  const outcome = String(card.outcome ?? '').trim().toUpperCase();
  if (outcome === 'APPROVED' || outcome === 'SUCCEEDED' || outcome === 'ANSWERED') return 'approved';
  if (outcome === 'REJECTED' || outcome === 'FAILED' || outcome === 'TIMED_OUT') return 'rejected';
  return 'unknown';
}

/** 状态小圆点。 */
export function cardDotClass(tone: CardTone): string {
  switch (tone) {
    case 'approved':
      return 'bg-emerald-500';
    case 'rejected':
      return 'bg-red-500';
    case 'pending':
      return 'bg-amber-400 animate-pulse';
    default:
      return 'bg-gray-400';
  }
}

/**
 * 状态徽标 / 已决横幅（胶囊或整行提示）的背景+文字+边框。
 *
 * <p>light 必须用 `*-50 / *-700 / *-200` 组合：浅底深字在白底卡片上对比度达标；
 * dark 用 `*-950/30 / *-400`。禁止再写 `bg-*-500/10 text-*-500`（白底对比度不达标）。</p>
 */
export function cardToneClass(tone: CardTone, isDark?: boolean): string {
  const map: Record<CardTone, { light: string; dark: string }> = {
    approved: {
      light: 'bg-emerald-50 text-emerald-700 border-emerald-200/60',
      dark: 'bg-emerald-950/30 text-emerald-400 border-emerald-900/40'
    },
    rejected: {
      light: 'bg-red-50 text-red-700 border-red-200/60',
      dark: 'bg-red-950/30 text-red-400 border-red-900/40'
    },
    pending: {
      light: 'bg-amber-50 text-amber-700 border-amber-200/60',
      dark: 'bg-amber-950/30 text-amber-400 border-amber-900/40'
    },
    unknown: {
      light: 'bg-gray-50 text-gray-600 border-gray-200',
      dark: 'bg-gray-800/40 text-gray-400 border-gray-700/60'
    }
  };
  return `border ${isDark ? map[tone].dark : map[tone].light}`;
}

/** 错误提示文案色（统一，light 用 600 保证对比度）。 */
export const CARD_ERROR_TEXT_CLASS = 'text-red-600 dark:text-red-400';

/** 卡片类型图标（单 path 的 stroke 图标），供已决摘要行等轻量场景使用。 */
const CARD_KIND_ICON_PATH: Record<string, string> = {
  PLAN: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  CHOICE: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  COMMAND: 'M8 9l3 3-3 3m5 0h3M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  UNAVAILABLE: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
};

/** 取卡片类型图标的 path d；未知类型回落到 UNAVAILABLE 图标。 */
export function cardKindIconPath(kind: string): string {
  return CARD_KIND_ICON_PATH[kind] ?? CARD_KIND_ICON_PATH.UNAVAILABLE;
}

/** 卡片容器统一样式（消除 p-6 / p-3.5 / px-5 与任意阴影值漂移）。 */
export const CARD_SHELL_CLASS = 'w-full rounded-2xl border my-2.5 shadow-xs transition-colors';

/** 卡片内边距（统一 4/8 基数）。 */
export const CARD_BODY_CLASS = 'p-4 space-y-3';
