/**
 * 主题令牌元数据：令牌名 → 元信息（分组、是否允许用户主题包覆盖）。
 *
 * <p>与 {@link file://./tokens.css} 必须**键集合完全一致**（双向差集为空），
 * 由 `frontend/tests/themeTokens.test.ts` 守住；改一边不改另一边会直接红。</p>
 */

/** 令牌分组：仅用于设置页分组展示与文档，不参与渲染。 */
export type ThemeTokenGroup = 'surface' | 'text' | 'border' | 'accent' | 'status' | 'code' | 'shape' | 'scrollbar';

export interface ThemeTokenMeta {
  /** 不含 `--lx-` 前缀的短名，如 `surface-elevated` */
  readonly name: string;
  /** 完整 CSS 变量名，如 `--lx-surface-elevated` */
  readonly cssVar: string;
  readonly group: ThemeTokenGroup;
  /**
   * 是否允许用户主题包（ThemePack）覆盖。
   * 颜色类全部开放；radius / shadow / ring / blur / scrollbar 归内置，
   * 避免用户包把界面撑坏（改圆角、超大阴影是负价值定制）。
   */
  readonly overridable: boolean;
  /** 设计意图说明，写给后续做主题包 UI 的人看 */
  readonly comment: string;
}

const def = (name: string, group: ThemeTokenGroup, overridable: boolean, comment: string): ThemeTokenMeta =>
  Object.freeze({ name, cssVar: `--lx-${name}`, group, overridable, comment });

/** 全部令牌（顺序与 tokens.css 保持同序，便于 diff） */
export const THEME_TOKEN_META: readonly ThemeTokenMeta[] = Object.freeze([
  // 表面
  def('canvas', 'surface', true, '最底层画布（整窗背景）'),
  def('canvas-subtle', 'surface', true, '次级画布（大区块分隔）'),
  def('canvas-glow-from', 'surface', true, '画布顶部环境光晕起点色（暗色=极微弱蓝光，亮色=transparent）'),
  def('canvas-glow-via', 'surface', true, '画布顶部环境光晕中段色（暗色=极微弱靛蓝光，亮色=transparent）'),
  def('canvas-scrim', 'surface', true, '主页背景图遮罩色（暗色偏重/亮色偏轻，最终不透明度再乘 --lx-background-scrim）'),
  def('surface', 'surface', true, '常规卡片/面板底'),
  def('surface-elevated', 'surface', true, '浮层、下拉、弹窗底'),
  def('surface-sunken', 'surface', true, '凹陷区（输入槽、代码槽）'),
  def('surface-hover', 'surface', true, '悬停态叠加层'),
  def('surface-active', 'surface', true, '按下态叠加层'),
  def('surface-selected', 'surface', true, '选中态叠加层'),
  def('overlay', 'surface', true, '遮罩层'),

  // 文字
  def('text-primary', 'text', true, '正文主色'),
  def('text-primary-soft', 'text', true, '主文字柔和档（需读长文本的正文/列表主标题，低于 primary 高于 secondary）'),
  def('text-secondary', 'text', true, '次级文字'),
  def('text-tertiary', 'text', true, '辅助说明'),
  def('text-muted', 'text', true, '弱化文字/占位'),
  def('text-faint', 'text', true, '最弱文字层（空态提示/占位/禁用态共用）'),
  def('text-inverse', 'text', true, '反色文字（用于浅底）'),
  def('text-on-accent', 'text', true, '强调色之上的文字'),

  // 边框
  def('border-subtle', 'border', true, '最弱分隔线'),
  def('border-faint', 'border', true, '最淡边框（分隔/描边下限）'),
  def('border-default', 'border', true, '常规边框'),
  def('border-strong', 'border', true, '强边框/聚焦外框'),
  def('border-focus', 'border', true, '聚焦描边色'),

  // 强调
  def('accent', 'accent', true, '品牌强调色'),
  def('accent-hover', 'accent', true, '强调色悬停'),
  def('accent-pressed', 'accent', true, '强调色按下'),
  def('accent-soft', 'accent', true, '强调色柔和底'),
  def('accent-spark', 'accent', true, 'PromptBar 焦点光斑'),

  // 状态
  def('info', 'status', true, '信息态'),
  def('info-soft', 'status', true, '信息态柔和底'),
  def('success', 'status', true, '成功态'),
  def('success-soft', 'status', true, '成功态柔和底'),
  def('warning', 'status', true, '警告态'),
  def('warning-soft', 'status', true, '警告态柔和底'),
  def('danger', 'status', true, '危险态'),
  def('danger-soft', 'status', true, '危险态柔和底'),
  def('danger-border', 'status', true, '危险态边框'),

  // 代码 / Markdown
  def('code-bg', 'code', true, '代码块底'),
  def('code-text', 'code', true, '代码块文字'),
  def('inline-code-bg', 'code', true, '行内代码底'),
  def('diff-add-bg', 'code', true, 'diff 新增行底'),
  def('diff-del-bg', 'code', true, 'diff 删除行底'),

  // 形态（不可覆盖）
  def('radius-sm', 'shape', false, '小圆角'),
  def('radius-md', 'shape', false, '中圆角'),
  def('radius-lg', 'shape', false, '大圆角'),
  def('radius-full', 'shape', false, '全圆角'),
  def('shadow-1', 'shape', false, '一级阴影'),
  def('shadow-2', 'shape', false, '二级阴影'),
  def('shadow-3', 'shape', false, '三级阴影'),
  def('ring', 'shape', false, '聚焦环'),
  def('blur-panel', 'shape', false, '面板毛玻璃模糊半径'),

  // 滚动条（不可覆盖）
  def('scrollbar-thumb', 'scrollbar', false, '滚动条滑块'),
  def('scrollbar-thumb-hover', 'scrollbar', false, '滚动条滑块悬停')
]);

/** 短名列表（不含前缀），供校验器与测试做集合比对 */
export const THEME_TOKEN_NAMES: readonly string[] = Object.freeze(
  THEME_TOKEN_META.map(token => token.name)
);

/** 允许用户主题包覆盖的令牌短名白名单 */
export const OVERRIDABLE_TOKEN_NAMES: readonly string[] = Object.freeze(
  THEME_TOKEN_META.filter(token => token.overridable).map(token => token.name)
);

/** 短名 → 元信息，便于 O(1) 查询 */
export const THEME_TOKEN_BY_NAME: Readonly<Record<string, ThemeTokenMeta>> = Object.freeze(
  Object.fromEntries(THEME_TOKEN_META.map(token => [token.name, token]))
);

/** 按分组取令牌，供设置页分组渲染 */
export const tokensByGroup = (group: ThemeTokenGroup): ThemeTokenMeta[] =>
  THEME_TOKEN_META.filter(token => token.group === group);
