<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import Moveable from 'moveable';
import Selecto from 'selecto';
import type {FilePreviewTab} from '../../types/filePreview';

const props = defineProps<{
  active?: boolean;
  tabs?: FilePreviewTab[];
  activeId?: string;
}>();

const canvasRef = ref<HTMLElement | null>(null);
const artboardRef = ref<HTMLElement | null>(null);
const artboardContentRef = ref<HTMLElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

let moveableInstance: Moveable | null = null;
let selectoInstance: Selecto | null = null;

// 加载的文件状态
const loadedFileName = ref<string>('');
const loadedHtml = ref<string>('');
const customStyleTag = ref<string>('');
const isDragOver = ref(false);

// 画板视口尺寸：390 (移动端), 768 (平板), 1024 (桌面), '100%' (流式自适应)
const viewportWidth = ref<string>('390');

// 选中与样式属性状态
const selectedInfo = ref<string>('未选中元素（点击或拖拽框选画布组件）');
const isSelected = ref(false);
const selectedElement = ref<HTMLElement | null>(null);
const isEditingText = ref(false);
const copySuccess = ref(false);

// 当前打开的文件列表中是否有可用文件
const currentTab = computed(() => {
  if (!props.tabs?.length) return null;
  return props.tabs.find(t => t.id === props.activeId) || props.tabs[0];
});

// 计算样式状态
const currentStyles = ref({
  color: '#000000',
  backgroundColor: '#ffffff',
  borderRadius: 0,
  fontSize: 14,
  fontWeight: '400',
});

// rgb/rgba 转 hex
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
  const computedStyle = window.getComputedStyle(el);
  currentStyles.value = {
    color: rgbToHex(computedStyle.color),
    backgroundColor: rgbToHex(computedStyle.backgroundColor),
    borderRadius: parseInt(computedStyle.borderRadius, 10) || 0,
    fontSize: parseInt(computedStyle.fontSize, 10) || 14,
    fontWeight: computedStyle.fontWeight || '400',
  };
};

/**
 * 样式调整函数（重点解决字号/颜色被内部 class 覆盖的问题）。
 */
const applyStyle = (key: 'color' | 'backgroundColor' | 'borderRadius' | 'fontSize' | 'fontWeight', val: string | number) => {
  if (!selectedElement.value) return;
  const el = selectedElement.value;

  if (key === 'fontSize') {
    const num = Number(val);
    currentStyles.value.fontSize = num;
    // 自身强制生效
    el.style.setProperty('font-size', `${num}px`, 'important');
    // 如果是包含文字的容器，内部所有直接文字子节点同步生效，解决 Tailwind text-* class 覆盖问题
    const textChildren = el.querySelectorAll<HTMLElement>('p, span, h1, h2, h3, h4, h5, h6, a, button, label, strong, b, em, i');
    textChildren.forEach(child => {
      child.style.setProperty('font-size', `${num}px`, 'important');
    });
  } else if (key === 'color') {
    currentStyles.value.color = String(val);
    el.style.setProperty('color', String(val), 'important');
    const textChildren = el.querySelectorAll<HTMLElement>('p, span, h1, h2, h3, h4, h5, h6, a, button, label, strong, b, em, i');
    textChildren.forEach(child => {
      child.style.setProperty('color', String(val), 'important');
    });
  } else if (key === 'borderRadius') {
    currentStyles.value.borderRadius = Number(val);
    el.style.setProperty('border-radius', `${val}px`, 'important');
  } else if (key === 'backgroundColor') {
    currentStyles.value.backgroundColor = String(val);
    el.style.setProperty('background-color', String(val), 'important');
  } else if (key === 'fontWeight') {
    currentStyles.value.fontWeight = String(val);
    el.style.setProperty('font-weight', String(val), 'important');
    const textChildren = el.querySelectorAll<HTMLElement>('p, span, h1, h2, h3, h4, h5, h6, a, button, label, strong, b, em, i');
    textChildren.forEach(child => {
      child.style.setProperty('font-weight', String(val), 'important');
    });
  }

  nextTick(() => {
    moveableInstance?.updateRect();
  });
};

/**
 * 解析用户文件内容（HTML / Vue SFC / SVG / 文本）。
 */
const parseAndLoad = (content: string, name: string) => {
  loadedFileName.value = name;
  let html = content;
  let styles = '';

  // 如果是 Vue 单文件组件，提取 <template> 和 <style>
  if (name.toLowerCase().endsWith('.vue')) {
    const templateMatch = content.match(/<template[\s\S]*?>([\s\S]*?)<\/template>/i);
    const styleMatch = content.match(/<style[\s\S]*?>([\s\S]*?)<\/style>/i);
    html = templateMatch ? templateMatch[1]!.trim() : content;
    styles = styleMatch ? styleMatch[1]!.trim() : '';
  }

  loadedHtml.value = html;
  customStyleTag.value = styles;

  // 清空选中并重新打标
  if (moveableInstance) {
    moveableInstance.target = [];
  }
  isSelected.value = false;
  selectedElement.value = null;
  selectedInfo.value = `已加载文件: ${name}（点击组件开始设计）`;

  nextTick(() => {
    makeElementsInteractive();
  });
};

/**
 * 遍历载入的真实 DOM 结构，智能赋予可设计标记与手势。
 */
const makeElementsInteractive = () => {
  const container = artboardContentRef.value;
  if (!container) return;

  // 为直接子元素以及常用交互/容器元素附加 design-target
  const candidates = container.querySelectorAll<HTMLElement>('*');
  candidates.forEach(el => {
    const tag = el.tagName.toLowerCase();
    // 忽略 script / style / svg 内部细节
    if (['script', 'style', 'path', 'g', 'circle', 'line', 'defs'].includes(tag)) return;
    // 拥有直接子节点或者是常用视觉组件
    if (el.parentElement === container || ['div', 'section', 'article', 'button', 'a', 'header', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'input', 'img'].includes(tag)) {
      el.classList.add('design-target');
      el.style.touchAction = 'none';
      if (!el.getAttribute('data-label')) {
        el.setAttribute('data-label', tag);
      }
    }
  });

  if (moveableInstance) {
    moveableInstance.updateRect();
  }
};

// 触发本地文件选择
const triggerFilePicker = () => {
  fileInputRef.value?.click();
};

const handleFileInputChange = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    const text = String(e.target?.result || '');
    parseAndLoad(text, file.name);
    input.value = '';
  };
  reader.readAsText(file);
};

// 拖拽文件进入
const handleDrop = (event: DragEvent) => {
  isDragOver.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    const text = String(e.target?.result || '');
    parseAndLoad(text, file.name);
  };
  reader.readAsText(file);
};

// 一键载入当前打开的文件
const loadCurrentTab = () => {
  if (!currentTab.value?.data?.content) return;
  parseAndLoad(currentTab.value.data.content, currentTab.value.name);
};

// 双击就地文字编辑
const handleDblClick = (e: MouseEvent) => {
  const target = (e.target as HTMLElement).closest('.design-target') as HTMLElement | null;
  if (!target) return;

  isEditingText.value = true;
  target.contentEditable = 'true';
  target.focus();

  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

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

// 重置画板
const resetArtboard = () => {
  if (!artboardContentRef.value) return;
  const targets = artboardContentRef.value.querySelectorAll<HTMLElement>('.design-target');
  targets.forEach(el => {
    el.style.transform = '';
    el.style.width = '';
    el.style.height = '';
    el.style.removeProperty('font-size');
    el.style.removeProperty('color');
    el.style.removeProperty('border-radius');
    el.style.removeProperty('background-color');
    el.style.removeProperty('font-weight');
  });
  if (moveableInstance) {
    moveableInstance.target = [];
    moveableInstance.updateRect();
  }
  isSelected.value = false;
  selectedElement.value = null;
  selectedInfo.value = '已重置所有样式与布局';
};

// 复制调整后的 HTML
const copyModifiedHtml = async () => {
  if (!artboardContentRef.value) return;
  const clone = artboardContentRef.value.cloneNode(true) as HTMLElement;
  // 移除运行时标记 class
  clone.querySelectorAll('.design-target').forEach(el => el.classList.remove('design-target'));
  try {
    await navigator.clipboard.writeText(clone.innerHTML.trim());
    copySuccess.value = true;
    setTimeout(() => {
      copySuccess.value = false;
    }, 2000);
  } catch {
    // 兜底
  }
};

const updateSelectionInfo = (target: HTMLElement | SVGElement | undefined) => {
  if (!target || !(target instanceof HTMLElement)) {
    isSelected.value = false;
    selectedElement.value = null;
    selectedInfo.value = '未选中元素（点击或拖拽框选画布组件）';
    return;
  }
  isSelected.value = true;
  syncElementStyles(target);
  const tag = target.tagName.toLowerCase();
  const label = target.getAttribute('data-label') || tag;
  const rect = target.getBoundingClientRect();
  selectedInfo.value = `选中: <${label}> · 宽 ${Math.round(rect.width)}px · 高 ${Math.round(rect.height)}px`;
};

// 监听当前 active tab 的变化，若初次且有打开文件，可友好提示或自动载入
watch(
  () => props.activeId,
  () => {
    if (!loadedHtml.value && currentTab.value?.data?.content) {
      loadCurrentTab();
    }
  },
  {immediate: true}
);

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
    snappable: true,
    snapThreshold: 5,
    isDisplaySnapDigit: true,
    snapGap: true,
    snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
    snapContainer: artboardEl,
    elementGuidelines: ['.design-target'],
  });

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

  if (loadedHtml.value) {
    makeElementsInteractive();
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
    <!-- 隐藏的文件选择器 -->
    <input
      ref="fileInputRef"
      type="file"
      accept=".html,.htm,.vue,.svg,.txt"
      class="hidden"
      @change="handleFileInputChange"
    />

    <!-- 顶栏：文件源管理与视口切换 -->
    <div class="design-header-bar">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="header-action-btn primary"
          @click="triggerFilePicker"
          title="从本地计算机选择任意 .html / .vue 文件"
        >
          📂 打开本地文件
        </button>

        <button
          v-if="currentTab?.data?.content"
          type="button"
          class="header-action-btn"
          @click="loadCurrentTab"
          :title="`载入正在预览的文件: ${currentTab.name}`"
        >
          载入当前标签 ({{ currentTab.name }})
        </button>

        <span v-if="loadedFileName" class="loaded-file-badge">
          已加载: <strong>{{ loadedFileName }}</strong>
        </span>
      </div>

      <div class="flex items-center gap-2">
        <!-- 视口宽度切换 -->
        <div class="viewport-selector">
          <button
            type="button"
            class="viewport-btn"
            :class="{ active: viewportWidth === '390' }"
            @click="viewportWidth = '390'"
          >
            📱 移动 (390)
          </button>
          <button
            type="button"
            class="viewport-btn"
            :class="{ active: viewportWidth === '768' }"
            @click="viewportWidth = '768'"
          >
            💻 平板 (768)
          </button>
          <button
            type="button"
            class="viewport-btn"
            :class="{ active: viewportWidth === '100%' }"
            @click="viewportWidth = '100%'"
          >
            🖥️ 自适应
          </button>
        </div>

        <button
          v-if="loadedHtml"
          type="button"
          class="header-action-btn"
          @click="copyModifiedHtml"
          title="复制当前已修改的 HTML 代码"
        >
          {{ copySuccess ? '✓ 已复制代码' : '📋 复制代码' }}
        </button>

        <button
          v-if="loadedHtml"
          type="button"
          class="header-action-btn danger"
          @click="resetArtboard"
          title="清除所有拖拽与样式改动"
        >
          重置布局
        </button>
      </div>
    </div>

    <!-- 选中状态提示条 -->
    <div class="design-status-bar">
      <div class="selection-status" :class="{ 'is-active': isSelected }">
        <span class="status-dot"></span>
        <span class="status-text">{{ selectedInfo }}</span>
      </div>
      <div class="flex items-center gap-2 text-xs text-slate-500">
        <span>💡 双击文字直接编辑</span>
        <span>•</span>
        <span>智能吸附对齐</span>
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
            <button type="button" class="preset-btn bg-white border border-slate-300" @click="applyStyle('backgroundColor', '#ffffff')" title="纯白"></button>
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
            <button type="button" class="preset-btn bg-rose-600" @click="applyStyle('color', '#e11d48')" title="红色字"></button>
          </div>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 圆角调节 -->
      <div class="inspector-group">
        <span class="inspector-label">圆角</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 0 }" @click="applyStyle('borderRadius', 0)">0</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 6 }" @click="applyStyle('borderRadius', 6)">6px</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius === 12 }" @click="applyStyle('borderRadius', 12)">12px</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.borderRadius >= 999 }" @click="applyStyle('borderRadius', 9999)">全圆</button>
        </div>
      </div>

      <div class="inspector-divider"></div>

      <!-- 字号与大小调节 -->
      <div class="inspector-group">
        <span class="inspector-label">字号</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 12 }" @click="applyStyle('fontSize', 12)">12</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 14 }" @click="applyStyle('fontSize', 14)">14</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 18 }" @click="applyStyle('fontSize', 18)">18</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 24 }" @click="applyStyle('fontSize', 24)">24</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize >= 32 }" @click="applyStyle('fontSize', 32)">32</button>
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

    <!-- 可视化设计画布主区域 -->
    <div
      ref="canvasRef"
      class="canvas-viewport"
      @dragover.prevent="isDragOver = true"
      @dragleave.prevent="isDragOver = false"
      @drop.prevent="handleDrop"
      @dblclick="handleDblClick"
    >
      <!-- 空状态：引导用户选择文件 -->
      <div
        v-if="!loadedHtml"
        class="empty-drop-zone"
        :class="{ 'is-hover': isDragOver }"
        @click="triggerFilePicker"
      >
        <div class="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 flex items-center justify-center text-2xl mb-3 shadow-sm">
          📂
        </div>
        <h3 class="text-base font-bold text-slate-800 dark:text-slate-100">请选择要进行可视化设计的文件</h3>
        <p class="text-xs text-slate-500 max-w-sm text-center mt-1.5 leading-relaxed">
          点击或将本地文件拖拽到此处，支持 <strong>.html</strong>、<strong>.vue</strong> 模板或 <strong>.svg</strong>。
        </p>

        <div class="flex items-center gap-3 mt-4">
          <button type="button" class="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 shadow-md transition-all">
            选择本地文件
          </button>
          <button
            v-if="currentTab?.data?.content"
            type="button"
            class="px-4 py-2 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 text-xs font-semibold hover:bg-indigo-50 transition-all"
            @click.stop="loadCurrentTab"
          >
            载入当前打开的 {{ currentTab.name }}
          </button>
        </div>
      </div>

      <!-- 居中画板（Artboard）：渲染真实加载的文件内容 -->
      <div
        v-else
        ref="artboardRef"
        class="artboard-card"
        :style="{
          width: viewportWidth === '100%' ? '100%' : `${viewportWidth}px`,
          maxWidth: viewportWidth === '100%' ? '100%' : `${viewportWidth}px`,
        }"
      >
        <!-- 注入自定义样式（来自 .vue 的 <style>） -->
        <component :is="'style'" v-if="customStyleTag">
          {{ customStyleTag }}
        </component>

        <!-- 真实内容挂载点 -->
        <div
          ref="artboardContentRef"
          class="artboard-content"
          v-html="loadedHtml"
        ></div>
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

/* 顶部操作条 */
.design-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  flex-shrink: 0;
}

.is-dark .design-header-bar {
  background: #0c0e13;
  border-color: #252933;
}

.header-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  background: #f4f4f5;
  color: #3f3f46;
  border: 1px solid #e4e4e7;
  cursor: pointer;
  transition: all 0.15s ease;
}

.is-dark .header-action-btn {
  background: #1b1f29;
  color: #d4d4d8;
  border-color: #2c3144;
}

.header-action-btn.primary {
  background: #6366f1;
  color: #ffffff;
  border-color: #6366f1;
}

.header-action-btn.primary:hover {
  background: #4f46e5;
}

.header-action-btn.danger {
  color: #ef4444;
}

.header-action-btn:hover {
  background: #e4e4e7;
}

.is-dark .header-action-btn:hover {
  background: #282e3f;
}

.loaded-file-badge {
  font-size: 11px;
  color: #64748b;
  padding: 3px 8px;
  border-radius: 6px;
  background: #f1f5f9;
}

.is-dark .loaded-file-badge {
  background: #181d28;
  color: #94a3b8;
}

/* 视口切换器 */
.viewport-selector {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
}

.is-dark .viewport-selector {
  background: #181d28;
  border-color: #262c3c;
}

.viewport-btn {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  border: 0;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}

.is-dark .viewport-btn {
  color: #94a3b8;
}

.viewport-btn.active {
  background: #ffffff;
  color: #4f46e5;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.is-dark .viewport-btn.active {
  background: #25283b;
  color: #818cf8;
}

/* 状态条 */
.design-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 14px;
  font-size: 11px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  background: #fafafa;
}

.is-dark .design-status-bar {
  background: #11141c;
  border-color: #252933;
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

/* 属性面板（Inspector Bar） */
.design-inspector-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  font-size: 12px;
  border-bottom: 1px solid #6366f130;
  background: #f5f3ff;
  overflow-x: auto;
  animation: slideDown 0.15s ease-out;
}

.is-dark .design-inspector-bar {
  background: #181926;
  border-color: #6366f140;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-4px); }
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

/* 画布主视口 */
.canvas-viewport {
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 28px 20px;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  background-color: #f8fafc;
  background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
  background-size: 18px 18px;
  user-select: none;
}

.is-dark .canvas-viewport {
  background-color: #0b0d13;
  background-image: radial-gradient(#1f2430 1px, transparent 1px);
}

/* 空状态拖拽上传区 */
.empty-drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin-top: 40px;
  padding: 48px 32px;
  border: 2px dashed #cbd5e1;
  border-radius: 20px;
  background: #ffffff;
  cursor: pointer;
  transition: all 0.2s ease;
}

.empty-drop-zone:hover, .empty-drop-zone.is-hover {
  border-color: #6366f1;
  background: #f5f3ff20;
  transform: translateY(-2px);
}

.is-dark .empty-drop-zone {
  background: #131620;
  border-color: #2a3142;
}

/* 居中画板（Artboard） */
.artboard-card {
  position: relative;
  min-height: 480px;
  border-radius: 16px;
  padding: 16px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 12px 36px -8px rgba(0, 0, 0, 0.08), 0 4px 12px -2px rgba(0, 0, 0, 0.04);
  transition: width 0.2s ease, max-width 0.2s ease;
}

.is-dark .artboard-card {
  background: #13161f;
  border-color: #262b38;
  box-shadow: 0 14px 40px -10px rgba(0, 0, 0, 0.6);
}

.artboard-content {
  width: 100%;
  height: 100%;
}

/* 深度选择器：让载入的真实 DOM 元素获得交互感 */
:deep(.design-target) {
  cursor: pointer;
  touch-action: none;
  transition: background-color 0.15s, border-radius 0.15s;
}

:deep(.design-target:hover) {
  outline: 1px dashed #6366f180;
  outline-offset: 2px;
}

:deep(.design-target[contenteditable="true"]) {
  outline: 2px solid #6366f1 !important;
  outline-offset: 2px;
  cursor: text;
  user-select: text;
}
</style>
