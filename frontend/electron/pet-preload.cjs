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
 */
const KNOWN_COMMAND_TYPES = ['ready', 'hit-state', 'visible', 'ping', 'play', 'expression'];

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
   * 报告鼠标是否在命中区。true = 关掉穿透（可交互），false = 恢复穿透。
   * @param hit 命中与否，非 true 一律按 false 处理
   */
  setHit: (hit) => ipcRenderer.send('pet:set-hit', hit === true),
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
});
