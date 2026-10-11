/**
 * i18n 运行时单测。
 *
 * <p>覆盖：默认 / 持久化偏好解析、system 探测、t() 命中 / 回退 / 插值 / 占位保留、
 * setPreference 的响应式更新与持久化。使用动态 import（带唯一 query）为“初始化期”
 * 逻辑（读取 localStorage / navigator）构造隔离的模块实例。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';

const KEY = 'lingxi-locale';

type Store = Map<string, string>;

/** 安装隔离的 globalThis.localStorage 与 navigator，返回可控的存储 Map。 */
function installEnv(opts: { stored?: string; language?: string; languageMissing?: boolean }): Store {
  const store: Store = new Map();
  if (opts.stored !== undefined) {
    store.set(KEY, opts.stored);
  }
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      store.set(k, String(v));
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
    clear: (): void => store.clear(),
  };
  const nav: { language?: string } = {};
  if (!opts.languageMissing) {
    nav.language = opts.language;
  }
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  return store;
}

let seq = 0;
/** 载入一个全新的 i18n 模块实例（绕开 ESM 缓存）。 */
async function loadFresh(): Promise<typeof import('../src/i18n/index')> {
  seq += 1;
  return import(`../src/i18n/index.ts?fresh=${seq}`);
}

// ───────────────────────── 默认 / 持久化 / system 探测 ─────────────────────────

test('无本地记录 + navigator=zh-CN → preference=system、locale=zh-CN', async () => {
  installEnv({ language: 'zh-CN' });
  const m = await loadFresh();
  assert.equal(m.LOCALE_STORAGE_KEY, 'lingxi-locale');
  assert.equal(m.useI18n().preference.value, 'system');
  assert.equal(m.useI18n().locale.value, 'zh-CN');
});

test('无本地记录 + navigator=en-US → locale=en-US', async () => {
  installEnv({ language: 'en-US' });
  const m = await loadFresh();
  assert.equal(m.useI18n().locale.value, 'en-US');
});

test('localStorage=zh-CN 覆盖系统语言', async () => {
  installEnv({ stored: 'zh-CN', language: 'en-US' });
  const m = await loadFresh();
  assert.equal(m.useI18n().preference.value, 'zh-CN');
  assert.equal(m.useI18n().locale.value, 'zh-CN');
});

test('localStorage=en-US 覆盖系统语言', async () => {
  installEnv({ stored: 'en-US', language: 'zh-CN' });
  const m = await loadFresh();
  assert.equal(m.useI18n().preference.value, 'en-US');
  assert.equal(m.useI18n().locale.value, 'en-US');
});

test('localStorage=system → 跟随 navigator（zh 前缀）', async () => {
  installEnv({ stored: 'system', language: 'zh-TW' });
  const m = await loadFresh();
  assert.equal(m.useI18n().preference.value, 'system');
  assert.equal(m.useI18n().locale.value, 'zh-CN');
});

test('localStorage=system → navigator 非 zh → en-US', async () => {
  installEnv({ stored: 'system', language: 'fr-FR' });
  const m = await loadFresh();
  assert.equal(m.useI18n().locale.value, 'en-US');
});

test('非法 localStorage 值 → 回退为 system', async () => {
  installEnv({ stored: 'de-DE', language: 'zh-CN' });
  const m = await loadFresh();
  assert.equal(m.useI18n().preference.value, 'system');
  assert.equal(m.useI18n().locale.value, 'zh-CN');
});

test('navigator.language 缺失 → 探测为 en-US', async () => {
  installEnv({ languageMissing: true });
  const m = await loadFresh();
  assert.equal(m.useI18n().locale.value, 'en-US');
});

// ───────────────────────── t() 行为 ─────────────────────────

test('t() 命中断言 + 非叶子/缺失回退 + 插值', async () => {
  installEnv({ stored: 'zh-CN', language: 'zh-CN' });
  const m = await loadFresh();
  const { t, setPreference } = m.useI18n();
  const { messages } = await import('../src/i18n/messages');

  // 命中：zh-CN
  assert.equal(t('app.titlebar'), messages['zh-CN'].app.titlebar);
  assert.equal(t('settings.general.theme'), messages['zh-CN'].settings.general.theme);

  // 插值：命中参数
  const total = messages['zh-CN'].model.totalConfigs as string;
  assert.ok(total.includes('{count}'));
  assert.ok(t('model.totalConfigs', { count: 7 }).includes('7'));
  assert.ok(!t('model.totalConfigs', { count: 7 }).includes('{count}'));

  // 缺失参数保留占位符
  assert.equal(t('model.totalConfigs', {}), total);
  assert.ok(t('model.totalConfigs', {}).includes('{count}'));

  // 完全缺失的 key → 原样返回 key
  assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');
  // 非叶子节点 → 回退为 key
  assert.equal(t('settings.general'), 'settings.general');

  // 切到 en-US 后命中英文
  setPreference('en-US');
  await nextTick();
  assert.equal(t('app.titlebar'), messages['en-US'].app.titlebar);
  assert.notEqual(messages['en-US'].app.titlebar, messages['zh-CN'].app.titlebar);
});

test('t() 缺失 en-US 叶子时回退到 zh-CN', async () => {
  installEnv({ stored: 'en-US', language: 'en-US' });
  const m = await loadFresh();
  const { t } = m.useI18n();
  const { messages } = await import('../src/i18n/messages');

  const enDict = messages['en-US'] as unknown as { app: Record<string, unknown> };
  const savedEn = enDict.app.titlebar;
  const zhValue = messages['zh-CN'].app.titlebar;
  try {
    delete enDict.app.titlebar; // 制造 en-US 缺失、zh-CN 存在的场景
    assert.equal(t('app.titlebar'), zhValue, 'en-US 缺失时应回退 zh-CN');
  } finally {
    enDict.app.titlebar = savedEn;
  }
  assert.equal(t('app.titlebar'), savedEn, '恢复后应回到英文');
});

// ───────────────────────── setPreference 响应式与持久化 ─────────────────────────

test('setPreference 触发 locale 响应式变化并持久化', async () => {
  const store = installEnv({ stored: 'zh-CN', language: 'en-US' });
  const m = await loadFresh();
  const { locale, preference, setPreference } = m.useI18n();

  assert.equal(locale.value, 'zh-CN');
  setPreference('en-US');
  assert.equal(preference.value, 'en-US');
  assert.equal(locale.value, 'zh-CN', 'locale 在 watcher flush 前不应同步变化');
  await nextTick();
  assert.equal(locale.value, 'en-US');
  assert.equal(store.get(KEY), 'en-US', '偏好应写入 localStorage');

  // 切回 system 应重新探测（navigator=en-US）
  setPreference('system');
  await nextTick();
  assert.equal(locale.value, 'en-US');
  assert.equal(store.get(KEY), 'system');

  // 非法值被忽略
  setPreference('xx-YY' as never);
  await nextTick();
  assert.equal(preference.value, 'system');
});

test('setPreference 后新读取的 t() 反映新语言（全局单例）', async () => {
  installEnv({ stored: 'zh-CN', language: 'zh-CN' });
  const m = await loadFresh();
  const a = m.useI18n();
  const b = m.useI18n();
  assert.equal(a.t('app.titlebar'), b.t('app.titlebar'));
  a.setPreference('en-US');
  await nextTick();
  assert.equal(a.t('app.titlebar'), b.t('app.titlebar'), '同一模块实例共享语言状态');
});
