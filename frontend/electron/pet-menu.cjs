/**
 * M3 S1 · 菜单规格构建器（**纯函数 + 文案单一真源**）。
 *
 * <p><b>要解决的问题：</b>右键菜单（原生 `Menu.popup`，在 `pet-window.cjs`）与托盘菜单
 * （`main.cjs` 的 `buildTrayMenu`）今天各写一份 `label` 字面量，且托盘那份根本没有两个开关。
 * 两处文案一旦漂移，用户看到的是"托盘写着显示、右键写着隐藏"这种自相矛盾的界面。</p>
 *
 * <p><b>做法：</b>本模块是**唯一的文案与勾选态来源**，导出两个 spec 构建器：</p>
 * <ul>
 *   <li>{@link buildContextMenuItems} —— 右键菜单；</li>
 *   <li>{@link buildTrayItems} —— 托盘菜单；</li>
 *   <li>{@link buildMenuSpec} —— 两个菜单共用的"开关段"（勾选态由 `prefs` 派生）。</li>
 * </ul>
 *
 * <p>返回值是**可直接喂给 `Menu.buildFromTemplate` 的普通对象数组**（`{id, label, type,
 * checked, click, enabled}`），所以本模块**不依赖 Electron 运行时**（零 require）——
 * 主进程只做 `Menu.buildFromTemplate(petMenu.buildContextMenuItems({...}))`，
 * 不再自己写 `label`。这也是门禁 G-M9 的可检查口径：`label`/`checked` 只允许出现在本文件。</p>
 *
 * <p><b>勾选态是派生的，不是持有状态：</b>spec 的 `checked` 一律从 `prefs` 现算，
 * 本模块**没有**任何"上一次的菜单状态"缓存。设计 §9.3 最后一行：
 * "`prefs` 是唯一真源；没有第二份菜单状态"。</p>
 *
 * <p><b>S1 边界：</b>本片不接线（不注册 IPC、不改 `pet-window.cjs`/`main.cjs`），
 * `click` 回调由调用方通过 `actions` 注入，本模块自己**不做任何事**。</p>
 *
 * @module electron/pet-menu
 */

'use strict';

/**
 * 菜单文案的**单一真源**（唯一允许出现中文标签的地方）。
 *
 * <p>改文案只改这里。门禁 G-M9 断言 `pet-window.cjs` / `main.cjs` 里
 * 不再出现 `跟随鼠标` / `自由漫游` / `显示桌宠` 这些字面量。</p>
 */
const MENU_LABELS = Object.freeze({
  /** 右键菜单：显/隐切换（按当前可见性二选一）。 */
  contextShow: '显示桌宠',
  contextHide: '隐藏桌宠',
  /** 右键菜单：两个开关。 */
  follow: '跟随鼠标',
  roam: '自由漫游',
  /** 右键菜单：关掉画面但保留托盘入口（桌宠是常驻件，误点退出代价太高）。 */
  closePet: '关闭桌宠（可从托盘恢复）',
  /** 右键菜单：整个应用退出。 */
  quitApp: '退出 LX',
  /** 托盘菜单：主窗口。 */
  trayShowMain: '显示界面',
  /** 托盘菜单：桌宠显/隐切换（托盘侧显示的是"能否点开"，不是当前状态）。 */
  trayShowPet: '显示桌宠',
  /** 托盘菜单：整个应用退出。 */
  trayQuitApp: '彻底退出',
});

/**
 * 菜单项的稳定 id（主进程重组菜单时按 id 找项，不按文案找）。
 *
 * <p>按文案找项会在改文案时静默失效；按 id 找项则会立刻找不到并暴露问题。</p>
 */
const MENU_IDS = Object.freeze({
  TOGGLE_VISIBLE: 'pet-menu:toggle-visible',
  FOLLOW: 'pet-menu:follow',
  ROAM: 'pet-menu:roam',
  CLOSE_PET: 'pet-menu:close-pet',
  QUIT_APP: 'pet-menu:quit-app',
  TRAY_SHOW_MAIN: 'pet-tray:show-main',
  TRAY_TOGGLE_PET: 'pet-tray:toggle-pet',
  TRAY_QUIT_APP: 'pet-tray:quit-app',
});

/** 偏好里的两个开关（顺序即菜单里的顺序）。 */
const TOGGLE_KEYS = Object.freeze(['follow', 'roam']);

/**
 * 断言是布尔（`checked` 只有一个合法来源：`prefs` 上的布尔字段）。
 *
 * @param {unknown} value 待校验值
 * @param {string} name 参数名
 * @returns {boolean} 布尔
 * @throws {TypeError} 不是布尔
 */
function requireBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`[pet-menu] ${name} 必须是布尔，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 归一入参（`{prefs, isVisible, actions}` 或 `{prefs, state:{isVisible}}` 两种写法都接受）。
 *
 * <p>两种写法都要接受的原因：任务书用 `{prefs, state}`，设计 §9.1 用
 * `{prefs, isVisible, actions}`。**替身只有一个**——内部统一成 `{prefs, isVisible, actions}`，
 * 避免出现两份构建逻辑。</p>
 *
 * <p>`includePet` 决定托盘是否包含桌宠相关项（**安装版必须为 false**）：
 * 它只切"有没有这一段"，段的内部结构仍然只有一份（{@link buildToggleItems}）。</p>
 *
 * @param {{prefs?: object, isVisible?: boolean, state?: {isVisible?: boolean},
 *   actions?: object, includePet?: boolean}} input 入参
 * @returns {{prefs: {follow: boolean, roam: boolean}, isVisible: boolean,
 *   actions: Record<string, Function>, includePet: boolean}} 归一结果
 * @throws {TypeError} 缺 `prefs` / 开关不是布尔 / `actions` 不是对象 / `includePet` 不是布尔
 */
function normalizeMenuInput(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('[pet-menu] 需要 {prefs, isVisible|state, actions} 对象');
  }
  const prefs = input.prefs;
  if (prefs === null || typeof prefs !== 'object') {
    throw new TypeError('[pet-menu] prefs 必须是对象（勾选态的唯一来源）');
  }
  const isVisible =
    input.isVisible === undefined && input.state && typeof input.state === 'object'
      ? input.state.isVisible
      : input.isVisible;
  const actions = input.actions === undefined ? {} : input.actions;
  if (actions === null || typeof actions !== 'object') {
    throw new TypeError('[pet-menu] actions 必须是对象（回调由调用方注入）');
  }
  const includePet = input.includePet === undefined ? true : input.includePet;
  if (typeof includePet !== 'boolean') {
    throw new TypeError(`[pet-menu] includePet 必须是布尔，实际为 ${JSON.stringify(includePet)}`);
  }
  return {
    prefs: {
      follow: requireBoolean(prefs.follow, 'prefs.follow'),
      roam: requireBoolean(prefs.roam, 'prefs.roam'),
    },
    isVisible: requireBoolean(isVisible, 'isVisible'),
    actions: /** @type {Record<string, Function>} */ (actions),
    includePet,
  };
}

/**
 * 取出动作回调；缺省时返回一个**什么都不做的函数**（不抛）。
 *
 * <p>为什么允许缺省：托盘菜单在没有偏好文件时也要能构建（"显示界面/彻底退出"与偏好无关）。
 * 缺的开关只是点不动，不会让整个菜单构建失败。</p>
 *
 * @param {Record<string, Function>} actions 动作表
 * @param {string} name 动作名
 * @returns {() => void} 回调
 */
function actionOf(actions, name) {
  const fn = actions[name];
  if (typeof fn !== 'function') return () => {};
  return () => {
    fn();
  };
}

/**
 * 构建两个开关的菜单段（**右键与托盘共用同一份**）。
 *
 * @param {{prefs: {follow: boolean, roam: boolean}, actions: Record<string, Function>}} options 归一后的入参
 * @returns {Array<{id: string, label: string, type: 'checkbox', checked: boolean, click: () => void}>} 菜单项
 */
function buildToggleItems(options) {
  /** 开关键 → 文案与 id 的映射（**唯一一处**把三者绑在一起）。 */
  const descriptor = {
    follow: { id: MENU_IDS.FOLLOW, label: MENU_LABELS.follow, action: 'toggleFollow' },
    roam: { id: MENU_IDS.ROAM, label: MENU_LABELS.roam, action: 'toggleRoam' },
  };
  return TOGGLE_KEYS.map((key) => ({
    id: descriptor[key].id,
    label: descriptor[key].label,
    type: /** @type {const} */ ('checkbox'),
    checked: options.prefs[key],
    click: actionOf(options.actions, descriptor[key].action),
  }));
}

/**
 * 构建原生右键菜单的规格（**可直接喂 `Menu.buildFromTemplate`**）。
 *
 * <p>内容（设计 §9.3）：显示/隐藏桌宠 → 跟随鼠标 ☑ → 自由漫游 ☑ → 分隔线 →
 * 关闭桌宠（可从托盘恢复）→ 分隔线 → 退出 LX。</p>
 *
 * @param {{prefs: object, isVisible?: boolean, state?: {isVisible?: boolean},
 *   actions?: object}} input 入参
 * @returns {Array<object>} `Menu.buildFromTemplate` 模板
 * @throws {TypeError} 入参非法
 */
function buildContextMenuItems(input) {
  const { prefs, isVisible, actions } = normalizeMenuInput(input);
  return [
    {
      id: MENU_IDS.TOGGLE_VISIBLE,
      // 显/隐是同一项：按**当前**可见性给文案，点击永远是"切一下"
      label: isVisible ? MENU_LABELS.contextHide : MENU_LABELS.contextShow,
      click: actionOf(actions, 'toggleVisible'),
    },
    ...buildToggleItems({ prefs, actions }),
    { type: /** @type {const} */ ('separator') },
    {
      id: MENU_IDS.CLOSE_PET,
      // 显式给一个"关掉画面但留着入口"的中间档：桌宠是常驻件，误点退出代价太高
      label: MENU_LABELS.closePet,
      click: actionOf(actions, 'closePet'),
    },
    { type: /** @type {const} */ ('separator') },
    {
      id: MENU_IDS.QUIT_APP,
      label: MENU_LABELS.quitApp,
      click: actionOf(actions, 'quitApp'),
    },
  ];
}

/**
 * 构建托盘菜单的规格（**与右键共用开关段与文案常量**）。
 *
 * <p>内容（设计 §9.3）：显示界面 → 显示桌宠（勾选态 = 当前可见）→ 分隔线 →
 * 跟随鼠标 ☑ → 自由漫游 ☑ → 分隔线 → 彻底退出。</p>
 *
 * <p><b>`includePet === false`（安装版）</b>：只保留"显示界面 / 彻底退出"两项，
 * <b>零桌宠菜单项</b>（用户硬约束 #3）。仍然走同一份文案常量与同一份模板函数，
 * 所以"两处菜单同源"在安装版下也成立——只是桌宠段整体不出现。</p>
 *
 * @param {{prefs: object, isVisible?: boolean, state?: {isVisible?: boolean},
 *   actions?: object, includePet?: boolean}} input 入参
 * @returns {Array<object>} `Menu.buildFromTemplate` 模板
 * @throws {TypeError} 入参非法
 */
function buildTrayItems(input) {
  const { prefs, isVisible, actions, includePet } = normalizeMenuInput(input);
  /** 主窗口入口（两个版本都有）。 */
  const showMainItem = {
    id: MENU_IDS.TRAY_SHOW_MAIN,
    label: MENU_LABELS.trayShowMain,
    click: actionOf(actions, 'showMain'),
  };
  /** 退出入口（两个版本都有；必须是最后一项）。 */
  const quitItem = {
    id: MENU_IDS.TRAY_QUIT_APP,
    label: MENU_LABELS.trayQuitApp,
    click: actionOf(actions, 'quitApp'),
  };
  if (!includePet) {
    // 安装版：桌宠项整体不出现（连分隔线也不留，避免出现孤立的一条横线）
    return [showMainItem, { type: /** @type {const} */ ('separator') }, quitItem];
  }
  return [
    showMainItem,
    {
      id: MENU_IDS.TRAY_TOGGLE_PET,
      label: MENU_LABELS.trayShowPet,
      type: /** @type {const} */ ('checkbox'),
      checked: isVisible,
      click: actionOf(actions, 'toggleVisible'),
    },
    { type: /** @type {const} */ ('separator') },
    ...buildToggleItems({ prefs, actions }),
    { type: /** @type {const} */ ('separator') },
    quitItem,
  ];
}

/**
 * 列出 spec 里全部 `label`（门禁与单测用来断言"文案只来自一处"）。
 *
 * @param {Array<object>} spec 菜单模板
 * @returns {string[]} 文案（跳过分隔线）
 */
function collectLabels(spec) {
  if (!Array.isArray(spec)) {
    throw new TypeError('[pet-menu] collectLabels 需要菜单模板数组');
  }
  return spec.filter((item) => item && typeof item.label === 'string').map((item) => item.label);
}

/**
 * 按 id 取菜单项（主进程"重建托盘时同步勾选态"用；按 id 不按文案）。
 *
 * @param {Array<object>} spec 菜单模板
 * @param {string} id 菜单项 id
 * @returns {object|null} 菜单项
 */
function findItemById(spec, id) {
  if (!Array.isArray(spec)) {
    throw new TypeError('[pet-menu] findItemById 需要菜单模板数组');
  }
  return spec.find((item) => item && item.id === id) || null;
}

module.exports = {
  MENU_LABELS,
  MENU_IDS,
  TOGGLE_KEYS,
  buildContextMenuItems,
  buildTrayItems,
  buildToggleItems,
  collectLabels,
  findItemById,
};
