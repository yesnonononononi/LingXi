/**
 * 桌宠窗口测试脚手架（假 electron + 手动时钟 + 舞台）。
 *
 * <p><b>为什么需要这套东西：</b>`electron/pet-window.cjs` 里真正有价值的行为（窗口位置解算、
 * 命中轮询接线、三个例外）都长在 `registerPetWindow()` 的闭包里，构造函数直接跑不起来。
 * 但它的 `require('electron')` 是**懒加载**的（写在 `electron()` 函数体内），于是测试可以
 * 临时改写 `Module._load` 塞进一套假 electron，把 `create()` 真跑起来——不启动 Electron，
 * 也能逐值断言"窗口在哪、调了几次 setIgnoreMouseEvents、发了几条 hit-state"。</p>
 *
 * <p><b>为什么不另起一套：</b>这套假 electron 是 `tests/petWindowBounds.test.cjs`
 * （D-02/B-3 守卫）已经验证过的同一份，现在抽到这里由两个套件共用。两套假的后果是
 * "A 套件绿、B 套件绿，真机上两种情况都不成立"——那才是最贵的假绿。</p>
 *
 * <p><b>时钟为什么要手摇：</b>命中轮询是 40ms 定频。用真的 `setInterval` 写测试 =
 * 睡眠 + 竞态 + 偶发红；用 `ManualClock` 则是纯函数式推进：`clock.tick(40)` 走一拍，
 * 断言必然确定。</p>
 *
 * @module tests/helpers/petWindowHarness
 */

const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { mkdtempSync, rmSync } = require('node:fs');

const petWindow = require(path.join(__dirname, '..', '..', 'electron', 'pet-window.cjs'));

/** 前端根目录（`pet-window.cjs` 解析 `dist/pet.html` 用）。 */
const FRONTEND_ROOT = path.join(__dirname, '..', '..');

/** 主屏工作区（1920×1080 减去任务栏：常见 Windows 桌面）。 */
const PRIMARY_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/** 单屏环境（`pickDisplay` / 命中判定都只读 `workArea`）。 */
const ONE_SCREEN = [{ workArea: { ...PRIMARY_AREA } }];

/**
 * 造一个极简事件发射器（假 BrowserWindow / 假 webContents 共用）。
 *
 * @returns {object} 带 `on` / `once` / `emit` / `off` 的对象
 */
function makeEmitter() {
  const listeners = new Map();
  return {
    on(name, handler) {
      const list = listeners.get(name) || [];
      list.push(handler);
      listeners.set(name, list);
      return undefined;
    },
    once(name, handler) {
      const wrapped = (...args) => {
        this.off(name, wrapped);
        handler(...args);
      };
      return this.on(name, wrapped);
    },
    off(name, handler) {
      const list = listeners.get(name) || [];
      listeners.set(
        name,
        list.filter((item) => item !== handler),
      );
    },
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) || [])]) handler(...args);
    },
    listenerCount(name) {
      return (listeners.get(name) || []).length;
    },
  };
}

/**
 * 手动时钟：只有 `tick()` 推进时间，`setInterval` 注册的回调按到期顺序触发。
 *
 * @returns {{now: Function, setInterval: Function, clearInterval: Function, pending: Function, tick: Function}}
 *   时钟对象（`registerPetWindow({ clock })` 直接吃这套接口）
 */
function makeManualClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    /** 当前虚拟时间（毫秒）。 */
    now: () => now,
    /**
     * 注册周期回调（语义与全局 `setInterval` 一致，但没有真实时间）。
     *
     * @param {Function} callback 回调
     * @param {number} delay 周期（毫秒，非正数按 1 处理，与浏览器行为近似）
     * @returns {number} 句柄
     */
    setInterval(callback, delay) {
      const interval = Number(delay) > 0 ? Number(delay) : 1;
      const id = (sequence += 1);
      timers.set(id, { callback, interval, next: now + interval });
      return id;
    },
    /**
     * 取消周期回调。
     *
     * @param {number} id 句柄
     * @returns {void}
     */
    clearInterval(id) {
      timers.delete(id);
    },
    /** 还挂着几个定时器（`0` 表示已停表）。 */
    pending: () => timers.size,
    /**
     * 把时间往前推 `ms`，到期回调按"到期时间先后"逐个触发（同一拍内注册的新定时器也能被后续拍看见）。
     *
     * @param {number} ms 推进的毫秒数
     * @returns {number} 本次触发的回调次数
     */
    tick(ms) {
      const delta = Number(ms) > 0 ? Number(ms) : 0;
      now += delta;
      let fired = 0;
      for (let guard = 0; guard < 10000; guard += 1) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.next <= now && (due === null || timer.next < due.timer.next)) due = { id, timer };
        }
        if (due === null) break;
        due.timer.next = now + due.timer.interval;
        due.timer.callback();
        fired += 1;
      }
      return fired;
    },
  };
}

/**
 * 造一套假 electron（`BrowserWindow` / `screen` / `app` / `Menu`），只实现被测代码真正会调的方法。
 *
 * @param {object} state 共享舞台状态（见 {@link makeStage}）
 * @returns {{fake: object, screenHandlers: Map<string, Function[]>}} 假模块与 `screen` 事件表
 */
function makeFakeElectron(state) {
  const screenHandlers = new Map();

  /** 假 BrowserWindow：位置 / 可见性 / 穿透调用全部记账，并像真窗口一样发事件。 */
  class FakeBrowserWindow {
    constructor(options) {
      const settings = options && typeof options === 'object' ? options : {};
      this.bounds = { x: Number(settings.x) || 0, y: Number(settings.y) || 0, width: Number(settings.width) || 0, height: Number(settings.height) || 0 };
      this.destroyed = false;
      this.visible = false;
      this.emitter = makeEmitter();
      this.webContents = {
        sender: null,
        /** 是否已销毁（真 electron 崩溃后仍可能是 false，这里保持同语义的默认值）。 */
        destroyed: false,
        /** 是否已崩溃（`render-process-gone` 之后真 electron 会置 true）。 */
        crashed: false,
        send(channel, payload) {
          // `state.sendThrows` 用来复现真机那条 `Render frame was disposed before WebFrameMain could be accessed`
          if (state.sendThrows === true) {
            throw new Error('Render frame was disposed before WebFrameMain could be accessed');
          }
          state.sent.push({ channel, payload });
        },
        isDestroyed() {
          return this.destroyed === true;
        },
        isCrashed() {
          return this.crashed === true;
        },
        on: (name, handler) => this.webContentsEmitter.on(name, handler),
        once: (name, handler) => this.webContentsEmitter.once(name, handler),
        setWindowOpenHandler() {},
      };
      this.webContentsEmitter = makeEmitter();
      state.windows.push(this);
    }

    getBounds() {
      return { ...this.bounds };
    }

    setPosition(x, y) {
      this.bounds.x = x;
      this.bounds.y = y;
      state.moves.push({ x, y });
      this.emitter.emit('move');
    }

    isDestroyed() {
      return this.destroyed;
    }

    setAlwaysOnTop() {}

    setIgnoreMouseEvents(ignore, options) {
      state.ignoreCalls.push({ ignore: ignore === true, forward: options && options.forward === true });
    }

    loadURL(target) {
      state.loaded = target;
    }

    loadFile(target) {
      state.loaded = target;
    }

    showInactive() {
      this.visible = true;
      this.emitter.emit('show');
    }

    isVisible() {
      return this.visible;
    }

    hide() {
      this.visible = false;
      this.emitter.emit('hide');
    }

    isMinimized() {
      return false;
    }

    restore() {}

    destroy() {
      this.destroyed = true;
      this.emitter.emit('closed');
    }

    on(name, handler) {
      this.emitter.on(name, handler);
    }

    once(name, handler) {
      this.emitter.once(name, handler);
    }

    emit(name, ...args) {
      this.emitter.emit(name, ...args);
    }
  }

  const fake = {
    BrowserWindow: FakeBrowserWindow,
    app: {
      getPath: () => state.userData,
      quit() {
        state.quitCalled = true;
      },
    },
    screen: {
      getAllDisplays: () => ONE_SCREEN,
      getPrimaryDisplay: () => ({ workArea: { ...PRIMARY_AREA } }),
      getDisplayNearestPoint: () => ({ workArea: { ...PRIMARY_AREA } }),
      getCursorScreenPoint: () => {
        state.cursorReads += 1;
        if (state.cursorThrows === true) throw new Error('cursor 读不到（测试注入）');
        return { x: state.cursor.x, y: state.cursor.y };
      },
      on(name, handler) {
        const list = screenHandlers.get(name) || [];
        list.push(handler);
        screenHandlers.set(name, list);
      },
    },
    Menu: {
      buildFromTemplate(template) {
        state.menuTemplate = template;
        return {
          popup(options) {
            state.menuPopups.push(options);
          },
        };
      },
    },
  };
  return { fake, screenHandlers };
}

/**
 * 在假 electron 模块下执行一段同步代码（`Module._load` 临时改写，`finally` 必还原）。
 *
 * @param {object} fakeElectron 假 electron 模块
 * @param {Function} run 待执行的回调
 * @returns {*} 回调返回值
 */
function withFakeElectron(fakeElectron, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return run();
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * 造一个临时状态文件目录 + 假 electron 舞台（跑完必须 `cleanup()`）。
 *
 * @param {object|null} savedState 预置的状态文件内容（`null` 表示不预置）
 * @returns {{statePath: string, state: object, clock: object, cleanup: Function}} 舞台
 */
function makeStage(savedState) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pet-hit-'));
  const statePath = path.join(dir, petWindow.STATE_FILE_NAME);
  if (savedState) petWindow.writeState(statePath, savedState);
  const state = {
    userData: dir,
    moves: [],
    ignoreCalls: [],
    sent: [],
    loaded: null,
    cursor: { x: 0, y: 0 },
    cursorReads: 0,
    cursorThrows: false,
    sendThrows: false,
    menuPopups: [],
    menuTemplate: null,
    windows: [],
    quitCalled: false,
  };
  return {
    statePath,
    state,
    clock: makeManualClock(),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 假 ipcMain：记录注册的处理器，并提供 `send` / `invoke` 供测试"从渲染层发起调用"。
 *
 * @returns {object} 假 ipcMain 与调用助手
 */
function makeFakeIpcMain() {
  const listeners = new Map();
  const handlers = new Map();
  return {
    /** 传给 `registerPetWindow({ ipcMain })` 的对象。 */
    main: {
      on(channel, handler) {
        listeners.set(channel, handler);
      },
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
      removeAllListeners() {
        listeners.clear();
        handlers.clear();
      },
    },
    listeners,
    handlers,
    /**
     * 模拟渲染层 `ipcRenderer.send`（主进程侧是 `ipcMain.on`）。
     *
     * @param {string} channel 频道
     * @param {*} payload 负载
     * @param {object} event IPC 事件（必须带 `sender`）
     * @returns {*} 处理器返回值
     */
    send(channel, payload, event) {
      const handler = listeners.get(channel);
      if (typeof handler !== 'function') return undefined;
      return handler(event, payload);
    },
    /**
     * 模拟渲染层 `ipcRenderer.invoke`（主进程侧是 `ipcMain.handle`）。
     *
     * @param {string} channel 频道
     * @param {*} payload 负载
     * @param {object} event IPC 事件（必须带 `sender`）
     * @returns {*} 处理器返回值
     */
    invoke(channel, payload, event) {
      const handler = handlers.get(channel);
      if (typeof handler !== 'function') return undefined;
      return handler(event, payload);
    },
    /**
     * 造一个"来源合法"的 IPC 事件（`isFromPet` 只认 `event.sender === win.webContents`）。
     *
     * @param {object} win 假窗口
     * @returns {{sender: object}} IPC 事件
     */
    eventFor(win) {
      return { sender: win.webContents };
    },
  };
}

/** 兼容旧套件：一个"全部吞掉"的假 ipcMain。 */
const FAKE_IPC_MAIN = makeFakeIpcMain().main;

/**
 * 完整舞台：假 electron + 假 ipcMain + 手动时钟 + 真跑 `create()`。
 *
 * <p>`run` 结束后一律 `destroy()`（停表、落盘、清定时器），避免残留状态污染下一个用例。</p>
 *
 * @param {object} stage `makeStage()` 的返回值
 * @param {(context: object) => *} run 用例主体（拿到 controller / win / ipc / clock / state）
 * @returns {*} 用例返回值
 */
function withPetWindow(stage, run) {
  const { fake, screenHandlers } = makeFakeElectron(stage.state);
  const ipc = makeFakeIpcMain();
  return withFakeElectron(fake, () => {
    const controller = petWindow.registerPetWindow({
      ipcMain: ipc.main,
      isDev: false,
      frontendRoot: FRONTEND_ROOT,
      statePath: stage.statePath,
      clock: stage.clock,
    });
    const win = controller.create();
    try {
      return run({ controller, win, ipc, clock: stage.clock, state: stage.state, screenHandlers });
    } finally {
      controller.destroy();
    }
  });
}

module.exports = {
  FRONTEND_ROOT,
  PRIMARY_AREA,
  ONE_SCREEN,
  makeEmitter,
  makeManualClock,
  makeFakeElectron,
  withFakeElectron,
  makeStage,
  makeFakeIpcMain,
  FAKE_IPC_MAIN,
  withPetWindow,
};
