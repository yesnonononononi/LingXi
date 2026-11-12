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
import type {ContextMenuContext, TextEditCommand} from '../src/utils/contextMenu';
import {clampMenuPosition, isMenuEnabled, resolveTextMenuItems} from '../src/utils/contextMenu';
import {messages} from '../src/i18n/messages';

const COMMANDS: readonly TextEditCommand[] = ['cut', 'copy', 'paste', 'selectAll'];

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
