import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDesignAiPrompt,
  buildDesignAnimationCss,
  DESIGN_ANIMATION_PRESETS,
  DESIGN_QUICK_BLOCKS,
  DESIGN_STARTER_TEMPLATES,
  type ElementLike,
  resolveAnimationCssValue,
  resolveElementBreadcrumb,
  resolveElementLabel,
  resolveElementSelector,
} from '../src/utils/designCanvasHelpers.ts';

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
