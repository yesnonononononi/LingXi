<script setup lang="ts">
import {computed, onMounted, ref} from 'vue';
import {useI18n} from '../../../i18n';
import {usePackHost} from '../../../packs/packHost';
import {listOfficialPacksByCategory} from '../../../packs/packRegistry';
import type {OfficialPackCategory, OfficialPackMeta} from '../../../packs/types';
import {isElectron, type RemotePackManifest} from '../../../utils/platform';

const { t, locale } = useI18n();
const {
  activePackIds,
  activePackCount,
  loadingCategory,
  activePackError,
  installedRemotePacks,
  remoteRegistryByCategory,
  remoteLoading,
  remoteError,
  selectCategoryPack,
  resetAllPacks,
  refreshInstalledRemotePacks,
  fetchRemoteRegistry,
  installRemotePack,
  uninstallRemotePack,
} = usePackHost();

const desktopAvailable = isElectron();
const isZh = computed(() => locale.value === 'zh-CN');

const selectedCategory = ref<OfficialPackCategory | null>(null);
const transitionName = ref<'pack-slide-forward' | 'pack-slide-back'>('pack-slide-forward');

interface CategoryDescriptor {
  readonly key: OfficialPackCategory;
  readonly label: string;
  readonly desc: string;
}

const categories = computed<readonly CategoryDescriptor[]>(() => [
  {
    key: 'theme',
    label: isZh.value ? '主题皮肤' : 'Themes',
    desc: isZh.value ? '调整全局明暗配色、强调色与面板表面质感' : 'Colors, accents, and surface palette',
  },
  {
    key: 'font',
    label: isZh.value ? '文字字体' : 'Fonts',
    desc: isZh.value ? '替换正文字体与代码块等宽字体族，可与任意主题叠加' : 'Body and code font families',
  },
  {
    key: 'background',
    label: isZh.value ? '主页背景' : 'Backgrounds',
    desc: isZh.value ? '替换主页背景装饰表面（自定义背景图片优先级更高）' : 'Home canvas background surface',
  },
  {
    key: 'sidebar',
    label: isZh.value ? '侧边栏' : 'Sidebar',
    desc: isZh.value ? '改造侧边栏容器形态并替换底部栏 Slot 组件' : 'Sidebar layout and footer slot',
  },
  {
    key: 'input',
    label: isZh.value ? '输入框' : 'Input Box',
    desc: isZh.value ? '定制输入卡片质感、聚焦光环与输入区 Slot 组件' : 'Input box styling and input slots',
  },
  {
    key: 'component',
    label: isZh.value ? '组件与动效' : 'Components',
    desc: isZh.value ? '替换局部交互 Slot 组件或调整流式渲染动效' : 'Slot components and streaming motion',
  },
]);

const activeCategoryDescriptor = computed(() =>
  selectedCategory.value ? categories.value.find(c => c.key === selectedCategory.value) ?? null : null,
);

const listCategoryCards = (category: OfficialPackCategory): readonly { meta: OfficialPackMeta; isRemote: boolean }[] => {
  const builtins = listOfficialPacksByCategory(category).map(entry => ({
    meta: entry.meta,
    isRemote: false,
  }));
  const remotes = installedRemotePacks.value
    .filter(meta => meta.category === category)
    .map(meta => ({ meta, isRemote: true }));
  return [...builtins, ...remotes];
};

const resolveActivePackName = (category: OfficialPackCategory): string | null => {
  const activeId = activePackIds.value[category];
  if (!activeId) return null;
  const found = listCategoryCards(category).find(item => item.meta.id === activeId);
  return found ? found.meta.name : activeId;
};

const installedIdSet = computed(() => new Set(installedRemotePacks.value.map(item => item.id)));

const currentRemoteList = computed<readonly RemotePackManifest[]>(() => {
  if (!selectedCategory.value) return [];
  return remoteRegistryByCategory.value[selectedCategory.value] ?? [];
});

const hasFetchedCurrentCategory = computed(() => {
  if (!selectedCategory.value) return false;
  return Object.prototype.hasOwnProperty.call(remoteRegistryByCategory.value, selectedCategory.value);
});

const enterCategory = (category: OfficialPackCategory): void => {
  transitionName.value = 'pack-slide-forward';
  selectedCategory.value = category;
  if (desktopAvailable && !Object.prototype.hasOwnProperty.call(remoteRegistryByCategory.value, category)) {
    void fetchRemoteRegistry(category);
  }
};

const backToCategories = (): void => {
  transitionName.value = 'pack-slide-back';
  selectedCategory.value = null;
};

const handleSelect = async (category: OfficialPackCategory, packId: string | null): Promise<void> => {
  await selectCategoryPack(category, packId);
};

const handleInstallAndApply = async (manifest: RemotePackManifest): Promise<void> => {
  const ok = await installRemotePack(manifest);
  if (ok) {
    await selectCategoryPack(manifest.category, manifest.id);
  }
};

const handleUninstall = async (packId: string): Promise<void> => {
  await uninstallRemotePack(packId);
};

onMounted(() => {
  if (desktopAvailable) {
    void refreshInstalledRemotePacks();
  }
});
</script>

<template>
  <div class="relative overflow-hidden" data-testid="packs-tab">
    <Transition :name="transitionName" mode="out-in">
      <!-- 一级页面：类目总览列表 -->
      <div v-if="!selectedCategory" key="category-overview" class="space-y-4" data-testid="packs-category-overview">
        <header class="flex items-start justify-between gap-3">
          <div class="flex flex-col min-w-0">
            <div class="flex items-center gap-2">
              <h4 class="text-sm font-semibold text-lx-primary">{{ t('settings.general.appearancePack') }}</h4>
              <span
                v-if="activePackCount > 0"
                class="px-1.5 py-0.5 rounded-full text-lx-fs-2xs font-medium bg-lx-accent-soft text-lx-accent"
              >
                {{ isZh ? `已启用 ${activePackCount} 项` : `${activePackCount} active` }}
              </span>
            </div>
            <p class="text-lx-fs-sm text-lx-muted mt-1 leading-relaxed">{{ t('settings.general.appearancePackDesc') }}</p>
          </div>
          <button
            v-if="activePackCount > 0"
            type="button"
            data-testid="packs-reset-all"
            @click="resetAllPacks"
            class="shrink-0 px-2.5 py-1.5 rounded-lg border border-lx-border-subtle text-lx-fs-xs font-medium text-lx-secondary hover:text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer"
          >
            {{ isZh ? '全部恢复默认' : 'Reset all' }}
          </button>
        </header>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            v-for="cat in categories"
            :key="cat.key"
            type="button"
            :data-testid="`pack-category-card-${cat.key}`"
            @click="enterCategory(cat.key)"
            class="group p-4 rounded-2xl border border-lx-border-subtle bg-lx-surface-sunken hover:border-lx-border hover:bg-lx-surface-hover transition text-left cursor-pointer flex flex-col gap-2"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-semibold text-lx-primary">{{ cat.label }}</span>
              <svg
                class="w-4 h-4 text-lx-faint group-hover:text-lx-primary group-hover:translate-x-0.5 transition-all shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 5l7 7-7 7" />
              </svg>
            </div>

            <p class="text-lx-fs-xs text-lx-muted leading-relaxed line-clamp-2">{{ cat.desc }}</p>

            <div class="flex items-center justify-between gap-2 mt-auto pt-1">
              <span
                v-if="resolveActivePackName(cat.key)"
                class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-lx-accent-soft text-lx-accent text-lx-fs-2xs font-medium truncate max-w-[70%]"
              >
                <span class="w-1.5 h-1.5 rounded-full bg-lx-accent shrink-0" aria-hidden="true" />
                <span class="truncate">{{ resolveActivePackName(cat.key) }}</span>
              </span>
              <span v-else class="text-lx-fs-2xs text-lx-faint">
                {{ t('settings.general.appearancePackDefault') }}
              </span>

              <span class="text-lx-fs-2xs text-lx-tertiary shrink-0">
                {{ isZh ? `${listCategoryCards(cat.key).length} 个可用` : `${listCategoryCards(cat.key).length} local` }}
              </span>
            </div>
          </button>
        </div>
      </div>

      <!-- 二级页面：单个类目详情页（内置 + 按类目从 GitHub 拉取） -->
      <div
        v-else
        :key="`category-detail-${selectedCategory}`"
        class="space-y-5"
        :data-testid="`pack-detail-${selectedCategory}`"
      >
        <!-- 返回栏 -->
        <header class="flex items-center justify-between gap-3 pb-3 border-b border-lx-border-faint">
          <div class="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              data-testid="packs-back-btn"
              @click="backToCategories"
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-lx-border-subtle bg-lx-surface-sunken text-lx-fs-xs font-medium text-lx-secondary hover:text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer shrink-0"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
              <span>{{ isZh ? '返回类目' : 'Categories' }}</span>
            </button>
            <div class="flex flex-col min-w-0">
              <h4 class="text-sm font-semibold text-lx-primary truncate">{{ activeCategoryDescriptor?.label }}</h4>
              <p class="text-lx-fs-xs text-lx-muted truncate">{{ activeCategoryDescriptor?.desc }}</p>
            </div>
          </div>

          <button
            v-if="activePackIds[selectedCategory]"
            type="button"
            @click="handleSelect(selectedCategory, null)"
            class="shrink-0 px-2.5 py-1 rounded-lg border border-lx-border-subtle text-lx-fs-xs text-lx-secondary hover:text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer"
          >
            {{ isZh ? '恢复默认' : 'Reset' }}
          </button>
        </header>

        <!-- 本地已就绪（内置 + 已安装远程包） -->
        <section class="space-y-2.5">
          <h5 class="text-xs font-semibold text-lx-primary-soft">
            {{ isZh ? '内置与已安装' : 'Built-in & Installed' }}
          </h5>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <!-- 默认项 -->
            <button
              type="button"
              :data-testid="`pack-${selectedCategory}-default`"
              :disabled="loadingCategory === selectedCategory"
              @click="handleSelect(selectedCategory, null)"
              :class="[
                'p-3 rounded-2xl border text-left transition cursor-pointer flex flex-col gap-1.5',
                !activePackIds[selectedCategory]
                  ? 'border-lx-accent bg-lx-accent-soft text-lx-primary'
                  : 'border-lx-border-subtle bg-lx-surface-sunken text-lx-secondary hover:border-lx-border hover:bg-lx-surface-hover'
              ]"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold truncate">{{ t('settings.general.appearancePackDefault') }}</span>
                <span class="w-2 h-2 rounded-full bg-lx-border-strong shrink-0" />
              </div>
              <span class="text-lx-fs-xs text-lx-muted leading-relaxed">{{ t('settings.general.appearancePackDefaultDesc') }}</span>
            </button>

            <!-- 该类目下可用扩展包 -->
            <div
              v-for="item in listCategoryCards(selectedCategory)"
              :key="item.meta.id"
              role="button"
              tabindex="0"
              :data-testid="`appearance-pack-${item.meta.id}`"
              @click="handleSelect(selectedCategory, item.meta.id)"
              @keydown.enter.prevent="handleSelect(selectedCategory, item.meta.id)"
              @keydown.space.prevent="handleSelect(selectedCategory, item.meta.id)"
              :class="[
                'p-3 rounded-2xl border text-left transition cursor-pointer flex flex-col gap-2',
                activePackIds[selectedCategory] === item.meta.id
                  ? 'border-lx-accent bg-lx-accent-soft text-lx-primary'
                  : 'border-lx-border-subtle bg-lx-surface-sunken text-lx-secondary hover:border-lx-border hover:bg-lx-surface-hover'
              ]"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-xs font-semibold truncate">{{ item.meta.name }}</span>
                  <span class="text-lx-fs-2xs text-lx-faint shrink-0">v{{ item.meta.version }}</span>
                </div>

                <div class="flex items-center gap-1.5 shrink-0">
                  <span v-if="item.meta.preview" class="flex items-center gap-1" aria-hidden="true">
                    <span class="w-2.5 h-2.5 rounded-full border border-lx-border-subtle" :style="{ backgroundColor: item.meta.preview.canvas }" />
                    <span class="w-2.5 h-2.5 rounded-full border border-lx-border-subtle" :style="{ backgroundColor: item.meta.preview.surface }" />
                    <span class="w-2.5 h-2.5 rounded-full border border-lx-border-subtle" :style="{ backgroundColor: item.meta.preview.accent }" />
                  </span>
                  <button
                    v-if="item.isRemote"
                    type="button"
                    :disabled="remoteLoading"
                    @click.stop="handleUninstall(item.meta.id)"
                    class="px-1.5 py-0.5 rounded-md text-lx-fs-2xs text-lx-muted hover:text-lx-danger hover:bg-lx-danger-soft transition cursor-pointer"
                  >
                    {{ isZh ? '卸载' : 'Remove' }}
                  </button>
                </div>
              </div>

              <div
                v-if="item.meta.fontPreview"
                class="px-2.5 py-1.5 rounded-xl bg-lx-surface border border-lx-border-faint text-xs text-lx-primary truncate"
                :style="{ fontFamily: item.meta.fontPreview.family }"
              >
                {{ item.meta.fontPreview.sample }}
              </div>

              <span class="text-lx-fs-xs text-lx-muted leading-relaxed">{{ item.meta.description }}</span>

              <div class="flex items-center gap-1 flex-wrap mt-auto pt-0.5">
                <span
                  v-for="cap in item.meta.capabilities"
                  :key="cap"
                  class="px-1.5 py-0.5 rounded-md bg-lx-surface border border-lx-border-faint text-lx-fs-2xs text-lx-tertiary"
                >
                  {{ cap }}
                </span>
              </div>
            </div>
          </div>
        </section>

        <!-- 按当前类目从 GitHub 拉取在线扩展包 -->
        <section
          v-if="desktopAvailable"
          data-testid="packs-github-registry"
          class="rounded-2xl border border-lx-border-subtle p-4 space-y-3 bg-lx-surface-sunken"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col min-w-0">
              <span class="text-xs font-semibold text-lx-primary-soft">
                {{ isZh ? `GitHub 在线 · ${activeCategoryDescriptor?.label}` : `GitHub Online · ${activeCategoryDescriptor?.label}` }}
              </span>
              <span class="text-lx-fs-xs text-lx-muted mt-0.5 truncate">
                yesnonononononi/lingxi-packs · categories/{{ selectedCategory }}.json
              </span>
            </div>
            <button
              type="button"
              data-testid="packs-fetch-registry"
              :disabled="remoteLoading"
              @click="fetchRemoteRegistry(selectedCategory)"
              class="shrink-0 px-3 py-1.5 rounded-xl border border-lx-border bg-lx-surface text-lx-fs-xs font-medium text-lx-primary hover:bg-lx-surface-hover disabled:opacity-50 transition cursor-pointer"
            >
              {{ remoteLoading ? (isZh ? '拉取中...' : 'Fetching...') : (isZh ? '刷新在线列表' : 'Refresh') }}
            </button>
          </div>

          <p v-if="remoteError" class="text-lx-fs-xs text-lx-danger">{{ remoteError }}</p>

          <div v-if="currentRemoteList.length > 0" class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div
              v-for="remote in currentRemoteList"
              :key="remote.id"
              class="p-3 rounded-xl border border-lx-border-subtle bg-lx-surface flex flex-col gap-2"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-xs font-semibold text-lx-primary truncate">{{ remote.name }}</span>
                  <span class="text-lx-fs-2xs text-lx-faint shrink-0">v{{ remote.version }}</span>
                </div>
                <span v-if="remote.preview" class="flex items-center gap-1 shrink-0" aria-hidden="true">
                  <span class="w-2.5 h-2.5 rounded-full border border-lx-border-subtle" :style="{ backgroundColor: remote.preview.canvas }" />
                  <span class="w-2.5 h-2.5 rounded-full border border-lx-border-subtle" :style="{ backgroundColor: remote.preview.accent }" />
                </span>
              </div>
              <span class="text-lx-fs-xs text-lx-muted leading-relaxed">{{ remote.description }}</span>
              <div class="flex items-center justify-end gap-1.5 mt-auto pt-1">
                <button
                  v-if="installedIdSet.has(remote.id)"
                  type="button"
                  :disabled="remoteLoading"
                  @click="handleUninstall(remote.id)"
                  class="px-2 py-1 rounded-lg border border-lx-border-subtle text-lx-fs-xs text-lx-muted hover:text-lx-danger hover:bg-lx-danger-soft transition cursor-pointer"
                >
                  {{ isZh ? '卸载' : 'Remove' }}
                </button>
                <button
                  type="button"
                  :disabled="remoteLoading"
                  @click="handleInstallAndApply(remote)"
                  class="px-2.5 py-1 rounded-lg bg-lx-accent text-lx-on-accent text-lx-fs-xs font-medium hover:bg-lx-accent-hover transition cursor-pointer"
                >
                  {{ installedIdSet.has(remote.id) ? (isZh ? '更新并启用' : 'Update & Apply') : (isZh ? '安装并启用' : 'Install & Apply') }}
                </button>
              </div>
            </div>
          </div>

          <p
            v-else-if="hasFetchedCurrentCategory && !remoteLoading && !remoteError"
            class="text-lx-fs-xs text-lx-faint py-1"
          >
            {{ isZh ? '该类目下暂无更多 GitHub 在线扩展包。' : 'No remote packs available in this category yet.' }}
          </p>
        </section>

        <p v-if="activePackError" class="text-lx-fs-xs text-lx-danger">{{ activePackError }}</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.pack-slide-forward-enter-active,
.pack-slide-forward-leave-active,
.pack-slide-back-enter-active,
.pack-slide-back-leave-active {
  transition: opacity 180ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.pack-slide-forward-enter-from {
  opacity: 0;
  transform: translateX(18px);
}
.pack-slide-forward-leave-to {
  opacity: 0;
  transform: translateX(-18px);
}

.pack-slide-back-enter-from {
  opacity: 0;
  transform: translateX(-18px);
}
.pack-slide-back-leave-to {
  opacity: 0;
  transform: translateX(18px);
}

@media (prefers-reduced-motion: reduce) {
  .pack-slide-forward-enter-active,
  .pack-slide-forward-leave-active,
  .pack-slide-back-enter-active,
  .pack-slide-back-leave-active {
    transition: none;
  }
}
</style>
