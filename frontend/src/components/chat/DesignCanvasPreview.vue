<script setup lang="ts">
import {nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import Moveable from 'moveable';
import Selecto from 'selecto';

const props = defineProps<{
  active?: boolean;
  initialContent?: string;
  initialFileName?: string;
}>();

const canvasRef = ref<HTMLElement | null>(null);
const artboardRef = ref<HTMLElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

let moveableInstance: Moveable | null = null;
let selectoInstance: Selecto | null = null;

const selectedInfo = ref<string>('未选中元素（点击或拖拽框选画布组件）');
const isSelected = ref(false);
const selectedElement = ref<HTMLElement | null>(null);
const isEditingText = ref(false);

const loadedFileName = ref<string>('');
const isFileLoaded = ref(false);
const isDraggingOver = ref(false);

// 提取当前元素的实际计算样式
const currentStyles = ref({
  color: '#000000',
  backgroundColor: '#ffffff',
  borderRadius: 0,
  fontSize: 14,
  fontWeight: '400',
  textAlign: 'left',
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
  const computed = window.getComputedStyle(el);
  currentStyles.value = {
    color: rgbToHex(computed.color),
    backgroundColor: rgbToHex(computed.backgroundColor),
    borderRadius: parseInt(computed.borderRadius, 10) || 0,
    fontSize: parseInt(computed.fontSize, 10) || 14,
    fontWeight: computed.fontWeight || '400',
    textAlign: computed.textAlign || 'left',
  };
};

const applyStyle = (key: 'color' | 'backgroundColor' | 'borderRadius' | 'fontSize' | 'fontWeight' | 'textAlign', val: string | number) => {
  if (!selectedElement.value) return;
  const el = selectedElement.value;

  if (key === 'borderRadius') {
    el.style.setProperty('border-radius', `${val}px`, 'important');
    currentStyles.value.borderRadius = Number(val);
  } else if (key === 'fontSize') {
    // 强制优先级覆盖 Tailwind 及原有 CSS
    el.style.setProperty('font-size', `${val}px`, 'important');
    // 如果选中的是容器，也将其直接子文本元素同步设置
    el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,span,a,button,label,li').forEach(child => {
      child.style.setProperty('font-size', `${val}px`, 'important');
    });
    currentStyles.value.fontSize = Number(val);
  } else if (key === 'fontWeight') {
    el.style.setProperty('font-weight', String(val), 'important');
    currentStyles.value.fontWeight = String(val);
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

  // 变更后立即更新 Moveable 边界框
  nextTick(() => {
    moveableInstance?.updateRect();
  });
};

const triggerFileInput = () => {
  fileInputRef.value?.click();
};

const parseAndMountHtml = (content: string, name: string) => {
  loadedFileName.value = name;
  isFileLoaded.value = true;
  selectedElement.value = null;
  isSelected.value = false;
  selectedInfo.value = '已加载 HTML，点击任意组件进行设计';

  if (!artboardRef.value) return;

  // 清空现有 Moveable 选中
  if (moveableInstance) {
    moveableInstance.target = [];
    moveableInstance.updateRect();
  }

  // 提取 html body 或直接作为内容
  let htmlToInject = content;
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'text/html');
  if (doc.body && doc.body.children.length > 0) {
    htmlToInject = doc.body.innerHTML;
  }

  // 提取原有的 style 标签以便保留自定义样式
  const styles = Array.from(doc.querySelectorAll('style')).map(s => s.outerHTML).join('\n');

  artboardRef.value.innerHTML = styles + htmlToInject;

  // 标记所有可见设计元素为可设计目标
  tagDesignElements(artboardRef.value);

  // 重新配置 Moveable 吸附参考线
  nextTick(() => {
    if (moveableInstance) {
      moveableInstance.elementGuidelines = Array.from(artboardRef.value?.querySelectorAll('.design-target') || []);
      moveableInstance.updateRect();
    }
  });
};

const tagDesignElements = (root: HTMLElement) => {
  const elements = root.querySelectorAll<HTMLElement>('*');
  elements.forEach(el => {
    const tag = el.tagName.toLowerCase();
    // 忽略 script、style、svg 内部微元
    if (['script', 'style', 'path', 'g', 'circle', 'svg'].includes(tag)) return;
    el.classList.add('design-target');
  });
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
  loadedFileName.value = '';
  selectedElement.value = null;
  isSelected.value = false;
  selectedInfo.value = '未加载 HTML 文件';
  if (artboardRef.value) {
    artboardRef.value.innerHTML = '';
  }
  if (moveableInstance) {
    moveableInstance.target = [];
    moveableInstance.updateRect();
  }
};

const updateSelectionInfo = (target: HTMLElement | SVGElement | undefined) => {
  if (!target || !(target instanceof HTMLElement)) {
    isSelected.value = false;
    selectedElement.value = null;
    selectedInfo.value = isFileLoaded.value ? '已加载 HTML，点击组件可拖拽、缩放、改样式' : '请先选择 HTML 文件';
    return;
  }
  isSelected.value = true;
  syncElementStyles(target);
  const tag = target.tagName.toLowerCase();
  const label = target.getAttribute('data-label') || target.className?.toString().split(' ')[0] || tag;
  const rect = target.getBoundingClientRect();
  selectedInfo.value = `选中: <${label}> · 宽 ${Math.round(rect.width)}px · 高 ${Math.round(rect.height)}px`;
};

// 双击就地文字编辑（Inline Text Editing）
const handleDblClick = (e: MouseEvent) => {
  const target = (e.target as HTMLElement).closest('.design-target') as HTMLElement | null;
  if (!target) return;

  isEditingText.value = true;
  target.contentEditable = 'true';
  target.focus();

  // 选中文本内容
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  // 编辑期间临时让 Moveable 移出，避免手柄遮挡输入
  if (moveableInstance) {
    moveableInstance.target = [];
  }

  const finishEdit = () => {
    target.contentEditable = 'false';
    isEditingText.value = false;
    target.removeEventListener('blur', finishEdit);
    target.removeEventListener('keydown', onKey);

    // 恢复 Moveable 选中与外框同步
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

// 导出修改后的 HTML
const exportHtml = () => {
  if (!artboardRef.value) return;
  const cloned = artboardRef.value.cloneNode(true) as HTMLElement;
  cloned.querySelectorAll('.design-target').forEach(el => {
    el.classList.remove('design-target');
    if (!el.getAttribute('class')) el.removeAttribute('class');
    if (el.getAttribute('contenteditable')) el.removeAttribute('contenteditable');
  });

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-slate-50 text-slate-900 p-6 flex justify-center">
  ${cloned.innerHTML}
</body>
</html>`;

  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = loadedFileName.value ? `modified-${loadedFileName.value}` : 'modified-page.html';
  a.click();
  URL.revokeObjectURL(url);
};

onMounted(async () => {
  await nextTick();
  const canvasEl = canvasRef.value;
  const artboardEl = artboardRef.value;
  if (!canvasEl || !artboardEl) return;

  // 1. 初始化 Moveable 变形与吸附引擎
  moveableInstance = new Moveable(canvasEl, {
    target: [],
    container: canvasEl,
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
    // 智能吸附与对齐参考线配置（Figma / Stitch 核心体验）
    snappable: true,
    snapThreshold: 5,
    isDisplaySnapDigit: true,
    snapGap: true,
    snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    snapContainer: artboardEl,
    elementGuidelines: ['.design-target'],
  });

  // 单元素拖拽
  moveableInstance.on('drag', ({ target, transform }) => {
    target.style.transform = transform;
    updateSelectionInfo(target);
  });

  // 单元素缩放拉伸
  moveableInstance.on('resize', ({ target, width, height, drag }) => {
    target.style.width = `${width}px`;
    target.style.height = `${height}px`;
    target.style.transform = drag.transform;
    updateSelectionInfo(target);
  });

  // 单元素旋转
  moveableInstance.on('rotate', ({ target, transform }) => {
    target.style.transform = transform;
    updateSelectionInfo(target);
  });

  // 多选批量拖拽支持
  moveableInstance.on('dragGroup', ({ events }) => {
    events.forEach(ev => {
      ev.target.style.transform = ev.transform;
    });
  });

  // 2. 初始化 Selecto 框选引擎
  selectoInstance = new Selecto({
    container: canvasEl,
    dragContainer: canvasEl,
    selectableTargets: ['.design-target'],
    hitRate: 0,
    selectByClick: true,
    selectFromInside: false,
    toggleContinueSelect: ['shift'],
    preventClickEventOnDrag: true,
  });

  selectoInstance.on('dragStart', e => {
    if (isEditingText.value) {
      e.stop();
      return;
    }
    const inputEvent = e.inputEvent;
    const target = inputEvent.target as HTMLElement;
    // 如果点击的是 moveable 自身的控制手柄或正在输入的元素，不触发框选
    if (moveableInstance?.isMoveableElement(target) || target.closest('.moveable-control-box') || target.isContentEditable) {
      e.stop();
    }
  });

  selectoInstance.on('select', e => {
    if (moveableInstance) {
      moveableInstance.target = e.selected;
      if (e.selected.length === 1) {
        updateSelectionInfo(e.selected[0] as HTMLElement);
      } else if (e.selected.length > 1) {
        isSelected.value = true;
        selectedElement.value = null;
        selectedInfo.value = `已框选 ${e.selected.length} 个设计组件（支持批量拖拽）`;
      } else {
        updateSelectionInfo(undefined);
      }
    }
  });

  selectoInstance.on('selectEnd', e => {
    if (e.isDragStartEnd) {
      e.inputEvent.stopPropagation();
    }
    if (moveableInstance) {
      moveableInstance.updateRect();
    }
  });

  if (props.initialContent) {
    parseAndMountHtml(props.initialContent, props.initialFileName || 'preview.html');
  }
});

watch(() => props.initialContent, newContent => {
  if (newContent && !isFileLoaded.value) {
    parseAndMountHtml(newContent, props.initialFileName || 'preview.html');
  }
});

onBeforeUnmount(() => {
  moveableInstance?.destroy();
  selectoInstance?.destroy();
  moveableInstance = null;
  selectoInstance = null;
});
</script>

<template>
  <div class="design-canvas-container">
    <!-- 隐藏的原生文件输入框 -->
    <input
      ref="fileInputRef"
      type="file"
      accept=".html,.htm"
      class="hidden"
      style="display: none;"
      @change="handleFileChange"
    />

    <!-- 顶部状态栏与文件操作 -->
    <div class="design-top-bar">
      <div class="selection-status" :class="{ 'is-active': isSelected }">
        <span class="status-dot"></span>
        <span class="status-text">{{ selectedInfo }}</span>
      </div>
      <div class="design-actions">
        <!-- 文件选择与管理 -->
        <button
          type="button"
          class="btn-primary-action"
          @click="triggerFileInput"
          title="选择本地 HTML 文件并渲染到画布"
        >
          <svg class="w-3.5 h-3.5 inline mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          {{ isFileLoaded ? '更换 HTML 文件' : '选择 HTML 文件' }}
        </button>

        <button
          v-if="isFileLoaded"
          type="button"
          class="btn-secondary-action"
          @click="exportHtml"
          title="导出调整后的 HTML 代码文件"
        >
          导出 HTML
        </button>

        <button
          v-if="isFileLoaded"
          type="button"
          class="btn-reset"
          title="清除当前画布"
          @click="clearLoadedHtml"
        >
          清空
        </button>
      </div>
    </div>

    <!-- 选中元素的实时样式属性面板（Style Inspector） -->
    <div v-if="selectedElement" class="design-inspector-bar">
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
            <button type="button" class="preset-btn bg-white" @click="applyStyle('backgroundColor', '#ffffff')" title="纯白"></button>
            <button type="button" class="preset-btn bg-slate-900" @click="applyStyle('backgroundColor', '#0f172a')" title="暗黑"></button>
            <button type="button" class="preset-btn bg-indigo-600" @click="applyStyle('backgroundColor', '#4f46e5')" title="靛蓝"></button>
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
            <button type="button" class="preset-btn bg-indigo-600" @click="applyStyle('color', '#4f46e5')" title="蓝色字"></button>
          </div>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 圆角调节 -->
      <div class="inspector-group">
        <span class="inspector-label">圆角</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 0 }" @click="applyStyle('borderRadius', 0)">0</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 8 }" @click="applyStyle('borderRadius', 8)">8px</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 16 }" @click="applyStyle('borderRadius', 16)">16px</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius >= 999 }" @click="applyStyle('borderRadius', 9999)">全圆</button>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 字体与大小调节（支持强制覆盖 + 步进器） -->
      <div class="inspector-group">
        <span class="inspector-label">字号</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" title="减小字号 2px" @click="applyStyle('fontSize', Math.max(10, currentStyles.fontSize - 2))">A-</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize <= 12 }" @click="applyStyle('fontSize', 12)">12</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 14 }" @click="applyStyle('fontSize', 14)">14</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 18 }" @click="applyStyle('fontSize', 18)">18</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 24 }" @click="applyStyle('fontSize', 24)">24</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize >= 32 }" @click="applyStyle('fontSize', 32)">32</button>
          <button type="button" class="option-pill" title="增大字号 2px" @click="applyStyle('fontSize', currentStyles.fontSize + 2)">A+</button>
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
      </div>
    </div>

    <!-- 可视化设计画布主区域（带现代点阵背景） -->
    <div
      ref="canvasRef"
      class="canvas-viewport"
      :class="{ 'is-dragging-over': isDraggingOver }"
      @dblclick="handleDblClick"
      @dragover.prevent="isDraggingOver = true"
      @dragleave.prevent="isDraggingOver = false"
      @drop.prevent="handleDrop"
    >
      <!-- 空状态：文件选择与拖拽引导卡片 -->
      <div v-show="!isFileLoaded" class="empty-upload-card" @click="triggerFileInput">
        <div class="upload-icon-circle">
          <svg class="w-8 h-8 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h3 class="text-base font-bold text-slate-800 dark:text-slate-100 mt-3">选择本地 HTML 文件并渲染</h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 text-center max-w-xs leading-relaxed">
          点击此处选择本地 HTML 文件，或直接将 <span class="font-semibold text-indigo-600 dark:text-indigo-400">.html</span> 拖入画布中
        </p>
        <button type="button" class="upload-cta-btn mt-4">
          选择 HTML 文件
        </button>
        <span class="text-[11px] text-slate-400 mt-2">支持包含 Tailwind 类名或自定义样式的网页</span>
      </div>

      <!-- 渲染 HTML 的画板容器（Artboard / Screen） -->
      <div
        v-show="isFileLoaded"
        ref="artboardRef"
        class="artboard-card"
      >
        <!-- 用户选择的 HTML 动态挂载到这里 -->
      </div>
    </div>
  </div>
</template>

<style scoped>
.design-canvas-container {
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
  gap: 12px;
  padding: 8px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
}

.is-dark .design-top-bar {
  background: #0c0e13;
  border-color: #252933;
}

/* 顶部悬浮属性检查面板（Inspector Bar） */
.design-inspector-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  font-size: 12px;
  border-bottom: 1px solid #6366f130;
  background: #f5f3ff;
  overflow-x: auto;
  animation: slideDown 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.is-dark .design-inspector-bar {
  background: #181926;
  border-color: #6366f140;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}

.inspector-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.inspector-label {
  font-size: 11px;
  font-weight: 600;
  color: #6366f1;
}

.is-dark .inspector-label {
  color: #818cf8;
}

.color-picker {
  width: 22px;
  height: 22px;
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
  width: 16px;
  height: 16px;
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
  padding: 2px 7px;
  border-radius: 6px;
  background: #e0e7ff;
  color: #3730a3;
  border: 0;
  cursor: pointer;
  transition: all 0.1s;
}

.is-dark .option-pill {
  background: #25283b;
  color: #c7d2fe;
}

.option-pill:hover {
  background: #c7d2fe;
}

.option-pill.is-selected {
  background: #6366f1;
  color: #ffffff;
  font-weight: 600;
}

.inspector-divider {
  width: 1px;
  height: 16px;
  background: #e0e7ff;
}

.is-dark .inspector-divider {
  background: #2c3144;
}

.selection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--file-muted, #71717a);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.selection-status.is-active {
  color: #6366f1;
  font-weight: 600;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: #cbd5e1;
}

.selection-status.is-active .status-dot {
  background: #6366f1;
  box-shadow: 0 0 6px #6366f1a0;
}

.design-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-primary-action {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  background: #6366f1;
  color: #ffffff;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-primary-action:hover {
  background: #4f46e5;
}

.btn-secondary-action {
  font-size: 11px;
  font-weight: 500;
  padding: 4px 9px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #334155;
  cursor: pointer;
}

.is-dark .btn-secondary-action {
  background: #1e222d;
  color: #cbd5e1;
}

.btn-reset {
  font-size: 11px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 6px;
  background: transparent;
  color: #ef4444;
  cursor: pointer;
}

.btn-reset:hover {
  background: #ef444415;
}

/* 画布背景：类似 Figma / Stitch 的点阵网格 */
.canvas-viewport {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 32px 20px;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  background-color: #f8fafc;
  background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
  background-size: 18px 18px;
  user-select: none;
  transition: background-color 0.2s;
}

.is-dark .canvas-viewport {
  background-color: #0b0d13;
  background-image: radial-gradient(#1f2430 1px, transparent 1px);
}

.canvas-viewport.is-dragging-over {
  background-color: #e0e7ff;
}

/* 空状态卡片 */
.empty-upload-card {
  width: 380px;
  min-height: 280px;
  border-radius: 20px;
  border: 2px dashed #cbd5e1;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  cursor: pointer;
  transition: all 0.2s;
}

.is-dark .empty-upload-card {
  background: #13161f;
  border-color: #2e3547;
}

.empty-upload-card:hover {
  border-color: #6366f1;
  box-shadow: 0 12px 30px -10px rgba(99, 102, 241, 0.15);
  transform: translateY(-2px);
}

.upload-icon-circle {
  width: 56px;
  height: 56px;
  border-radius: 9999px;
  background: #e0e7ff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.is-dark .upload-icon-circle {
  background: #1e2438;
}

.upload-cta-btn {
  font-size: 12px;
  font-weight: 600;
  padding: 7px 18px;
  border-radius: 8px;
  background: #6366f1;
  color: #ffffff;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
}

/* 居中画板卡片（Artboard / Screen） */
.artboard-card {
  position: relative;
  min-width: 360px;
  max-width: 900px;
  min-height: 480px;
  border-radius: 16px;
  padding: 24px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 12px 36px -8px rgba(0, 0, 0, 0.08), 0 4px 12px -2px rgba(0, 0, 0, 0.04);
}

.is-dark .artboard-card {
  background: #13161f;
  border-color: #262b38;
  box-shadow: 0 14px 40px -10px rgba(0, 0, 0, 0.6);
}

/* 赋予可设计目标元素优雅的鼠标手势与悬浮微动 */
:deep(.design-target) {
  cursor: pointer;
  touch-action: none;
  transition: background-color 0.15s, border-radius 0.15s, color 0.15s, font-size 0.1s;
}

:deep(.design-target:hover) {
  outline: 1px dashed #6366f180 !important;
  outline-offset: 2px;
}

:deep(.design-target[contenteditable="true"]) {
  outline: 2px solid #6366f1 !important;
  outline-offset: 2px;
  cursor: text;
  user-select: text;
}
</style>
