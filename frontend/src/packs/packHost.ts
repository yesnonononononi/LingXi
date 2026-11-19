import {computed, ref, shallowReactive} from 'vue';
import type {ChatBackgroundSlots} from '../types/backgroundSlots';
import type {ChatInputSlotOverrides} from '../types/chatInputSlots';
import type {ChatMessageSlotOverrides} from '../types/chatMessageSlots';
import type {InteractionCardSlotOverrides} from '../types/interactionCardSlots';
import type {SidebarSlotOverrides} from '../types/sidebarSlots';
import type {TaskProgressSlotOverrides} from '../types/taskProgressSlots';
import {OFFICIAL_PACKS, findOfficialPack} from './packRegistry';
import type {CustomScannedPackManifest, ElectronPacksAPI, RemotePackManifest} from '../utils/platform';
import {
  PACK_CATEGORY_ORDER,
  type ChatMessageTab,
  type InteractionCardTab,
  type OfficialPackCategory,
  type OfficialPackDefinition,
  type OfficialPackEntry,
  type OfficialPackFont,
  type OfficialPackMeta,
  type TaskProgressTab,
} from './types';

export const PACK_STORAGE_KEY = 'lx_active_packs';
export const CUSTOM_PACK_DIRS_KEY = 'lx_custom_pack_dirs';
export const LEGACY_PACK_STORAGE_KEY = 'lx_active_pack_id';
export const PACK_STYLE_ATTR = 'data-lx-pack';

export type ActivePackSelectionMap = Partial<Record<OfficialPackCategory, string>>;

/** 扩展包激活后写入的 Slot 覆盖容器（仅保存覆盖项，未覆盖字段保持 undefined）。 */
export interface ActivePackSlotsState {
  readonly background: ChatBackgroundSlots;
  readonly chatInput: ChatInputSlotOverrides;
  readonly chatMessage: ChatMessageSlotOverrides;
  readonly interactionCard: InteractionCardSlotOverrides;
  readonly sidebar: SidebarSlotOverrides;
  readonly taskProgress: TaskProgressSlotOverrides;
}

const INTERACTION_CARD_TABS: readonly InteractionCardTab[] = ['approval', 'plan', 'choice'];
const TASK_PROGRESS_TABS: readonly TaskProgressTab[] = ['background', 'checklist', 'pendingQueue'];
const CHAT_MESSAGE_TABS: readonly ChatMessageTab[] = ['userMessage', 'messageItem', 'processThought', 'processTool', 'processSubAgent'];

/**
 * 「按子 Tab 独立叠加」的类目清单。
 *
 * <p>这些类目的选择状态既不在 `activePackIds` 里，也不该走单值选择分支；
 * 新增一个子 Tab 类目时只改这里，别再往各处散落的 `category === 'x' || ...` 上加一项。</p>
 */
const SUB_TAB_CATEGORIES: readonly OfficialPackCategory[] = ['interactionCard', 'taskProgress', 'chatMessage'];

/** 该类目是否按子 Tab 独立叠加（每 Tab 各选一个包）。 */
const isSubTabCategory = (category: OfficialPackCategory): boolean => SUB_TAB_CATEGORIES.includes(category);
const activePackIds = ref<ActivePackSelectionMap>({});
const activeInteractionPackIds = ref<Partial<Record<InteractionCardTab, string>>>({});
const activeTaskProgressPackIds = ref<Partial<Record<TaskProgressTab, string>>>({});
const activeChatMessagePackIds = ref<Partial<Record<ChatMessageTab, string>>>({});
const loadingCategory = ref<OfficialPackCategory | null>(null);
const activePackError = ref<string | null>(null);
const loadedDefinitions = new Map<OfficialPackCategory, OfficialPackDefinition>();
const loadedInteractionDefinitions = new Map<InteractionCardTab, OfficialPackDefinition>();
const loadedTaskProgressDefinitions = new Map<TaskProgressTab, OfficialPackDefinition>();
const loadedChatMessageDefinitions = new Map<ChatMessageTab, OfficialPackDefinition>();

const installedRemotePacks = ref<OfficialPackMeta[]>([]);
const remoteRegistryByCategory = ref<Partial<Record<OfficialPackCategory, RemotePackManifest[]>>>({});
const remoteLoading = ref(false);
const remoteError = ref<string | null>(null);

export interface CustomPackSourceEntry {
  readonly dirPath: string;
  readonly packs: readonly (OfficialPackMeta & { readonly packDir: string })[];
}

const customPackSources = ref<CustomPackSourceEntry[]>([]);
const customPackLoading = ref(false);
const customPackError = ref<string | null>(null);

const customPacks = computed(() =>
  customPackSources.value.flatMap(source => source.packs),
);

function resolveElectronPacksApi(): ElectronPacksAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI?.packs;
}

function toPackMeta(manifest: RemotePackManifest, defaultCap = 'GitHub 远程'): OfficialPackMeta {
  return {
    id: manifest.id,
    category: manifest.category,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    capabilities: manifest.capabilities && manifest.capabilities.length > 0 ? manifest.capabilities : [defaultCap],
    preview: manifest.preview,
    fontPreview: manifest.fontPreview,
  };
}

/** 统一查找入口：优先内置包，其次本地已安装的远程包，最后自定义绝对路径扩展包。 */
function resolvePackEntry(packId: string): OfficialPackEntry | undefined {
  const builtin = findOfficialPack(packId);
  if (builtin) return builtin;

  const api = resolveElectronPacksApi();
  if (!api) return undefined;

  const remoteMeta = installedRemotePacks.value.find(item => item.id === packId);
  if (remoteMeta) {
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

  const customMeta = customPacks.value.find(item => item.id === packId);
  if (customMeta) {
    return {
      meta: customMeta,
      load: async () => {
        const res = await api.loadCustom({ id: customMeta.id, packDir: customMeta.packDir });
        if (!res.ok || typeof res.cssText !== 'string') {
          throw new Error(res.error || `加载自定义扩展包失败: ${packId}`);
        }
        return {
          id: customMeta.id,
          cssText: res.cssText,
        };
      },
    };
  }

  return undefined;
}

const packSlots: ActivePackSlotsState = {
  background: shallowReactive<ChatBackgroundSlots>({}),
  chatInput: shallowReactive<ChatInputSlotOverrides>({}),
  chatMessage: shallowReactive<ChatMessageSlotOverrides>({}),
  interactionCard: shallowReactive<InteractionCardSlotOverrides>({}),
  sidebar: shallowReactive<SidebarSlotOverrides>({}),
  taskProgress: shallowReactive<TaskProgressSlotOverrides>({}),
};

const activePackCount = computed(() => {
  const baseCount = Object.entries(activePackIds.value)
    .filter(([cat, val]) => cat !== 'interactionCard' && cat !== 'taskProgress' && cat !== 'chatMessage' && Boolean(val))
    .length;
  const interactionCount = Object.values(activeInteractionPackIds.value).filter(Boolean).length;
  const taskProgressCount = Object.values(activeTaskProgressPackIds.value).filter(Boolean).length;
  const chatMessageCount = Object.values(activeChatMessagePackIds.value).filter(Boolean).length;
  return baseCount + interactionCount + taskProgressCount + chatMessageCount;
});

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
  clearReactiveRecord(packSlots.interactionCard as Record<string, unknown>);
  clearReactiveRecord(packSlots.sidebar as Record<string, unknown>);
  clearReactiveRecord(packSlots.taskProgress as Record<string, unknown>);

  for (const category of PACK_CATEGORY_ORDER) {
    if (isSubTabCategory(category)) continue;
    const def = loadedDefinitions.get(category);
    if (!def?.slots) continue;
    if (def.slots.background) Object.assign(packSlots.background, def.slots.background);
    if (def.slots.chatInput) Object.assign(packSlots.chatInput, def.slots.chatInput);
    if (def.slots.chatMessage) Object.assign(packSlots.chatMessage, def.slots.chatMessage);
    if (def.slots.interactionCard) Object.assign(packSlots.interactionCard, def.slots.interactionCard);
    if (def.slots.sidebar) Object.assign(packSlots.sidebar, def.slots.sidebar);
    if (def.slots.taskProgress) Object.assign(packSlots.taskProgress, def.slots.taskProgress);
  }

  for (const tab of INTERACTION_CARD_TABS) {
    const def = loadedInteractionDefinitions.get(tab);
    if (!def?.slots?.interactionCard) continue;
    Object.assign(packSlots.interactionCard, def.slots.interactionCard);
  }

  for (const tab of TASK_PROGRESS_TABS) {
    const def = loadedTaskProgressDefinitions.get(tab);
    if (!def?.slots?.taskProgress) continue;
    Object.assign(packSlots.taskProgress, def.slots.taskProgress);
  }

  for (const tab of CHAT_MESSAGE_TABS) {
    const def = loadedChatMessageDefinitions.get(tab);
    if (!def?.slots?.chatMessage) continue;
    Object.assign(packSlots.chatMessage, def.slots.chatMessage);
  }
}

function removeCategoryStyle(doc: Document | undefined, styleKey: string): void {
  if (!doc?.head) return;
  const existing = doc.head.querySelectorAll(`style[${PACK_STYLE_ATTR}="${styleKey}"]`);
  existing.forEach(node => node.remove());
}

function removeAllPackStyles(doc: Document | undefined): void {
  if (!doc?.head) return;
  const existing = doc.head.querySelectorAll(`style[${PACK_STYLE_ATTR}]`);
  existing.forEach(node => node.remove());
}

function mountCategoryStyle(
  doc: Document | undefined,
  styleKey: string,
  packId: string,
  cssText: string,
): void {
  removeCategoryStyle(doc, styleKey);
  if (!doc?.head || !cssText) return;
  const styleEl = doc.createElement('style');
  styleEl.setAttribute(PACK_STYLE_ATTR, styleKey);
  styleEl.setAttribute('data-lx-pack-id', packId);
  styleEl.textContent = cssText;
  doc.head.appendChild(styleEl);
}

const INTERACTION_TABS_STORAGE_KEY = 'interactionCardTabs';
const TASK_PROGRESS_TABS_STORAGE_KEY = 'taskProgressTabs';
const CHAT_MESSAGE_TABS_STORAGE_KEY = 'chatMessageTabs';

function persistSelectionMap(
  storage: Storage | undefined,
  map: ActivePackSelectionMap,
  interactionMap: Partial<Record<InteractionCardTab, string>> = activeInteractionPackIds.value,
  taskProgressMap: Partial<Record<TaskProgressTab, string>> = activeTaskProgressPackIds.value,
  chatMessageMap: Partial<Record<ChatMessageTab, string>> = activeChatMessagePackIds.value,
): void {
  if (!storage) return;
  try {
    const payload: Record<string, unknown> = {};
    for (const category of PACK_CATEGORY_ORDER) {
      if (isSubTabCategory(category)) continue;
      const id = map[category];
      if (id) payload[category] = id;
    }
    const cleanedInteractionTabs: Partial<Record<InteractionCardTab, string>> = {};
    for (const tab of INTERACTION_CARD_TABS) {
      const id = interactionMap[tab];
      if (id) cleanedInteractionTabs[tab] = id;
    }
    if (Object.keys(cleanedInteractionTabs).length > 0) {
      payload[INTERACTION_TABS_STORAGE_KEY] = cleanedInteractionTabs;
    }
    const cleanedTaskTabs: Partial<Record<TaskProgressTab, string>> = {};
    for (const tab of TASK_PROGRESS_TABS) {
      const id = taskProgressMap[tab];
      if (id) cleanedTaskTabs[tab] = id;
    }
    if (Object.keys(cleanedTaskTabs).length > 0) {
      payload[TASK_PROGRESS_TABS_STORAGE_KEY] = cleanedTaskTabs;
    }
    const cleanedChatMessageTabs: Partial<Record<ChatMessageTab, string>> = {};
    for (const tab of CHAT_MESSAGE_TABS) {
      const id = chatMessageMap[tab];
      if (id) cleanedChatMessageTabs[tab] = id;
    }
    if (Object.keys(cleanedChatMessageTabs).length > 0) {
      payload[CHAT_MESSAGE_TABS_STORAGE_KEY] = cleanedChatMessageTabs;
    }
    if (Object.keys(payload).length > 0) {
      storage.setItem(PACK_STORAGE_KEY, JSON.stringify(payload));
    } else {
      storage.removeItem(PACK_STORAGE_KEY);
    }
    storage.removeItem(LEGACY_PACK_STORAGE_KEY);
  } catch {
    // 受限存储环境忽略持久化错误
  }
}

interface PersistedSelection {
  readonly categories: ActivePackSelectionMap;
  readonly interactionTabs: Partial<Record<InteractionCardTab, string>>;
  readonly taskProgressTabs: Partial<Record<TaskProgressTab, string>>;
  readonly chatMessageTabs: Partial<Record<ChatMessageTab, string>>;
}

function readPersistedSelectionMap(storage: Storage | undefined): PersistedSelection {
  if (!storage) return { categories: {}, interactionTabs: {}, taskProgressTabs: {}, chatMessageTabs: {} };
  try {
    const raw = storage.getItem(PACK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const categories: ActivePackSelectionMap = {};
      const interactionTabs: Partial<Record<InteractionCardTab, string>> = {};
      const taskProgressTabs: Partial<Record<TaskProgressTab, string>> = {};
      const chatMessageTabs: Partial<Record<ChatMessageTab, string>> = {};
      for (const category of PACK_CATEGORY_ORDER) {
        if (isSubTabCategory(category)) continue;
        const val = parsed[category];
        if (typeof val === 'string' && val.trim().length > 0) {
          categories[category] = val.trim();
        }
      }
      const tabsRaw = parsed[INTERACTION_TABS_STORAGE_KEY];
      if (tabsRaw && typeof tabsRaw === 'object') {
        for (const tab of INTERACTION_CARD_TABS) {
          const val = (tabsRaw as Record<string, unknown>)[tab];
          if (typeof val === 'string' && val.trim().length > 0) {
            interactionTabs[tab] = val.trim();
          }
        }
      }
      const taskTabsRaw = parsed[TASK_PROGRESS_TABS_STORAGE_KEY];
      if (taskTabsRaw && typeof taskTabsRaw === 'object') {
        for (const tab of TASK_PROGRESS_TABS) {
          const val = (taskTabsRaw as Record<string, unknown>)[tab];
          if (typeof val === 'string' && val.trim().length > 0) {
            taskProgressTabs[tab] = val.trim();
          }
        }
      }
      const chatMessageTabsRaw = parsed[CHAT_MESSAGE_TABS_STORAGE_KEY];
      if (chatMessageTabsRaw && typeof chatMessageTabsRaw === 'object') {
        for (const tab of CHAT_MESSAGE_TABS) {
          const val = (chatMessageTabsRaw as Record<string, unknown>)[tab];
          if (typeof val === 'string' && val.trim().length > 0) {
            chatMessageTabs[tab] = val.trim();
          }
        }
      }
      // 兼容旧版单包 interactionCard 字符串
      const legacyInteraction = parsed.interactionCard;
      if (typeof legacyInteraction === 'string' && legacyInteraction.trim().length > 0) {
        const entry = findOfficialPack(legacyInteraction.trim());
        const tab = entry?.meta.interactionTab ?? 'approval';
        if (!interactionTabs[tab]) interactionTabs[tab] = legacyInteraction.trim();
      }
      return { categories, interactionTabs, taskProgressTabs, chatMessageTabs };
    }
    const legacyId = storage.getItem(LEGACY_PACK_STORAGE_KEY);
    if (legacyId && legacyId.trim().length > 0) {
      const entry = findOfficialPack(legacyId.trim());
      if (entry) {
        if (entry.meta.category === 'interactionCard') {
          return { categories: {}, interactionTabs: { [entry.meta.interactionTab ?? 'approval']: entry.meta.id }, taskProgressTabs: {}, chatMessageTabs: {} };
        }
        if (entry.meta.category === 'taskProgress') {
          return { categories: {}, interactionTabs: {}, taskProgressTabs: { [entry.meta.taskProgressTab ?? 'background']: entry.meta.id }, chatMessageTabs: {} };
        }
        if (entry.meta.category === 'chatMessage') {
          return { categories: {}, interactionTabs: {}, taskProgressTabs: {}, chatMessageTabs: { [entry.meta.chatMessageTab ?? 'userMessage']: entry.meta.id } };
        }
        return { categories: { [entry.meta.category]: entry.meta.id }, interactionTabs: {}, taskProgressTabs: {}, chatMessageTabs: {} };
      }
    }
    return { categories: {}, interactionTabs: {}, taskProgressTabs: {}, chatMessageTabs: {} };
  } catch {
    return { categories: {}, interactionTabs: {}, taskProgressTabs: {}, chatMessageTabs: {} };
  }
}

async function selectSubTabPack<TTab extends string>(options: {
  category: 'interactionCard' | 'taskProgress' | 'chatMessage';
  packId: string | null;
  subTab: TTab | undefined;
  allTabs: readonly TTab[];
  defaultTab: TTab;
  resolveEntryTab: (entry: OfficialPackEntry | undefined) => TTab | undefined;
  stateRef: { value: Partial<Record<TTab, string>> };
  loadedMap: Map<TTab, OfficialPackDefinition>;
  doc: Document | undefined;
  storage: Storage | undefined;
  lookup: (id: string) => OfficialPackEntry | undefined;
}): Promise<boolean> {
  const { category, packId, subTab, allTabs, defaultTab, resolveEntryTab, stateRef, loadedMap, doc, storage, lookup } = options;
  if (!packId) {
    const targetTabs = subTab ? [subTab] : allTabs;
    const nextTabs = { ...stateRef.value };
    for (const tab of targetTabs) {
      removeCategoryStyle(doc, `${category}:${tab}`);
      loadedMap.delete(tab);
      delete nextTabs[tab];
    }
    stateRef.value = nextTabs;
    rebuildMergedPackSlots();
    persistSelectionMap(storage, activePackIds.value);
    return true;
  }

  const entry = lookup(packId);
  const tab = subTab ?? resolveEntryTab(entry) ?? defaultTab;
  if (!entry || entry.meta.category !== category) {
    removeCategoryStyle(doc, `${category}:${tab}`);
    loadedMap.delete(tab);
    const nextTabs = { ...stateRef.value };
    delete nextTabs[tab];
    stateRef.value = nextTabs;
    rebuildMergedPackSlots();
    persistSelectionMap(storage, activePackIds.value);
    activePackError.value = `未找到扩展包: ${packId}`;
    return false;
  }

  loadingCategory.value = category;
  try {
    const def = await entry.load();
    const cssText = buildPackCss(def);
    mountCategoryStyle(doc, `${category}:${tab}`, def.id, cssText);
    loadedMap.set(tab, def);
    rebuildMergedPackSlots();
    const nextTabs = { ...stateRef.value, [tab]: def.id };
    stateRef.value = nextTabs;
    persistSelectionMap(storage, activePackIds.value);
    return true;
  } catch (err) {
    removeCategoryStyle(doc, `${category}:${tab}`);
    loadedMap.delete(tab);
    const nextTabs = { ...stateRef.value };
    delete nextTabs[tab];
    stateRef.value = nextTabs;
    rebuildMergedPackSlots();
    activePackError.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    loadingCategory.value = null;
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
    interactionTab?: InteractionCardTab;
    taskProgressTab?: TaskProgressTab;
    chatMessageTab?: ChatMessageTab;
  } = {},
): Promise<boolean> {
  const doc = env.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const storage = env.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  const lookup = env.lookup ?? resolvePackEntry;

  activePackError.value = null;

  if (category === 'interactionCard') {
    return selectSubTabPack({
      category: 'interactionCard',
      packId,
      subTab: env.interactionTab,
      allTabs: INTERACTION_CARD_TABS,
      defaultTab: 'approval',
      resolveEntryTab: entry => entry?.meta.interactionTab,
      stateRef: activeInteractionPackIds,
      loadedMap: loadedInteractionDefinitions,
      doc,
      storage,
      lookup,
    });
  }

  if (category === 'taskProgress') {
    return selectSubTabPack({
      category: 'taskProgress',
      packId,
      subTab: env.taskProgressTab,
      allTabs: TASK_PROGRESS_TABS,
      defaultTab: 'background',
      resolveEntryTab: entry => entry?.meta.taskProgressTab,
      stateRef: activeTaskProgressPackIds,
      loadedMap: loadedTaskProgressDefinitions,
      doc,
      storage,
      lookup,
    });
  }

  if (category === 'chatMessage') {
    return selectSubTabPack({
      category: 'chatMessage',
      packId,
      subTab: env.chatMessageTab,
      allTabs: CHAT_MESSAGE_TABS,
      defaultTab: 'userMessage',
      resolveEntryTab: entry => entry?.meta.chatMessageTab,
      stateRef: activeChatMessagePackIds,
      loadedMap: loadedChatMessageDefinitions,
      doc,
      storage,
      lookup,
    });
  }

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
  loadedInteractionDefinitions.clear();
  loadedTaskProgressDefinitions.clear();
  loadedChatMessageDefinitions.clear();
  rebuildMergedPackSlots();
  activePackIds.value = {};
  activeInteractionPackIds.value = {};
  activeTaskProgressPackIds.value = {};
  activeChatMessagePackIds.value = {};
  activePackError.value = null;
  persistSelectionMap(storage, {}, {}, {}, {});
}

export async function selectCategoryPack(
  category: OfficialPackCategory,
  packId: string | null,
  subTab?: InteractionCardTab | TaskProgressTab | ChatMessageTab,
): Promise<boolean> {
  if (category === 'taskProgress') {
    return selectPackWithEnv(category, packId, { taskProgressTab: subTab as TaskProgressTab | undefined });
  }
  if (category === 'chatMessage') {
    return selectPackWithEnv(category, packId, { chatMessageTab: subTab as ChatMessageTab | undefined });
  }
  return selectPackWithEnv(category, packId, { interactionTab: subTab as InteractionCardTab | undefined });
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
    installedRemotePacks.value = res.packs.map(item => toPackMeta(item));
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

function readPersistedCustomDirs(storage: Storage | undefined): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOM_PACK_DIRS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function persistCustomDirs(storage: Storage | undefined, dirs: readonly string[]): void {
  if (!storage) return;
  try {
    if (dirs.length > 0) {
      storage.setItem(CUSTOM_PACK_DIRS_KEY, JSON.stringify([...dirs]));
    } else {
      storage.removeItem(CUSTOM_PACK_DIRS_KEY);
    }
  } catch {
    // 忽略存储限制错误
  }
}

function toCustomSourceEntry(dirPath: string, packs: readonly CustomScannedPackManifest[]): CustomPackSourceEntry {
  return {
    dirPath,
    packs: packs.map(item => ({
      ...toPackMeta(item, '本地自定义'),
      packDir: item.packDir,
    })),
  };
}

export async function refreshCustomPacks(): Promise<void> {
  const api = resolveElectronPacksApi();
  const storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
  const dirs = readPersistedCustomDirs(storage);
  if (!api || dirs.length === 0) {
    customPackSources.value = [];
    return;
  }
  const nextSources: CustomPackSourceEntry[] = [];
  for (const dirPath of dirs) {
    const res = await api.scanCustomDir(dirPath);
    if (res.ok && res.dirPath && Array.isArray(res.packs)) {
      nextSources.push(toCustomSourceEntry(res.dirPath, res.packs));
    }
  }
  customPackSources.value = nextSources;
}

export async function addCustomPackDir(rawDirPath: string): Promise<boolean> {
  const api = resolveElectronPacksApi();
  if (!api) {
    customPackError.value = '仅桌面端支持加载本地绝对路径扩展包';
    return false;
  }
  customPackLoading.value = true;
  customPackError.value = null;
  try {
    const res = await api.scanCustomDir(rawDirPath);
    if (!res.ok || !res.dirPath || !Array.isArray(res.packs)) {
      customPackError.value = res.error || '扫描自定义扩展包目录失败';
      return false;
    }
    if (res.packs.length === 0) {
      customPackError.value = `目录下未发现包含合法 manifest.json 的扩展包: ${res.dirPath}`;
      return false;
    }
    const entry = toCustomSourceEntry(res.dirPath, res.packs);
    const filtered = customPackSources.value.filter(s => s.dirPath !== res.dirPath);
    customPackSources.value = [...filtered, entry];

    const storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
    persistCustomDirs(storage, customPackSources.value.map(s => s.dirPath));
    return true;
  } catch (err) {
    customPackError.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    customPackLoading.value = false;
  }
}

export async function pickAndAddCustomPackDir(): Promise<boolean> {
  const api = resolveElectronPacksApi();
  if (!api) return false;
  const picked = await api.pickCustomDir();
  if (!picked.ok || picked.canceled || !picked.dirPath) {
    return false;
  }
  return addCustomPackDir(picked.dirPath);
}

export async function removeCustomPackDir(dirPath: string): Promise<void> {
  const targetSource = customPackSources.value.find(s => s.dirPath === dirPath);
  if (targetSource) {
    const packIds = new Set(targetSource.packs.map(p => p.id));
    for (const category of PACK_CATEGORY_ORDER) {
      if (category === 'interactionCard') {
        for (const tab of INTERACTION_CARD_TABS) {
          const activeId = activeInteractionPackIds.value[tab];
          if (activeId && packIds.has(activeId)) {
            await selectCategoryPack('interactionCard', null, tab);
          }
        }
        continue;
      }
      if (category === 'taskProgress') {
        for (const tab of TASK_PROGRESS_TABS) {
          const activeId = activeTaskProgressPackIds.value[tab];
          if (activeId && packIds.has(activeId)) {
            await selectCategoryPack('taskProgress', null, tab);
          }
        }
        continue;
      }
      if (category === 'chatMessage') {
        for (const tab of CHAT_MESSAGE_TABS) {
          const activeId = activeChatMessagePackIds.value[tab];
          if (activeId && packIds.has(activeId)) {
            await selectCategoryPack('chatMessage', null, tab);
          }
        }
        continue;
      }
      const activeId = activePackIds.value[category];
      if (activeId && packIds.has(activeId)) {
        await selectCategoryPack(category, null);
      }
    }
  }
  customPackSources.value = customPackSources.value.filter(s => s.dirPath !== dirPath);
  const storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
  persistCustomDirs(storage, customPackSources.value.map(s => s.dirPath));
}

/** 应用启动时按持久化配置恢复各分类已启用的扩展包。 */
export async function initPackHost(): Promise<void> {
  await Promise.all([refreshInstalledRemotePacks(), refreshCustomPacks()]);
  const storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
  const saved = readPersistedSelectionMap(storage);
  for (const category of PACK_CATEGORY_ORDER) {
    if (isSubTabCategory(category)) continue;
    const id = saved.categories[category];
    if (id) {
      await selectPackWithEnv(category, id);
    }
  }
  for (const tab of INTERACTION_CARD_TABS) {
    const id = saved.interactionTabs[tab];
    if (id) {
      await selectPackWithEnv('interactionCard', id, { interactionTab: tab });
    }
  }
  for (const tab of TASK_PROGRESS_TABS) {
    const id = saved.taskProgressTabs[tab];
    if (id) {
      await selectPackWithEnv('taskProgress', id, { taskProgressTab: tab });
    }
  }
  for (const tab of CHAT_MESSAGE_TABS) {
    const id = saved.chatMessageTabs[tab];
    if (id) {
      await selectPackWithEnv('chatMessage', id, { chatMessageTab: tab });
    }
  }
}

/** 供宿主（ChatView）与设置页消费的扩展包状态接口。 */
export function usePackHost() {
  return {
    activePackIds,
    activeInteractionPackIds,
    activeTaskProgressPackIds,
    activeChatMessagePackIds,
    activePackCount,
    loadingCategory,
    activePackError,
    availablePacks: OFFICIAL_PACKS,
    installedRemotePacks,
    remoteRegistryByCategory,
    remoteLoading,
    remoteError,
    customPackSources,
    customPacks,
    customPackLoading,
    customPackError,
    packSlots,
    selectCategoryPack,
    resetAllPacks,
    refreshInstalledRemotePacks,
    fetchRemoteRegistry,
    installRemotePack,
    uninstallRemotePack,
    addCustomPackDir,
    pickAndAddCustomPackDir,
    removeCustomPackDir,
    refreshCustomPacks,
  };
}
