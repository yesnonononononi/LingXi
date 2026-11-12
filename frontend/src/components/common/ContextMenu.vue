<script setup lang="ts">
/**
 * 全站唯一的右键菜单。
 *
 * <p>既负责监听（document 上的 contextmenu）也负责渲染（Teleport 到 body 的浮层），
 * 因为这两件事必须成对存在：少一个监听就少一个菜单，多一份监听就会弹出两份。
 * 规则与状态见 {@link ../../utils/contextMenu} 与 {@link ../../composables/useContextMenu}。</p>
 *
 * <p>三个不能动的细节：① 菜单本身用 `pointerdown.prevent` 吞掉按下，否则输入框失焦、
 * 粘贴会落空；② 只有真的弹出才 `preventDefault`，让 Monaco 等自带菜单的区域先声明主权
 * （它们会自己 preventDefault，这里据此让位）；③ 坐标必须实测后夹取，右键点在屏幕右下角时
 * 菜单不会跑到视口外。</p>
 */
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {t} from '../../i18n';
import {useContextMenu} from '../../composables/useContextMenu';
import {clampMenuPosition} from '../../utils/contextMenu';

const {state, openTextMenu, closeTextMenu, runTextCommand} = useContextMenu();

const menuRef = ref<HTMLElement | null>(null);
/** 实测尺寸后夹取到的落点；未测量前先用右键坐标顶上，避免闪到左上角。 */
const position = ref({x: 0, y: 0});
/** 键盘导航的高亮项（-1 表示没有高亮）。 */
const activeIndex = ref(-1);

const items = computed(() => state.items);

/** 第一个可用项的下标；全禁用时返回 -1。 */
const firstEnabledIndex = (): number => items.value.findIndex(item => !item.disabled);

/**
 * 按实测尺寸把浮层夹进视口。
 *
 * <p>必须在渲染后测：菜单高度取决于语言（中英文行高不同）与禁用项数量，
 * 靠估算会在边界处露头。</p>
 */
const syncPosition = (): void => {
  const element = menuRef.value;
  if (!element) {
    return;
  }
  const rect = element.getBoundingClientRect();
  position.value = clampMenuPosition(
    {x: state.x, y: state.y},
    {width: rect.width, height: rect.height},
    {width: window.innerWidth, height: window.innerHeight}
  );
};

watch(
  () => [state.open, state.x, state.y] as const,
  async ([open]) => {
    if (!open) {
      return;
    }
    position.value = {x: state.x, y: state.y};
    activeIndex.value = firstEnabledIndex();
    await nextTick();
    syncPosition();
  },
  {immediate: true}
);

/** 打开菜单。落点没有任何可用命令时保持浏览器默认行为。 */
const handleContextMenu = (event: MouseEvent): void => {
  // 自带菜单的组件（Monaco、代码预览）会先 preventDefault，这里让位，不叠两层菜单
  if (event.defaultPrevented) {
    return;
  }
  if (openTextMenu(event)) {
    event.preventDefault();
  }
};

/** 点/滚/失焦都关闭：菜单锚在屏幕坐标上，页面一动就跟内容脱节。 */
const handlePointerDown = (event: PointerEvent): void => {
  if (!state.open) {
    return;
  }
  const element = menuRef.value;
  if (element && event.target instanceof Node && element.contains(event.target)) {
    return;
  }
  closeTextMenu();
};

const handleDismiss = (): void => {
  if (state.open) {
    closeTextMenu();
  }
};

const moveActive = (step: number): void => {
  const count = items.value.length;
  if (!count) {
    return;
  }
  let next = activeIndex.value;
  for (let moved = 0; moved < count; moved += 1) {
    next = (next + step + count) % count;
    if (!items.value[next]?.disabled) {
      activeIndex.value = next;
      return;
    }
  }
};

/**
 * 菜单打开期间接管键盘。
 *
 * <p>必须挂在**捕获阶段**并阻断传播：菜单打开时焦点仍留在原输入框里（否则粘贴落空），
 * 而聊天输入框的 Enter 会直接发送消息 —— 不拦的话「按回车确认菜单项」会顺带把消息发出去。</p>
 */
const handleKeydown = (event: KeyboardEvent): void => {
  if (!state.open) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeTextMenu();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    moveActive(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key === 'Enter') {
    const item = items.value[activeIndex.value];
    if (!item || item.disabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    runTextCommand(item.command);
  }
};

onMounted(() => {
  document.addEventListener('contextmenu', handleContextMenu);
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('resize', handleDismiss);
  window.addEventListener('blur', handleDismiss);
  window.addEventListener('scroll', handleDismiss, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', handleContextMenu);
  document.removeEventListener('pointerdown', handlePointerDown, true);
  document.removeEventListener('keydown', handleKeydown, true);
  window.removeEventListener('resize', handleDismiss);
  window.removeEventListener('blur', handleDismiss);
  window.removeEventListener('scroll', handleDismiss, true);
});

/**
 * 菜单项配色。
 *
 * <p>一律用语义令牌（`lx-*`），不写死 zinc/black —— 换主题包时菜单跟着走，
 * 也不用在中英文之外再维护一套明暗分支。</p>
 */
const itemClass = (index: number, disabled: boolean): string[] => [
  'w-full px-3 py-1.5 rounded-lx-sm text-left text-xs leading-[18px] transition-colors select-none border-0',
  disabled ? 'text-lx-faint cursor-default bg-transparent' : 'text-lx-secondary cursor-pointer',
  !disabled && index === activeIndex.value ? 'bg-lx-surface-selected' : 'bg-transparent',
];
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.open"
      ref="menuRef"
      role="menu"
      aria-orientation="vertical"
      class="fixed z-[1000] flex flex-col gap-0.5 min-w-[8.5rem] rounded-lx-md border p-1 backdrop-blur-2xl bg-lx-surface-elevated border-lx-border-strong shadow-lx-3"
      :style="{left: position.x + 'px', top: position.y + 'px'}"
      @pointerdown.prevent
      @contextmenu.prevent
    >
      <button
        v-for="(item, index) in items"
        :key="item.command"
        type="button"
        role="menuitem"
        :data-command="item.command"
        :disabled="item.disabled"
        :class="itemClass(index, item.disabled)"
        @mouseenter="activeIndex = item.disabled ? activeIndex : index"
        @click="runTextCommand(item.command)"
      >{{ t(`contextMenu.${item.command}`) }}</button>
    </div>
  </Teleport>
</template>
