export interface DesignStarterTemplate {
  id: 'landing' | 'dashboard' | 'form' | 'blank';
  titleKey: string;
  descKey: string;
  fileName: string;
  html: string;
}

export interface DesignQuickBlock {
  id: 'heading' | 'text' | 'button' | 'card' | 'divider';
  labelKey: string;
  html: string;
}

export interface DesignAnimationPreset {
  id:
    | 'none'
    | 'fade-in'
    | 'fade-in-out'
    | 'zoom-in'
    | 'zoom-out'
    | 'drawer-left'
    | 'drawer-right'
    | 'drawer-top'
    | 'drawer-bottom'
    | 'bounce-in';
  labelKey: string;
  keyframeName: string;
  timing: string;
  iterationCount?: string;
}

export interface DesignBreadcrumbNode {
  tag: string;
  label: string;
  depth: number;
}

export interface ElementLike {
  tagName: string;
  id?: string;
  className?: string | { baseVal?: string };
  getAttribute?: (name: string) => string | null;
  parentElement?: ElementLike | null;
}

export interface DesignComputedStyleSummary {
  width: number;
  height: number;
  display: string;
  position?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
  gridTemplateColumns?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  backgroundColor?: string;
  borderRadius?: string;
  padding?: string;
}

export interface DesignAiPromptInput {
  instruction: string;
  fileName?: string;
  /** 已落盘的工作区相对路径；有它时让 Agent 直接改文件，不再贴整页 HTML。 */
  filePath?: string;
  selector?: string;
  elementHtml?: string;
  fullHtml?: string;
  /** 可选：选中元素的计算样式与布局摘要，避免 Agent 只看 HTML 猜不出真实排版。 */
  styleSummary?: DesignComputedStyleSummary;
  /** 可选：注入的设计系统令牌或品牌规范摘要。 */
  designTokens?: string;
}

export const DESIGN_STARTER_TEMPLATES: DesignStarterTemplate[] = [
  {
    id: 'landing',
    titleKey: 'designPreview.templateLanding',
    descKey: 'designPreview.templateLandingDesc',
    fileName: 'landing-prototype.html',
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Landing Prototype</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #18181b; background: #fafafa; line-height: 1.6; }
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 18px 32px; background: #ffffff; border-bottom: 1px solid #e4e4e7; }
    .brand { font-weight: 700; font-size: 16px; letter-spacing: -0.02em; }
    .nav-links { display: flex; gap: 20px; font-size: 14px; color: #52525b; }
    .hero { max-width: 780px; margin: 56px auto 40px; padding: 0 24px; text-align: center; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; background: #f4f4f5; color: #3f3f46; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
    .hero h1 { font-size: 40px; line-height: 1.15; letter-spacing: -0.03em; margin-bottom: 16px; }
    .hero p { font-size: 16px; color: #52525b; max-width: 560px; margin: 0 auto 28px; }
    .cta-row { display: flex; justify-content: center; gap: 12px; }
    .btn-primary { padding: 11px 22px; border-radius: 10px; border: 0; background: #18181b; color: #ffffff; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn-secondary { padding: 11px 22px; border-radius: 10px; border: 1px solid #e4e4e7; background: #ffffff; color: #18181b; font-size: 14px; font-weight: 600; cursor: pointer; }
    .grid { max-width: 920px; margin: 0 auto 56px; padding: 0 24px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .card { background: #ffffff; border: 1px solid #e4e4e7; border-radius: 14px; padding: 22px; }
    .card h3 { font-size: 15px; margin-bottom: 8px; }
    .card p { font-size: 13px; color: #71717a; }
  </style>
</head>
<body>
  <header class="nav">
    <div class="brand">LingXi Studio</div>
    <nav class="nav-links">
      <span>功能</span>
      <span>定价</span>
      <span>文档</span>
    </nav>
  </header>
  <main>
    <section class="hero">
      <span class="badge">AI-Native Design Workspace</span>
      <h1>用自然语言与画布，快速打磨产品原型</h1>
      <p>点击任意元素即可拖拽排版、微调样式，或直接选中组件让 AI 帮你完成重构与视觉升级。</p>
      <div class="cta-row">
        <button class="btn-primary">立即开始</button>
        <button class="btn-secondary">查看示例</button>
      </div>
    </section>
    <section class="grid">
      <article class="card">
        <h3>即时可视化编辑</h3>
        <p>选中组件直接调整字号、配色、圆角与间距，所见即所得。</p>
      </article>
      <article class="card">
        <h3>AI 局部精修</h3>
        <p>针对单个卡片或按钮发起对话指令，精准修改而不破坏全局。</p>
      </article>
      <article class="card">
        <h3>多端视口预览</h3>
        <p>一键切换桌面、平板与手机尺寸，快速验证响应式布局。</p>
      </article>
    </section>
  </main>
</body>
</html>`,
  },
  {
    id: 'dashboard',
    titleKey: 'designPreview.templateDashboard',
    descKey: 'designPreview.templateDashboardDesc',
    fileName: 'dashboard-prototype.html',
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dashboard Prototype</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f4f5; color: #18181b; padding: 28px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .header h1 { font-size: 22px; font-weight: 700; }
    .header p { font-size: 13px; color: #71717a; }
    .action-btn { padding: 9px 16px; border-radius: 8px; border: 0; background: #18181b; color: #fff; font-size: 13px; font-weight: 600; }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
    .metric-card { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 18px; }
    .metric-label { font-size: 12px; color: #71717a; margin-bottom: 6px; }
    .metric-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
    .metric-delta { font-size: 12px; color: #059669; margin-top: 6px; font-weight: 600; }
    .panel { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 20px; }
    .panel h2 { font-size: 15px; margin-bottom: 14px; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-top: 1px solid #f4f4f5; font-size: 13px; }
    .pill { padding: 3px 10px; border-radius: 999px; background: #f4f4f5; font-size: 12px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>运营概览看板</h1>
      <p>实时追踪核心转化、活跃用户与项目吞吐</p>
    </div>
    <button class="action-btn">导出报表</button>
  </div>
  <section class="metrics">
    <div class="metric-card">
      <div class="metric-label">周活跃用户</div>
      <div class="metric-value">24,890</div>
      <div class="metric-delta">+14.2% 较上周</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">任务完成率</div>
      <div class="metric-value">92.4%</div>
      <div class="metric-delta">+3.1% 较上周</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">平均响应耗时</div>
      <div class="metric-value">1.28s</div>
      <div class="metric-delta">-180ms 优化</div>
    </div>
  </section>
  <section class="panel">
    <h2>近期原型迭代</h2>
    <div class="row"><span>登录与工作区引导页</span><span class="pill">已定稿</span></div>
    <div class="row"><span>计费方案对比卡片</span><span class="pill">评审中</span></div>
    <div class="row"><span>移动端个人中心</span><span class="pill">草稿</span></div>
  </section>
</body>
</html>`,
  },
  {
    id: 'form',
    titleKey: 'designPreview.templateForm',
    descKey: 'designPreview.templateFormDesc',
    fileName: 'form-prototype.html',
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Form Prototype</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f4f5; color: #18181b; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .auth-card { width: 100%; max-width: 400px; background: #ffffff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 28px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.06); }
    .auth-card h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .auth-card p { font-size: 13px; color: #71717a; margin-bottom: 22px; }
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; color: #3f3f46; }
    .field input { width: 100%; padding: 10px 12px; border: 1px solid #d4d4d8; border-radius: 9px; font-size: 14px; }
    .submit-btn { width: 100%; margin-top: 8px; padding: 11px; border-radius: 9px; border: 0; background: #18181b; color: #ffffff; font-size: 14px; font-weight: 600; cursor: pointer; }
    .hint { text-align: center; font-size: 12px; color: #71717a; margin-top: 16px; }
  </style>
</head>
<body>
  <form class="auth-card">
    <h1>欢迎回来</h1>
    <p>登录你的设计工作区以继续编辑原型</p>
    <div class="field">
      <label>工作邮箱</label>
      <input type="email" placeholder="name@company.com" />
    </div>
    <div class="field">
      <label>密码</label>
      <input type="password" placeholder="••••••••" />
    </div>
    <button class="submit-btn" type="button">登录工作区</button>
    <div class="hint">还没有账号？联系管理员开通</div>
  </form>
</body>
</html>`,
  },
  {
    id: 'blank',
    titleKey: 'designPreview.templateBlank',
    descKey: 'designPreview.templateBlankDesc',
    fileName: 'blank-canvas.html',
    html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Blank Canvas</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #18181b; background: #ffffff; margin: 0; padding: 36px; min-height: 100vh; }
    .canvas-starter { max-width: 680px; margin: 0 auto; padding: 32px; border: 1px dashed #d4d4d8; border-radius: 16px; }
    .canvas-starter h1 { margin: 0 0 10px; font-size: 26px; }
    .canvas-starter p { margin: 0; color: #71717a; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <section class="canvas-starter">
    <h1>空白设计画板</h1>
    <p>双击此处直接编辑文案，或使用上方「插入组件」与下方 AI 指令栏生成新的界面模块。</p>
  </section>
</body>
</html>`,
  },
];

export const DESIGN_QUICK_BLOCKS: DesignQuickBlock[] = [
  {
    id: 'heading',
    labelKey: 'designPreview.blockHeading',
    html: '<h2 style="font-size: 22px; font-weight: 700; margin: 12px 0; color: #18181b;">新标题模块</h2>',
  },
  {
    id: 'text',
    labelKey: 'designPreview.blockText',
    html: '<p style="font-size: 14px; line-height: 1.6; margin: 10px 0; color: #52525b;">双击即可编辑这段正文内容，支持在右侧或上方检查器中调整字号与颜色。</p>',
  },
  {
    id: 'button',
    labelKey: 'designPreview.blockButton',
    html: '<button type="button" style="padding: 10px 18px; border-radius: 8px; border: 0; background: #18181b; color: #ffffff; font-size: 13px; font-weight: 600; cursor: pointer; margin: 8px 0;">主要操作按钮</button>',
  },
  {
    id: 'card',
    labelKey: 'designPreview.blockCard',
    html: '<div style="padding: 20px; border-radius: 12px; border: 1px solid #e4e4e7; background: #ffffff; margin: 12px 0; box-shadow: 0 4px 12px rgba(0,0,0,0.04);"><h3 style="margin: 0 0 6px; font-size: 16px; font-weight: 600; color: #18181b;">卡片标题</h3><p style="margin: 0; font-size: 13px; color: #71717a;">卡片描述内容，可继续拖拽或选中局部调整。</p></div>',
  },
  {
    id: 'divider',
    labelKey: 'designPreview.blockDivider',
    html: '<hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 18px 0;" />',
  },
];

export const DESIGN_AI_SUGGESTIONS: string[] = [
  '优化视觉层次与留白',
  '改为现代极简暗黑风格',
  '增加卡片阴影与悬停交互',
  '优化移动端响应式排版',
];

export const DESIGN_ANIMATION_STYLE_ID = 'lx-design-animations';

export const DESIGN_ANIMATION_PRESETS: DesignAnimationPreset[] = [
  { id: 'none', labelKey: 'designPreview.animNone', keyframeName: '', timing: 'ease' },
  { id: 'fade-in', labelKey: 'designPreview.animFadeIn', keyframeName: 'lx-fade-in', timing: 'ease-out' },
  {
    id: 'fade-in-out',
    labelKey: 'designPreview.animFadeInOut',
    keyframeName: 'lx-fade-in-out',
    timing: 'ease-in-out',
  },
  { id: 'zoom-in', labelKey: 'designPreview.animZoomIn', keyframeName: 'lx-zoom-in', timing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'zoom-out', labelKey: 'designPreview.animZoomOut', keyframeName: 'lx-zoom-out', timing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'drawer-left', labelKey: 'designPreview.animDrawerLeft', keyframeName: 'lx-drawer-left', timing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'drawer-right', labelKey: 'designPreview.animDrawerRight', keyframeName: 'lx-drawer-right', timing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'drawer-top', labelKey: 'designPreview.animDrawerTop', keyframeName: 'lx-drawer-top', timing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'drawer-bottom', labelKey: 'designPreview.animDrawerBottom', keyframeName: 'lx-drawer-bottom', timing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'bounce-in', labelKey: 'designPreview.animBounceIn', keyframeName: 'lx-bounce-in', timing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
];

export const buildDesignAnimationCss = (): string => `
@keyframes lx-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes lx-fade-in-out {
  0% { opacity: 0; }
  45% { opacity: 1; }
  75% { opacity: 0.2; }
  100% { opacity: 1; }
}
@keyframes lx-zoom-in {
  from { opacity: 0; transform: scale(0.88); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes lx-zoom-out {
  from { opacity: 0; transform: scale(1.12); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes lx-drawer-left {
  from { opacity: 0; transform: translateX(-36px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes lx-drawer-right {
  from { opacity: 0; transform: translateX(36px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes lx-drawer-top {
  from { opacity: 0; transform: translateY(-28px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes lx-drawer-bottom {
  from { opacity: 0; transform: translateY(28px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes lx-bounce-in {
  0% { opacity: 0; transform: scale(0.82); }
  65% { opacity: 1; transform: scale(1.04); }
  100% { opacity: 1; transform: scale(1); }
}
`.trim();

export const resolveAnimationCssValue = (
  presetId: DesignAnimationPreset['id'],
  durationMs: number = 400
): string => {
  const preset = DESIGN_ANIMATION_PRESETS.find(item => item.id === presetId);
  if (!preset || !preset.keyframeName) return 'none';
  const safeDuration = Math.max(100, Math.min(5000, Math.round(durationMs)));
  const count = preset.iterationCount || '1';
  return `${preset.keyframeName} ${safeDuration}ms ${preset.timing} 0ms ${count} backwards`;
};

const readClassText = (el: ElementLike): string => {
  if (typeof el.className === 'string') return el.className;
  if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
  return el.getAttribute?.('class') || '';
};

export const resolveElementLabel = (el: ElementLike): string => {
  const tag = el.tagName.toLowerCase();
  const dataLabel = el.getAttribute?.('data-label')?.trim();
  if (dataLabel) return dataLabel;
  const id = el.id?.trim();
  if (id) return `${tag}#${id}`;
  const firstClass = readClassText(el)
    .split(/\s+/)
    .map(item => item.trim())
    .find(item => item.length > 0 && !item.startsWith('moveable-'));
  return firstClass ? `${tag}.${firstClass}` : tag;
};

export const resolveElementSelector = (el: ElementLike): string => {
  const parts: string[] = [];
  let cursor: ElementLike | null | undefined = el;
  let guard = 0;

  while (cursor && guard < 12) {
    guard += 1;
    const tag = cursor.tagName.toLowerCase();
    if (tag === 'html') break;
    const id = cursor.id?.trim();
    if (id) {
      parts.unshift(`${tag}#${id}`);
      break;
    }
    const cls = readClassText(cursor)
      .split(/\s+/)
      .map(item => item.trim())
      .filter(item => item.length > 0 && !item.startsWith('moveable-'))
      .slice(0, 2);
    parts.unshift(cls.length > 0 ? `${tag}.${cls.join('.')}` : tag);
    if (tag === 'body') break;
    cursor = cursor.parentElement;
  }

  return parts.join(' > ');
};

export const resolveElementBreadcrumb = (el: ElementLike): DesignBreadcrumbNode[] => {
  const chain: ElementLike[] = [];
  let cursor: ElementLike | null | undefined = el;
  let guard = 0;

  while (cursor && guard < 16) {
    guard += 1;
    const tag = cursor.tagName.toLowerCase();
    if (tag === 'html') break;
    chain.unshift(cursor);
    if (tag === 'body') break;
    cursor = cursor.parentElement;
  }

  return chain.map((node, index) => ({
    tag: node.tagName.toLowerCase(),
    label: resolveElementLabel(node),
    depth: index,
  }));
};

const truncateHtmlSnippet = (raw: string, maxChars: number): string => {
  const trimmed = raw.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n<!-- ... truncated (${trimmed.length} chars total) ... -->`;
};

/** 从 DOM 元素及其计算样式提取紧凑布局与外观摘要。 */
export const extractElementStyleSummary = (
  rect: { width: number; height: number },
  computed: Partial<CSSStyleDeclaration>,
): DesignComputedStyleSummary => {
  const display = computed.display || 'block';
  const summary: DesignComputedStyleSummary = {
    width: Math.round(rect.width || 0),
    height: Math.round(rect.height || 0),
    display,
  };
  if (computed.position && computed.position !== 'static') summary.position = computed.position;
  if (display.includes('flex')) {
    if (computed.flexDirection) summary.flexDirection = computed.flexDirection;
    if (computed.justifyContent && computed.justifyContent !== 'normal') summary.justifyContent = computed.justifyContent;
    if (computed.alignItems && computed.alignItems !== 'normal') summary.alignItems = computed.alignItems;
  }
  if (display.includes('grid') && computed.gridTemplateColumns && computed.gridTemplateColumns !== 'none') {
    summary.gridTemplateColumns = computed.gridTemplateColumns;
  }
  if (computed.gap && computed.gap !== 'normal' && computed.gap !== '0px') summary.gap = computed.gap;
  if (computed.fontSize) summary.fontSize = computed.fontSize;
  if (computed.fontWeight) summary.fontWeight = computed.fontWeight;
  if (computed.color) summary.color = computed.color;
  if (computed.backgroundColor && computed.backgroundColor !== 'rgba(0, 0, 0, 0)' && computed.backgroundColor !== 'transparent') {
    summary.backgroundColor = computed.backgroundColor;
  }
  if (computed.borderRadius && computed.borderRadius !== '0px') summary.borderRadius = computed.borderRadius;
  if (computed.padding && computed.padding !== '0px') summary.padding = computed.padding;
  return summary;
};

export const formatStyleSummary = (summary: DesignComputedStyleSummary): string => {
  const tokens: string[] = [`size=${summary.width}x${summary.height}px`, `display=${summary.display}`];
  if (summary.position) tokens.push(`position=${summary.position}`);
  if (summary.flexDirection) tokens.push(`flex-direction=${summary.flexDirection}`);
  if (summary.justifyContent) tokens.push(`justify=${summary.justifyContent}`);
  if (summary.alignItems) tokens.push(`align=${summary.alignItems}`);
  if (summary.gridTemplateColumns) tokens.push(`grid-cols=${summary.gridTemplateColumns}`);
  if (summary.gap) tokens.push(`gap=${summary.gap}`);
  if (summary.fontSize) tokens.push(`font=${summary.fontSize}/${summary.fontWeight || '400'}`);
  if (summary.color) tokens.push(`color=${summary.color}`);
  if (summary.backgroundColor) tokens.push(`bg=${summary.backgroundColor}`);
  if (summary.borderRadius) tokens.push(`radius=${summary.borderRadius}`);
  if (summary.padding) tokens.push(`padding=${summary.padding}`);
  return tokens.join(', ');
};

export const buildDesignAiPrompt = (input: DesignAiPromptInput): string => {
  const instruction = input.instruction.trim();
  const targetName = input.fileName?.trim() || '当前设计原型';
  const lines: string[] = [`请帮我优化设计原型「${targetName}」：`];

  if (input.filePath) {
    // 贴进对话的 HTML 会被截断，Agent 只能按文件改才改得全；画布监听这个文件并自动刷新。
    lines.push(`- 原型文件：\`${input.filePath}\`（画布会在文件写入后自动刷新）`);
    lines.push('- 请先读取该文件，再用编辑文件工具直接修改它；保持单文件 HTML，样式与脚本内联，不要另建文件');
  }
  if (input.designTokens?.trim()) {
    lines.push('- 设计系统规范（请优先复用以下变量/色板与排版令牌）：');
    lines.push('```css');
    lines.push(input.designTokens.trim());
    lines.push('```');
  }
  if (input.selector) {
    lines.push(`- 目标组件选择器：\`${input.selector}\``);
  }
  if (input.styleSummary) {
    lines.push(`- 当前计算布局与样式：${formatStyleSummary(input.styleSummary)}`);
  }
  lines.push(`- 修改要求：${instruction}`);

  if (input.elementHtml?.trim()) {
    lines.push('');
    lines.push('选中组件当前 HTML：');
    lines.push('```html');
    lines.push(truncateHtmlSnippet(input.elementHtml, 1800));
    lines.push('```');
  } else if (input.fullHtml?.trim()) {
    lines.push('');
    lines.push('当前画布 HTML：');
    lines.push('```html');
    lines.push(truncateHtmlSnippet(input.fullHtml, 2800));
    lines.push('```');
  }

  return lines.join('\n');
};

export interface DesignCommentPromptEntry {
  selector: string;
  elementLabel: string;
  text: string;
}

export interface DesignCommentsAiPromptInput {
  fileName?: string;
  filePath: string;
  comments: DesignCommentPromptEntry[];
  designTokens?: string;
}

/** 将多条锚定在元素上的评论汇总为一条结构化 AI 修改指令。 */
export const buildDesignCommentsAiPrompt = (input: DesignCommentsAiPromptInput): string => {
  const targetName = input.fileName?.trim() || '当前设计原型';
  const lines: string[] = [
    `请根据以下画布评论批量优化设计原型「${targetName}」：`,
    `- 原型文件：\`${input.filePath}\`（画布会在文件写入后自动刷新）`,
    '- 请先读取该文件，再用编辑文件工具逐条落实修改；保持单文件 HTML，样式与脚本内联，不要另建文件',
  ];
  if (input.designTokens?.trim()) {
    lines.push('- 设计系统规范：');
    lines.push('```css');
    lines.push(input.designTokens.trim());
    lines.push('```');
  }
  lines.push('');
  lines.push('待处理评论：');

  input.comments.forEach((item, idx) => {
    lines.push(`${idx + 1}. [${item.elementLabel}] \`${item.selector}\`：${item.text}`);
  });

  return lines.join('\n');
};

export interface DesignTweakVar {
  name: string;
  label: string;
  value: string;
  kind: 'color' | 'length' | 'text';
  unit?: string;
  numericValue?: number;
  min?: number;
  max?: number;
}

export const DESIGN_TWEAK_STYLE_ID = 'lx-design-tweaks';

/** 从 HTML 中的 CSS 提取 `--lx-tweak-*` 可调参数，供画布右侧滑杆实时调节。 */
export const parseDesignTweakVars = (html: string): DesignTweakVar[] => {
  const seen = new Map<string, DesignTweakVar>();
  const regex = /(--lx-tweak-[a-z0-9-]+)\s*:\s*([^;}\n]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const name = match[1]!.trim();
    const rawValue = match[2]!.trim();
    const label = name.replace(/^--lx-tweak-/, '').replace(/-/g, ' ');

    let kind: DesignTweakVar['kind'] = 'text';
    let unit: string | undefined;
    let numericValue: number | undefined;
    let min: number | undefined;
    let max: number | undefined;

    if (/^#[0-9a-f]{3,8}$/i.test(rawValue)) {
      kind = 'color';
    } else {
      const lenMatch = rawValue.match(/^(-?\d+(?:\.\d+)?)(px|rem|em|%)$/);
      if (lenMatch) {
        kind = 'length';
        numericValue = Number(lenMatch[1]);
        unit = lenMatch[2];
        min = 0;
        max = unit === 'px' ? Math.max(64, Math.ceil(numericValue * 2)) : 100;
      }
    }

    seen.set(name, { name, label, value: rawValue, kind, unit, numericValue, min, max });
  }
  return Array.from(seen.values());
};

/** 将调参变量实时写入 iframe 文档并同步到内联 `<style id="lx-design-tweaks">`，确保导出与保存可保留。 */
export const applyDesignTweakToDocument = (doc: Document, vars: Record<string, string>): void => {
  const entries = Object.entries(vars).filter(([k, v]) => k.startsWith('--lx-tweak-') && v.trim());
  for (const [key, value] of entries) {
    doc.documentElement?.style.setProperty(key, value);
  }
  if (!doc.head) return;
  let styleEl = doc.getElementById(DESIGN_TWEAK_STYLE_ID) as HTMLStyleElement | null;
  if (entries.length === 0) {
    styleEl?.remove();
    return;
  }
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.id = DESIGN_TWEAK_STYLE_ID;
    doc.head.appendChild(styleEl);
  }
  styleEl.textContent = `:root {\n${entries.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`;
};

/** 从项目 tokens.css 中提取精简的 `--lx-*` 变量摘要，控制提示词长度。 */
export const extractDesignSystemTokens = (cssText: string, maxLines = 48): string => {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutComments
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('--lx-'));
  return lines.slice(0, maxLines).join('\n');
};

/** 根据当前原型路径派生 3 个并排对比方案的工作区路径。 */
export const buildDesignVariantPaths = (baseFilePath: string): string[] => {
  const stem = baseFilePath.replace(/\.html?$/i, '');
  return [1, 2, 3].map(idx => `${stem}-v${idx}.html`);
};

export interface DesignVariantsPromptInput {
  fileName?: string;
  filePath: string;
  variantPaths: string[];
  instruction?: string;
  designTokens?: string;
}

/** 生成「一次产出 3 个视觉方案」的提示词。 */
export const buildDesignVariantsPrompt = (input: DesignVariantsPromptInput): string => {
  const targetName = input.fileName?.trim() || '当前设计原型';
  const lines: string[] = [
    `请基于设计原型「${targetName}」（\`${input.filePath}\`）生成 3 个风格与布局各有侧重的备选方案：`,
    input.instruction?.trim() ? `- 设计方向要求：${input.instruction.trim()}` : '- 设计方向要求：在保留核心信息与功能的前提下，探索 3 种不同的视觉层次、配色或版式',
    ...input.variantPaths.map((vp, idx) => `- 方案 ${idx + 1} 输出文件：\`${vp}\``),
    '- 请先读取原文件，再用 write_file 分别写入以上 3 个单文件 HTML（样式与脚本内联，不要修改原文件）',
    '- 可在 `:root` 中声明 `--lx-tweak-*` 变量（如主色、圆角、间距），方便在画布里实时调参',
  ];
  if (input.designTokens?.trim()) {
    lines.push('- 设计系统规范：');
    lines.push('```css');
    lines.push(input.designTokens.trim());
    lines.push('```');
  }
  return lines.join('\n');
};

/** 生成「交接为 Vue/React 组件代码」的提示词。 */
export const buildDesignHandoffPrompt = (input: {
  fileName?: string;
  filePath: string;
  framework: 'vue' | 'react';
}): string => {
  const targetName = input.fileName?.trim() || '当前设计原型';
  const fwLabel = input.framework === 'vue' ? 'Vue 3 (`<script setup lang="ts">`) 单文件组件' : 'React + TypeScript 函数组件';
  return [
    `请将设计原型「${targetName}」（\`${input.filePath}\`）交接转换为干净、可维护的 ${fwLabel}：`,
    '- 请先读取该 HTML 文件，拆解其中的结构、状态与交互逻辑',
    '- 保留原有视觉层次与响应式断点，输出完整组件代码（如项目中有对应目录可给出落盘建议）',
  ].join('\n');
};
