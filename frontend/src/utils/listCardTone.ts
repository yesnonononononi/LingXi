/**
 * 列表卡片的徽标 / 操作按钮样式令牌（浅深两态都写在同一处，模板里只传语义）。
 *
 * 存在的理由：MCP 设置页曾在一行里塞 4 个徽标 + 5 个彩色按钮，颜色靠 20 多个
 * `isDark ? '...' : '...'` 三元表达式散落在模板各处 —— 改一次配色要翻半个文件，
 * 而且每加一个徽标就多一份自由度，最终谁都能长出自己的颜色。
 *
 * 约定：
 * - 语义只有这几种，**不要**在模板里再造新颜色；确实需要新语义就加到 `ChipTone` / `ActionTone`。
 * - 用 Tailwind 的 `dark:` 变体而不是 `isDark` 三元：项目 `.dark` 类由 `useTheme` 统一切换，
 *   两种写法在本仓等价，但前者少一层运行时分支。
 * - 徽标 = 只读事实（中性色优先）；彩色只留给「实时状态」和「主操作」，否则一屏全是绿红。
 */
export type ChipTone = 'muted' | 'ok' | 'warn' | 'danger';
export type ActionTone = ChipTone | 'accent' | 'primary';

const CHIP_BASE =
  'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-lx-fs-xs font-medium leading-none whitespace-nowrap';

const CHIP_TONES: Record<ChipTone, string> = {
  muted: 'border-zinc-200 bg-black/5 text-zinc-500 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300',
  ok: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
};

/** 徽标类名。`tone` 决定颜色，尺寸/圆角/字重由令牌保证一致。 */
export const chipClass = (tone: ChipTone) => `${CHIP_BASE} ${CHIP_TONES[tone]}`;

const ACTION_BASE =
  'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-lx-fs-sm font-medium whitespace-nowrap transition-colors disabled:cursor-wait disabled:opacity-60';

const ACTION_TONES: Record<ActionTone, string> = {
  muted: 'text-zinc-600 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/5',
  ok: 'text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/10',
  accent: 'text-blue-600 hover:bg-blue-500/10 dark:text-cyan-400 dark:hover:bg-white/5',
  warn: 'text-amber-600 hover:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/10',
  danger: 'text-red-500 hover:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/10',
  primary: 'text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/10',
};

/** 卡片操作条里的文字按钮类名。`primary` 用于该卡的主操作（如「测试连接」）。 */
export const actionClass = (tone: ActionTone) => `${ACTION_BASE} ${ACTION_TONES[tone]}`;
