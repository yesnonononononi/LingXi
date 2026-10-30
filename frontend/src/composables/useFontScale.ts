/**
 * 全局字号缩放（`--lx-font-scale`）的**唯一写入口**。
 *
 * <p><b>为什么只写一个变量：</b>字号令牌定义在 `theme/tokens.css`，形如
 * `--lx-font-size-sm: calc(11px * var(--lx-font-scale, 1))`。改一个 `--lx-font-scale`
 * 就能同时驱动全部 8 档令牌，避免逐个令牌赋值造成「改了一半」的中间态（M2 变异靶点）。</p>
 *
 * <p><b>默认态零写入（硬要求）：</b>缩放值是默认档时**不写** `--lx-font-scale`
 * （不是写 `1`）。视觉基线按默认态采集，一旦显式写 `1`，`calc(11px * 1)` 的属性字符串形态
 * 就会从「未设置」变成「已设置」，等价性判据与截图比对都可能因此翻车（见
 * .lingxi/plan/font-scale-assessment.md §7.1）。所以 {@link applyToDocument} 在默认档
 * 走 `removeProperty`，其余任何地方都不得直接写这个变量。</p>
 *
 * <p><b>为什么首帧还要 index.html 兜一道：</b>真值源在服务端（S2 接入），首帧拿不到；
 * 若等模块加载再写变量，用户会看到「小字 → 变大」闪一下。因此 index.html 的内联脚本
 * 也从同一个 localStorage 键镜像写入，本文件的持久化与它必须保持同一口径。</p>
 */

import { computed, ref, watch } from 'vue';
import type { ComputedRef, Ref } from 'vue';

/** localStorage 键。命名风格对齐 `lingxi-theme`：`lingxi-<关注点>`。 */
export const FONT_SCALE_STORAGE_KEY = 'lingxi-font-scale';

/** 默认缩放（=当前视觉基线对应的档位）。 */
export const DEFAULT_FONT_SCALE = 1;
/** 下限：再小会把 9px 档压到不可读。 */
export const MIN_FONT_SCALE = 0.875;
/** 上限：再大会让固定 px 的容器装不下文本。 */
export const MAX_FONT_SCALE = 1.5;

/** 字号档位枚举（设置页四档；数值口径见 PRESET_SCALE）。 */
export type FontScalePreset = 'SMALL' | 'MEDIUM' | 'LARGE' | 'X_LARGE';

/** 档位 → 缩放倍数。改这里等于改产品口径，必须同步 index.html 的夹紧区间。 */
export const PRESET_SCALE: Readonly<Record<FontScalePreset, number>> = Object.freeze({
  SMALL: 0.875,
  MEDIUM: 1,
  LARGE: 1.125,
  X_LARGE: 1.25
});

/** 档位顺序（设置页按此渲染）。 */
export const FONT_SCALE_PRESETS: readonly FontScalePreset[] = Object.freeze([
  'SMALL',
  'MEDIUM',
  'LARGE',
  'X_LARGE'
]);

/** 文档根上的变量名（唯一写入口在本文件）。 */
const FONT_SCALE_VAR = '--lx-font-scale';

/**
 * 校验并夹紧一次缩放倍数。
 * @param value 任意输入
 * @returns 落在 [MIN_FONT_SCALE, MAX_FONT_SCALE] 内的有限数；非法输入回落默认档
 */
const normalizeScale = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_FONT_SCALE;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, num));
};

/**
 * 从 localStorage 读出持久化的缩放值。
 *
 * <p>读不到 / 脏数据一律回落默认档：宁可首帧是默认字号，也不能拿半截数据去写 CSS 变量。</p>
 *
 * @returns 已夹紧的缩放倍数
 */
const readPersisted = (): number => {
  if (typeof localStorage === 'undefined') return DEFAULT_FONT_SCALE;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
  } catch {
    return DEFAULT_FONT_SCALE; // 隐私模式 / 配额异常：当作没有偏好
  }
  if (raw === null || raw.trim() === '') return DEFAULT_FONT_SCALE;
  return normalizeScale(raw);
};

/** 当前缩放（模块级单例：设置页与聊天页读到的是同一份状态）。 */
const scale = ref<number>(readPersisted());

/** 文档根变量是否处于「已写入」状态（默认态零写入，故默认态为 false）。 */
let documentVariablesApplied = false;

/**
 * 把当前缩放写到文档根。
 *
 * <p>这是 `--lx-font-scale` 的**唯一写入口**。默认档必须走 `removeProperty`（见文件头说明）。</p>
 */
const applyToDocument = (): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  const current = scale.value;
  if (current === DEFAULT_FONT_SCALE) {
    root.style.removeProperty(FONT_SCALE_VAR);
    documentVariablesApplied = false;
    return;
  }
  root.style.setProperty(FONT_SCALE_VAR, String(current));
  documentVariablesApplied = true;
};

/** 持久化当前缩放：默认档直接删键，避免 localStorage 里留下「看起来有偏好」的空壳。 */
const writePersisted = (): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    if (scale.value === DEFAULT_FONT_SCALE) {
      localStorage.removeItem(FONT_SCALE_STORAGE_KEY);
    } else {
      localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(scale.value));
    }
  } catch {
    // 写不进去只影响下次启动的首帧镜像，不影响本次渲染
  }
};

// 缩放变化时：先应用到文档（用户立刻看到效果），再持久化（供首帧镜像）
watch(scale, () => {
  applyToDocument();
  writePersisted();
});

/**
 * 启动时应用已持久化的缩放。
 *
 * <p>默认态**一个变量都不写**：index.html 首帧脚本同样跳过默认档，两边口径一致。</p>
 */
const initialize = (): void => {
  if (scale.value === DEFAULT_FONT_SCALE) return;
  applyToDocument();
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyToDocument();
    });
  }
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initialize();
}

/**
 * 全局字号缩放（单例）。
 *
 * @returns 缩放状态与读写入口
 */
export function useFontScale(): {
  scale: Ref<number>;
  isDefault: ComputedRef<boolean>;
  preset: ComputedRef<FontScalePreset | null>;
  presets: readonly FontScalePreset[];
  setScale: (value: number) => void;
  setPreset: (preset: FontScalePreset) => void;
  reset: () => void;
  applyToDocument: () => void;
} {
  const isDefault = computed<boolean>(() => scale.value === DEFAULT_FONT_SCALE);
  // 当前缩放若正好落在某个档位上，给出该档位；自由缩放（非档位值）时为 null
  const preset = computed<FontScalePreset | null>(() => {
    const matched = FONT_SCALE_PRESETS.find(item => PRESET_SCALE[item] === scale.value);
    return matched ?? null;
  });

  /**
   * 设置缩放倍数（越界会被夹紧，非法值回落默认档）。
   * @param value 目标缩放倍数
   */
  const setScale = (value: number): void => {
    scale.value = normalizeScale(value);
  };

  /**
   * 按档位设置缩放。
   * @param preset 目标档位
   */
  const setPreset = (preset: FontScalePreset): void => {
    scale.value = normalizeScale(PRESET_SCALE[preset] ?? DEFAULT_FONT_SCALE);
  };

  /** 重置到默认档（默认档不写变量，等价于「恢复改动前渲染」）。 */
  const reset = (): void => {
    scale.value = DEFAULT_FONT_SCALE;
  };

  return { scale, isDefault, preset, presets: FONT_SCALE_PRESETS, setScale, setPreset, reset, applyToDocument };
}

/** 内部状态是否已写入文档根（仅供测试与调试观察，不影响渲染）。 */
export function isDocumentVariablesApplied(): boolean {
  return documentVariablesApplied;
}
