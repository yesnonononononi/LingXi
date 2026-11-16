import {computed, ref, shallowReactive} from 'vue';
import type {ChatBackgroundSlots} from '../types/backgroundSlots';
import type {ChatInputSlotOverrides} from '../types/chatInputSlots';
import type {ChatMessageSlotOverrides} from '../types/chatMessageSlots';
import type {SidebarSlotOverrides} from '../types/sidebarSlots';
import {OFFICIAL_PACKS, findOfficialPack} from './packRegistry';
import type {ElectronPacksAPI, RemotePackManifest} from '../utils/platform';
import {
  PACK_CATEGORY_ORDER,
  type OfficialPackCategory,
  type OfficialPackDefinition,
  type OfficialPackEntry,
  type OfficialPackFont,
  type OfficialPackMeta,
} from './types';

export const PACK_STORAGE_KEY = 'lx_active_packs';
export const LEGACY_PACK_STORAGE_KEY = 'lx_active_pack_id';
export const PACK_STYLE_ATTR = 'data-lx-pack';

export type ActivePackSelectionMap = Partial<Record<OfficialPackCategory, string>>;

/** 扩展包激活后写入的 Slot 覆盖容器（仅保存覆盖项，未覆盖字段保持 undefined）。 */
export interface ActivePackSlotsState {
  readonly background: ChatBackgroundSlots;
  readonly chatInput: ChatInputSlotOverrides;
  readonly chatMessage: ChatMessageSlotOverrides;
  readonly sidebar: SidebarSlotOverrides;
}

const activePackIds = ref<ActivePackSelectionMap>({});
const loadingCategory = ref<OfficialPackCategory | null>(null);
const activePackError = ref<string | null>(null);
const loadedDefinitions = new Map<OfficialPackCategory, OfficialPackDefinition>();

const installedRemotePacks = ref<OfficialPackMeta[]>([]);
const remoteRegistryByCategory = ref<Partial<Record<OfficialPackCategory, RemotePackManifest[]>>>({});
const remoteLoading = ref(false);
const remoteError = ref<string | null>(null);

function resolveElectronPacksApi(): ElectronPacksAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI?.packs;
}

function toPackMeta(manifest: RemotePackManifest): OfficialPackMeta {
  return {
    id: manifest.id,
    category: manifest.category,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    capabilities: manifest.capabilities ?? ['GitHub 远程'],
    preview: manifest.preview,
    fontPreview: manifest.fontPreview,
  };
}

/** 统一查找入口：优先内置包，其次本地已安装的 GitHub 远程包。 */
function resolvePackEntry(packId: string): OfficialPackEntry | undefined {
  const builtin = findOfficialPack(packId);
  if (builtin) return builtin;

  const remoteMeta = installedRemotePacks.value.find(item => item.id === packId);
  const api = resolveElectronPacksApi();
  if (!remoteMeta || !api) return undefined;

  return {
    meta: remoteMeta,
    load: async () => {
      const res = await api.load(packId);
      if (!res.ok || typeof res.cssText !== 'string') {
        throw new Error(res.error || `加载远程扩展包失败: ${packId}`);
      }
      return {
        id: packId,
        cssText: res.cssText,
      };
    },
  };
}

const packSlots: ActivePackSlotsState = {
  background: shallowReactive<ChatBackgroundSlots>({}),
  chatInput: shallowReactive<ChatInputSlotOverrides>({}),
  chatMessage: shallowReactive<ChatMessageSlotOverrides>({}),
  sidebar: shallowReactive<SidebarSlotOverrides>({}),
};

const activePackCount = computed(() => Object.values(activePackIds.value).filter(Boolean).length);

/** 序列化单个字体声明为 @font-face 规则。 */
function formatFontFaceRule(font: OfficialPackFont): string {
  const weight = font.weight ? `  font-weight: ${font.weight};\n` : '';
  const style = font.style ? `  font-style: ${font.style};\n` : '';
  return `@font-face {\n  font-family: '${font.family}';\n  src: url('${font.src}');\n${weight}${style}  font-display: swap;\n}`;
}

/**
 * 将扩展包定义编译为单一 CSS 文本：
 * 包含 @font-face、字体族变量覆写及包体自定义样式，方便通过单个 <style data-lx-pack> 挂载与整体卸载。
 */
export function buildPackCss(def: OfficialPackDefinition): string {
  const blocks: string[] = [];

  if (def.fonts && def.fonts.length > 0) {
    const faceRules = def.fonts.map(formatFontFaceRule).join('\n');
    blocks.push(faceRules);

    const sansFamilies = def.fonts.filter(f => f.target === 'sans').map(f => `'${f.family}'`);
    const codeFamilies = def.fonts.filter(f => f.target === 'code').map(f => `'${f.family}'`);
    const rootVars: string[] = [];
    if (sansFamilies.length > 0) {
      rootVars.push(`  --font-sans: ${sansFamilies.join(', ')}, ui-sans-serif, system-ui, sans-serif;`);
    }
    if (codeFamilies.length > 0) {
      rootVars.push(`  --font-lx-code: ${codeFamilies.join(', ')}, ui-monospace, monospace;`);
    }
    if (rootVars.length > 0) {
      blocks.push(`:root {\n${rootVars.join('\n')}\n}`);
    }
  }

  if (def.cssText && def.cssText.trim().length > 0) {
    blocks.push(def.cssText.trim());
  }

  return blocks.join('\n\n');
}

function clearReactiveRecord<T extends Record<string, unknown>>(target: T): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
}

/** 按固定分类叠加顺序重算 Slot 覆盖，确保停用某分类后其余分类覆盖依然保留。 */
function rebuildMergedPackSlots(): void {
  clearReactiveRecord(packSlots.background as Record<string, unknown>);
  clearReactiveRecord(packSlots.chatInput as Record<string, unknown>);
  clearReactiveRecord(packSlots.chatMessage as Record<string, unknown>);
  clearReactiveRecord(packSlots.sidebar as Record<string, unknown>);

  for (const category of PACK_CATEGORY_ORDER) {
    const def = loadedDefinitions.get(category);
    if (!def?.slots) continue;
    if (def.slots.background) Object.assign(packSlots.background, def.slots.background);
    if (def.slots.chatInput) Object.assign(packSlots.chatInput, def.slots.chatInput);
    if (def.slots.chatMessage) Object.assign(packSlots.chatMessage, def.slots.chatMessage);
    if (def.slots.sidebar) Object.assign(packSlots.sidebar, def.slots.sidebar);
  }
}

function removeCategoryStyle(doc: Document | undefined, category: OfficialPackCategory): void {
  if (!doc?.head) return;
  const existing = doc.head.querySelectorAll(`style[${PACK_STYLE_ATTR}="${category}"]`);
  existing.forEach(node => node.remove());
}

function removeAllPackStyles(doc: Document | undefined): void {
  if (!doc?.head) return;
  const existing = doc.head.querySelectorAll(`style[${PACK_STYLE_ATTR}]`);
  existing.forEach(node => node.remove());
}

function mountCategoryStyle(
  doc: Document | undefined,
  category: OfficialPackCategory,
  packId: string,
  cssText: string,
): void {
  removeCategoryStyle(doc, category);
  if (!doc?.head || !cssText) return;
  const styleEl = doc.createElement('style');
  styleEl.setAttribute(PACK_STYLE_ATTR, category);
  styleEl.setAttribute('data-lx-pack-id', packId);
  styleEl.textContent = cssText;
  doc.head.appendChild(styleEl);
}

function persistSelectionMap(storage: Storage | undefined, map: ActivePackSelectionMap): void {
  if (!storage) return;
  try {
    const cleaned: ActivePackSelectionMap = {};
    for (const category of PACK_CATEGORY_ORDER) {
      const id = map[category];
      if (id) cleaned[category] = id;
    }
    if (Object.keys(cleaned).length > 0) {
      storage.setItem(PACK_STORAGE_KEY, JSON.stringify(cleaned));
    } else {
      storage.removeItem(PACK_STORAGE_KEY);
    }
    storage.removeItem(LEGACY_PACK_STORAGE_KEY);
  } catch {
    // 受限存储环境忽略持久化错误
  }
}

function readPersistedSelectionMap(storage: Storage | undefined): ActivePackSelectionMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PACK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result: ActivePackSelectionMap = {};
      for (const category of PACK_CATEGORY_ORDER) {
        const val = parsed[category];
        if (typeof val === 'string' && val.trim().length > 0) {
          result[category] = val.trim();
        }
      }
      return result;
    }
    // 兼容早期单包持久化键
    const legacyId = storage.getItem(LEGACY_PACK_STORAGE_KEY);
    if (legacyId && legacyId.trim().length > 0) {
      const entry = findOfficialPack(legacyId.trim());
      if (entry) {
        return { [entry.meta.category]: entry.meta.id };
      }
    }
    return {};
  } catch {
    return {};
  }
}

/** 内部执行器：允许测试注入 doc/storage/lookup 避免强依赖浏览器全局对象。 */
export async function selectPackWithEnv(
  category: OfficialPackCategory,
  packId: string | null,
  env: {
    doc?: Document;
    storage?: Storage;
    lookup?: (id: string) => OfficialPackEntry | undefined;
  } = {},
): Promise<boolean> {
  const doc = env.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const storage = env.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  const lookup = env.lookup ?? resolvePackEntry;

  activePackError.value = null;

  if (!packId) {
    removeCategoryStyle(doc, category);
    loadedDefinitions.delete(category);
    rebuildMergedPackSlots();
    const next = { ...activePackIds.value };
    delete next[category];
    activePackIds.value = next;
    persistSelectionMap(storage, next);
    return true;
  }

  const entry = lookup(packId);
  if (!entry || entry.meta.category !== category) {
    removeCategoryStyle(doc, category);
    loadedDefinitions.delete(category);
    rebuildMergedPackSlots();
    const next = { ...activePackIds.value };
    delete next[category];
    activePackIds.value = next;
    persistSelectionMap(storage, next);
    activePackError.value = `未找到扩展包: ${packId}`;
    return false;
  }

  loadingCategory.value = category;
  try {
    const def = await entry.load();
    const cssText = buildPackCss(def);
    mountCategoryStyle(doc, category, def.id, cssText);
    loadedDefinitions.set(category, def);
    rebuildMergedPackSlots();
    const next = { ...activePackIds.value, [category]: def.id };
    activePackIds.value = next;
    persistSelectionMap(storage, next);
    return true;
  } catch (err) {
    // Fail-Closed：单分类加载失败时仅回滚该分类，不影响其他已激活分类
    removeCategoryStyle(doc, category);
    loadedDefinitions.delete(category);
    rebuildMergedPackSlots();
    const next = { ...activePackIds.value };
    delete next[category];
    activePackIds.value = next;
    activePackError.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    loadingCategory.value = null;
  }
}

/** 重置所有分类的扩展包，恢复全部内置默认外观。 */
export function resetAllPacksWithEnv(
  env: { doc?: Document; storage?: Storage } = {},
): void {
  const doc = env.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const storage = env.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);

  removeAllPackStyles(doc);
  loadedDefinitions.clear();
  rebuildMergedPackSlots();
  activePackIds.value = {};
  activePackError.value = null;
  persistSelectionMap(storage, {});
}

export async function selectCategoryPack(category: OfficialPackCategory, packId: string | null): Promise<boolean> {
  return selectPackWithEnv(category, packId);
}

export function resetAllPacks(): void {
  resetAllPacksWithEnv();
}

export async function refreshInstalledRemotePacks(): Promise<void> {
  const api = resolveElectronPacksApi();
  if (!api) {
    installedRemotePacks.value = [];
    return;
  }
  const res = await api.listInstalled();
  if (res.ok && Array.isArray(res.packs)) {
    installedRemotePacks.value = res.packs.map(toPackMeta);
  }
}

export async function fetchRemoteRegistry(category: OfficialPackCategory): Promise<boolean> {
  const api = resolveElectronPacksApi();
  if (!api) {
    remoteError.value = '仅桌面端支持从 GitHub 拉取扩展包';
    return false;
  }
  remoteLoading.value = true;
  remoteError.value = null;
  try {
    const res = await api.fetchRegistry(category);
    if (!res.ok || !Array.isArray(res.packs)) {
      remoteError.value = res.error || '拉取 GitHub 扩展包清单失败';
      return false;
    }
    remoteRegistryByCategory.value = {
      ...remoteRegistryByCategory.value,
      [category]: res.packs,
    };
    return true;
  } catch (err) {
    remoteError.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    remoteLoading.value = false;
  }
}

export async function installRemotePack(manifest: RemotePackManifest): Promise<boolean> {
  const api = resolveElectronPacksApi();
  if (!api) {
    remoteError.value = '仅桌面端支持安装远程扩展包';
    return false;
  }
  remoteLoading.value = true;
  remoteError.value = null;
  try {
    // 解除 Vue 响应式 Proxy（Electron IPC structured clone 不支持克隆 Proxy 数组）
    const plainFiles = Array.isArray(manifest.files) ? manifest.files.map(String) : undefined;
    const res = await api.install({ id: String(manifest.id), files: plainFiles });
    if (!res.ok) {
      remoteError.value = res.error || `安装失败: ${manifest.id}`;
      return false;
    }
    await refreshInstalledRemotePacks();
    return true;
  } catch (err) {
    remoteError.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    remoteLoading.value = false;
  }
}

export async function uninstallRemotePack(packId: string): Promise<boolean> {
  const api = resolveElectronPacksApi();
  if (!api) return false;
  remoteLoading.value = true;
  remoteError.value = null;
  try {
    // 若卸载的包正在启用，先从对应分类撤下并清理样式
    for (const category of PACK_CATEGORY_ORDER) {
      if (activePackIds.value[category] === packId) {
        await selectCategoryPack(category, null);
      }
    }
    const res = await api.uninstall(packId);
    if (!res.ok) {
      remoteError.value = res.error || `卸载失败: ${packId}`;
      return false;
    }
    await refreshInstalledRemotePacks();
    return true;
  } catch (err) {
    remoteError.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    remoteLoading.value = false;
  }
}

/** 应用启动时按持久化配置恢复各分类已启用的扩展包。 */
export async function initPackHost(): Promise<void> {
  await refreshInstalledRemotePacks();
  const storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
  const saved = readPersistedSelectionMap(storage);
  for (const category of PACK_CATEGORY_ORDER) {
    const id = saved[category];
    if (id) {
      await selectPackWithEnv(category, id);
    }
  }
}

/** 供宿主（ChatView）与设置页消费的扩展包状态接口。 */
export function usePackHost() {
  return {
    activePackIds,
    activePackCount,
    loadingCategory,
    activePackError,
    availablePacks: OFFICIAL_PACKS,
    installedRemotePacks,
    remoteRegistryByCategory,
    remoteLoading,
    remoteError,
    packSlots,
    selectCategoryPack,
    resetAllPacks,
    refreshInstalledRemotePacks,
    fetchRemoteRegistry,
    installRemotePack,
    uninstallRemotePack,
  };
}
