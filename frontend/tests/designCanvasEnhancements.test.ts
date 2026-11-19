import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDesignAiPrompt,
  buildDesignAnimationCss,
  buildDesignCommentsAiPrompt,
  buildDesignHandoffPrompt,
  buildDesignVariantPaths,
  buildDesignVariantsPrompt,
  DESIGN_ANIMATION_PRESETS,
  DESIGN_QUICK_BLOCKS,
  DESIGN_STARTER_TEMPLATES,
  type ElementLike,
  extractDesignSystemTokens,
  extractElementStyleSummary,
  formatStyleSummary,
  parseDesignTweakVars,
  resolveAnimationCssValue,
  resolveElementBreadcrumb,
  resolveElementLabel,
  resolveElementSelector,
} from '../src/utils/designCanvasHelpers.ts';
import {
  buildDesignDocumentPath,
  DESIGN_DOCUMENT_DIR,
} from '../src/composables/useDesignDocument.ts';
import {
  computeDesignVersionDiff,
  useDesignVersions,
} from '../src/composables/useDesignVersions.ts';
import {useDesignComments} from '../src/composables/useDesignComments.ts';

test('预设模板列表包含 4 套独立模板且 HTML 完整', () => {
  assert.equal(DESIGN_STARTER_TEMPLATES.length, 4);
  const ids = new Set(DESIGN_STARTER_TEMPLATES.map(item => item.id));
  assert.equal(ids.size, 4);
  for (const tpl of DESIGN_STARTER_TEMPLATES) {
    assert.ok(tpl.fileName.endsWith('.html'));
    assert.match(tpl.html, /<!DOCTYPE html>/i);
    assert.match(tpl.html, /<body>[\s\S]*<\/body>/i);
  }
});

test('快速插入组件库包含常用模块且片段非空', () => {
  assert.ok(DESIGN_QUICK_BLOCKS.length >= 4);
  for (const block of DESIGN_QUICK_BLOCKS) {
    assert.ok(block.html.trim().startsWith('<'));
  }
});

test('元素标签、选择器与 DOM 面包屑解析忽略 moveable 辅助类名', () => {
  const bodyNode: ElementLike = { tagName: 'BODY' };
  const sectionNode: ElementLike = {
    tagName: 'SECTION',
    className: 'hero moveable-dragging',
    parentElement: bodyNode,
  };
  const buttonNode: ElementLike = {
    tagName: 'BUTTON',
    className: 'btn-primary moveable-target',
    getAttribute: (name: string) => (name === 'data-label' ? '主行动按钮' : null),
    parentElement: sectionNode,
  };

  assert.equal(resolveElementLabel(buttonNode), '主行动按钮');
  assert.equal(resolveElementLabel(sectionNode), 'section.hero');
  assert.equal(resolveElementSelector(buttonNode), 'body > section.hero > button.btn-primary');

  const chain = resolveElementBreadcrumb(buttonNode);
  assert.deepEqual(
    chain.map(node => node.label),
    ['body', 'section.hero', '主行动按钮']
  );
  assert.deepEqual(
    chain.map(node => node.depth),
    [0, 1, 2]
  );
});

test('AI 协同设计提示词构建：选中组件优先输出选择器与局部 HTML，长代码安全截断', () => {
  const prompt = buildDesignAiPrompt({
    instruction: '把主按钮改成胶囊圆角并增强对比度',
    fileName: 'landing-prototype.html',
    selector: 'body > section.hero > button.btn-primary',
    elementHtml: '<button class="btn-primary">立即开始</button>',
    fullHtml: '<html><body>ignored</body></html>',
  });

  assert.match(prompt, /landing-prototype\.html/);
  assert.match(prompt, /body > section\.hero > button\.btn-primary/);
  assert.match(prompt, /把主按钮改成胶囊圆角并增强对比度/);
  assert.match(prompt, /<button class="btn-primary">立即开始<\/button>/);
  assert.doesNotMatch(prompt, /ignored/);

  const hugeHtml = `<div>${'a'.repeat(4000)}</div>`;
  const canvasPrompt = buildDesignAiPrompt({
    instruction: '整体改为双栏结构',
    fullHtml: hugeHtml,
  });
  assert.match(canvasPrompt, /truncated \(4011 chars total\)/);
});

test('DesignCanvasPreview -> FilePreviewPanel -> ChatView 对话桥接与样式分支完整接线', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => fs.readFileSync(path.resolve(currentDir, '..', rel), 'utf8');
  const designCode = read('src/components/chat/DesignCanvasPreview.vue');
  const panelCode = read('src/components/chat/FilePreviewPanel.vue');
  const chatCode = read('src/views/chat/ChatView.vue');

  assert.match(designCode, /emit\('sendToChat'/);
  assert.match(designCode, /key === 'textAlign'/);
  assert.match(designCode, /duplicateSelectedElement/);
  assert.match(designCode, /toggleCodeView/);
  assert.match(designCode, /class="font-size-input"/);
  assert.match(designCode, /<LxSelect\b/);
  assert.doesNotMatch(designCode, /<select\b/, '动画下拉框应统一使用全局 LxSelect 组件');
  assert.match(designCode, /applyAnimationPreset/);
  assert.match(designCode, /replaySelectedAnimation/);
  assert.doesNotMatch(designCode, /instanceof\s+HTMLElement/, 'iframe 跨 realm 元素禁止使用 instanceof HTMLElement');
  assert.match(panelCode, /@sendToChat="emit\('sendToChat', \$event\)"/);
  assert.match(chatCode, /@sendToChat="handleDesignSendToChat"/);
});

test('内置过渡动画预设、keyframes 生成与 CSS 值解析', () => {
  const ids = DESIGN_ANIMATION_PRESETS.map(item => item.id);
  for (const required of ['none', 'fade-in', 'fade-in-out', 'zoom-in', 'zoom-out', 'drawer-left', 'drawer-right', 'drawer-top', 'drawer-bottom', 'bounce-in']) {
    assert.ok(ids.includes(required as typeof ids[number]), `缺少内置动画预设: ${required}`);
  }

  const css = buildDesignAnimationCss();
  for (const preset of DESIGN_ANIMATION_PRESETS) {
    if (preset.id === 'none') continue;
    assert.match(css, new RegExp(`@keyframes\\s+${preset.keyframeName}\\b`), `缺少 @keyframes ${preset.keyframeName}`);
  }

  assert.equal(resolveAnimationCssValue('none', 400), 'none');
  assert.match(resolveAnimationCssValue('drawer-left', 50), /^lx-drawer-left 100ms /);
  assert.match(resolveAnimationCssValue('fade-in-out', 700), /^lx-fade-in-out 700ms .* 1 backwards$/);
});

test('设计原型文件绑定路径生成与 AI 闭环提示词（携带 filePath 不再贴整页 HTML）', () => {
  assert.equal(buildDesignDocumentPath('landing-page.html'), `${DESIGN_DOCUMENT_DIR}landing-page.html`);
  assert.equal(buildDesignDocumentPath('产品着陆页.htm'), `${DESIGN_DOCUMENT_DIR}产品着陆页.html`);
  assert.equal(buildDesignDocumentPath('my app / v1?.html'), `${DESIGN_DOCUMENT_DIR}my-app-v1-.html`);
  assert.equal(buildDesignDocumentPath('...'), `${DESIGN_DOCUMENT_DIR}design-prototype.html`);

  const filePrompt = buildDesignAiPrompt({
    instruction: '将主标题改得更有冲击力',
    fileName: 'landing-page.html',
    filePath: '.lingxi/design/landing-page.html',
    selector: 'body > h1.title',
    elementHtml: '<h1 class="title">欢迎使用</h1>',
  });
  assert.match(filePrompt, /\.lingxi\/design\/landing-page\.html/);
  assert.match(filePrompt, /画布会在文件写入后自动刷新/);
  assert.match(filePrompt, /body > h1\.title/);

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => fs.readFileSync(path.resolve(currentDir, '..', rel), 'utf8');
  const designCode = read('src/components/chat/DesignCanvasPreview.vue');
  const panelCode = read('src/components/chat/FilePreviewPanel.vue');
  const chatCode = read('src/views/chat/ChatView.vue');

  assert.match(designCode, /useDesignDocument\(/);
  assert.match(designCode, /saveDesignDocument/);
  assert.match(designCode, /sessionId\?:\s*string \| number \| null/);
  assert.match(panelCode, /:sessionId="props\.sessionId"/);
  assert.match(chatCode, /:sessionId="localActiveId"/);
});

test('版本历史管理：去重记录、数量上限、差异计算与回退接线', () => {
  const { versions, recordVersion, clearVersions } = useDesignVersions();
  const v1 = recordVersion('<div>v1</div>', 'initial');
  assert.ok(v1);
  // 连续相同内容不重复入栈
  const dup = recordVersion('<div>v1</div>', 'manual');
  assert.equal(dup?.id, v1.id);
  assert.equal(versions.value.length, 1);

  const v2 = recordVersion('<div>v1</div>\n<p>v2</p>', 'ai');
  assert.ok(v2);
  assert.equal(versions.value.length, 2);
  assert.equal(versions.value[0]?.source, 'ai');

  const diff = computeDesignVersionDiff(v1.html, v2.html);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
  assert.ok(diff.lines.some(l => l.kind === 'add' && l.text.includes('<p>v2</p>')));

  clearVersions();
  assert.equal(versions.value.length, 0);
});

test('元素锚定评论：增删改状态与批量提交 AI 提示词构建', () => {
  const { comments, unresolvedComments, addComment, toggleResolve, removeComment, resolveAll } = useDesignComments();
  const c1 = addComment('body > header > button.cta', 'button.cta', '增大按钮内边距');
  const c2 = addComment('body > main > h1', 'h1', '字体改为 36px');
  assert.ok(c1 && c2);
  assert.equal(unresolvedComments.value.length, 2);

  toggleResolve(c1.id);
  assert.equal(unresolvedComments.value.length, 1);

  const batchPrompt = buildDesignCommentsAiPrompt({
    fileName: 'landing.html',
    filePath: '.lingxi/design/landing.html',
    comments: unresolvedComments.value,
  });
  assert.match(batchPrompt, /\.lingxi\/design\/landing\.html/);
  assert.match(batchPrompt, /1\. \[h1\] `body > main > h1`：字体改为 36px/);
  assert.doesNotMatch(batchPrompt, /增大按钮内边距/);

  resolveAll();
  assert.equal(unresolvedComments.value.length, 0);
  removeComment(c2.id);
  assert.equal(comments.value.length, 1);

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const designCode = fs.readFileSync(path.resolve(currentDir, '../src/components/chat/DesignCanvasPreview.vue'), 'utf8');
  assert.match(designCode, /<DesignVersionPanel\b/);
  assert.match(designCode, /<DesignCommentLayer\b/);
  assert.match(designCode, /submitAllCommentsToAi/);
  assert.match(designCode, /restoreVersion/);
});

test('第三期：实时调参解析、设计令牌注入、多方案路径与代码交接提示词', () => {
  const html = `
    <style>
      :root {
        --lx-tweak-primary: #2563eb;
        --lx-tweak-radius: 12px;
        --lx-tweak-font: "Inter", sans-serif;
        --lx-tweak-primary: #0f766e;
      }
    </style>
  `;
  const vars = parseDesignTweakVars(html);
  assert.equal(vars.length, 3);
  assert.equal(vars[0]?.kind, 'color');
  assert.equal(vars[0]?.value, '#0f766e');
  assert.equal(vars[1]?.kind, 'length');
  assert.equal(vars[1]?.numericValue, 12);
  assert.equal(vars[1]?.unit, 'px');
  assert.equal(vars[2]?.kind, 'text');

  const tokens = extractDesignSystemTokens('/* comment */\n:root {\n  --lx-canvas: #000000;\n  --lx-text-primary: #ffffff;\n  color: red;\n}');
  assert.equal(tokens, '--lx-canvas: #000000;\n--lx-text-primary: #ffffff;');

  const promptWithTokens = buildDesignAiPrompt({
    instruction: '统一按钮圆角',
    filePath: '.lingxi/design/app.html',
    designTokens: tokens,
  });
  assert.match(promptWithTokens, /设计系统规范/);
  assert.match(promptWithTokens, /--lx-canvas: #000000;/);

  const variantPaths = buildDesignVariantPaths('.lingxi/design/landing.html');
  assert.deepEqual(variantPaths, [
    '.lingxi/design/landing-v1.html',
    '.lingxi/design/landing-v2.html',
    '.lingxi/design/landing-v3.html',
  ]);

  const variantsPrompt = buildDesignVariantsPrompt({
    fileName: 'landing.html',
    filePath: '.lingxi/design/landing.html',
    variantPaths,
    instruction: '极简科技风',
  });
  assert.match(variantsPrompt, /landing-v1\.html/);
  assert.match(variantsPrompt, /landing-v3\.html/);
  assert.match(variantsPrompt, /--lx-tweak-\*/);

  const handoffPrompt = buildDesignHandoffPrompt({
    fileName: 'landing.html',
    filePath: '.lingxi/design/landing.html',
    framework: 'vue',
  });
  assert.match(handoffPrompt, /Vue 3/);
  assert.match(handoffPrompt, /\.lingxi\/design\/landing\.html/);

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const designCode = fs.readFileSync(path.resolve(currentDir, '../src/components/chat/DesignCanvasPreview.vue'), 'utf8');
  assert.match(designCode, /<DesignTweakPanel\b/);
  assert.match(designCode, /<DesignVariantsModal\b/);
  assert.match(designCode, /exportPng/);
  assert.match(designCode, /exportPdf/);
  assert.match(designCode, /handoffToCode/);
});

test('Design 发给 AI 附带计算布局/样式摘要与画布截图接线', () => {
  const summary = extractElementStyleSummary(
    { width: 320.4, height: 48.2 },
    {
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '12px',
      fontSize: '14px',
      fontWeight: '600',
      color: 'rgb(24, 24, 27)',
      backgroundColor: 'rgb(255, 255, 255)',
      borderRadius: '10px',
      padding: '8px 16px',
    },
  );
  assert.equal(summary.width, 320);
  assert.equal(summary.height, 48);
  assert.equal(summary.display, 'flex');
  assert.equal(summary.gap, '12px');

  const formatted = formatStyleSummary(summary);
  assert.match(formatted, /size=320x48px/);
  assert.match(formatted, /display=flex/);
  assert.match(formatted, /justify=space-between/);

  const prompt = buildDesignAiPrompt({
    instruction: '增大按钮间距',
    fileName: 'landing.html',
    filePath: '.lingxi/design/landing.html',
    selector: 'body > header.nav',
    styleSummary: summary,
  });
  assert.match(prompt, /当前计算布局与样式：size=320x48px/);

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => fs.readFileSync(path.resolve(currentDir, '..', rel), 'utf8');
  const designCode = read('src/components/chat/DesignCanvasPreview.vue');
  const chatCode = read('src/views/chat/ChatView.vue');
  assert.match(designCode, /renderCanvasSnapshotFile/);
  assert.match(designCode, /extractElementStyleSummary/);
  assert.match(chatCode, /payload\.files && payload\.files\.length > 0/);
});
