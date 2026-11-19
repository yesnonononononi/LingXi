/**
 * browser_query 的页面侧实现：列出可见交互元素、稳定 ref、角色状态与页面文本摘要。
 *
 *注入方式见 mcp/page-scripts.cjs：本文件是函数体，拼接 common.js 后作为一个 IIFE 执行。
 */

const targetSelector = args.customSelector || args.defaultSelector;
const nodes = Array.from(document.querySelectorAll(targetSelector));
const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

/** 选择器是否唯一命中，用来判断能不能拿它当稳定 hint。 */
const isUnique = sel => {
  try {
    return document.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
};

/** 逐级尝试 #id / data-testid / name / aria-label，最后退到三级标签路径。 */
const buildSelectorHint = el => {
  const tag = el.tagName.toLowerCase();
  if (el.id) {
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
    const idSel = '#' + escapedId;
    if (isUnique(idSel)) return idSel;
  }
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
  if (testId) {
    const attr = el.hasAttribute('data-testid') ? 'data-testid' : 'data-test';
    const sel = '[' + attr + '="' + lxEscapeAttr(testId) + '"]';
    if (isUnique(sel)) return sel;
  }
  const name = el.getAttribute('name');
  if (name) {
    const sel = tag + '[name="' + lxEscapeAttr(name) + '"]';
    if (isUnique(sel)) return sel;
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.length <= 60) {
    const sel = tag + '[aria-label="' + lxEscapeAttr(ariaLabel) + '"]';
    if (isUnique(sel)) return sel;
  }
  const parts = [];
  let current = el;
  for (let depth = 0; current && current.nodeType === 1 && depth < 3; depth++) {
    const currentTag = current.tagName.toLowerCase();
    if (currentTag === 'html' || currentTag === 'body') break;
    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(currentTag);
      break;
    }
    const sameTagSiblings = Array.from(parent.children).filter(sibling => sibling.tagName === current.tagName);
    parts.unshift(sameTagSiblings.length > 1
      ? currentTag + ':nth-of-type(' + (sameTagSiblings.indexOf(current) + 1) + ')'
      : currentTag);
    const candidate = parts.join(' > ');
    if (isUnique(candidate)) return candidate;
    current = parent;
  }
  return parts.join(' > ') || tag;
};

/** 取元素的可读标签：优先关联 label，其次 aria-labelledby。 */
const resolveLabel = el => {
  if (el.labels && el.labels.length > 0) {
    const text = lxNormalizeText(el.labels[0].innerText || el.labels[0].textContent);
    if (text) return text.slice(0, 80);
  }
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refText = labelledBy
      .split(/\s+/)
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .map(node => lxNormalizeText(node.innerText || node.textContent))
      .filter(Boolean)
      .join(' ');
    if (refText) return refText.slice(0, 80);
  }
  return '';
};

/** 取元素当前值；密码只暴露是否已填。 */
const resolveValue = (el, tag, type) => {
  if (tag === 'input') {
    if (type === 'password') return el.value ? '***' : '';
    if (type === 'checkbox' || type === 'radio') return '';
    return String(el.value || '').slice(0, 100);
  }
  if (tag === 'textarea') return String(el.value || '').slice(0, 100);
  if (tag === 'select') {
    const option = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    return lxNormalizeText(option ? (option.textContent || option.value) : el.value).slice(0, 100);
  }
  if (el.isContentEditable) return lxNormalizeText(el.innerText || el.textContent).slice(0, 100);
  return '';
};

const inViewNodes = [];
const outViewNodes = [];
for (let i = 0; i < nodes.length; i++) {
  const el = nodes[i];
  if (!lxIsVisible(el)) continue;
  const rect = el.getBoundingClientRect();
  const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
  if (inViewport || args.customSelector) inViewNodes.push({el, inViewport});
  else outViewNodes.push({el, inViewport});
}
const ordered = args.customSelector ? inViewNodes : inViewNodes.concat(outViewNodes);

// 每次 query 重发 ref：旧属性先清掉，避免 ref 指向上一轮的节点
try {
  document.querySelectorAll('[data-lx-ref]').forEach(node => node.removeAttribute('data-lx-ref'));
} catch {
  // 页面禁用属性操作时忽略：ref 机制降级为按 selector 定位
}

const items = [];
for (let i = 0; i < ordered.length && items.length < args.maxItems; i++) {
  const {el, inViewport} = ordered[i];
  const refId = 'e' + (items.length + 1);
  try {
    el.setAttribute('data-lx-ref', refId);
  } catch {
    // 同上：属性写不进去只影响 ref 定位
  }
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type') || '';
  const ariaChecked = el.getAttribute('aria-checked');
  const ariaSelected = el.getAttribute('aria-selected');
  const ariaExpanded = el.getAttribute('aria-expanded');
  const item = {
    ref: refId,
    index: items.length,
    tag,
    role: el.getAttribute('role') || '',
    id: el.id || '',
    className: typeof el.className === 'string' ? el.className.trim() : '',
    type,
    name: el.getAttribute('name') || '',
    placeholder: el.getAttribute('placeholder') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    label: resolveLabel(el),
    href: el.getAttribute('href') || '',
    value: resolveValue(el, tag, type),
    disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    inViewport,
    selectorHint: buildSelectorHint(el),
    text: lxNormalizeText(el.innerText || el.textContent).slice(0, 100),
  };
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    item.checked = Boolean(el.checked);
  } else if (ariaChecked === 'true' || ariaChecked === 'false') {
    item.checked = ariaChecked === 'true';
  }
  if (ariaSelected === 'true' || ariaSelected === 'false') item.selected = ariaSelected === 'true';
  if (ariaExpanded === 'true' || ariaExpanded === 'false') item.expanded = ariaExpanded === 'true';
  items.push(item);
}

return {
  url: window.location.href,
  title: document.title,
  totalMatched: nodes.length,
  visibleCount: ordered.length,
  elements: items,
  textExcerpt: lxNormalizeText(document.body && document.body.innerText).slice(0, 1500),
  truncated: ordered.length > items.length,
};
