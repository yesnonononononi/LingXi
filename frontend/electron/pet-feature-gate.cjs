'use strict';

/**
 * 桌宠暴露开关的**单一真源**（安装版必须不展示桌宠入口）。
 *
 * <p><b>为什么必须先有这个模块（用户硬约束 #3）：</b>桌宠目前只有开发链（`pet-up.cmd` /
 * `npm run dev:pet`）能用，安装版不得出现桌宠入口。但仓库现状是"入口天然存在"：
 * `frontend/vite.config.ts` 的 `build.rollupOptions.input` 里有 `pet`、`package.json` 的
 * `build.files` 又含 `dist/**\/*`，所以只要有人把 `pet.show()` 留在 `main.cjs` 里，
 * 装好的 LX 一启动就会冒出桌宠窗口。<b>把关决定收敛到一个纯函数里</b>，
 * 才能被单测真值表钉住、被静态扫描守住。</p>
 *
 * <p><b>判定口径（三条，顺序即优先级）：</b></p>
 * <ol>
 *   <li>`isPackaged === true` ⇒ <b>恒关</b>，且 `LX_PET=1` <b>不得</b>覆盖。
 *       要开闸必须是将来某次显式代码改动 + 发布评审，不能靠环境变量；</li>
 *   <li>开发态（未打包）+ `LX_PET=0` ⇒ 关（单次联调想清静时用）；</li>
 *   <li>其余（开发态默认）⇒ 开，与今天的行为一致。</li>
 * </ol>
 *
 * <p><b>为什么是 CommonJS：</b>要同时被 Electron 主进程、`node --test` 与门禁脚本读取，
 * CJS 是三者唯一都零配置支持的格式（与 `electron/pet-dev-endpoint.cjs` 同口径）。
 * 本模块<b>不 require electron</b>，因此在纯 node 里可以直接单测。</p>
 */

/** 关闭桌宠的环境变量名（只有开发态生效）。 */
const PET_ENV_KEY = 'LX_PET';

/** 判定结果的原因码（排障与断言共用，改文案不改语义）。 */
const PET_EXPOSURE_REASON = Object.freeze({
  /** 安装版：恒关，env 不得覆盖。 */
  PACKAGED: 'packaged',
  /** 开发态被 `LX_PET=0` 显式关闭。 */
  ENV_OFF: 'env-off',
  /** 开发态默认开启。 */
  DEV: 'dev',
});

/** `LX_PET` 允许的"关闭"取值（大小写与空白不敏感）。 */
const PET_ENV_OFF_VALUES = Object.freeze(['0', 'false', 'off', 'no']);

/**
 * 读环境变量（键名大小写不敏感）。
 *
 * <p>Windows 的环境变量本身大小写不敏感，但 node 把键原样暴露出来：
 * 用户敲 `set lx_pet=0` 与 `set LX_PET=0` 都该生效，否则"我明明关了却没关"
 * 会变成一次查不出原因的排障。</p>
 *
 * @param {object} env 环境变量对象（通常是 `process.env`）
 * @param {string} key 键名
 * @returns {string} 值；不存在时为空串
 */
function readEnvValue(env, key) {
  if (!env || typeof env !== 'object') return '';
  const wanted = String(key).toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (String(name).toLowerCase() !== wanted) continue;
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }
  return '';
}

/**
 * 解析桌宠暴露开关。
 *
 * @param {object} [input] 输入
 * @param {boolean} [input.isPackaged] 是否安装版（`app.isPackaged`）
 * @param {object} [input.env] 环境变量（缺省 `process.env`）
 * @returns {{enabled: boolean, reason: string}} 是否暴露桌宠 + 原因码
 */
function resolvePetExposure(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const isPackaged = source.isPackaged === true;
  const env = source.env && typeof source.env === 'object' ? source.env : process.env;

  // 1) 安装版恒关：这是硬约束，env 一律不得覆盖（不许出现"生产环境被一个环境变量打开"的路径）
  if (isPackaged) return { enabled: false, reason: PET_EXPOSURE_REASON.PACKAGED };

  // 2) 开发态允许显式关闭
  const raw = readEnvValue(env, PET_ENV_KEY);
  if (raw.length > 0 && PET_ENV_OFF_VALUES.includes(raw.toLowerCase())) {
    return { enabled: false, reason: PET_EXPOSURE_REASON.ENV_OFF };
  }

  // 3) 开发态默认开启（与今天的行为一致，dev 链验收口径不变）
  return { enabled: true, reason: PET_EXPOSURE_REASON.DEV };
}

/**
 * 造一个"什么都没有"的桌宠对象。
 *
 * <p><b>为什么要空对象而不是 `null`：</b>`main.cjs` 里有 5 处消费 `pet`
 * （`show` / `toggle` / `isVisible` / `onVisibilityChange` / `destroy`，外加托盘菜单的勾选态）。
 * 返回 `null` 就得在每个调用点加 `pet &&`，分叉一多，早晚有人在某条分支上忘记判空。
 * 这里返回与 {@link import('./pet-window.cjs')} **同形状**的空实现，下游代码零分叉。</p>
 *
 * @returns {object} 空桌宠对象（所有方法可安全调用）
 */
function createDisabledPet() {
  /**
   * 无操作的取消订阅。
   *
   * @returns {() => void} 空的取消函数
   */
  const noUnsubscribe = () => () => {};

  return {
    /**
     * 创建窗口（关闸时永远不创建）。
     *
     * @returns {boolean} 恒为 `false`
     */
    create: () => false,
    /**
     * 显示桌宠（关闸时永远不显示）。
     *
     * @returns {boolean} 恒为 `false`
     */
    show: () => false,
    /**
     * 隐藏桌宠。
     *
     * @returns {void}
     */
    hide: () => {},
    /**
     * 显示/隐藏切换。
     *
     * @returns {void}
     */
    toggle: () => {},
    /**
     * 是否可见。
     *
     * @returns {boolean} 恒为 `false`
     */
    isVisible: () => false,
    /**
     * 销毁窗口。
     *
     * @returns {void}
     */
    destroy: () => {},
    /**
     * 订阅可见性变化（关闸时立即返回一个空的取消函数）。
     *
     * @returns {() => void} 空的取消函数
     */
    onVisibilityChange: noUnsubscribe,
    /** 状态文件路径（关闸时没有状态文件）。 */
    statePath: '',
  };
}

module.exports = {
  PET_ENV_KEY,
  PET_EXPOSURE_REASON,
  PET_ENV_OFF_VALUES,
  readEnvValue,
  resolvePetExposure,
  createDisabledPet,
};