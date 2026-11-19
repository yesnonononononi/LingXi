/**
 * 页面内公共件：以文本方式拼进每个 page-script 的函数体，不是 Node 模块。
 *
 *拼装由 mcp/page-scripts.cjs 完成，所以这里只能用 function 声明（提升可见），
 * 不要用 import/export，也不要 require。所有名字加 lx 前缀，避免与页面全局冲突。
 */

/** 折叠空白并裁掉首尾。 */
function lxNormalizeText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

/** 转义成可安全放进属性选择器的文本。 */
function lxEscapeAttr(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** ref 对应的属性选择器。 */
function lxRefSelector(ref) {
  return '[data-lx-ref="' + lxEscapeAttr(ref) + '"]';
}

/** 元素是否可见（display/visibility/尺寸三重判断）。 */
function lxIsVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** 元素几何中心，供原生鼠标事件定位。 */
function lxCenter(el) {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}

/**
 * 在元素位置画一个短暂高亮框，让用户看清 Agent 正在操作哪里。
 *
 * @param el 目标元素
 * @param label 高亮标签文案
 */
function lxFlash(el, label) {
  try {
    const rect = el.getBoundingClientRect();
    document.querySelectorAll('[data-lx-agent-flash]').forEach(node => node.remove());
    const box = document.createElement('div');
    box.setAttribute('data-lx-agent-flash', '1');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;'
      + 'border:2px solid #3b82f6;border-radius:6px;background:rgba(59,130,246,0.12);'
      + 'box-shadow:0 0 0 3px rgba(59,130,246,0.22);transition:opacity 220ms ease;'
      + 'left:' + Math.max(0, rect.left - 3) + 'px;top:' + Math.max(0, rect.top - 3) + 'px;'
      + 'width:' + Math.max(12, rect.width + 6) + 'px;height:' + Math.max(12, rect.height + 6) + 'px;';
    const tagEl = document.createElement('div');
    tagEl.textContent = label;
    tagEl.style.cssText = 'position:absolute;left:0;top:-22px;padding:2px 6px;border-radius:4px;'
      + 'background:#2563eb;color:#fff;font:600 11px/1.2 system-ui,sans-serif;white-space:nowrap;';
    box.appendChild(tagEl);
    (document.body || document.documentElement).appendChild(box);
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 240);
    }, 550);
  } catch {
    // 高亮是纯装饰，失败不能影响工具本身
  }
}

/**
 * 按 ref 或 selector 定位元素，ref 优先。
 *
 * @param rawRef 上一次 browser_query 返回的 ref
 * @param rawSelector 模型给的 CSS 选择器
 * @returns {el, error} 二者取其一；error 已是给模型看的文案
 */
function lxLocate(rawRef, rawSelector) {
  if (rawRef) {
    const el = document.querySelector(lxRefSelector(rawRef));
    return el ? {el, error: ''} : {el: null, error: 'ref ' + rawRef + ' 已失效（页面可能已刷新），请重新调用 browser_query'};
  }
  if (!rawSelector) return {el: null, error: 'ref 与 selector 至少要给一个'};
  try {
    return {el: document.querySelector(rawSelector), error: ''};
  } catch (error) {
    return {el: null, error: '选择器不合法: ' + rawSelector};
  }
}

/**
 * 按 ref 或 selector + index 定位元素，供 fill / pressKey 复用。
 *
 * @param rawRef 上一次 browser_query 返回的 ref
 * @param rawSelector CSS 选择器
 * @param index 同选择器多命中时的序号
 */
function lxLocateIndexed(rawRef, rawSelector, index) {
  if (rawRef) {
    const located = lxLocate(rawRef, '');
    return {el: located.el, error: located.error, matchedCount: located.el ? 1 : 0};
  }
  if (!rawSelector) return {el: null, error: 'ref 与 selector 至少要给一个', matchedCount: 0};
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(rawSelector));
  } catch {
    return {el: null, error: '选择器不合法: ' + rawSelector, matchedCount: 0};
  }
  const picked = lxPickIndexed(nodes, index);
  return {
    el: picked.el,
    error: picked.el ? '' : '未找到匹配元素: ' + rawSelector,
    matchedCount: picked.matchedCount,
  };
}

/** 按序号挑元素：优先可见元素，index 越界返回 null。 */
function lxPickIndexed(nodes, index) {
  const visible = nodes.filter(lxIsVisible);
  const candidates = visible.length > 0 ? visible : nodes;
  return {el: candidates[index] || null, matchedCount: nodes.length, visibleCount: visible.length};
}

/** 元素的值长度，用于校验输入是否真的写进去了。 */
function lxValueLength(el) {
  const value = el.value != null ? el.value : el.textContent;
  return String(value == null ? '' : value).length;
}

/** 元素摘要，回给模型做确认。 */
function lxDescribe(el) {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    className: typeof el.className === 'string' ? el.className : '',
    valueLength: lxValueLength(el),
  };
}
