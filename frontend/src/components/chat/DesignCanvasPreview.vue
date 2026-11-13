<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import Moveable from 'moveable';
import {t} from '../../i18n';
import LxSelect from '../common/LxSelect.vue';
import type {SelectOption} from '../../types/ui';
import {
  buildDesignAiPrompt,
  buildDesignAnimationCss,
  DESIGN_AI_SUGGESTIONS,
  DESIGN_ANIMATION_PRESETS,
  DESIGN_ANIMATION_STYLE_ID,
  DESIGN_QUICK_BLOCKS,
  DESIGN_STARTER_TEMPLATES,
  type DesignAnimationPreset,
  type DesignBreadcrumbNode,
  type DesignQuickBlock,
  type DesignStarterTemplate,
  resolveAnimationCssValue,
  resolveElementBreadcrumb,
  resolveElementLabel,
  resolveElementSelector,
} from '../../utils/designCanvasHelpers';

const props = defineProps<{
  active?: boolean;
  initialContent?: string;
  initialFileName?: string;
}>();

const emit = defineEmits<{
  (e: 'sendToChat', payload: { prompt: string }): void;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

let moveableInstance: Moveable | null = null;
let hoverBoxEl: HTMLElement | null = null;
let breadcrumbNodes: HTMLElement[] = [];

export type CanvasMode = 'design' | 'interactive';
const canvasMode = ref<CanvasMode>('design');
const isCodeView = ref(false);
const codeDraft = ref('');

const selectedInfo = ref<string>('未选中元素（点击 iframe 内任意组件进行设计）');
const isSelected = ref(false);
const selectedElement = ref<HTMLElement | null>(null);
const isEditingText = ref(false);
const breadcrumb = ref<DesignBreadcrumbNode[]>([]);

const loadedFileName = ref<string>('');
const isFileLoaded = ref(false);
const isDraggingOver = ref(false);
const currentViewportWidth = ref<string>('100%');
const canvasZoom = ref<number>(1);

const showPasteModal = ref(false);
const pasteHtmlDraft = ref('');
const showInsertMenu = ref(false);
const aiInstruction = ref('');
const copyFeedback = ref(false);

// 撤销 / 重做快照栈
const undoStack = ref<string[]>([]);
const redoStack = ref<string[]>([]);
const MAX_HISTORY = 30;

const cleanCloneBody = (doc: Document): HTMLElement => {
  const cloned = doc.body.cloneNode(true) as HTMLElement;
  cloned.querySelectorAll('.moveable-control-box, [data-lx-hover-box]').forEach(el => el.remove());
  return cloned;
};

const serializeDocumentHtml = (): string => {
  const doc = iframeRef.value?.contentDocument;
  if (!doc) return '';
  const cloned = doc.documentElement.cloneNode(true) as HTMLElement;
  cloned.querySelectorAll('.moveable-control-box, [data-lx-hover-box]').forEach(el => el.remove());
  return `<!DOCTYPE html>\n${cloned.outerHTML}`;
};

const recordSnapshot = (): void => {
  const doc = iframeRef.value?.contentDocument;
  if (!doc?.body) return;
  const cloned = cleanCloneBody(doc);
  undoStack.value.push(cloned.innerHTML);
  if (undoStack.value.length > MAX_HISTORY) {
    undoStack.value.shift();
  }
  redoStack.value = [];
};

const clearSelectionState = (hint?: string): void => {
  selectedElement.value = null;
  isSelected.value = false;
  breadcrumb.value = [];
  breadcrumbNodes = [];
  selectedInfo.value = hint || t('designPreview.modeDesignHint') || '点击组件可选中拖拽、调整尺寸、改样式与删除';
  if (moveableInstance) {
    moveableInstance.target = [];
    moveableInstance.updateRect();
  }
};

const undo = (): void => {
  if (undoStack.value.length === 0) return;
  const doc = iframeRef.value?.contentDocument;
  if (!doc?.body) return;

  const currentCloned = cleanCloneBody(doc);
  redoStack.value.push(currentCloned.innerHTML);

  const previousHtml = undoStack.value.pop()!;
  doc.body.innerHTML = previousHtml;
  clearSelectionState();
  syncMoveableGuidelines(doc);
};

const redo = (): void => {
  if (redoStack.value.length === 0) return;
  const doc = iframeRef.value?.contentDocument;
  if (!doc?.body) return;

  const currentCloned = cleanCloneBody(doc);
  undoStack.value.push(currentCloned.innerHTML);

  const nextHtml = redoStack.value.pop()!;
  doc.body.innerHTML = nextHtml;
  clearSelectionState();
  syncMoveableGuidelines(doc);
};

// 模式手动切换：设计模式 ⇄ 交互模式
const setCanvasMode = (mode: CanvasMode): void => {
  isCodeView.value = false;
  if (canvasMode.value === mode) return;
  canvasMode.value = mode;

  if (mode === 'interactive') {
    hideHoverBox();
    clearSelectionState(t('designPreview.modeInteractiveHint') || '交互模式：支持正常点击、输入与网页原生交互');
  } else {
    selectedInfo.value = isFileLoaded.value
      ? (t('designPreview.modeDesignHint') || '点击组件可选中拖拽、调整尺寸、改样式与删除')
      : '请先选择 HTML 文件';
  }
};

const toggleCodeView = (): void => {
  if (!isFileLoaded.value) return;
  if (!isCodeView.value) {
    codeDraft.value = serializeDocumentHtml();
    isCodeView.value = true;
  } else {
    isCodeView.value = false;
  }
};

const applyCodeDraft = (): void => {
  if (!codeDraft.value.trim()) return;
  parseAndMountHtml(codeDraft.value, loadedFileName.value || 'design-prototype.html');
  isCodeView.value = false;
};

// 提取当前选中元素的实际计算样式
const currentStyles = ref({
  color: '#000000',
  backgroundColor: '#ffffff',
  borderRadius: 0,
  fontSize: 14,
  fontWeight: '400',
  textAlign: 'left',
  padding: 0,
  opacity: 1,
  boxShadow: 'none',
  animationPreset: 'none' as DesignAnimationPreset['id'],
  animationDuration: 400,
});

// rgb/rgba 转 hex 辅助函数
const rgbToHex = (color: string): string => {
  if (!color || color === 'transparent' || color.startsWith('rgba(0, 0, 0, 0)')) return '#ffffff';
  if (color.startsWith('#')) return color;
  const match = color.match(/\d+/g);
  if (!match || match.length < 3) return '#ffffff';
  const r = parseInt(match[0]!, 10).toString(16).padStart(2, '0');
  const g = parseInt(match[1]!, 10).toString(16).padStart(2, '0');
  const b = parseInt(match[2]!, 10).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
};

const syncElementStyles = (el: HTMLElement) => {
  selectedElement.value = el;
  const iframeDoc = iframeRef.value?.contentDocument;
  const win = iframeDoc?.defaultView || window;
  const computed = win.getComputedStyle(el);

  const rawAnim = el.getAttribute('data-lx-animation') as DesignAnimationPreset['id'] | null;
  const rawDuration = Number(el.getAttribute('data-lx-animation-duration'));

  currentStyles.value = {
    color: rgbToHex(computed.color),
    backgroundColor: rgbToHex(computed.backgroundColor),
    borderRadius: parseInt(computed.borderRadius, 10) || 0,
    fontSize: parseInt(computed.fontSize, 10) || 14,
    fontWeight: computed.fontWeight || '400',
    textAlign: computed.textAlign || 'left',
    padding: parseInt(computed.paddingTop, 10) || 0,
    opacity: Number(parseFloat(computed.opacity || '1').toFixed(2)),
    boxShadow: computed.boxShadow && computed.boxShadow !== 'none' ? computed.boxShadow : 'none',
    animationPreset: rawAnim || 'none',
    animationDuration: Number.isFinite(rawDuration) && rawDuration >= 100 ? rawDuration : 400,
  };
};

const ensureAnimationStylesheet = (doc: Document): void => {
  if (!doc.head) return;
  let styleEl = doc.getElementById(DESIGN_ANIMATION_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.id = DESIGN_ANIMATION_STYLE_ID;
    styleEl.textContent = buildDesignAnimationCss();
    doc.head.appendChild(styleEl);
  }
};

const applyAnimationPreset = (
  presetId: DesignAnimationPreset['id'],
  durationMs: number = currentStyles.value.animationDuration
): void => {
  const el = selectedElement.value;
  const doc = iframeRef.value?.contentDocument;
  if (!el || !doc) return;

  recordSnapshot();
  currentStyles.value.animationPreset = presetId;
  currentStyles.value.animationDuration = durationMs;

  if (presetId === 'none') {
    el.removeAttribute('data-lx-animation');
    el.removeAttribute('data-lx-animation-duration');
    el.style.removeProperty('animation');
    nextTick(() => moveableInstance?.updateRect());
    return;
  }

  ensureAnimationStylesheet(doc);
  const cssValue = resolveAnimationCssValue(presetId, durationMs);
  el.setAttribute('data-lx-animation', presetId);
  el.setAttribute('data-lx-animation-duration', String(durationMs));
  el.style.setProperty('animation', 'none', 'important');
  void el.offsetWidth;
  el.style.setProperty('animation', cssValue, 'important');
  nextTick(() => moveableInstance?.updateRect());
};

const replaySelectedAnimation = (): void => {
  const el = selectedElement.value;
  const doc = iframeRef.value?.contentDocument;
  if (!el || !doc || currentStyles.value.animationPreset === 'none') return;

  ensureAnimationStylesheet(doc);
  const cssValue = resolveAnimationCssValue(
    currentStyles.value.animationPreset,
    currentStyles.value.animationDuration
  );
  el.style.setProperty('animation', 'none', 'important');
  void el.offsetWidth;
  el.style.setProperty('animation', cssValue, 'important');
};

type StyleKey =
  | 'color'
  | 'backgroundColor'
  | 'borderRadius'
  | 'fontSize'
  | 'fontWeight'
  | 'textAlign'
  | 'padding'
  | 'opacity'
  | 'boxShadow';

const applyStyle = (key: StyleKey, val: string | number) => {
  if (!selectedElement.value) return;
  const el = selectedElement.value;
  recordSnapshot();

  if (key === 'borderRadius') {
    el.style.setProperty('border-radius', `${val}px`, 'important');
    currentStyles.value.borderRadius = Number(val);
  } else if (key === 'fontSize') {
    el.style.setProperty('font-size', `${val}px`, 'important');
    el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,span,a,button,label,li').forEach(child => {
      child.style.setProperty('font-size', `${val}px`, 'important');
    });
    currentStyles.value.fontSize = Number(val);
  } else if (key === 'fontWeight') {
    el.style.setProperty('font-weight', String(val), 'important');
    currentStyles.value.fontWeight = String(val);
  } else if (key === 'textAlign') {
    el.style.setProperty('text-align', String(val), 'important');
    currentStyles.value.textAlign = String(val);
  } else if (key === 'padding') {
    el.style.setProperty('padding', `${val}px`, 'important');
    currentStyles.value.padding = Number(val);
  } else if (key === 'opacity') {
    el.style.setProperty('opacity', String(val), 'important');
    currentStyles.value.opacity = Number(val);
  } else if (key === 'boxShadow') {
    el.style.setProperty('box-shadow', String(val), 'important');
    currentStyles.value.boxShadow = String(val);
  } else if (key === 'backgroundColor') {
    el.style.setProperty('background-color', String(val), 'important');
    currentStyles.value.backgroundColor = String(val);
  } else if (key === 'color') {
    el.style.setProperty('color', String(val), 'important');
    el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,span,a,button,label,li').forEach(child => {
      child.style.setProperty('color', String(val), 'important');
    });
    currentStyles.value.color = String(val);
  }

  nextTick(() => {
    moveableInstance?.updateRect();
  });
};

const isProtectedNode = (el: HTMLElement): boolean => {
  const tag = el.tagName?.toUpperCase();
  if (['HTML', 'BODY', 'HEAD', 'STYLE', 'SCRIPT', 'TITLE', 'META', 'LINK'].includes(tag)) {
    return true;
  }
  return Boolean(
    el.hasAttribute('data-lx-hover-box') ||
    el.closest('.moveable-control-box') ||
    moveableInstance?.isMoveableElement(el)
  );
};

/** 删除当前选中的元素（避开根节点，记录快照，并清理选中状态）。 */
const deleteSelectedElement = (): void => {
  if (canvasMode.value !== 'design') return;
  const el = selectedElement.value;
  if (!el) return;
  if (isProtectedNode(el)) return;

  recordSnapshot();
  el.remove();
  clearSelectionState(t('designPreview.deletedFeedback') || '已删除选中元素');
  const doc = iframeRef.value?.contentDocument;
  if (doc) syncMoveableGuidelines(doc);
};

const duplicateSelectedElement = (): void => {
  if (canvasMode.value !== 'design') return;
  const el = selectedElement.value;
  if (!el || isProtectedNode(el) || !el.parentElement) return;

  recordSnapshot();
  const clone = el.cloneNode(true) as HTMLElement;
  el.parentElement.insertBefore(clone, el.nextSibling);
  const doc = iframeRef.value?.contentDocument;
  if (doc) syncMoveableGuidelines(doc);
  selectElement(clone);
  selectedInfo.value = t('designPreview.duplicatedFeedback') || '已复制选中组件';
};

const isHtmlElementNode = (node: unknown): node is HTMLElement => {
  if (!node || typeof node !== 'object') return false;
  const candidate = node as { nodeType?: number; tagName?: unknown; style?: unknown };
  return candidate.nodeType === 1 && typeof candidate.tagName === 'string' && typeof candidate.style === 'object';
};

const moveSelectedLayer = (direction: 'up' | 'down'): void => {
  if (canvasMode.value !== 'design') return;
  const el = selectedElement.value;
  if (!el || isProtectedNode(el) || !el.parentElement) return;

  const parent = el.parentElement;
  const sibling = direction === 'up' ? el.previousElementSibling : el.nextElementSibling;
  if (!sibling || (isHtmlElementNode(sibling) && isProtectedNode(sibling))) return;

  recordSnapshot();
  if (direction === 'up') {
    parent.insertBefore(el, sibling);
  } else {
    parent.insertBefore(sibling, el);
  }
  nextTick(() => moveableInstance?.updateRect());
};

const insertQuickBlock = (block: DesignQuickBlock): void => {
  const doc = iframeRef.value?.contentDocument;
  if (!doc?.body) return;
  if (canvasMode.value !== 'design') {
    setCanvasMode('design');
  }
  recordSnapshot();

  const temp = doc.createElement('div');
  temp.innerHTML = block.html.trim();
  const inserted = temp.firstElementChild as HTMLElement | null;
  if (!inserted) return;

  const targetContainer =
    selectedElement.value && !['IMG', 'INPUT', 'HR', 'BR', 'BUTTON'].includes(selectedElement.value.tagName)
      ? selectedElement.value
      : doc.body;
  targetContainer.appendChild(inserted);
  showInsertMenu.value = false;
  syncMoveableGuidelines(doc);
  selectElement(inserted);
};

const handleCanvasKeyDown = (e: KeyboardEvent): void => {
  if (isEditingText.value || isCodeView.value) return;

  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    if (canvasMode.value === 'design' && selectedElement.value) {
      e.preventDefault();
      duplicateSelectedElement();
    }
    return;
  }

  if (canvasMode.value === 'design' && selectedElement.value) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelectedElement();
    }
  }
};

const triggerFileInput = () => {
  fileInputRef.value?.click();
};

const syncMoveableGuidelines = (doc: Document) => {
  if (!moveableInstance || !doc.body) return;
  moveableInstance.elementGuidelines = Array.from(doc.body.querySelectorAll('*')).filter(
    node => !(isHtmlElementNode(node) && node.hasAttribute('data-lx-hover-box'))
  );
};

const ensureHoverBox = (doc: Document): HTMLElement => {
  if (hoverBoxEl && doc.body.contains(hoverBoxEl)) {
    return hoverBoxEl;
  }
  const box = doc.createElement('div');
  box.setAttribute('data-lx-hover-box', 'true');
  box.style.position = 'fixed';
  box.style.pointerEvents = 'none';
  box.style.zIndex = '2147483640';
  box.style.border = '1.5px dashed #71717a';
  box.style.background = 'rgba(24, 24, 27, 0.03)';
  box.style.borderRadius = '3px';
  box.style.display = 'none';
  doc.body.appendChild(box);
  hoverBoxEl = box;
  return box;
};

const hideHoverBox = () => {
  if (hoverBoxEl) {
    hoverBoxEl.style.display = 'none';
  }
};

const setupIframeInteraction = (doc: Document) => {
  if (!doc.body) return;

  if (moveableInstance) {
    moveableInstance.destroy();
    moveableInstance = null;
  }
  hoverBoxEl = null;

  moveableInstance = new Moveable(doc.body, {
    target: [],
    container: doc.body,
    draggable: true,
    resizable: true,
    rotatable: true,
    scalable: false,
    warpable: false,
    pinchable: false,
    keepRatio: false,
    origin: true,
    edge: true,
    throttleDrag: 0,
    throttleResize: 0,
    throttleRotate: 0,
    snappable: true,
    snapThreshold: 5,
    isDisplaySnapDigit: true,
    snapGap: true,
    snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    snapContainer: doc.body,
    elementGuidelines: Array.from(doc.body.querySelectorAll('*')),
  });

  moveableInstance.on('dragStart', () => recordSnapshot());
  moveableInstance.on('resizeStart', () => recordSnapshot());
  moveableInstance.on('rotateStart', () => recordSnapshot());

  moveableInstance.on('drag', ({ target, transform }) => {
    target.style.transform = transform;
    updateSelectionInfo(target);
  });

  moveableInstance.on('resize', ({ target, width, height, drag }) => {
    target.style.width = `${width}px`;
    target.style.height = `${height}px`;
    target.style.transform = drag.transform;
    updateSelectionInfo(target);
  });

  moveableInstance.on('rotate', ({ target, transform }) => {
    target.style.transform = transform;
    updateSelectionInfo(target);
  });

  doc.addEventListener('mousemove', (e: MouseEvent) => {
    if (canvasMode.value !== 'design' || isEditingText.value) {
      hideHoverBox();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (
      !target ||
      target === doc.body ||
      target === doc.documentElement ||
      target === selectedElement.value ||
      isProtectedNode(target)
    ) {
      hideHoverBox();
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideHoverBox();
      return;
    }
    const box = ensureHoverBox(doc);
    box.style.display = 'block';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  });

  doc.addEventListener('mouseleave', hideHoverBox);

  // 2. 监听点击以选中任意目标元素（交互模式下直接放行原生点击）
  doc.addEventListener('click', (e: MouseEvent) => {
    if (canvasMode.value !== 'design') return;
    if (isEditingText.value) return;
    const target = e.target as HTMLElement;
    if (!target || target === doc.body || target === doc.documentElement) return;
    if (target.closest('.moveable-control-box') || moveableInstance?.isMoveableElement(target)) return;

    e.preventDefault();
    e.stopPropagation();

    hideHoverBox();
    selectElement(target);
  }, true);

  // 3. 监听双击就地文字编辑（交互模式下直接放行）
  doc.addEventListener('dblclick', (e: MouseEvent) => {
    if (canvasMode.value !== 'design') return;
    const target = e.target as HTMLElement;
    if (!target || target === doc.body || target === doc.documentElement) return;
    e.preventDefault();
    e.stopPropagation();
    hideHoverBox();
    startInlineEdit(target);
  }, true);

  // 4. 监听键盘快捷键（删除元素、撤销重做、复制组件）
  doc.addEventListener('keydown', handleCanvasKeyDown);
};

const rebuildBreadcrumbChain = (target: HTMLElement) => {
  const nodes: HTMLElement[] = [];
  let cursor: HTMLElement | null = target;
  let guard = 0;
  while (cursor && guard < 16) {
    guard += 1;
    const tag = cursor.tagName.toLowerCase();
    if (tag === 'html') break;
    nodes.unshift(cursor);
    if (tag === 'body') break;
    cursor = cursor.parentElement;
  }
  breadcrumbNodes = nodes;
  breadcrumb.value = resolveElementBreadcrumb(target);
};

const selectBreadcrumbAt = (index: number): void => {
  const node = breadcrumbNodes[index];
  if (!node) return;
  if (node.tagName.toLowerCase() === 'body') {
    clearSelectionState();
    return;
  }
  selectElement(node);
};

const selectElement = (target: HTMLElement) => {
  if (!moveableInstance) return;
  moveableInstance.target = [target];
  moveableInstance.updateRect();
  updateSelectionInfo(target);
  rebuildBreadcrumbChain(target);
};

const startInlineEdit = (target: HTMLElement) => {
  isEditingText.value = true;
  recordSnapshot();
  target.contentEditable = 'true';
  target.focus();

  const iframeDoc = iframeRef.value?.contentDocument;
  const win = iframeDoc?.defaultView || window;
  const range = docRange(iframeDoc || document, target);
  const sel = win.getSelection();
  sel?.removeAllRanges();
  if (range) sel?.addRange(range);

  if (moveableInstance) {
    moveableInstance.target = [];
  }

  const finishEdit = () => {
    target.contentEditable = 'false';
    isEditingText.value = false;
    target.removeEventListener('blur', finishEdit);
    target.removeEventListener('keydown', onKey);

    if (moveableInstance) {
      moveableInstance.target = [target];
      moveableInstance.updateRect();
      updateSelectionInfo(target);
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey && target.tagName !== 'P')) {
      ev.preventDefault();
      target.blur();
    }
  };

  target.addEventListener('blur', finishEdit);
  target.addEventListener('keydown', onKey);
};

const docRange = (doc: Document, el: HTMLElement) => {
  try {
    const range = doc.createRange();
    range.selectNodeContents(el);
    return range;
  } catch {
    return null;
  }
};

const parseAndMountHtml = (content: string, name: string) => {
  loadedFileName.value = name;
  isFileLoaded.value = true;
  isCodeView.value = false;
  selectedElement.value = null;
  isSelected.value = false;
  breadcrumb.value = [];
  breadcrumbNodes = [];
  undoStack.value = [];
  redoStack.value = [];
  canvasMode.value = 'design';
  selectedInfo.value = t('designPreview.modeDesignHint') || '点击组件可选中拖拽、调整尺寸、改样式与删除';

  nextTick(() => {
    const iframe = iframeRef.value;
    if (!iframe) return;

    if (moveableInstance) {
      moveableInstance.target = [];
    }

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    doc.open();
    doc.write(content);
    doc.close();

    setTimeout(() => {
      setupIframeInteraction(doc);
    }, 150);
  });
};

const loadTemplate = (tpl: DesignStarterTemplate) => {
  parseAndMountHtml(tpl.html, tpl.fileName);
};

const confirmPasteHtml = () => {
  const raw = pasteHtmlDraft.value.trim();
  if (!raw) return;
  const normalized = /<html[\s>]/i.test(raw)
    ? raw
    : `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px;}</style></head><body>${raw}</body></html>`;
  parseAndMountHtml(normalized, 'pasted-prototype.html');
  pasteHtmlDraft.value = '';
  showPasteModal.value = false;
};

const handleFileChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = ev => {
    const content = String(ev.target?.result || '');
    parseAndMountHtml(content, file.name);
  };
  reader.readAsText(file);
  input.value = '';
};

const handleDrop = (e: DragEvent) => {
  isDraggingOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.endsWith('.html') && !file.name.endsWith('.htm')) return;

  const reader = new FileReader();
  reader.onload = ev => {
    const content = String(ev.target?.result || '');
    parseAndMountHtml(content, file.name);
  };
  reader.readAsText(file);
};

const clearLoadedHtml = () => {
  isFileLoaded.value = false;
  isCodeView.value = false;
  loadedFileName.value = '';
  clearSelectionState('未加载 HTML 文件');
  undoStack.value = [];
  redoStack.value = [];
  canvasMode.value = 'design';

  if (moveableInstance) {
    moveableInstance.destroy();
    moveableInstance = null;
  }
  hoverBoxEl = null;

  const iframe = iframeRef.value;
  if (iframe) {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (doc) {
      doc.open();
      doc.write('<html><body></body></html>');
      doc.close();
    }
  }
};

const updateSelectionInfo = (target: HTMLElement | SVGElement | undefined) => {
  if (!isHtmlElementNode(target)) {
    isSelected.value = false;
    selectedElement.value = null;
    breadcrumb.value = [];
    breadcrumbNodes = [];
    if (canvasMode.value === 'interactive') {
      selectedInfo.value = t('designPreview.modeInteractiveHint') || '交互模式：支持正常点击、输入与网页原生交互';
    } else {
      selectedInfo.value = isFileLoaded.value
        ? (t('designPreview.modeDesignHint') || '点击组件可选中拖拽、调整尺寸、改样式与删除')
        : '请先选择 HTML 文件';
    }
    return;
  }
  isSelected.value = true;
  syncElementStyles(target);
  const label = resolveElementLabel(target);
  const rect = target.getBoundingClientRect();
  selectedInfo.value = `<${label}> · ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
};

const copyFullHtml = async () => {
  const fullHtml = isCodeView.value ? codeDraft.value : serializeDocumentHtml();
  if (!fullHtml) return;
  try {
    await navigator.clipboard.writeText(fullHtml);
    copyFeedback.value = true;
    setTimeout(() => {
      copyFeedback.value = false;
    }, 1600);
  } catch {
    // 忽略无剪贴板权限时的错误
  }
};

// 导出调整后的完整 HTML
const exportHtml = () => {
  const fullHtml = isCodeView.value ? codeDraft.value : serializeDocumentHtml();
  if (!fullHtml) return;
  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = loadedFileName.value ? `modified-${loadedFileName.value}` : 'modified-page.html';
  a.click();
  URL.revokeObjectURL(url);
};

const animationPresetOptions = computed<SelectOption<DesignAnimationPreset['id']>[]>(() =>
  DESIGN_ANIMATION_PRESETS.map(preset => ({
    value: preset.id,
    label: t(preset.labelKey) || preset.id,
  }))
);

const animationDurationOptions: SelectOption<number>[] = [
  { value: 200, label: '0.2s' },
  { value: 400, label: '0.4s' },
  { value: 700, label: '0.7s' },
  { value: 1200, label: '1.2s' },
];

const aiTargetLabel = computed(() => {
  if (selectedElement.value) {
    return `<${resolveElementLabel(selectedElement.value)}>`;
  }
  return loadedFileName.value || '当前画布';
});

const sendDesignPrompt = (presetText?: string) => {
  const text = (presetText ?? aiInstruction.value).trim();
  if (!text) return;

  const selected = selectedElement.value;
  const prompt = buildDesignAiPrompt({
    instruction: text,
    fileName: loadedFileName.value,
    selector: selected ? resolveElementSelector(selected) : undefined,
    elementHtml: selected ? selected.outerHTML : undefined,
    fullHtml: selected ? undefined : serializeDocumentHtml(),
  });

  emit('sendToChat', { prompt });
  if (!presetText) {
    aiInstruction.value = '';
  }
};

onMounted(async () => {
  window.addEventListener('keydown', handleCanvasKeyDown);
  await nextTick();
  if (props.initialContent) {
    parseAndMountHtml(props.initialContent, props.initialFileName || 'preview.html');
  }
});

watch(() => [props.initialContent, props.initialFileName] as const, ([newContent, newName]) => {
  if (newContent && (!isFileLoaded.value || newName !== loadedFileName.value)) {
    parseAndMountHtml(newContent, newName || 'preview.html');
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleCanvasKeyDown);
  moveableInstance?.destroy();
  moveableInstance = null;
  hoverBoxEl = null;
});
</script>

<template>
  <div class="design-canvas-container">
    <input
      ref="fileInputRef"
      type="file"
      accept=".html,.htm"
      class="hidden"
      style="display: none;"
      @change="handleFileChange"
    />

    <!-- 顶部主控制栏 -->
    <div class="design-top-bar">
      <div class="selection-status" :class="{ 'is-active': isSelected }">
        <span class="status-dot"></span>
        <span class="status-text" :title="selectedInfo">{{ selectedInfo }}</span>
      </div>

      <div class="design-actions">
        <!-- 模式切换：设计模式 vs 交互模式 vs 源码 -->
        <div v-if="isFileLoaded" class="mode-switch" role="group">
          <button
            type="button"
            :class="{ 'is-selected': !isCodeView && canvasMode === 'design' }"
            @click="setCanvasMode('design')"
            :title="t('designPreview.modeDesignHint') || '设计模式：可点击选中组件、调整尺寸样式与删除'"
          >
            {{ t('designPreview.modeDesign') || '设计模式' }}
          </button>
          <button
            type="button"
            :class="{ 'is-selected': !isCodeView && canvasMode === 'interactive' }"
            @click="setCanvasMode('interactive')"
            :title="t('designPreview.modeInteractiveHint') || '交互模式：支持正常点击、输入与网页原生交互'"
          >
            {{ t('designPreview.modeInteractive') || '交互模式' }}
          </button>
          <button
            type="button"
            :class="{ 'is-selected': isCodeView }"
            @click="toggleCodeView"
            :title="t('designPreview.modeCodeHint') || '查看并编辑当前画布 HTML 源码'"
          >
            {{ t('designPreview.modeCode') || '源码' }}
          </button>
        </div>

        <!-- 撤销 / 重做操作 -->
        <div v-if="isFileLoaded && !isCodeView && canvasMode === 'design'" class="undo-redo-group" role="group">
          <button
            type="button"
            class="undo-redo-btn"
            :disabled="undoStack.length === 0"
            @click="undo"
            :title="`${t('designPreview.undo') || '撤销'} (Ctrl+Z)`"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a5 5 0 015 5v2m0 0l-4-4m4 4l4-4M3 10l4-4m-4 4l4 4" />
            </svg>
          </button>
          <button
            type="button"
            class="undo-redo-btn"
            :disabled="redoStack.length === 0"
            @click="redo"
            :title="`${t('designPreview.redo') || '重做'} (Ctrl+Shift+Z / Ctrl+Y)`"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 10H11a5 5 0 00-5 5v2m0 0l4-4m-4 4l-4-4m14-6l-4-4m4 4l-4 4" />
            </svg>
          </button>
        </div>

        <!-- 快速插入组件 -->
        <div v-if="isFileLoaded && !isCodeView && canvasMode === 'design'" class="insert-dropdown">
          <button
            type="button"
            class="btn-secondary-action"
            @click="showInsertMenu = !showInsertMenu"
          >
            + {{ t('designPreview.insertBlock') || '插入组件' }}
          </button>
          <div v-if="showInsertMenu" class="insert-menu">
            <button
              v-for="block in DESIGN_QUICK_BLOCKS"
              :key="block.id"
              type="button"
              class="insert-menu-item"
              @click="insertQuickBlock(block)"
            >
              {{ t(block.labelKey) || block.id }}
            </button>
          </div>
        </div>

        <!-- 视口尺寸切换器 -->
        <div v-if="isFileLoaded && !isCodeView" class="device-switch" role="group">
          <button type="button" :class="{ 'is-selected': currentViewportWidth === '100%' }" @click="currentViewportWidth = '100%'" title="桌面自适应">桌面</button>
          <button type="button" :class="{ 'is-selected': currentViewportWidth === '768px' }" @click="currentViewportWidth = '768px'" title="平板 768px">平板</button>
          <button type="button" :class="{ 'is-selected': currentViewportWidth === '390px' }" @click="currentViewportWidth = '390px'" title="手机 390px">手机</button>
        </div>

        <!-- 缩放倍率 -->
        <div v-if="isFileLoaded && !isCodeView" class="device-switch" role="group" :title="t('designPreview.zoomLabel') || '缩放'">
          <button type="button" :class="{ 'is-selected': canvasZoom === 0.75 }" @click="canvasZoom = 0.75">75%</button>
          <button type="button" :class="{ 'is-selected': canvasZoom === 1 }" @click="canvasZoom = 1">100%</button>
          <button type="button" :class="{ 'is-selected': canvasZoom === 1.25 }" @click="canvasZoom = 1.25">125%</button>
        </div>

        <button
          type="button"
          class="btn-primary-action"
          @click="triggerFileInput"
          title="选择本地 HTML 文件并渲染到画布"
        >
          {{ isFileLoaded ? (t('designPreview.replaceFile') || '更换文件') : (t('designPreview.openFile') || '选择 HTML 文件') }}
        </button>

        <button
          v-if="isFileLoaded"
          type="button"
          class="btn-secondary-action"
          @click="copyFullHtml"
        >
          {{ copyFeedback ? (t('designPreview.copiedHtml') || '已复制 HTML') : (t('designPreview.copyHtml') || '复制 HTML') }}
        </button>

        <button
          v-if="isFileLoaded"
          type="button"
          class="btn-secondary-action"
          @click="exportHtml"
        >
          {{ t('designPreview.exportHtml') || '导出 HTML' }}
        </button>

        <button
          v-if="isFileLoaded"
          type="button"
          class="btn-reset"
          @click="clearLoadedHtml"
        >
          {{ t('designPreview.clearCanvas') || '清空' }}
        </button>
      </div>
    </div>

    <!-- 选中元素的实时样式属性面板（Style Inspector） -->
    <div v-if="!isCodeView && canvasMode === 'design' && selectedElement" class="design-inspector-bar">
      <!-- 背景色调节 -->
      <div class="inspector-group">
        <span class="inspector-label">背景</span>
        <div class="flex items-center gap-1.5">
          <input
            type="color"
            class="color-picker"
            :value="currentStyles.backgroundColor"
            @input="applyStyle('backgroundColor', ($event.target as HTMLInputElement).value)"
            title="选择自定义背景色"
          />
          <div class="color-presets">
            <button type="button" class="option-pill" @click="applyStyle('backgroundColor', 'transparent')" :title="t('designPreview.transparentBg') || '透明'">
              {{ t('designPreview.transparentBg') || '透明' }}
            </button>
            <button type="button" class="preset-btn bg-white" @click="applyStyle('backgroundColor', '#ffffff')" title="纯白"></button>
            <button type="button" class="preset-btn bg-slate-900" @click="applyStyle('backgroundColor', '#0f172a')" title="暗黑"></button>
            <button type="button" class="preset-btn bg-blue-600" @click="applyStyle('backgroundColor', '#2563eb')" title="蓝色"></button>
            <button type="button" class="preset-btn bg-emerald-600" @click="applyStyle('backgroundColor', '#059669')" title="翠绿"></button>
            <button type="button" class="preset-btn bg-rose-500" @click="applyStyle('backgroundColor', '#f43f5e')" title="粉红"></button>
            <button type="button" class="preset-btn bg-amber-500" @click="applyStyle('backgroundColor', '#f59e0b')" title="琥珀"></button>
          </div>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 文字色调节 -->
      <div class="inspector-group">
        <span class="inspector-label">文字</span>
        <div class="flex items-center gap-1.5">
          <input
            type="color"
            class="color-picker"
            :value="currentStyles.color"
            @input="applyStyle('color', ($event.target as HTMLInputElement).value)"
            title="选择自定义文字色"
          />
          <div class="color-presets">
            <button type="button" class="preset-btn bg-slate-900 border border-slate-300" @click="applyStyle('color', '#0f172a')" title="深色字"></button>
            <button type="button" class="preset-btn bg-white border border-slate-300" @click="applyStyle('color', '#ffffff')" title="白色字"></button>
            <button type="button" class="preset-btn bg-blue-600" @click="applyStyle('color', '#2563eb')" title="蓝色字"></button>
          </div>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 圆角调节 -->
      <div class="inspector-group">
        <span class="inspector-label">圆角</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 0 }" @click="applyStyle('borderRadius', 0)">0</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 8 }" @click="applyStyle('borderRadius', 8)">8</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 16 }" @click="applyStyle('borderRadius', 16)">16</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius >= 999 }" @click="applyStyle('borderRadius', 9999)">全圆</button>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 内边距调节 -->
      <div class="inspector-group">
        <span class="inspector-label">边距</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.padding === 0 }" @click="applyStyle('padding', 0)">0</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.padding === 8 }" @click="applyStyle('padding', 8)">8</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.padding === 16 }" @click="applyStyle('padding', 16)">16</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.padding === 24 }" @click="applyStyle('padding', 24)">24</button>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 字号与对齐 -->
      <div class="inspector-group">
        <span class="inspector-label">字号</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" title="减小字号 2px" @click="applyStyle('fontSize', Math.max(8, currentStyles.fontSize - 2))">A-</button>
          <input
            type="number"
            min="8"
            max="144"
            class="font-size-input"
            :value="currentStyles.fontSize"
            :title="t('designPreview.fontSizeInput') || '自定义字号 (px)'"
            @change="applyStyle('fontSize', Math.max(8, Math.min(144, Number(($event.target as HTMLInputElement).value) || 14)))"
          />
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 14 }" @click="applyStyle('fontSize', 14)">14</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 18 }" @click="applyStyle('fontSize', 18)">18</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 24 }" @click="applyStyle('fontSize', 24)">24</button>
          <button type="button" class="option-pill" title="增大字号 2px" @click="applyStyle('fontSize', Math.min(144, currentStyles.fontSize + 2))">A+</button>
        </div>
        <button
          type="button"
          class="option-pill font-bold ml-1"
          :class="{ 'is-selected': Number(currentStyles.fontWeight) >= 600 || currentStyles.fontWeight === 'bold' }"
          @click="applyStyle('fontWeight', (Number(currentStyles.fontWeight) >= 600 || currentStyles.fontWeight === 'bold') ? '400' : '700')"
          title="切换粗体"
        >
          B
        </button>
        <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.textAlign === 'left' }" @click="applyStyle('textAlign', 'left')" :title="t('designPreview.alignLeft') || '左对齐'">左</button>
        <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.textAlign === 'center' }" @click="applyStyle('textAlign', 'center')" :title="t('designPreview.alignCenter') || '居中对齐'">中</button>
        <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.textAlign === 'right' }" @click="applyStyle('textAlign', 'right')" :title="t('designPreview.alignRight') || '右对齐'">右</button>
      </div>

      <div class="inspector-divider"></div>

      <!-- 阴影与透明度 -->
      <div class="inspector-group">
        <span class="inspector-label">阴影</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.boxShadow === 'none' }" @click="applyStyle('boxShadow', 'none')">无</button>
          <button type="button" class="option-pill" @click="applyStyle('boxShadow', '0 4px 12px rgba(0, 0, 0, 0.08)')">轻</button>
          <button type="button" class="option-pill" @click="applyStyle('boxShadow', '0 14px 32px rgba(0, 0, 0, 0.14)')">强</button>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 内置过渡动画样式选择框 -->
      <div class="inspector-group animation-picker-group">
        <span class="inspector-label">{{ t('designPreview.animation') || '过渡动画' }}</span>
        <LxSelect
          :modelValue="currentStyles.animationPreset"
          :options="animationPresetOptions"
          variant="popup"
          size="sm"
          panelWidth="content"
          :label="t('designPreview.animation') || '过渡动画'"
          @update:modelValue="applyAnimationPreset($event)"
        />
        <LxSelect
          v-if="currentStyles.animationPreset !== 'none'"
          :modelValue="currentStyles.animationDuration"
          :options="animationDurationOptions"
          variant="popup"
          size="sm"
          panelWidth="content"
          :label="t('designPreview.animDuration') || '动画时长'"
          @update:modelValue="applyAnimationPreset(currentStyles.animationPreset, Number($event))"
        />
        <button
          v-if="currentStyles.animationPreset !== 'none'"
          type="button"
          class="option-pill"
          @click="replaySelectedAnimation"
        >
          {{ t('designPreview.animReplay') || '预览动画' }}
        </button>
      </div>

      <div class="inspector-divider"></div>

      <!-- 图层与元素操作 -->
      <div class="inspector-group ml-auto">
        <button type="button" class="option-pill" @click="moveSelectedLayer('up')" :title="t('designPreview.moveLayerUp') || '上移一层'">↑</button>
        <button type="button" class="option-pill" @click="moveSelectedLayer('down')" :title="t('designPreview.moveLayerDown') || '下移一层'">↓</button>
        <button type="button" class="option-pill" @click="duplicateSelectedElement" :title="`${t('designPreview.duplicateElement') || '复制组件'} (Ctrl+D)`">
          {{ t('designPreview.duplicateElement') || '复制' }}
        </button>
        <button
          type="button"
          class="btn-delete-element"
          @click="deleteSelectedElement"
          :title="`${t('designPreview.deleteElement') || '删除元素'} (Del / Backspace)`"
        >
          {{ t('designPreview.deleteElement') || '删除元素' }}
        </button>
      </div>
    </div>

    <!-- 源码视图 -->
    <div v-if="isFileLoaded && isCodeView" class="code-editor-pane">
      <textarea
        v-model="codeDraft"
        class="code-editor-textarea"
        spellcheck="false"
      ></textarea>
      <div class="code-editor-footer">
        <button type="button" class="btn-secondary-action" @click="isCodeView = false">
          {{ t('designPreview.cancel') || '取消' }}
        </button>
        <button type="button" class="btn-primary-action" @click="applyCodeDraft">
          {{ t('designPreview.applyCode') || '应用到画布' }}
        </button>
      </div>
    </div>

    <!-- 可视化设计画布主区域 -->
    <div
      v-show="!isCodeView"
      class="canvas-viewport"
      :class="{ 'is-dragging-over': isDraggingOver }"
      @dragover.prevent="isDraggingOver = true"
      @dragleave.prevent="isDraggingOver = false"
      @drop.prevent="handleDrop"
    >
      <!-- 空状态：文件选择 + 预设模板 + 粘贴 HTML -->
      <div v-show="!isFileLoaded" class="empty-workspace">
        <div class="empty-upload-card" @click="triggerFileInput">
          <div class="upload-icon-circle">
            <svg class="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 class="text-base font-bold mt-3">{{ t('designPreview.emptyTitle') || '开始你的可视化设计原型' }}</h3>
          <p class="text-xs opacity-70 mt-1.5 text-center max-w-sm leading-relaxed">
            {{ t('designPreview.emptyDesc') || '拖入或选择本地 .html 文件，或直接从下方预设模板 / 粘贴代码起步' }}
          </p>
          <div class="flex items-center gap-2 mt-4">
            <button type="button" class="upload-cta-btn">
              {{ t('designPreview.openFile') || '选择 HTML 文件' }}
            </button>
            <button type="button" class="btn-secondary-action" @click.stop="showPasteModal = true">
              {{ t('designPreview.pasteHtml') || '粘贴 HTML' }}
            </button>
          </div>
        </div>

        <div class="starter-templates-section">
          <div class="starter-templates-title">{{ t('designPreview.startFromTemplate') || '从预设模板起步' }}</div>
          <div class="starter-templates-grid">
            <button
              v-for="tpl in DESIGN_STARTER_TEMPLATES"
              :key="tpl.id"
              type="button"
              class="starter-template-card"
              @click="loadTemplate(tpl)"
            >
              <span class="starter-template-name">{{ t(tpl.titleKey) || tpl.id }}</span>
              <span class="starter-template-desc">{{ t(tpl.descKey) || '' }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Iframe 沙箱画板 -->
      <div
        v-show="isFileLoaded"
        class="artboard-iframe-wrapper"
        :style="{
          width: currentViewportWidth,
          transform: canvasZoom !== 1 ? `scale(${canvasZoom})` : undefined,
          transformOrigin: 'top center',
        }"
      >
        <iframe
          ref="iframeRef"
          class="artboard-iframe"
          title="Design Artboard"
          sandbox="allow-scripts allow-same-origin allow-modals"
        />
      </div>
    </div>

    <!-- 底部 DOM 面包屑与 AI 协同设计指令栏 -->
    <div v-if="isFileLoaded && !isCodeView" class="design-bottom-dock">
      <div v-if="breadcrumb.length > 0" class="breadcrumb-bar">
        <template v-for="(node, idx) in breadcrumb" :key="`${node.label}-${idx}`">
          <span v-if="idx > 0" class="breadcrumb-sep">›</span>
          <button
            type="button"
            class="breadcrumb-node"
            :class="{ 'is-current': idx === breadcrumb.length - 1 }"
            @click="selectBreadcrumbAt(idx)"
          >
            {{ node.label }}
          </button>
        </template>
      </div>

      <div class="ai-prompt-bar">
        <span class="ai-target-badge">{{ aiTargetLabel }}</span>
        <input
          v-model="aiInstruction"
          type="text"
          class="ai-prompt-input"
          :placeholder="t('designPreview.aiPromptPlaceholder') || '向 AI 描述设计修改...'"
          @keydown.enter.prevent="sendDesignPrompt()"
        />
        <button
          type="button"
          class="btn-primary-action"
          :disabled="!aiInstruction.trim()"
          @click="sendDesignPrompt()"
        >
          {{ t('designPreview.aiSendToChat') || '发送到对话' }}
        </button>
      </div>

      <div class="ai-suggestion-row">
        <button
          v-for="chip in DESIGN_AI_SUGGESTIONS"
          :key="chip"
          type="button"
          class="ai-suggestion-chip"
          @click="sendDesignPrompt(chip)"
        >
          {{ chip }}
        </button>
      </div>
    </div>

    <!-- 粘贴 HTML 弹窗 -->
    <div v-if="showPasteModal" class="paste-modal-backdrop" @click.self="showPasteModal = false">
      <div class="paste-modal-card">
        <div class="paste-modal-header">{{ t('designPreview.pasteHtml') || '粘贴 HTML' }}</div>
        <textarea
          v-model="pasteHtmlDraft"
          class="paste-modal-textarea"
          :placeholder="t('designPreview.pasteHtmlPlaceholder') || '在此粘贴完整 HTML 或页面片段...'"
        ></textarea>
        <div class="paste-modal-actions">
          <button type="button" class="btn-secondary-action" @click="showPasteModal = false">
            {{ t('designPreview.cancel') || '取消' }}
          </button>
          <button type="button" class="btn-primary-action" :disabled="!pasteHtmlDraft.trim()" @click="confirmPasteHtml">
            {{ t('designPreview.applyCode') || '应用到画布' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.design-canvas-container {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--file-bg, #ffffff);
}

.design-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
}

.design-inspector-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 6px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #f4f4f5);
  animation: slideDown 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}

.inspector-group {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.inspector-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--file-muted, #71717a);
}

.color-picker {
  width: 20px;
  height: 20px;
  border: 0;
  padding: 0;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
}

.color-presets {
  display: flex;
  align-items: center;
  gap: 3px;
}

.preset-btn {
  width: 14px;
  height: 14px;
  border-radius: 9999px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  cursor: pointer;
  transition: transform 0.1s;
}

.preset-btn:hover {
  transform: scale(1.2);
}

.option-pill {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--file-bg, #ffffff);
  color: var(--file-muted, #71717a);
  border: 1px solid var(--file-line, #e4e4e7);
  cursor: pointer;
  transition: background-color 0.1s, color 0.1s, border-color 0.1s;
}

.option-pill:hover {
  background: var(--file-line, #e4e4e7);
  color: var(--file-ink, #18181b);
}

.option-pill.is-selected {
  background: var(--file-ink, #18181b);
  border-color: var(--file-ink, #18181b);
  color: var(--file-ink-contrast, #ffffff);
  font-weight: 600;
}

.font-size-input {
  width: 44px;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: inherit;
  text-align: center;
  outline: none;
}

.font-size-input:focus-visible {
  border-color: var(--file-focus, #a1a1aa);
}

.inspector-divider {
  width: 1px;
  height: 14px;
  background: var(--file-line, #e4e4e7);
}

.selection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 240px;
  color: var(--file-muted, #71717a);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selection-status.is-active {
  color: var(--file-ink, #18181b);
  font-weight: 600;
}

.status-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 9999px;
  background: #cbd5e1;
}

.selection-status.is-active .status-dot {
  background: var(--file-ink, #18181b);
}

.design-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.mode-switch {
  display: flex;
  align-items: center;
  border: 1px solid var(--file-line, #e4e4e7);
  border-radius: 6px;
  padding: 1px;
  background: var(--file-tab, #f4f4f5);
}

.mode-switch button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 500;
  border: 0;
  background: transparent;
  color: var(--file-muted, #71717a);
  border-radius: 4px;
  cursor: pointer;
}

.mode-switch button.is-selected {
  background: var(--file-bg, #ffffff);
  color: var(--file-ink, #18181b);
  font-weight: 600;
}

.undo-redo-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.undo-redo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: var(--file-muted, #71717a);
  cursor: pointer;
}

.undo-redo-btn:hover:not(:disabled) {
  color: var(--file-ink, #18181b);
  border-color: var(--file-focus, #a1a1aa);
}

.undo-redo-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.insert-dropdown {
  position: relative;
}

.insert-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 112px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.insert-menu-item {
  text-align: left;
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.insert-menu-item:hover {
  background: var(--file-tab, #f4f4f5);
}

.btn-delete-element {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  color: #ef4444;
  cursor: pointer;
}

.btn-delete-element:hover {
  background: rgba(239, 68, 68, 0.18);
}

.device-switch {
  display: flex;
  border: 1px solid var(--file-line, #e4e4e7);
  border-radius: 6px;
  padding: 1px;
  background: var(--file-tab, #f4f4f5);
}

.device-switch button {
  padding: 2px 6px;
  font-size: 11px;
  border: 0;
  background: transparent;
  color: var(--file-muted, #71717a);
  border-radius: 4px;
  cursor: pointer;
}

.device-switch button.is-selected {
  background: var(--file-bg, #ffffff);
  color: var(--file-ink, #18181b);
  font-weight: 600;
}

.btn-primary-action {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  border: 0;
  background: var(--file-ink, #18181b);
  color: var(--file-ink-contrast, #ffffff);
  cursor: pointer;
}

.btn-primary-action:hover:not(:disabled) {
  background: var(--file-ink-hover, #27272a);
}

.btn-primary-action:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-secondary-action {
  font-size: 11px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #f4f4f5);
  color: inherit;
  cursor: pointer;
}

.btn-reset {
  font-size: 11px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: #ef4444;
  cursor: pointer;
}

.canvas-viewport {
  position: relative;
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  background-color: var(--file-tab, #f8fafc);
  background-image: radial-gradient(var(--file-line, #cbd5e1) 1px, transparent 1px);
  background-size: 18px 18px;
  user-select: none;
}

.canvas-viewport.is-dragging-over {
  background-color: var(--file-line, #e4e4e7);
}

.empty-workspace {
  width: 100%;
  max-width: 460px;
  margin: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.empty-upload-card {
  width: 100%;
  border-radius: 16px;
  border: 1.5px dashed var(--file-focus, #cbd5e1);
  background: var(--file-bg, #ffffff);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 26px 20px;
  cursor: pointer;
}

.upload-icon-circle {
  width: 48px;
  height: 48px;
  border-radius: 9999px;
  background: var(--file-tab, #f4f4f5);
  color: var(--file-muted, #71717a);
  display: flex;
  align-items: center;
  justify-content: center;
}

.upload-cta-btn {
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 8px;
  border: 0;
  background: var(--file-ink, #18181b);
  color: var(--file-ink-contrast, #ffffff);
  cursor: pointer;
}

.upload-cta-btn:hover {
  background: var(--file-ink-hover, #27272a);
}

.starter-templates-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.starter-templates-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--file-muted, #71717a);
}

.starter-templates-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.starter-template-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s;
}

.starter-template-card:hover {
  border-color: var(--file-focus, #a1a1aa);
}

.starter-template-name {
  font-size: 12px;
  font-weight: 600;
}

.starter-template-desc {
  font-size: 11px;
  color: var(--file-muted, #71717a);
}

.artboard-iframe-wrapper {
  position: relative;
  height: 100%;
  min-height: 540px;
  border-radius: 12px;
  background: #ffffff;
  border: 1px solid var(--file-line, #e2e8f0);
  box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  transition: width 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.artboard-iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #ffffff;
}

.code-editor-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--file-bg, #ffffff);
}

.code-editor-textarea {
  flex: 1;
  width: 100%;
  border: 0;
  padding: 12px 14px;
  resize: none;
  outline: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  background: transparent;
  color: inherit;
}

.code-editor-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--file-line, #e4e4e7);
}

.design-bottom-dock {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
}

.breadcrumb-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.breadcrumb-sep {
  color: var(--file-muted, #71717a);
}

.breadcrumb-node {
  border: 0;
  padding: 1px 5px;
  border-radius: 4px;
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
}

.breadcrumb-node:hover {
  background: var(--file-tab, #f4f4f5);
  color: var(--file-ink, #18181b);
}

.breadcrumb-node.is-current {
  background: var(--file-tab, #f4f4f5);
  color: var(--file-ink, #18181b);
  font-weight: 600;
}

.ai-prompt-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-target-badge {
  flex-shrink: 0;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 7px;
  border-radius: 6px;
  background: var(--file-tab, #f4f4f5);
  color: var(--file-ink, #18181b);
  border: 1px solid var(--file-line, #e4e4e7);
}

.ai-prompt-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #f4f4f5);
  color: inherit;
  outline: none;
}

.ai-prompt-input:focus-visible {
  border-color: var(--file-focus, #a1a1aa);
}

.ai-suggestion-row {
  display: flex;
  align-items: center;
  gap: 5px;
  overflow-x: auto;
}

.ai-suggestion-chip {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
}

.ai-suggestion-chip:hover {
  background: var(--file-tab, #f4f4f5);
  color: var(--file-ink, #18181b);
}

.paste-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.paste-modal-card {
  width: 100%;
  max-width: 440px;
  border-radius: 12px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.paste-modal-header {
  font-size: 13px;
  font-weight: 600;
}

.paste-modal-textarea {
  width: 100%;
  min-height: 180px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #f4f4f5);
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
  outline: none;
}

.paste-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
