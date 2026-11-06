const { contextBridge, ipcRenderer } = require('electron');

/**
 * 桌宠窗口的桥。
 *
 * <p>刻意做得极窄：渲染层只能「报告鼠标状态 / 发起拖拽 / 关掉自己」，
 * 拿不到任何文件、网络或进程能力。窗口位置全部由主进程按系统光标换算，
 * 渲染层即使被注入也改不了自己的坐标（它能上报的只有光标位置，而主进程还会夹进屏幕范围）。</p>
 */

/**
 * 主进程推来指令时只放行这几种类型，避免未知消息进渲染层。
 *
 * <p><b>新增 type 必须在这里加一条</b>，否则渲染层永远收不到（被静默丢弃）。
 * 这条坑很容易踩：主进程发了、渲染层代码也写了，就是不动——因为白名单在 preload 这层拦掉了。
 * `tests/petPresentation.test.ts` 会交叉检查「路由器认得的类型」与「本清单」是否一致。</p>
 *
 * <p>M3 §8.2 新增两个：`motion`（运动事实，主进程按拍下发）与 `prefs`（偏好广播）。
 * 清单里**不写行内注释**：`petPresentation.test.ts` 是按 `,` 切分这个数组的，
 * 行内注释会被当成一个"类型名"，让"清单与路由器一致"这条断言读起来莫名其妙。</p>
 */
const KNOWN_COMMAND_TYPES = ['ready', 'hit-state', 'visible', 'ping', 'play', 'expression', 'motion', 'prefs'];

/**
 * 归一化一条拖拽坐标。
 *
 * @param payload 渲染层传来的 { cursorX, cursorY }
 * @returns 只含有限数值的对象；非法时不带字段（主进程会退回系统光标位置）
 */
function normalizePoint(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const result = {};
  const x = Number(source.cursorX);
  const y = Number(source.cursorY);
  if (Number.isFinite(x)) result.cursorX = Math.round(x);
  if (Number.isFinite(y)) result.cursorY = Math.round(y);
  return result;
}

contextBridge.exposeInMainWorld('petAPI', {
  /**
   * 开始拖拽。
   * @param payload { cursorX, cursorY } 按下瞬间的光标屏幕坐标
   * @returns Promise<{ ok: boolean, error?: string }>
   */
  startDrag: (payload) => ipcRenderer.invoke('pet:drag-start', normalizePoint(payload)),
  /**
   * 拖拽中上报位置（高频单向，不等回执）。
   * @param payload { cursorX, cursorY } 当前光标的屏幕坐标
   */
  moveDrag: (payload) => ipcRenderer.send('pet:drag-move', normalizePoint(payload)),
  /**
   * 结束拖拽（主进程会立刻把位置落盘）。
   * @returns Promise<{ ok: boolean, error?: string }>
   */
  endDrag: () => ipcRenderer.invoke('pet:drag-end'),
  /**
   * 悬停提示：**只叫醒主进程，不上报判定结果**（M2 修正版的主通道）。
   *
   * <p>穿透态下窗口收不到点击，但 `{ forward: true }` 仍会把 `mousemove` 转发进来，
   * 渲染层对每次转发调用本方法 ⇒ 主进程当场读系统光标 + 同步 apply，
   * 于是"光标刚进立绘就点"也能命中（延迟 = 一次 IPC 往返）。</p>
   *
   * <p><b>载荷里的坐标主进程不读</b>：判定只认 `screen.getCursorScreenPoint()`。
   * 这是防回声的结构性保证 —— 伪造一条 hint（哪怕坐标指向立绘中心）也不会改变窗口状态，
   * `tests/petHitOwnership.test.cjs` 的 C20 就是这条的守卫。</p>
   *
   * <p>注意与已删除的 `setHit` 的区别：`setHit` 上报的是"渲染层认为命中与否"（判定），
   * 本方法上报的是"现在可能该看一眼"（触发）。**`setHit` 不许复活**：
   * `scripts/check-pet-hit-ownership.mjs` 与 `tests/petHitRenderSide.test.ts` 两处都守着。</p>
   *
   * @param payload `{ x, y }` 光标屏幕坐标（仅排障参考，主进程不参与判定）
   */
  hoverHint: (payload) => {
    const source = payload && typeof payload === 'object' ? payload : {};
    const x = Number(source.x);
    const y = Number(source.y);
    const point = {};
    if (Number.isFinite(x)) point.x = Math.round(x);
    if (Number.isFinite(y)) point.y = Math.round(y);
    ipcRenderer.send('pet:hover-hint', point);
  },
  /**
   * 关掉桌宠（隐藏，不销毁）。保留给主进程内部与调试用；
   * **用户手势走 {@link openContextMenu}**（M6-b：关闭入口唯一）。
   * @returns Promise<{ ok: boolean, error?: string }>
   */
  close: () => ipcRenderer.invoke('pet:close'),
  /**
   * 弹出原生右键菜单（显示/隐藏、关闭、退出）——M6-b 起这是关闭/显隐的唯一入口。
   *
   * 单向 `send`：菜单项的点击由主进程执行，渲染层不需要回执。
   */
  openContextMenu: () => ipcRenderer.send('pet:context-menu'),
  /**
   * 订阅主进程指令。
   * @param callback 收到 { type, ... } 指令时调用
   * @returns 取消订阅函数
   */
  onCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, command) => {
      if (!command || typeof command !== 'object') return;
      if (!KNOWN_COMMAND_TYPES.includes(command.type)) return;
      callback(command);
    };
    ipcRenderer.on('pet:command', listener);
    return () => ipcRenderer.removeListener('pet:command', listener);
  },
  /**
   * 请求切换运动模式（`invoke('pet:motion-intent')`，M3 §8.1）。
   *
   * <p><b>载荷只有 `{mode, reason}`，没有坐标</b>：渲染层永远不能指定位置
   * （"唯一位置写入者"铁律）。主进程还会再校验一次枚举与偏好——这里不做判定，
   * 只做形状收敛，判定权在主进程。</p>
   *
   * <p>渲染层把它当**可选桥**用：缺失时它自己会打一条明确日志并返回 false，
   * 所以本方法存在与否只影响"能不能动"，不影响加载。</p>
   *
   * @param {{mode: string, reason: string}} intent 运动意图
   * @returns Promise<{ ok: boolean, error?: string }>
   */
  motionIntent: (intent) => {
    const source = intent && typeof intent === 'object' ? intent : {};
    const payload = {};
    if (typeof source.mode === 'string') payload.mode = source.mode;
    if (typeof source.reason === 'string') payload.reason = source.reason;
    return ipcRenderer.invoke('pet:motion-intent', payload);
  },
  /**
   * 读运动快照（`invoke('pet:motion-snapshot')`，只读，M3 §8.1）。
   *
   * <p>仅供 dev 后门与 CDP 采样；生产态无人调用。返回主进程的只读快照，
   * 渲染层**不许**据此反推位置再自己写（那会立刻破坏单写者）。</p>
   *
   * @returns Promise<object|null>
   */
  motionSnapshot: () => ipcRenderer.invoke('pet:motion-snapshot'),
  /**
   * 写偏好（`invoke('pet:prefs-set')`，M3 §8.1）。
   *
   * <p><b>只给 dev 后门用</b>：生产态的偏好唯一写入者是主进程的右键/托盘菜单。
   * 这里只做布尔收敛（非布尔字段直接丢掉），落盘与广播全在主进程的偏好端口里。</p>
   *
   * @param {{follow?: boolean, roam?: boolean}} patch 偏好补丁
   * @returns Promise<{ prefs: object, ok: boolean, problems: string[], changed: boolean }>
   */
  prefsSet: (patch) => {
    const source = patch && typeof patch === 'object' ? patch : {};
    const payload = {};
    if (typeof source.follow === 'boolean') payload.follow = source.follow;
    if (typeof source.roam === 'boolean') payload.roam = source.roam;
    return ipcRenderer.invoke('pet:prefs-set', payload);
  },
});
