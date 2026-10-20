/**
 * 主题令牌 → Tailwind 工具类的静态映射表。
 *
 * <p><b>为什么全部写成字面量 Record，而不是拼字符串</b>：Tailwind 靠扫描源码文本生成 CSS，
 * `bg-lx-${tone}` 这种模板字符串不会被收集，产物里就没有这条规则。
 * 因此每个类名都必须以完整字面量出现在源码里，静态查表既满足这点、又能被单测覆盖。</p>
 *
 * <p><b>这些类名从哪来</b>：`src/style.css` 的 `@theme inline` 块把 `--lx-*` 映射成 `--color-lx-*`，
 * Tailwind v4 据此生成 `bg-lx-surface` / `text-lx-primary` / `border-lx-border-strong` 等工具类。
 * 单测会断言本文件出现的每个类名都能在 `@theme` 块中找到对应变量（防止写错名字静默失效）。</p>
 */

export type SurfaceTone =
  | 'canvas'
  | 'canvas-subtle'
  | 'surface'
  | 'elevated'
  | 'sunken'
  | 'hover'
  | 'active'
  | 'selected'
  | 'overlay';

export type TextTone =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'muted'
  | 'disabled'
  | 'inverse'
  | 'on-accent';

export type BorderTone = 'subtle' | 'default' | 'strong' | 'focus';

export type StatusTone = 'info' | 'success' | 'warning' | 'danger';

export type RadiusTone = 'sm' | 'md' | 'lg' | 'full';

export type ShadowTone = '1' | '2' | '3';

/** 背景 */
export const SURFACE_BG: Readonly<Record<SurfaceTone, string>> = Object.freeze({
  'canvas': 'bg-lx-canvas',
  'canvas-subtle': 'bg-lx-canvas-subtle',
  'surface': 'bg-lx-surface',
  'elevated': 'bg-lx-surface-elevated',
  'sunken': 'bg-lx-surface-sunken',
  'hover': 'bg-lx-surface-hover',
  'active': 'bg-lx-surface-active',
  'selected': 'bg-lx-surface-selected',
  'overlay': 'bg-lx-overlay'
});

/** 文字色 */
export const TEXT_FG: Readonly<Record<TextTone, string>> = Object.freeze({
  'primary': 'text-lx-primary',
  'secondary': 'text-lx-secondary',
  'tertiary': 'text-lx-tertiary',
  'muted': 'text-lx-muted',
  'disabled': 'text-lx-disabled',
  'inverse': 'text-lx-inverse',
  'on-accent': 'text-lx-on-accent'
});

/** 边框色（注意 default 那一档的类名是 border-lx-border，不是 border-lx-default） */
export const BORDER_LINE: Readonly<Record<BorderTone, string>> = Object.freeze({
  'subtle': 'border-lx-border-subtle',
  'default': 'border-lx-border',
  'strong': 'border-lx-border-strong',
  'focus': 'border-lx-border-focus'
});

/** 状态色文字 */
export const STATUS_FG: Readonly<Record<StatusTone, string>> = Object.freeze({
  'info': 'text-lx-info',
  'success': 'text-lx-success',
  'warning': 'text-lx-warning',
  'danger': 'text-lx-danger'
});

/** 状态色柔和背景（徽章、提示条底） */
export const STATUS_BG_SOFT: Readonly<Record<StatusTone, string>> = Object.freeze({
  'info': 'bg-lx-info-soft',
  'success': 'bg-lx-success-soft',
  'warning': 'bg-lx-warning-soft',
  'danger': 'bg-lx-danger-soft'
});

/** 强调色 */
export const ACCENT_FG: Readonly<Record<'default' | 'hover', string>> = Object.freeze({
  'default': 'text-lx-accent',
  'hover': 'text-lx-accent-hover'
});

/** 圆角 */
export const RADIUS: Readonly<Record<RadiusTone, string>> = Object.freeze({
  'sm': 'rounded-lx-sm',
  'md': 'rounded-lx-md',
  'lg': 'rounded-lx-lg',
  'full': 'rounded-lx-full'
});

/** 阴影 */
export const SHADOW: Readonly<Record<ShadowTone, string>> = Object.freeze({
  '1': 'shadow-lx-1',
  '2': 'shadow-lx-2',
  '3': 'shadow-lx-3'
});

/**
 * 组类名小工具：过滤掉 undefined / false / 空串，避免模板里出现 `undefined` 字符串。
 * 刻意不引入 clsx/tailwind-merge，保持 A 档零新增依赖。
 */
export const cn = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');

/** 全部映射表，供测试遍历（新增表必须挂到这里，否则不会被校验） */
export const ALL_MAPPING_TABLES: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = Object.freeze([
  ['SURFACE_BG', SURFACE_BG],
  ['TEXT_FG', TEXT_FG],
  ['BORDER_LINE', BORDER_LINE],
  ['STATUS_FG', STATUS_FG],
  ['STATUS_BG_SOFT', STATUS_BG_SOFT],
  ['ACCENT_FG', ACCENT_FG],
  ['RADIUS', RADIUS],
  ['SHADOW', SHADOW]
]);
