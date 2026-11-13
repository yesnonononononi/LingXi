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

export interface DesignAiPromptInput {
  instruction: string;
  fileName?: string;
  selector?: string;
  elementHtml?: string;
  fullHtml?: string;
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

export const buildDesignAiPrompt = (input: DesignAiPromptInput): string => {
  const instruction = input.instruction.trim();
  const targetName = input.fileName?.trim() || '当前设计原型';
  const lines: string[] = [`请帮我优化设计原型「${targetName}」：`];

  if (input.selector) {
    lines.push(`- 目标组件选择器：\`${input.selector}\``);
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
