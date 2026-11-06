/**
 * S2 · 偏好与菜单的**接线层**（纯逻辑，零 Electron 依赖，可注入、可手摇）。
 *
 * <p><b>为什么要有这个文件（而不是全写在 `main.cjs` 里）：</b>
 * `main.cjs` 是入口脚本，`require` 它就会去 `require('electron')`、抢单实例锁、读
 * `app.getPath('userData')` ⇒ <b>它在 node 里根本跑不起来</b>。而 S2 真正容易坏的东西
 * 恰恰全是纯逻辑："点一下开关 → 先落盘 → 再广播 → 最后重建菜单 → 新勾选态对不对"。
 * 上一轮把它们直接写在 `main.cjs` 里，结果留下了一个**悬空的 `rebuildTrayMenu`**
 * （被调用、没定义，用户一点开关就 `ReferenceError`），却没有任何用例能红——
 * 因为那段代码不可测。</p>
 *
 * <p>所以这里把接线收成一个工厂：时钟之外的**全部外部依赖都注入**
 * （`store` / `builder` / `isVisible` / `includePet` / `rebuildTray` / `actions` / `warn`）。
 * `main.cjs` 只负责把 Electron 侧的四个适配器塞进来：</p>
 *
 * <pre>
 * const wiring = createPrefsWiring({
 *   store: petPrefsStore,                       // null ⇒ 门禁关闭（打包版）
 *   prefersReducedMotion: probe.reducedMotion,  // U-M4 探针结果
 *   builder: petMenu,                           // 菜单 spec 的唯一来源
 *   isVisible: () => pet.isVisible(),
 *   includePet: petExposure.enabled,
 *   actions: { showMain, toggleVisible, quitApp },
 *   rebuildTray: (spec) => tray && tray.setContextMenu(Menu.buildFromTemplate(spec)),
 *   warn: (message) => console.warn(message),
 * });
 * </pre>
 *
 * <h3>S4 交接（右键菜单怎么接，写死）</h3>
 * <p>右键菜单的 `Menu.popup` 在 `electron/pet-window.cjs`（M3 归 S4）。S4 要做的只有两步，
 * <b>不要另写模板、不要自己拼 label</b>：</p>
 * <ol>
 *   <li>把当前偏好与动作作为端口注入 `registerPetWindow`：
 *       `prefs: { get: () => prefsWiring.getPrefs(), set: (patch) => prefsWiring.setPrefs(patch) }`；</li>
 *   <li>`ipcMain.on('pet:context-menu')` 里把内联模板换成
 *       {@link import('./pet-menu.cjs')} 的
 *       `buildContextMenuItems({ prefs: prefs.get(), isVisible: isVisible(), actions })`，
 *       再 `Menu.buildFromTemplate(spec).popup(...)`；`actions` 里至少要有
 *       `toggleVisible` / `toggleFollow` / `toggleRoam` / `closePet` / `quitApp`
 *       （`toggleFollow` / `toggleRoam` 直接调 `prefs.set({follow:!…})` / `prefs.set({roam:!…})`）。</li>
 * </ol>
 * <p>做完这两步，"托盘与右键同源" 才是**事实上**成立的：两处 spec 都出自
 * `pet-menu.cjs` 的同一个 {@link import('./pet-menu.cjs').buildToggleItems} 段，
 * 勾选态都从同一个 `prefs` 派生（`petMenu.test.cjs` 的 N10 逐项断言这份相等）。</p>
 *
 * @module electron/pet-prefs-wiring
 */

'use strict';

const {
  PREFS_VERSION,
  PREF_PROBLEMS,
  defaultPrefs,
  loadInitialPrefs,
  applyPrefsPatch,
} = require('./pet-prefs.cjs');

/** 接线层可能处于的装载状态（`gate-off` = 打包版，不读不写偏好文件）。 */
const WIRING_SOURCE = Object.freeze({
  FILE: 'file',
  DEFAULT: 'default',
  REDUCED_MOTION: 'reduced-motion-default',
  GATE_OFF: 'gate-off',
});

/**
 * 造一个偏好-菜单接线器（**全部外部依赖注入**，没有隐式全局）。
 *
 * @param {object} options 选项
 * @param {object|null} options.store 偏好仓库（`createPrefsStore()` 的返回物）；
 *   `null` 表示桌宠门禁关闭（打包版）⇒ 不读盘、不写盘、`setPrefs` 变 no-op
 * @param {{buildTrayItems: Function}} options.builder 菜单 spec 构建器（生产传 `pet-menu.cjs`）
 * @param {() => boolean} options.isVisible 桌宠当前是否可见（托盘勾选态用）
 * @param {boolean} options.includePet 是否包含桌宠菜单段（门禁；打包版必须 `false`）
 * @param {(spec: object[]) => void} [options.rebuildTray] 菜单重建回调（注入 `tray.setContextMenu`）
 * @param {object} [options.actions] 应用级动作：`showMain` / `toggleVisible` / `quitApp`
 *   （`toggleFollow` / `toggleRoam` 由本模块自己提供，因为它们是纯偏好变更）
 * @param {boolean} [options.prefersReducedMotion] 系统"减少动态效果"（U-M4）
 * @param {(message: string) => void} [options.warn] 日志（读失败/写失败各记一条）
 * @returns {object} 接线器
 * @throws {TypeError} 缺 `builder` / `isVisible` / `includePet` 类型错
 */
function createPrefsWiring(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-prefs-wiring] 需要 {store, builder, isVisible, includePet} 对象');
  }
  const builder = options.builder;
  if (!builder || typeof builder.buildTrayItems !== 'function') {
    throw new TypeError('[pet-prefs-wiring] builder 必须提供 buildTrayItems()');
  }
  if (typeof options.isVisible !== 'function') {
    throw new TypeError('[pet-prefs-wiring] isVisible 必须是函数');
  }
  if (typeof options.includePet !== 'boolean') {
    throw new TypeError(`[pet-prefs-wiring] includePet 必须是布尔，实际为 ${JSON.stringify(options.includePet)}`);
  }
  const store = options.store || null;
  if (store && (typeof store.read !== 'function' || typeof store.write !== 'function')) {
    throw new TypeError('[pet-prefs-wiring] store 必须是 createPrefsStore() 的返回物');
  }
  const warn = typeof options.warn === 'function' ? options.warn : () => {};
  const rebuildTray = typeof options.rebuildTray === 'function' ? options.rebuildTray : () => {};
  const appActions = options.actions && typeof options.actions === 'object' ? options.actions : {};
  const prefersReducedMotion = options.prefersReducedMotion === true;

  /** 装载结果（含降级原因，排障与测试用）。 */
  const loadResult = store
    ? loadInitialPrefs({ store, prefersReducedMotion, warn })
    : {
        prefs: defaultPrefs(),
        problems: [],
        status: WIRING_SOURCE.GATE_OFF,
        writable: false,
        source: WIRING_SOURCE.GATE_OFF,
        appliedReducedMotion: false,
      };

  /** 内存真源（文件是持久化真源）。 */
  let prefsState = loadResult.prefs;

  /** 偏好变更订阅者（渲染层广播挂这里；顺序固定：先落盘 → 广播 → 重建菜单）。 */
  const changeListeners = new Set();

  /**
   * 通知所有订阅者（单个订阅者抛错不影响其它人与主流程）。
   *
   * @param {object} prefs 新偏好
   * @returns {void}
   */
  function notify(prefs) {
    for (const listener of changeListeners) {
      try {
        listener(prefs);
      } catch (error) {
        warn(`[pet-prefs-wiring] 变更订阅者抛错（已跳过）: ${(error && error.message) || error}`);
      }
    }
  }

  /** 接线器实例（先声明再用，便于内部闭包互相引用）。 */
  const wiring = {
    /**
     * 当前偏好（**只读快照**：调用方拿到的副本改动不会污染内存真源）。
     *
     * @returns {{version: number, follow: boolean, roam: boolean}} 偏好
     */
    getPrefs() {
      const snapshot = { version: PREFS_VERSION, follow: prefsState.follow === true, roam: prefsState.roam !== false };
      if (typeof prefsState.updatedAt === 'string' && prefsState.updatedAt.length > 0) {
        snapshot.updatedAt = prefsState.updatedAt;
      }
      return snapshot;
    },

    /**
     * 装载结果的诊断信息（降级原因 / 是否被 reduced-motion 影响）。
     *
     * @returns {{status: string, source: string, problems: string[],
     *   writable: boolean, appliedReducedMotion: boolean}} 诊断
     */
    getLoadResult() {
      return {
        status: loadResult.status,
        source: loadResult.source,
        problems: [...loadResult.problems],
        writable: loadResult.writable,
        appliedReducedMotion: loadResult.appliedReducedMotion,
      };
    },

    /**
     * 托盘菜单 spec（**唯一来源是注入的 builder**，本模块不写任何 label）。
     *
     * @returns {object[]} `Menu.buildFromTemplate` 模板
     */
    getTraySpec() {
      return builder.buildTrayItems({
        prefs: wiring.getPrefs(),
        isVisible: Boolean(options.isVisible()),
        includePet: options.includePet,
        actions: wiring.getActions(),
      });
    },

    /**
     * 菜单动作表：应用级动作来自注入，两个开关动作由本模块提供（纯偏好变更）。
     *
     * @returns {Record<string, Function>} 动作
     */
    getActions() {
      return {
        ...appActions,
        toggleFollow: () => {
          wiring.setPrefs({ follow: !wiring.getPrefs().follow });
        },
        toggleRoam: () => {
          wiring.setPrefs({ roam: !wiring.getPrefs().roam });
        },
      };
    },

    /**
     * 应用一次偏好变更（**菜单点击的唯一路径**）。
     *
     * <p>顺序（设计 §9.1，任何一步失败不影响另两步）：</p>
     * <ol>
     *   <li>{@link applyPrefsPatch} 原子落盘（失败记一条 warn，但仍返回新值）；</li>
     *   <li>通知订阅者（渲染层广播 / 行为层刷新）；</li>
     *   <li>重建菜单（托盘勾选态与事实对齐；右键菜单每次弹出按 `getPrefs()` 现算）。</li>
     * </ol>
     *
     * @param {{follow?: boolean, roam?: boolean}} patch 只接受布尔；未知键忽略
     * @returns {{prefs: object, ok: boolean, problems: string[], changed: boolean}} 结果
     *   （门禁关闭时 `ok:false, changed:false`，且**不触盘**）
     */
    setPrefs(patch) {
      if (!store) {
        // 打包版：不读不写不广播（菜单里根本没有桌宠项，没人能点到）
        return { prefs: wiring.getPrefs(), ok: false, problems: [], changed: false };
      }
      const result = applyPrefsPatch({ store, prefs: prefsState, patch, warn });
      prefsState = result.prefs;
      notify(wiring.getPrefs());
      wiring.rebuildTray();
      return { prefs: wiring.getPrefs(), ok: result.ok, problems: result.problems, changed: result.changed };
    },

    /**
     * 立即重建菜单（初始化、可见性变化、`setPrefs` 末尾都会走这里）。
     *
     * @returns {object[]} 本次用的 spec（便于调用方断言/日志）
     */
    rebuildTray() {
      const spec = wiring.getTraySpec();
      try {
        rebuildTray(spec);
      } catch (error) {
        // 菜单重建失败不许把偏好变更一起回滚：最坏是勾选态晚一拍，下次重建即纠正
        warn(`[pet-prefs-wiring] 菜单重建失败（偏好已生效）: ${(error && error.message) || error}`);
      }
      return spec;
    },

    /**
     * 订阅偏好变更。
     *
     * @param {(prefs: object) => void} listener 回调
     * @returns {() => void} 取消订阅函数
     */
    onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };

  return wiring;
}

module.exports = {
  WIRING_SOURCE,
  PREF_PROBLEMS,
  createPrefsWiring,
};
