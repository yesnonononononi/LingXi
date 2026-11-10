/**
 * 侧边预览面板的门禁：配色令牌单一来源 + 地址栏内嵌提交箭头。
 *
 * <p>背景：面板（FilePreviewPanel）与两个子视图（ProjectPagePreview / DesignCanvasPreview）
 * 曾各自硬编码 indigo（#6366f1 / #4f46e5 / #e0e7ff / #c7d2fe …）当「强调色」，而面板其余部分
 * 用的是 --file-* 中性灰，两套语言互相打架。现在强调色收敛成 --file-ink* 令牌，由面板根元素
 * 按明暗两套定义，子视图只消费。</p>
 *
 * <p>这些是**静态结构**门禁，不做真实渲染（渲染层由 projectPagePreview.smoke.cjs 覆盖）；
 * 目的是防止 indigo 与「独立『打开』按钮」被后来的改动悄悄带回来。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../src/components/chat');
const FILES = {
  panel: path.join(SRC, 'FilePreviewPanel.vue'),
  page: path.join(SRC, 'ProjectPagePreview.vue'),
  design: path.join(SRC, 'DesignCanvasPreview.vue'),
};

/** 去掉注释与 HTML 注释，避免说明文字里提到旧色值就误判。 */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const read = (file) => {
  assert.equal(fs.existsSync(file), true, `未找到文件：${file}`);
  return stripComments(fs.readFileSync(file, 'utf8'));
};

/** 取出某个 CSS 规则块的内容（首个匹配）。 */
const ruleBody = (code, selector) => {
  const at = code.indexOf(selector);
  assert.ok(at >= 0, `缺少规则：${selector}`);
  const open = code.indexOf('{', at);
  const close = code.indexOf('}', open);
  assert.ok(open > 0 && close > open, `规则未闭合：${selector}`);
  return code.slice(open + 1, close);
};

/** indigo 系色值/类名/函数式写法，任意一条命中即视为回归。 */
const INDIGO = /\bindigo\b|#6366f1|#4f46e5|#818cf8|#a5b4fc|#e0e7ff|#c7d2fe|#3730a3|#312e81|#f5f3ff|#eef2ff|rgb\(\s*99\s*,\s*102\s*,\s*241\s*\)|rgba\(\s*99\s*,\s*102\s*,\s*241/gi;

test('P1 预览面板三件套不得再出现 indigo 色值或类名', () => {
  const offenders = Object.entries(FILES).flatMap(([name, file]) =>
    (read(file).match(INDIGO) || []).map((hit) => `${name} → ${hit}`));
  assert.deepEqual(offenders, [], `预览面板仍有 indigo 残留：${offenders.join(' / ')}`);
});

test('P2 强调色令牌的唯一来源是面板外壳，且明暗两套齐全', () => {
  const code = read(FILES.panel);
  const lightBlock = ruleBody(code, '.file-preview-panel {');
  const darkBlock = ruleBody(code, '.file-preview-panel.is-dark {');
  for (const token of ['--file-ink', '--file-ink-hover', '--file-ink-contrast', '--file-focus']) {
    assert.match(lightBlock, new RegExp(`${token}\\s*:`), `亮色令牌块缺少 ${token}`);
    assert.match(darkBlock, new RegExp(`${token}\\s*:`), `暗色令牌块缺少 ${token}`);
  }
});

test('P3 子视图只消费令牌，不得自己重新定义面板令牌', () => {
  for (const name of ['page', 'design']) {
    const code = read(FILES[name]);
    assert.doesNotMatch(code, /--file-(ink|focus|tab|line|bg|muted)\s*:/,
      `${name} 不应重新定义 --file-* 令牌（唯一来源在 FilePreviewPanel）`);
  }
});

test('P4 面板强调面（CTA / 选中胶囊 / 属性栏 / 焦点环）必须走令牌', () => {
  const design = read(FILES.design);
  for (const selector of ['.design-inspector-bar {', '.option-pill.is-selected {', '.btn-primary-action {', '.upload-cta-btn {']) {
    assert.match(ruleBody(design, selector), /var\(--file-/, `${selector} 必须消费 --file-* 令牌`);
  }
  const page = read(FILES.page);
  assert.match(ruleBody(page, '.address-go:hover:not(:disabled) {'), /var\(--file-/, '箭头 hover 高亮必须走令牌');
  assert.match(ruleBody(page, '.address-input:focus-visible {'), /var\(--file-focus/, '输入框焦点环必须走 --file-focus');
});

test('P5 打开地址的提交按钮内嵌在输入框末尾，而不是独立按钮', () => {
  const code = read(FILES.page);
  assert.match(code, /<div class="address-field">/, '缺少 .address-field 输入框容器');
  assert.doesNotMatch(code, /class="primary"/, '独立的「打开」主按钮应已移除');

  const scope = code.slice(code.indexOf('<div class="address-field">'), code.indexOf('</form>'));
  const inputAt = scope.indexOf('class="address-input"');
  const buttonAt = scope.indexOf('class="address-go"');
  assert.ok(inputAt >= 0, '.address-field 内缺少地址输入框');
  assert.ok(buttonAt > inputAt, '箭头按钮必须排在输入框之后（内嵌在末尾）');
  assert.match(scope, /type="submit"/, '内嵌箭头必须是表单提交按钮（回车与点击同一条路径）');
  assert.match(scope, /projectPagePreview\.openAddress/, '内嵌箭头必须保留可读名称');
});

test('P6 内嵌箭头有 hover 高亮，输入框右侧预留了不与箭头重叠的内边距', () => {
  const code = read(FILES.page);
  const go = ruleBody(code, '.address-go {');
  assert.match(go, /position:\s*absolute/, '箭头必须绝对定位内嵌进输入框');
  assert.match(go, /right:/, '箭头必须贴住输入框末尾');
  const hover = ruleBody(code, '.address-go:hover:not(:disabled) {');
  assert.match(hover, /background:/, '箭头缺少 hover 高亮背景');
  assert.match(hover, /color:/, '箭头 hover 未提升前景色');
  const input = ruleBody(code, '.address-input {');
  const shorthand = input.match(/padding:\s*[\d.]+px\s+([\d.]+)px/);
  assert.ok(shorthand, '.address-input 必须用四值以外的简写声明左右内边距');
  assert.ok(Number(shorthand[1]) >= 28, `输入框右侧内边距需为箭头让位（当前 ${shorthand[1]}px，至少 28px）`);
});

test('P7 导航按钮选择器必须限定直接子元素，别把内嵌箭头一起套上边框', () => {
  assert.doesNotMatch(read(FILES.page), /\.address-bar\s+button\s*\{/,
    '.address-bar button 会命中内嵌箭头，必须写成 .address-bar > button');
});

