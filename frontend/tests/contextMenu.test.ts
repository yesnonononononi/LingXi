/**
 * 右键菜单回归守卫（纯规则 + i18n 接线）。
 *
 * <p><b>钉住的用户可见契约：</b>右键落点决定四项命令哪些可用 —— 正文里选中一段文字要有「复制」，
 * 输入框里没有选区时「剪切/复制」是灰的、「粘贴/全选」可用，右键点在空白处不弹菜单（不弹一个
 * 四条全灰的空壳）。另一个契约是文案必须走 i18n：中英文各有一份，组件里不许写死中文。</p>
 *
 * <p>样式与坐标夹取只在组件里用，这里测的是「算出来的项」与「夹取后的坐标」。曲面渲染由
 * Electron 冒烟用例覆盖，本文件跑在 node 里，不碰 DOM。</p>
 */

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {nextTick} from 'vue';
import type {ContextMenuContext, ContextMenuCommand, ImageMenuCommand, TextEditCommand} from '../src/utils/contextMenu';
import {
  clampMenuPosition,
  IMAGE_MENU_NAME_ATTR,
  IMAGE_MENU_SRC_ATTR,
  IMAGE_MENU_TARGET_ATTR,
  isMenuEnabled,
  isTextEditCommand,
  resolveImageMenuItems,
  resolveTextMenuItems,
} from '../src/utils/contextMenu';
import {messages} from '../src/i18n/messages';

const COMMANDS: readonly TextEditCommand[] = ['cut', 'copy', 'paste', 'selectAll'];
const IMAGE_COMMANDS: readonly ImageMenuCommand[] = ['copyImage', 'saveImage'];

/** 读一个源文件并先做金丝雀校验，避免「路径写错 → 到处都找不到 → 静默变绿」。 */
function readSource(relativeUrl: string, canary: string): string {
  const source = readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
  assert.ok(source.includes(canary), `读到的不是目标文件（金丝雀未命中）：${relativeUrl}`);
  return source;
}

/** 取某条命令的禁用态；顺便断言四项恒在且顺序固定。 */
function disabledState(context: ContextMenuContext): Record<TextEditCommand, boolean> {
  const items = resolveTextMenuItems(context);
  assert.deepEqual(
    items.map(item => item.command),
    [...COMMANDS],
    '菜单项必须恒为四项且顺序固定，否则位置会随右键落点跳动'
  );
  return items.reduce((acc, item) => {
    acc[item.command] = item.disabled;
    return acc;
  }, {} as Record<TextEditCommand, boolean>);
}

// ───────────────────────── 命令可用性 ─────────────────────────

test('CM-1 可编辑 + 有选区：四项全部可用', () => {
  const state = disabledState({editable: true, readOnly: false, hasSelection: true});
  for (const command of COMMANDS) {
    assert.equal(state[command], false, `${command} 应当可用`);
  }
});

test('CM-2 可编辑 + 无选区：剪切/复制禁用，粘贴/全选可用', () => {
  const state = disabledState({editable: true, readOnly: false, hasSelection: false});
  assert.equal(state.cut, true);
  assert.equal(state.copy, true);
  assert.equal(state.paste, false);
  assert.equal(state.selectAll, false);
});

test('CM-3 只读输入框：只剩复制（有选区时）与全选，剪切/粘贴禁用', () => {
  const state = disabledState({editable: true, readOnly: true, hasSelection: true});
  assert.equal(state.copy, false, '只读框里选区照样能复制');
  assert.equal(state.cut, true);
  assert.equal(state.paste, true);
  assert.equal(state.selectAll, false, '只读框仍可全选，和系统原生菜单一致');
});

test('CM-4 非可编辑 + 有选区：只有复制可用（正文选中就该能复制）', () => {
  const state = disabledState({editable: false, readOnly: true, hasSelection: true});
  assert.equal(state.copy, false);
  assert.equal(state.cut, true);
  assert.equal(state.paste, true);
  assert.equal(state.selectAll, true);
  assert.equal(isMenuEnabled(resolveTextMenuItems({editable: false, readOnly: true, hasSelection: true})), true);
});

test('CM-5 非可编辑 + 无选区：一条都不可用，菜单不弹', () => {
  const context: ContextMenuContext = {editable: false, readOnly: true, hasSelection: false};
  const items = resolveTextMenuItems(context);
  for (const item of items) {
    assert.equal(item.disabled, true, `${item.command} 应当禁用`);
  }
  assert.equal(isMenuEnabled(items), false, '全禁用时不得弹菜单');
});

// ───────────────────────── 坐标夹取 ─────────────────────────

test('CM-6 落点在视口内：坐标原样返回', () => {
  assert.deepEqual(
    clampMenuPosition({x: 100, y: 120}, {width: 160, height: 130}, {width: 1000, height: 800}),
    {x: 100, y: 120}
  );
});

test('CM-7 落点贴着右下角：向左上翻回，不越界', () => {
  assert.deepEqual(
    clampMenuPosition({x: 980, y: 790}, {width: 160, height: 130}, {width: 1000, height: 800}),
    {x: 1000 - 160 - 8, y: 800 - 130 - 8}
  );
});

test('CM-8 落点为负 / 视口比菜单还小：夹到留白边距', () => {
  assert.deepEqual(
    clampMenuPosition({x: -40, y: -20}, {width: 160, height: 130}, {width: 1000, height: 800}),
    {x: 8, y: 8}
  );
  assert.deepEqual(
    clampMenuPosition({x: 5, y: 5}, {width: 400, height: 300}, {width: 200, height: 150}),
    {x: 8, y: 8}
  );
});

// ───────────────────────── i18n 接线 ─────────────────────────

test('CM-9 中英文各有四条命令文案，且不是同一个串', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const dict = messages[locale].contextMenu as unknown as Record<string, string> | undefined;
    assert.ok(dict, `${locale} 缺少 contextMenu 树`);
    for (const command of COMMANDS) {
      const label = dict[command];
      assert.equal(typeof label, 'string', `${locale} 缺少 contextMenu.${command}`);
      assert.ok(label.trim().length > 0, `${locale} 的 contextMenu.${command} 不能是空串`);
    }
  }
  const zh = messages['zh-CN'].contextMenu as unknown as Record<string, string>;
  const en = messages['en-US'].contextMenu as unknown as Record<string, string>;
  assert.notEqual(zh.copy, en.copy, '中英文必须真的翻译过，不能两边都是中文');
});

test('CM-10 t() 按当前语言取到菜单文案（组件用的就是这条动态 key）', async () => {
  const i18n = await import('../src/i18n/index');
  const {t, setPreference} = i18n.useI18n();
  setPreference('zh-CN');
  await nextTick();
  for (const command of COMMANDS) {
    assert.equal(t(`contextMenu.${command}`), (messages['zh-CN'].contextMenu as Record<string, string>)[command]);
  }
  setPreference('en-US');
  await nextTick();
  assert.equal(t('contextMenu.selectAll'), 'Select all');
});

test('CM-11 组件里不许写死菜单文案（必须走 t()）', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/components/common/ContextMenu.vue', import.meta.url)),
    'utf8'
  );
  // 金丝雀：先确认读到的确实是这个组件（文件读错/路径写错时这里先红）
  assert.ok(source.includes('role="menu"'), '读到的不是右键菜单组件');
  assert.ok(source.includes('t(`contextMenu.${item.command}`)'), '菜单项文案必须走 t() 取 i18n');
  // 只看模板：注释里出现「粘贴」是解释行为，渲染出去的文案才是要守的
  const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));
  assert.ok(template.length > 0, '没切到模板段，扫描器失效');
  for (const literal of ['剪切', '复制', '粘贴', '全选', 'Cut', 'Copy', 'Paste']) {
    assert.equal(template.includes(literal), false, `模板里出现了写死的文案：${literal}`);
  }
});

// ───────────────────────── 图片菜单（复制图片 / 保存图片） ─────────────────────────

test('IM-1 图片落点恒出两项，顺序固定且都可用', () => {
  const items = resolveImageMenuItems();
  assert.deepEqual(
    items.map(item => item.command),
    [...IMAGE_COMMANDS],
    '图片菜单必须恒为「复制图片 → 保存图片」两项，顺序固定'
  );
  for (const item of items) {
    assert.equal(item.disabled, false, `${item.command} 不得预先灰掉：失败只有执行时才知道`);
  }
});

test('IM-2 命令分组只有一组能走主进程文本白名单', () => {
  const members: ContextMenuCommand[] = [...COMMANDS, ...IMAGE_COMMANDS];
  for (const command of members) {
    assert.equal(
      isTextEditCommand(command),
      (COMMANDS as readonly string[]).includes(command),
      `${command} 的分组判错了：图片命令绝不能走 edit:command`
    );
  }
});

test('IM-3 中英文各有图片两项文案，且不是同一个串', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const dict = messages[locale].contextMenu as unknown as Record<string, string>;
    for (const command of IMAGE_COMMANDS) {
      const label = dict[command];
      assert.equal(typeof label, 'string', `${locale} 缺少 contextMenu.${command}`);
      assert.ok(label.trim().length > 0, `${locale} 的 contextMenu.${command} 不能是空串`);
    }
  }
  const zh = messages['zh-CN'].contextMenu as unknown as Record<string, string>;
  const en = messages['en-US'].contextMenu as unknown as Record<string, string>;
  assert.notEqual(zh.copyImage, en.copyImage, '中英文必须真的翻译过');
  assert.notEqual(zh.copyImage, zh.saveImage, '两项文案不能一样，否则用户分不清');
});

test('IM-4 大图声明图片落点属性，且属性名只有一份（渲染方与探测方共用常量）', () => {
  const lightbox = readSource('../src/components/common/ImageLightbox.vue', 'lx-image-lightbox__image');
  assert.ok(lightbox.includes('v-bind="imageMenuAttrs"'), '大图必须用共用的属性表挂落点');
  // 只看 imageMenuAttrs 那一段：属性名必须逐个来自常量，不许在组件里重写一遍
  const start = lightbox.indexOf('const imageMenuAttrs');
  const end = lightbox.indexOf('});', start);
  assert.ok(start > 0 && end > start, '没找到 imageMenuAttrs 定义，扫描器失效');
  const attrBlock = lightbox.slice(start, end);
  for (const constant of ['IMAGE_MENU_TARGET_ATTR', 'IMAGE_MENU_SRC_ATTR', 'IMAGE_MENU_NAME_ATTR']) {
    assert.ok(attrBlock.includes(constant), `大图缺少落点属性：${constant}`);
  }
  assert.ok(
    lightbox.includes("from '../../utils/contextMenu'"),
    '属性名必须从 utils/contextMenu 导入，不能在组件里重写一遍'
  );
  for (const literal of [IMAGE_MENU_TARGET_ATTR, IMAGE_MENU_SRC_ATTR, IMAGE_MENU_NAME_ATTR]) {
    assert.equal(
      lightbox.includes(`'${literal}'`) || lightbox.includes(`"${literal}"`),
      false,
      `不许在组件里写死属性名字面量：${literal}`
    );
  }
});

test('IM-5 图片探测先于文本探测，且模态框内的菜单挂进 dialog', () => {
  const source = readSource('../src/composables/useContextMenu.ts', 'export const useContextMenu');
  const textProbe = source.indexOf('const openTextMenu');
  const imageCallInTextProbe = source.indexOf('if (openImageMenu(event))', textProbe);
  assert.ok(textProbe > 0 && imageCallInTextProbe > textProbe, '图片落点必须在文本探测之前分流');
  assert.ok(
    source.includes('element.closest(\'dialog\')') || source.includes("element.closest('dialog')"),
    '落在模态 dialog 内必须把浮层挂进 dialog —— body 层的浮层会被 top layer 盖住'
  );
});

test('IM-6 浮层挂载目标是动态的，且命令派发走统一的 runMenuCommand', () => {
  const source = readSource('../src/components/common/ContextMenu.vue', 'role="menu"');
  assert.ok(source.includes('<Teleport :to="mountTarget">'), 'Teleport 目标必须跟着落点走');
  assert.ok(source.includes('state.mountTarget ?? \'body\''), '默认仍然挂 body，文本菜单行为不变');
  assert.equal(source.includes('runTextCommand'), false, '菜单项派发必须走统一的 runMenuCommand');
  assert.equal(
    (source.match(/runMenuCommand\(/g) ?? []).length >= 2,
    true,
    '点击与回车两条路径都必须走 runMenuCommand'
  );
});
