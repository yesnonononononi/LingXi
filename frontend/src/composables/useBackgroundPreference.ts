import { computed, ref } from 'vue';
import type { ComputedRef } from 'vue';
import { isElectron } from '../utils/platform';
import type { ElectronBackgroundAPI } from '../utils/platform';

/**
 * 主页背景偏好（**外观偏好**，只在本机，不进后端 user_configs）。
 *
 * <p><b>为什么是 localStorage 而不是后端配置：</b>它与主题 / 语言 / 提示音同类 —— 属于「这台机器长什么样」，
 * 而图片文件本身也存在本机 `userData/backgrounds/`。副作用是换数据目录或换机器不会带走背景图，
 * 这是 v1 明确接受的取舍（见 .lingxi/plan/feature-home-background-feasibility.md 风险 4）。</p>
 *
 * <p><b>单一真值来源：</b>偏好的形状只在这里定义；DOM 上的三个 CSS 变量（`--lx-canvas-image` /
 * `--lx-background-scrim` / `--lx-canvas-fit`）全部由 {@link applyToDocument} 写，别处不得直接写，
 * 否则会出现「清除了但变量还留着」的双真值（M2 变异靶点正是这条）。</p>
 */

/** localStorage 键。 */
export const BACKGROUND_STORAGE_KEY = 'lingxi-home-background';
/** 偏好结构版本：未来改形状时靠它做迁移/丢弃，避免读到旧结构后静默错乱。 */
export const BACKGROUND_SCHEMA_VERSION = 1;
/** 默认遮罩强度（0–1）；与 tokens 里的 scrim 颜色相乘得到最终不透明度。 */
export const DEFAULT_BACKGROUND_SCRIM = 0.5;
/** 遮罩强度上下限（设置页滑杆用的是百分数，这里统一收口到 0–1）。 */
export const MIN_BACKGROUND_SCRIM = 0;
export const MAX_BACKGROUND_SCRIM = 1;

/** 填充方式：铺满（cover） / 适应（contain）。 */
export type BackgroundFit = 'cover' | 'contain';

/** 持久化形状。无背景时存储项直接不存在（读出来是 null），不写空壳对象。 */
export interface BackgroundPreference {
  readonly version: typeof BACKGROUND_SCHEMA_VERSION;
  /** 本机文件名（**只存文件名，不存路径**）：渲染层永远不接触绝对路径。 */
  readonly fileName: string;
  readonly fit: BackgroundFit;
  /** 遮罩强度 0–1。 */
  readonly scrim: number;
  readonly updatedAt: string;
}

/** 文档根上的三个变量名（唯一写入口在本文件）。 */
const IMAGE_VAR = '--lx-canvas-image';
const SCRIM_VAR = '--lx-background-scrim';
const FIT_VAR = '--lx-canvas-fit';

/** 文件名白名单：与主进程 `background-images.cjs` 的校验同构，非法名一律当「无偏好」丢弃。 */
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** 当前偏好（模块级单例：设置页与聊天页读到的是同一份状态）。 */
const preference = ref<BackgroundPreference | null>(null);
/** 只保留短的 Blob URL，避免大图 Base64 超过 CSS 自定义属性的长度上限。 */
const imageUrl = ref<string | null>(null);

function replaceImage(dataUrl: string | null): void {
  let next: string | null = null;
  if (dataUrl) {
    const separator = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const decoded = atob(dataUrl.slice(separator + 1));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    next = URL.createObjectURL(new Blob([bytes], { type: mime }));
  }
  const previous = imageUrl.value;
  imageUrl.value = next;
  if (previous) URL.revokeObjectURL(previous);
}

/** 文档根变量是否处于「已写入」状态（用于默认态零写入）。 */
let documentVariablesApplied = false;

/**
 * 校验并规整一次遮罩强度。
 * @param value 任意输入
 * @returns 落在 [0,1] 内的有限数；非法输入回落默认值
 */
function normalizeScrim(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_BACKGROUND_SCRIM;
  return Math.min(MAX_BACKGROUND_SCRIM, Math.max(MIN_BACKGROUND_SCRIM, num));
}

/** 校验填充方式。 */
function normalizeFit(value: unknown): BackgroundFit {
  return value === 'contain' ? 'contain' : 'cover';
}

/**
 * 从 localStorage 读出偏好。
 *
 * <p>任何不合规（版本不符 / 文件名字符非法 / scrim 非数）都当作「没有偏好」返回 null ——
 * 宁可回落到默认背景，也不能拿半截脏数据去写 CSS 变量。</p>
 *
 * @returns 偏好对象或 null
 */
function readPersisted(): BackgroundPreference | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(BACKGROUND_STORAGE_KEY);
  } catch {
    return null; // 隐私模式 / 配额异常：当作没有偏好
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== BACKGROUND_SCHEMA_VERSION) return null;
  const fileName = typeof record.fileName === 'string' ? record.fileName : '';
  if (!fileName || fileName.length > 128 || !FILE_NAME_RE.test(fileName) || fileName.startsWith('.')) {
    return null;
  }
  return {
    version: BACKGROUND_SCHEMA_VERSION,
    fileName,
    fit: normalizeFit(record.fit),
    scrim: normalizeScrim(record.scrim),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  };
}

/**
 * 写入偏好到 localStorage。
 * @param next 待写入的偏好
 */
function writePersisted(next: BackgroundPreference): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 写不进去不影响本次会话的显示（内存态已生效），下次启动会回落到默认背景
  }
}

/** 清掉持久化项。 */
function removePersisted(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(BACKGROUND_STORAGE_KEY);
  } catch {
    // 同上：清不掉也不能挡住「回到默认背景」这件事
  }
}

/**
 * 把三个变量全部复位为空值。
 *
 * <p><b>这是 M2 变异的靶点：</b>只清偏好不清变量时，界面会继续显示上一张图，
 * 直到重启才消失 —— 「清除」看起来成功了，其实是假的。</p>
 */
function resetDocumentVariables(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty(IMAGE_VAR, '');
  root.style.setProperty(SCRIM_VAR, '');
  root.style.setProperty(FIT_VAR, '');
  documentVariablesApplied = false;
}

/**
 * 按当前偏好写文档根变量。
 *
 * <p>无偏好时复位三个变量（幂等）；有偏好但图片还没加载出来时只写强度与填充方式，
 * 不写 `--lx-canvas-image` —— 避免「有 scrim 没图」的半截状态。</p>
 */
function applyToDocument(): void {
  if (typeof document === 'undefined') return;
  const current = preference.value;
  if (!current) {
    resetDocumentVariables();
    return;
  }
  const root = document.documentElement;
  if (imageUrl.value) {
    root.style.setProperty(IMAGE_VAR, `url("${imageUrl.value}")`);
  } else {
    root.style.setProperty(IMAGE_VAR, '');
  }
  root.style.setProperty(SCRIM_VAR, String(current.scrim));
  root.style.setProperty(FIT_VAR, current.fit);
  documentVariablesApplied = true;
}

/** 取桌面端背景 IPC；非 Electron（浏览器 / 视觉场景）返回 null。 */
function backgroundApi(): ElectronBackgroundAPI | null {
  if (!isElectron() || typeof window === 'undefined') return null;
  return window.electronAPI?.background ?? null;
}

/**
 * 调起系统图片选择器并把选中的图片落地保存。
 *
 * @returns 是否已成功设置背景（取消 / 校验失败 / 非桌面端均为 false）
 */
async function pickImage(): Promise<boolean> {
  const api = backgroundApi();
  if (!api) return false;
  let result: Awaited<ReturnType<ElectronBackgroundAPI['pick']>> | null = null;
  try {
    result = await api.pick();
  } catch {
    return false;
  }
  if (!result || !result.ok || !result.fileName || !result.dataUrl) return false;
  replaceImage(result.dataUrl);
  const previous = preference.value;
  const next: BackgroundPreference = {
    version: BACKGROUND_SCHEMA_VERSION,
    fileName: result.fileName,
    fit: previous?.fit ?? 'cover',
    scrim: previous?.scrim ?? DEFAULT_BACKGROUND_SCRIM,
    updatedAt: new Date().toISOString(),
  };
  preference.value = next;
  writePersisted(next);
  applyToDocument();
  return true;
}

/**
 * 清除主页背景：复位三个 CSS 变量 + 删本机图片文件 + 删持久化项。
 *
 * <p>顺序刻意如此：先复位 DOM（用户立刻看到效果），再删文件（磁盘操作可能慢/失败）。
 * 文件删不掉时偏好已被清空，下次启动走默认背景，不会「幽灵背景」。</p>
 */
async function clear(): Promise<void> {
  preference.value = null;
  replaceImage(null);
  resetDocumentVariables();
  removePersisted();
  const api = backgroundApi();
  if (!api) return;
  try {
    await api.clear();
  } catch {
    // 删文件失败只影响磁盘占用，不影响「已回到默认背景」这一结果
  }
}

/**
 * 设置填充方式（铺满 / 适应）。
 * @param fit 目标填充方式
 */
function setFit(fit: BackgroundFit): void {
  const current = preference.value;
  if (!current) return;
  const next: BackgroundPreference = {
    ...current,
    fit: normalizeFit(fit),
    updatedAt: new Date().toISOString(),
  };
  preference.value = next;
  writePersisted(next);
  applyToDocument();
}

/**
 * 设置遮罩强度。
 * @param scrim 0–1 之间的强度（越界会被夹紧）
 */
function setScrim(scrim: number): void {
  const current = preference.value;
  if (!current) return;
  const next: BackgroundPreference = {
    ...current,
    scrim: normalizeScrim(scrim),
    updatedAt: new Date().toISOString(),
  };
  preference.value = next;
  writePersisted(next);
  applyToDocument();
}

/**
 * 启动时恢复偏好。
 *
 * <p>默认态（没有偏好）**一个变量都不写**：这是「默认渲染必须与改动前逐字节一致」的硬要求，
 * 视觉基线正是按默认态采集的。</p>
 *
 * <p>取不到图片（文件被删 / 损坏 / 换机器）时**静默回落**到 `clear()`：
 * 不弹错、不阻塞启动，用户看到的就是默认背景。</p>
 */
async function init(): Promise<void> {
  const stored = readPersisted();
  if (!stored) {
    preference.value = null;
    replaceImage(null);
    documentVariablesApplied = false;
    return;
  }
  const api = backgroundApi();
  if (!api) {
    // 非桌面端读不到本机文件：直接视为无背景，且不写任何变量
    preference.value = null;
    replaceImage(null);
    removePersisted();
    return;
  }
  preference.value = stored;
  let result: Awaited<ReturnType<ElectronBackgroundAPI['load']>> | null = null;
  try {
    result = await api.load(stored.fileName);
  } catch {
    result = null;
  }
  if (!result || !result.ok || !result.dataUrl) {
    await clear();
    return;
  }
  replaceImage(result.dataUrl);
  applyToDocument();
}

/**
 * 主页背景偏好（单例）。
 *
 * @returns 偏好读写与 DOM 应用入口
 */
export function useBackgroundPreference(): {
  preference: typeof preference;
  /** 当前背景与缩略图共用的 Blob URL；无背景时为 null。 */
  imageUrl: typeof imageUrl;
  hasBackground: ComputedRef<boolean>;
  pickImage: () => Promise<boolean>;
  clear: () => Promise<void>;
  setFit: (fit: BackgroundFit) => void;
  setScrim: (scrim: number) => void;
  applyToDocument: () => void;
  init: () => Promise<void>;
} {
  const hasBackground = computed<boolean>(() => preference.value !== null);
  return { preference, imageUrl, hasBackground, pickImage, clear, setFit, setScrim, applyToDocument, init };
}

/** 内部状态是否已写入文档根（仅供测试与调试观察，不影响渲染）。 */
export function isDocumentVariablesApplied(): boolean {
  return documentVariablesApplied;
}
