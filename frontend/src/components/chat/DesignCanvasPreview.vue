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

const resetArtboard = () => {
  if (!artboardRef.value) return;
  const targets = artboardRef.value.querySelectorAll<HTMLElement>('.design-target');
  targets.forEach(el => {
    el.style.transform = '';
    el.style.width = '';
    el.style.height = '';
  });
  if (moveableInstance) {
    moveableInstance.target = [];
    moveableInstance.updateRect();
  }
  isSelected.value = false;
  selectedInfo.value = '未选中元素（点击或拖拽框选画布组件）';
};

const updateSelectionInfo = (target: HTMLElement | SVGElement | undefined) => {
  if (!target || !(target instanceof HTMLElement)) {
    isSelected.value = false;
    selectedInfo.value = '未选中元素（点击或拖拽框选画布组件）';
    return;
  }
  isSelected.value = true;
  const tag = target.tagName.toLowerCase();
  const label = target.getAttribute('data-label') || tag;
  const rect = target.getBoundingClientRect();
  selectedInfo.value = `选中: <${label}> · 宽 ${Math.round(rect.width)}px · 高 ${Math.round(rect.height)}px`;
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
    const inputEvent = e.inputEvent;
    const target = inputEvent.target as HTMLElement;
    // 如果点击的是 moveable 自身的控制手柄，不触发框选
    if (moveableInstance?.isMoveableElement(target) || target.closest('.moveable-control-box')) {
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
    <!-- 顶部状态与辅助工具条 -->
    <div class="design-top-bar">
      <div class="selection-status" :class="{ 'is-active': isSelected }">
        <span class="status-dot"></span>
        <span class="status-text">{{ selectedInfo }}</span>
      </div>
      <div class="design-actions">
        <span class="feature-tag">智能吸附线</span>
        <span class="feature-tag">8向缩放</span>
        <span class="feature-tag">旋转手柄</span>
        <button type="button" class="btn-reset" title="重置位置与尺寸" @click="resetArtboard">
          重置布局
        </button>
      </div>
    </div>

    <!-- 可视化设计画布主区域（带现代点阵背景） -->
    <div ref="canvasRef" class="canvas-viewport">
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
            基于 Moveable + Selecto 构建。支持点选、拉伸、缩放手柄与组件边缘智能吸附对齐。
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
          <span class="text-xs text-slate-400 select-none">自然语言微调提示词 (Prompt)...</span>
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
}

.design-target:hover {
  outline: 1px dashed #6366f180;
  outline-offset: 2px;
}
</style>
