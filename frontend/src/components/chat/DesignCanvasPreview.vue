<script setup lang="ts">
import {nextTick, onBeforeUnmount, onMounted, ref} from 'vue';
import Moveable from 'moveable';
import Selecto from 'selecto';

defineProps<{
  active?: boolean;
}>();

const canvasRef = ref<HTMLElement | null>(null);
const artboardRef = ref<HTMLElement | null>(null);

let moveableInstance: Moveable | null = null;
let selectoInstance: Selecto | null = null;

const selectedInfo = ref<string>('未选中元素（点击或拖拽框选画布组件）');
const isSelected = ref(false);
const selectedElement = ref<HTMLElement | null>(null);
const isEditingText = ref(false);

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
    el.style.borderRadius = `${val}px`;
    currentStyles.value.borderRadius = Number(val);
  } else if (key === 'fontSize') {
    el.style.fontSize = `${val}px`;
    currentStyles.value.fontSize = Number(val);
  } else if (key === 'fontWeight') {
    el.style.fontWeight = String(val);
    currentStyles.value.fontWeight = String(val);
  } else if (key === 'backgroundColor') {
    el.style.backgroundColor = String(val);
    currentStyles.value.backgroundColor = String(val);
  } else if (key === 'color') {
    el.style.color = String(val);
    currentStyles.value.color = String(val);
  }
  // 变更后立即更新 Moveable 边界框
  nextTick(() => {
    moveableInstance?.updateRect();
  });
};

const resetArtboard = () => {
  if (!artboardRef.value) return;
  const targets = artboardRef.value.querySelectorAll<HTMLElement>('.design-target');
  targets.forEach(el => {
    el.style.transform = '';
    el.style.width = '';
    el.style.height = '';
    el.style.borderRadius = '';
    el.style.fontSize = '';
    el.style.fontWeight = '';
    el.style.backgroundColor = '';
    el.style.color = '';
  });
  if (moveableInstance) {
    moveableInstance.target = [];
    moveableInstance.updateRect();
  }
  isSelected.value = false;
  selectedElement.value = null;
  selectedInfo.value = '未选中元素（点击或拖拽框选画布组件）';
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
    <!-- 顶部状态栏 -->
    <div class="design-top-bar">
      <div class="selection-status" :class="{ 'is-active': isSelected }">
        <span class="status-dot"></span>
        <span class="status-text">{{ selectedInfo }}</span>
      </div>
      <div class="design-actions">
        <span class="feature-tag">双击文字直接编辑</span>
        <span class="feature-tag">智能吸附线</span>
        <button type="button" class="btn-reset" title="重置位置、尺寸与样式" @click="resetArtboard">
          重置布局
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

      <!-- 字体与大小调节 -->
      <div class="inspector-group">
        <span class="inspector-label">字号</span>
        <div class="flex items-center gap-1">
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize <= 12 }" @click="applyStyle('fontSize', 12)">12</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 14 }" @click="applyStyle('fontSize', 14)">14</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize === 18 }" @click="applyStyle('fontSize', 18)">18</button>
          <button type="button" class="option-pill" :class="{ 'is-selected': currentStyles.fontSize >= 24 }" @click="applyStyle('fontSize', 24)">24</button>
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
    <div ref="canvasRef" class="canvas-viewport" @dblclick="handleDblClick">
      <!-- 居中画板（Artboard / Screen） -->
      <div ref="artboardRef" class="artboard-card">
        <!-- 头部应用栏 -->
        <header class="artboard-header design-target" data-label="导航栏">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">LX</div>
            <span class="font-bold text-sm tracking-tight text-slate-800 dark:text-slate-100">Stitch Design Preview</span>
          </div>
          <span class="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 font-medium">Live</span>
        </header>

        <!-- 主视觉统计卡片 -->
        <div class="hero-card design-target" data-label="主视窗卡片">
          <div class="flex justify-between items-start mb-3">
            <div>
              <p class="text-xs font-medium text-indigo-100/90">AI 原生设计原型</p>
              <h3 class="text-xl font-extrabold text-white mt-0.5 tracking-tight">智能界面编排</h3>
            </div>
            <span class="p-1.5 rounded-lg bg-white/15 backdrop-blur-md text-white text-xs">✨ Vibe</span>
          </div>
          <p class="text-xs text-indigo-100/80 leading-relaxed mb-4">
            双击任意文字直接打字修改；点击元素在顶部面板实时修改背景、圆角、字号！
          </p>
          <div class="flex items-center gap-3">
            <button type="button" class="action-btn-primary design-target" data-label="主按钮">
              立即应用
            </button>
            <button type="button" class="action-btn-secondary design-target" data-label="次级按钮">
              查看源码
            </button>
          </div>
        </div>

        <!-- 搜索与筛选交互条 -->
        <div class="search-bar design-target" data-label="搜索框">
          <svg class="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <span class="text-xs text-slate-400 select-none">双击修改搜索框提示语 (Prompt)...</span>
        </div>

        <!-- 列表项目与指标 -->
        <div class="grid grid-cols-2 gap-2.5">
          <div class="metric-card design-target" data-label="指标卡片 1">
            <span class="text-[11px] text-slate-500 dark:text-slate-400 font-medium">渲染响应延迟</span>
            <div class="text-lg font-bold text-slate-800 dark:text-slate-100 mt-1">12 ms</div>
            <span class="text-[10px] text-emerald-600 font-semibold mt-1">↑ 原生 DOM 级变换</span>
          </div>
          <div class="metric-card design-target" data-label="指标卡片 2">
            <span class="text-[11px] text-slate-500 dark:text-slate-400 font-medium">吸附对齐精度</span>
            <div class="text-lg font-bold text-slate-800 dark:text-slate-100 mt-1">0.5 px</div>
            <span class="text-[10px] text-indigo-600 font-semibold mt-1">✨ 磁吸辅助参考线</span>
          </div>
        </div>

        <!-- 底部快速操作标签 -->
        <div class="flex items-center gap-2 pt-1">
          <span class="pill-tag design-target" data-label="标签 1">#移动端原型</span>
          <span class="pill-tag design-target" data-label="标签 2">#Tailwind</span>
          <span class="pill-tag design-target" data-label="标签 3">#可视化微调</span>
        </div>
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

.feature-tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 9999px;
  background: #f1f5f9;
  color: #64748b;
}

.is-dark .feature-tag {
  background: #1e222d;
  color: #94a3b8;
}

.btn-reset {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 6px;
  background: #6366f115;
  color: #6366f1;
  border: 1px solid #6366f130;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-reset:hover {
  background: #6366f1;
  color: #ffffff;
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
}

.is-dark .canvas-viewport {
  background-color: #0b0d13;
  background-image: radial-gradient(#1f2430 1px, transparent 1px);
}

/* 居中画板卡片（Artboard / Screen） */
.artboard-card {
  position: relative;
  width: 360px;
  min-height: 520px;
  border-radius: 20px;
  padding: 18px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 12px 36px -8px rgba(0, 0, 0, 0.08), 0 4px 12px -2px rgba(0, 0, 0, 0.04);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.is-dark .artboard-card {
  background: #13161f;
  border-color: #262b38;
  box-shadow: 0 14px 40px -10px rgba(0, 0, 0, 0.6);
}

/* 画板内部元素样式（均标注 .design-target） */
.artboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid #f1f5f9;
}

.is-dark .artboard-header {
  border-color: #1e2433;
}

.hero-card {
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
  border-radius: 14px;
  padding: 16px;
  color: #ffffff;
  box-shadow: 0 8px 20px -4px rgba(79, 70, 229, 0.35);
}

.action-btn-primary {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 8px;
  background: #ffffff;
  color: #4f46e5;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  cursor: pointer;
}

.action-btn-secondary {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
  cursor: pointer;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
}

.is-dark .search-bar {
  background: #181d28;
  border-color: #283042;
}

.metric-card {
  padding: 12px;
  border-radius: 12px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
}

.is-dark .metric-card {
  background: #181d28;
  border-color: #283042;
}

.pill-tag {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #475569;
  cursor: pointer;
}

.is-dark .pill-tag {
  background: #1e2433;
  color: #94a3b8;
}

/* 赋予可设计目标元素优雅的鼠标手势与悬浮微动 */
.design-target {
  cursor: pointer;
  touch-action: none;
  transition: background-color 0.15s, border-radius 0.15s, color 0.15s;
}

.design-target:hover {
  outline: 1px dashed #6366f180;
  outline-offset: 2px;
}

.design-target[contenteditable="true"] {
  outline: 2px solid #6366f1 !important;
  outline-offset: 2px;
  cursor: text;
  user-select: text;
}
</style>
