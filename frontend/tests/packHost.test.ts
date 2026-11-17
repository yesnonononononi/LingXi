import assert from 'node:assert/strict';
import test from 'node:test';
import {defineComponent} from 'vue';
import {
  PACK_STORAGE_KEY,
  PACK_STYLE_ATTR,
  buildPackCss,
  resetAllPacksWithEnv,
  selectPackWithEnv,
  usePackHost,
} from '../src/packs/packHost';
import type {OfficialPackCategory, OfficialPackDefinition, OfficialPackEntry} from '../src/packs/types';

function createFakeDom() {
  const styles: Array<{ attrs: Record<string, string>; textContent: string; remove: () => void }> = [];
  const head = {
    querySelectorAll(selector: string) {
      const exactMatch = selector.match(/^style\[data-lx-pack="([^"]+)"\]$/);
      if (exactMatch) {
        return styles.filter(s => s.attrs[PACK_STYLE_ATTR] === exactMatch[1]);
      }
      if (selector === `style[${PACK_STYLE_ATTR}]`) {
        return [...styles];
      }
      return [];
    },
    appendChild(el: { attrs: Record<string, string>; textContent: string; remove: () => void }) {
      styles.push(el);
    },
  };
  const doc = {
    head,
    createElement(tag: string) {
      assert.equal(tag, 'style');
      const node = {
        attrs: {} as Record<string, string>,
        textContent: '',
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
        remove() {
          const idx = styles.indexOf(node);
          if (idx >= 0) styles.splice(idx, 1);
        },
      };
      return node;
    },
  };
  return { doc: doc as unknown as Document, styles };
}

function createFakeStorage() {
  const map = new Map<string, string>();
  return {
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    } as unknown as Storage,
    map,
  };
}

function makeEntry(
  id: string,
  category: OfficialPackCategory,
  load: () => Promise<OfficialPackDefinition>,
): OfficialPackEntry {
  return {
    meta: {
      id,
      category,
      name: id,
      description: id,
      version: '1.0.0',
      capabilities: [category],
    },
    load,
  };
}

test('buildPackCss 生成 @font-face、字体变量及自定义 CSS', () => {
  const def: OfficialPackDefinition = {
    id: 'demo',
    fonts: [
      { family: 'DemoSans', src: '/fonts/sans.woff2', weight: '400', target: 'sans' },
      { family: 'DemoCode', src: '/fonts/code.woff2', target: 'code' },
    ],
    cssText: ':root { --lx-accent: #ff0000; }',
  };
  const css = buildPackCss(def);
  assert.match(css, /@font-face/);
  assert.match(css, /font-family: 'DemoSans'/);
  assert.match(css, /--font-sans: 'DemoSans'/);
  assert.match(css, /--font-lx-code: 'DemoCode'/);
  assert.match(css, /--lx-accent: #ff0000;/);
});

test('selectPackWithEnv 支持跨分类叠加、单分类卸载零残留与全部重置', async () => {
  const { doc, styles } = createFakeDom();
  const { storage, map } = createFakeStorage();
  const FakeBg = defineComponent({ name: 'FakeBg', render: () => null });
  const FakeSend = defineComponent({ name: 'FakeSend', render: () => null });

  const entries: Record<string, OfficialPackEntry> = {
    themeA: makeEntry('themeA', 'theme', async () => ({
      id: 'themeA',
      cssText: ':root { --lx-accent: #111111; }',
    })),
    bgA: makeEntry('bgA', 'background', async () => ({
      id: 'bgA',
      slots: { background: { surface: FakeBg } },
    })),
    compA: makeEntry('compA', 'component', async () => ({
      id: 'compA',
      cssText: '.codex-text-arrival { animation-duration: 500ms; }',
      slots: { chatInput: { sendButton: FakeSend } },
    })),
  };

  const host = usePackHost();
  resetAllPacksWithEnv({ doc, storage });

  // 1. 叠加激活 theme + background + component
  assert.equal(await selectPackWithEnv('theme', 'themeA', { doc, storage, lookup: id => entries[id] }), true);
  assert.equal(await selectPackWithEnv('background', 'bgA', { doc, storage, lookup: id => entries[id] }), true);
  assert.equal(await selectPackWithEnv('component', 'compA', { doc, storage, lookup: id => entries[id] }), true);

  assert.equal(host.activePackCount.value, 3);
  assert.equal(styles.length, 2); // bgA 无 cssText，themeA 与 compA 各一条 style
  assert.equal(host.packSlots.background.surface, FakeBg);
  assert.equal(host.packSlots.chatInput.sendButton, FakeSend);
  assert.deepEqual(JSON.parse(map.get(PACK_STORAGE_KEY)!), {
    theme: 'themeA',
    background: 'bgA',
    component: 'compA',
  });

  // 2. 单独停用 background：其他分类样式与 sendButton Slot 保持生效
  assert.equal(await selectPackWithEnv('background', null, { doc, storage, lookup: id => entries[id] }), true);
  assert.equal(host.activePackCount.value, 2);
  assert.equal(host.packSlots.background.surface, undefined);
  assert.equal(host.packSlots.chatInput.sendButton, FakeSend);
  assert.equal(styles.length, 2);

  // 3. 一键全部重置：style、slot 与持久化全部清空
  resetAllPacksWithEnv({ doc, storage });
  assert.equal(host.activePackCount.value, 0);
  assert.equal(styles.length, 0);
  assert.equal(host.packSlots.chatInput.sendButton, undefined);
  assert.equal(map.has(PACK_STORAGE_KEY), false);
});

test('selectPackWithEnv 单分类加载失败时仅回滚该分类（Fail-Closed）', async () => {
  const { doc, styles } = createFakeDom();
  const { storage } = createFakeStorage();
  const entries: Record<string, OfficialPackEntry> = {
    themeA: makeEntry('themeA', 'theme', async () => ({
      id: 'themeA',
      cssText: ':root { --lx-accent: #111111; }',
    })),
    brokenFont: makeEntry('brokenFont', 'font', async () => {
      throw new Error('font load failed');
    }),
  };

  const host = usePackHost();
  resetAllPacksWithEnv({ doc, storage });

  await selectPackWithEnv('theme', 'themeA', { doc, storage, lookup: id => entries[id] });
  const ok = await selectPackWithEnv('font', 'brokenFont', { doc, storage, lookup: id => entries[id] });

  assert.equal(ok, false);
  assert.equal(host.activePackIds.value.font, undefined);
  assert.equal(host.activePackIds.value.theme, 'themeA');
  assert.equal(styles.length, 1);
  assert.match(host.activePackError.value ?? '', /font load failed/);
});

test('selectPackWithEnv 支持 interactionCard 插槽覆盖审批卡与计划卡，停用后自动清空', async () => {
  const { doc } = createFakeDom();
  const { storage } = createFakeStorage();
  const CustomApproval = defineComponent({ name: 'CustomApprovalCard', render: () => null });
  const CustomPlan = defineComponent({ name: 'CustomPlanCard', render: () => null });
  const entries: Record<string, OfficialPackEntry> = {
    cardPack: makeEntry('cardPack', 'component', async () => ({
      id: 'cardPack',
      slots: {
        interactionCard: {
          approvalCard: CustomApproval,
          planCard: CustomPlan,
        },
      },
    })),
  };

  const host = usePackHost();
  resetAllPacksWithEnv({ doc, storage });

  await selectPackWithEnv('component', 'cardPack', { doc, storage, lookup: id => entries[id] });
  assert.equal(host.packSlots.interactionCard.approvalCard, CustomApproval);
  assert.equal(host.packSlots.interactionCard.planCard, CustomPlan);

  await selectPackWithEnv('component', null, { doc, storage, lookup: id => entries[id] });
  assert.equal(host.packSlots.interactionCard.approvalCard, undefined);
  assert.equal(host.packSlots.interactionCard.planCard, undefined);
});
