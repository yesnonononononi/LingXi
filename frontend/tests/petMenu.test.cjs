/**
 * M3 S1 · `electron/pet-menu.cjs` 的单测（菜单 spec 构建器 / 文案单一真源）。
 *
 * <p><b>守的是什么：</b>右键菜单与托盘菜单今天各写一份 `label` 字面量，勾选态还可能各错一份。
 * 本文件钉住三件事：①两处文案**只来自** `MENU_LABELS`（改文案只改一处）；
 * ②勾选态**由 `prefs` 派生**（没有第二份菜单状态）；③返回的 spec 是纯数据，
 * 可以直接喂 `Menu.buildFromTemplate`（不需要 Electron 参与构建）。</p>
 *
 * <p>运行：`npm run test:pet`（node 直接跑，不需要 Electron）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const menu = require(path.join(__dirname, '..', 'electron', 'pet-menu.cjs'));

const {
  MENU_LABELS,
  MENU_IDS,
  TOGGLE_KEYS,
  buildContextMenuItems,
  buildTrayItems,
  buildToggleItems,
  collectLabels,
  findItemById,
} = menu;

/** 造一个"记录被点了几次"的动作表。 */
function makeActions() {
  const calls = [];
  const record = (name) => () => {
    calls.push(name);
  };
  return {
    calls,
    actions: {
      toggleVisible: record('toggleVisible'),
      toggleFollow: record('toggleFollow'),
      toggleRoam: record('toggleRoam'),
      closePet: record('closePet'),
      quitApp: record('quitApp'),
      showMain: record('showMain'),
    },
  };
}

test('N01 · 文案单一真源：两处菜单的 label 全部来自 MENU_LABELS', () => {
  const known = new Set(Object.values(MENU_LABELS));
  const contextLabels = collectLabels(
    buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: true, actions: makeActions().actions }),
  );
  const trayLabels = collectLabels(
    buildTrayItems({ prefs: { follow: false, roam: true }, isVisible: true, actions: makeActions().actions }),
  );
  for (const label of [...contextLabels, ...trayLabels]) {
    assert.ok(known.has(label), `菜单里出现了 MENU_LABELS 之外的文案："${label}"（文案必须有单一真源）`);
  }

  // 两个菜单的开关文案与内容必须完全一致（同一份 spec 段）
  const contextFollow = findItemById(
    buildContextMenuItems({ prefs: { follow: true, roam: false }, isVisible: true }),
    MENU_IDS.FOLLOW,
  );
  const trayFollow = findItemById(
    buildTrayItems({ prefs: { follow: true, roam: false }, isVisible: true }),
    MENU_IDS.FOLLOW,
  );
  assert.equal(contextFollow.label, trayFollow.label, '右键与托盘的"跟随"文案必须相同');
  assert.equal(contextFollow.checked, trayFollow.checked, '两处勾选态必须都来自 prefs');
});

test('N02 · 勾选态由 prefs 派生（follow / roam 各自独立，不做任何"记忆"）', () => {
  const spec = buildContextMenuItems({
    prefs: { follow: true, roam: false },
    isVisible: true,
    actions: makeActions().actions,
  });
  assert.equal(findItemById(spec, MENU_IDS.FOLLOW).checked, true);
  assert.equal(findItemById(spec, MENU_IDS.ROAM).checked, false);
  assert.equal(findItemById(spec, MENU_IDS.FOLLOW).type, 'checkbox');
  assert.equal(findItemById(spec, MENU_IDS.ROAM).type, 'checkbox');

  // 换一份 prefs：勾选态必须整体跟着变（无缓存）
  const flipped = buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: true });
  assert.equal(findItemById(flipped, MENU_IDS.FOLLOW).checked, false);
  assert.equal(findItemById(flipped, MENU_IDS.ROAM).checked, true);

  // 托盘里的"显示桌宠"勾选态来自 isVisible（不是 prefs）
  const tray = buildTrayItems({ prefs: { follow: false, roam: true }, isVisible: false });
  assert.equal(findItemById(tray, MENU_IDS.TRAY_TOGGLE_PET).checked, false);
  assert.equal(findItemById(tray, MENU_IDS.TRAY_TOGGLE_PET).label, MENU_LABELS.trayShowPet);
});

test('N03 · 显/隐是**同一项**：文案随可见性切换，点击永远调 toggleVisible', () => {
  const recorder = makeActions();
  const visible = buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: true, actions: recorder.actions });
  const hidden = buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: false, actions: recorder.actions });
  assert.equal(findItemById(visible, MENU_IDS.TOGGLE_VISIBLE).label, MENU_LABELS.contextHide);
  assert.equal(findItemById(hidden, MENU_IDS.TOGGLE_VISIBLE).label, MENU_LABELS.contextShow);

  findItemById(visible, MENU_IDS.TOGGLE_VISIBLE).click();
  assert.deepEqual(recorder.calls, ['toggleVisible']);
});

test('N04 · spec 结构：可直接喂 Menu.buildFromTemplate（纯数据 + 分隔线 + 顺序）', () => {
  const spec = buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: true, actions: makeActions().actions });
  assert.equal(Array.isArray(spec), true);
  // 顺序：显/隐 → 跟随 → 漫游 → 分隔线 → 关闭桌宠 → 分隔线 → 退出 LX
  assert.deepEqual(
    spec.map((item) => item.id || item.type),
    [MENU_IDS.TOGGLE_VISIBLE, MENU_IDS.FOLLOW, MENU_IDS.ROAM, 'separator', MENU_IDS.CLOSE_PET, 'separator', MENU_IDS.QUIT_APP],
  );
  for (const item of spec) {
    assert.equal(typeof item, 'object');
    if (item.type === 'separator') {
      assert.equal('label' in item, false, '分隔线不许带 label');
      continue;
    }
    assert.equal(typeof item.label, 'string');
    assert.equal(typeof item.click, 'function', `菜单项 ${item.id} 必须有 click`);
    // 必须是纯数据：不许把 Electron 的 MenuItem 实例混进来
    assert.equal(Object.getPrototypeOf(item), Object.prototype, `菜单项 ${item.id} 必须是普通对象`);
  }

  // 托盘顺序：显示界面 → 显示桌宠 → 分隔线 → 跟随 → 漫游 → 分隔线 → 彻底退出
  const tray = buildTrayItems({ prefs: { follow: false, roam: true }, isVisible: true });
  assert.deepEqual(
    tray.map((item) => item.id || item.type),
    [MENU_IDS.TRAY_SHOW_MAIN, MENU_IDS.TRAY_TOGGLE_PET, 'separator', MENU_IDS.FOLLOW, MENU_IDS.ROAM, 'separator', MENU_IDS.TRAY_QUIT_APP],
  );
});

test('N05 · 动作全部由调用方注入；缺回调时只"点不动"，不许抛', () => {
  const recorder = makeActions();
  const spec = buildContextMenuItems({
    prefs: { follow: false, roam: true },
    isVisible: true,
    actions: recorder.actions,
  });
  for (const item of spec) {
    if (typeof item.click === 'function') item.click();
  }
  assert.deepEqual(recorder.calls, ['toggleVisible', 'toggleFollow', 'toggleRoam', 'closePet', 'quitApp']);

  // 一个动作都不给：构建成功，点击是 no-op（不抛）
  const bare = buildContextMenuItems({ prefs: { follow: true, roam: false }, isVisible: false });
  for (const item of bare) {
    if (typeof item.click === 'function') {
      assert.doesNotThrow(() => item.click());
    }
  }
  // prefs 里的真实值仍然照常反映在勾选态上（缺回调和缺偏好是两回事）
  assert.equal(findItemById(bare, MENU_IDS.FOLLOW).checked, true);
});

test('N06 · 入参两种写法等价（{prefs,isVisible} 与 {prefs,state:{isVisible}}）', () => {
  const a = buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: false });
  const b = buildContextMenuItems({ prefs: { follow: false, roam: true }, state: { isVisible: false } });
  assert.deepEqual(
    a.map((item) => [item.id, item.label, item.checked]),
    b.map((item) => [item.id, item.label, item.checked]),
  );
  // 顶层 isVisible 优先于 state（避免两种写法打架时行为不确定）
  const c = buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: true, state: { isVisible: false } });
  assert.equal(findItemById(c, MENU_IDS.TOGGLE_VISIBLE).label, MENU_LABELS.contextHide);
});

test('N07 · 入参校验：缺 prefs / 开关非布尔 / isVisible 非布尔 / actions 非对象都抛', () => {
  assert.throws(() => buildContextMenuItems({}), TypeError);
  assert.throws(() => buildContextMenuItems(null), TypeError);
  assert.throws(() => buildContextMenuItems({ prefs: { follow: 'yes', roam: true }, isVisible: true }), TypeError);
  assert.throws(() => buildContextMenuItems({ prefs: { follow: false, roam: true } }), TypeError, '缺 isVisible 必须抛');
  assert.throws(
    () => buildContextMenuItems({ prefs: { follow: false, roam: true }, isVisible: true, actions: 'nope' }),
    TypeError,
  );
  assert.throws(() => buildTrayItems({ prefs: { follow: false } , isVisible: true }), TypeError);
  assert.throws(() => collectLabels('nope'), TypeError);
  assert.throws(() => findItemById(null, MENU_IDS.FOLLOW), TypeError);
});

test('N09 · includePet=false（安装版）：托盘零桌宠项，只剩「显示界面 / 彻底退出」', () => {
  const spec = buildTrayItems({ prefs: { follow: true, roam: true }, isVisible: true, includePet: false });
  const ids = spec.map((item) => item.id).filter(Boolean);
  assert.deepEqual(ids, [MENU_IDS.TRAY_SHOW_MAIN, MENU_IDS.TRAY_QUIT_APP], '安装版托盘只许有两个可点项');
  for (const petOnly of [MENU_IDS.TRAY_TOGGLE_PET, MENU_IDS.FOLLOW, MENU_IDS.ROAM]) {
    assert.equal(ids.includes(petOnly), false, `安装版不许出现桌宠项：${petOnly}`);
  }
  // 分隔线只剩一条（不许留孤立的空行）
  assert.equal(spec.filter((item) => item.type === 'separator').length, 1);
  assert.equal(spec.some((item) => item.type === 'checkbox'), false, '安装版不许有任何勾选项');
  // 文案仍来自同一份真源（不是第二套字面量）
  for (const label of collectLabels(spec)) {
    assert.ok(Object.values(MENU_LABELS).includes(label), `安装版菜单出现未知文案：${label}`);
  }
});

test('N10 · 两处菜单同源：includePet=true 时开关段与右键逐项相等（id/文案/勾选态）', () => {
  for (const prefs of [
    { follow: false, roam: true },
    { follow: true, roam: false },
    { follow: true, roam: true },
  ]) {
    const tray = buildTrayItems({ prefs, isVisible: true, includePet: true });
    const context = buildContextMenuItems({ prefs, isVisible: true });
    const pickToggles = (items) =>
      items
        .filter((item) => item.type === 'checkbox' && item.id !== MENU_IDS.TRAY_TOGGLE_PET)
        .map((item) => [item.id, item.label, item.checked]);
    assert.deepEqual(pickToggles(tray), pickToggles(context), `prefs=${JSON.stringify(prefs)} 时两处开关段不一致`);
  }
});

test('N11 · includePet 只接受布尔（缺省 true）；非布尔立刻 TypeError', () => {
  const base = { prefs: { follow: false, roam: true }, isVisible: true };
  assert.equal(buildTrayItems(base).some((item) => item.id === MENU_IDS.TRAY_TOGGLE_PET), true, '缺省必须包含桌宠项');
  assert.throws(() => buildTrayItems({ ...base, includePet: 'no' }), TypeError);
  assert.throws(() => buildTrayItems({ ...base, includePet: 0 }), TypeError);
  assert.throws(() => buildTrayItems({ ...base, includePet: null }), TypeError);
});

test('N08 · buildToggleItems 与两个菜单里的开关段是**同一份**（id/文案/勾选态全等）', () => {
  const prefs = { follow: true, roam: true };
  const standalone = buildToggleItems({ prefs, actions: {} });
  assert.deepEqual(standalone.map((item) => item.id), [...TOGGLE_KEYS.map((key) => (key === 'follow' ? MENU_IDS.FOLLOW : MENU_IDS.ROAM))]);

  const context = buildContextMenuItems({ prefs, isVisible: true }).filter((item) => item.type === 'checkbox');
  const tray = buildTrayItems({ prefs, isVisible: true }).filter((item) => item.type === 'checkbox' && item.id !== MENU_IDS.TRAY_TOGGLE_PET);
  const pick = (items) => items.map((item) => [item.id, item.label, item.checked]);
  assert.deepEqual(pick(context), pick(standalone));
  assert.deepEqual(pick(tray), pick(standalone));

  // id 在**单个菜单内**全局唯一（两个菜单是两份独立模板，各自按 id 找项；
  // 跨菜单复用同一 id 是有意的：开关段是同一份 spec，主进程按 id 同步勾选态）
  for (const [name, spec] of [
    ['context', buildContextMenuItems({ prefs, isVisible: true })],
    ['tray', buildTrayItems({ prefs, isVisible: true })],
  ]) {
    const ids = spec.map((item) => item.id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `${name} 菜单 id 有重复：${ids.join(',')}`);
  }
});
