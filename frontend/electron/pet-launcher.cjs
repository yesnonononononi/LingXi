#!/usr/bin/env node
'use strict';
/**
 * 桌宠预览启动器（Electron 主进程）——**已从仓外收敛进仓库**。
 *
 * <p>历史：这份逻辑原来住 `.lingxi/tools/pet-launcher.cjs`（仓外、被 gitignore），
 * 里面有三处 `D:/Code/LingXi/...` 硬编码、且自己猜端口 ⇒ 换台机器就没了、CI 也验不到。
 * 现在：路径全部相对 `__dirname` 解析，端口/入口页只从单一真源
 * `electron/pet-dev-endpoint.cjs` 取（经 `electron/pet-launcher-config.cjs`），
 * 由 `npm run pet:dev` 拉起。</p>
 *
 * <p><b>与主应用启动链的关系：</b>主应用 `electron/main.cjs` 的桌宠排在后端就绪之后，
 * 且后端失败会退出；而桌宠本身不依赖后端。这个启动器只做"单开一个桌宠窗口"：
 * 注册 `lxa://` 协议 → 内容指纹探活 → 建窗口 + 托盘。与主应用共用同一份
 * `pet-window.cjs` / `lx-protocol.cjs`，不复制实现。</p>
 *
 * <p><b>窗口单实例：</b>旧 `.cmd` 用 `mkdir` 目录锁防止开出两个窗口；这里改用 Electron
 * 自带的 `requestSingleInstanceLock()`（跨进程原子、且进程退出自动释放，不会留死锁）。</p>
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, ipcMain, Tray, Menu, dialog, systemPreferences } = require('electron');

const { resolveLauncherConfig } = require('./pet-launcher-config.cjs');
const { probePetDevServer } = require('./pet-dev-probe.cjs');
const { registerPetWindow } = require('./pet-window.cjs');
const lx = require('./lx-protocol.cjs');

/**
 * 偏好（schema / 原子写 / 逐字段降级 / reduced-motion 探针）。
 *
 * <p><b>为什么启动器也要这一层：</b>M3 的漫游/跟随开关由主进程持有，偏好必须落盘——
 * 否则"在预览里勾上跟随，重启就忘了"，而用户手动验收 M3 用的正是这个启动器。
 * 与主应用 `main.cjs` 用的是**同一个模块**（`createPrefsStore`），不复制实现。</p>
 */
const petPrefsModule = require('./pet-prefs.cjs');

/**
 * 偏好-菜单**接线层**（纯逻辑，可单测）。
 *
 * <p>上一轮预览启动器与生产 `main.cjs` 分裂成了两条路：生产走"先落盘 → 广播 → 重建菜单"，
 * 预览却在 `registerPetWindow` 里**不传 `prefs`**，于是接线层拿到 `store === null`——
 * `window.petAPI.prefsSet({roam:true})` 返回 `ok:false`、磁盘上从来没有 `pet-prefs.json`、
 * 渲染层永远收不到偏好广播，**漫游/跟随在开发预览里根本打不开**。这就是那个缺陷的成因，
 * 现在收敛成与生产完全相同的一条链。</p>
 */
const petPrefsWiringModule = require('./pet-prefs-wiring.cjs');

/**
 * 菜单 spec 构建器（**文案与结构的唯一真源**，零 Electron 依赖）。
 *
 * <p>启动器原来自己内联了一份 `Menu.buildFromTemplate([...])` 模板（含英文菜单文案），
 * 与 `pet-menu.cjs` 形成第二份真源（生产已经同源、开发反而没有）。现在托盘只经
 * `pet-menu.cjs` 的 `buildTrayItems`，本文件里**一个菜单文案字面量都不留**。</p>
 */
const petMenu = require('./pet-menu.cjs');

/** 解析后的启动器配置（路径 + origin + 入口地址）。 */
const CONFIG = resolveLauncherConfig({ dirname: __dirname, env: process.env });

for (const note of CONFIG.notes) console.warn(`[pet-launcher] ${note}`);
if (!fs.existsSync(path.join(CONFIG.frontendRoot, 'package.json'))) {
  console.error(`[pet-launcher] 前端根目录解析错误（找不到 package.json）：${CONFIG.frontendRoot}`);
}

// 独立 userData：不与被占用的主应用 profile 抢缓存/锁；默认落在 <repo>/.lingxi/tmp（不进源码树）
app.setPath('userData', CONFIG.userDataDir);

// 必须在 app ready 之前登记特权（ready 之后登记会抛异常且 lxa:// 永远加载不出模型）
lx.registerLxSchemePrivileges();

/** 是否正在退出（决定 window-all-closed 是否结束后台进程）。 */
let quitting = false;
/** 托盘句柄。 */
let tray = null;
/** 桌宠窗口管理器句柄。 */
let pet = null;
/** 偏好-菜单接线器（`startPetWindow()` 里建；托盘重建与开关点击都走它）。 */
let petPrefsWiring = null;

/**
 * 偏好文件路径（**落启动器自己的 userData**，不污染真 userData）。
 *
 * <p>为什么不能直接用 `app.getPath('userData')`：启动器已经把 `userData` 改到
 * `<repo>/.lingxi/tmp/<profile>`（`app.setPath` 在前），但这里**显式用 `CONFIG.userDataDir`**
 * 有三种好处：①单测可以静态核对路径来源；②`PET_USER_DATA` 覆盖时行为可预期；
 * ③读代码的人不必去追 `app.setPath` 那一行才知道文件落在哪。</p>
 *
 * @returns {string} `pet-prefs.json` 的绝对路径
 */
function resolvePrefsFilePath() {
  return path.join(CONFIG.userDataDir, 'pet-prefs.json');
}

/**
 * 重建托盘菜单（**勾选态与事实对齐的唯一入口**）。
 *
 * <p>模板来自 `petPrefsWiring.rebuildTray()` → `pet-menu.cjs` 的 `buildTrayItems`，
 * 本文件不写任何文案。托盘可能还没建出来（`setPrefs` 的调用点都在托盘之后，但保持防御）。</p>
 *
 * @returns {void}
 */
function rebuildTrayMenu() {
  if (!petPrefsWiring) return;
  petPrefsWiring.rebuildTray();
}

/**
 * 建窗口 + 托盘。
 *
 * @returns {void}
 */
function startPetWindow() {
  lx.registerLxProtocol({
    userDataDir: app.getPath('userData'),
    appRoot: path.join(CONFIG.frontendRoot, 'dist'),
    extraBases: [path.join(CONFIG.frontendRoot, 'public', 'live2d')],
  });

  // ---------------------------------------------------------------- 偏好（与 main.cjs 同一条链）
  const prefsFilePath = resolvePrefsFilePath();
  // 首次运行 profile 目录可能还不存在：`pet-prefs.cjs` 只做原子写、不建目录
  // （它把"目录归谁"留给调用方）。不建目录的后果是写盘静默失败 —— 正是要修的那个缺陷。
  try {
    fs.mkdirSync(CONFIG.userDataDir, { recursive: true });
  } catch (err) {
    console.warn(`[pet-launcher] userData 目录创建失败（偏好将无法落盘）：${(err && err.message) || err}`);
  }
  const prefsStore = petPrefsModule.createPrefsStore({ filePath: prefsFilePath });
  // 与主应用共用同一个探针（U-M4）：口径只有一处，不在这里另判一遍
  const reducedMotionProbe = petPrefsModule.detectReducedMotion({ app, systemPreferences });

  petPrefsWiring = petPrefsWiringModule.createPrefsWiring({
    store: prefsStore,
    prefersReducedMotion: reducedMotionProbe.reducedMotion,
    builder: petMenu,
    // 启动器恒为开发态：桌宠段永远在（`includePet: true` 就是门禁语义）
    includePet: true,
    isVisible: () => (pet ? pet.isVisible() : false),
    warn: (message) => console.warn(message),
    actions: {
      /** 托盘第一项（应用级主界面项）：预览只有桌宠一个窗口，所以它就是把宠物窗口提上来。 */
      showMain: () => {
        if (pet) pet.show();
      },
      /** 显隐项：托盘勾选项与右键菜单里的显隐项是**同一项**（同一份 spec 派生）。 */
      toggleVisible: () => {
        if (pet) pet.toggle();
      },
      /** 应用级退出项（托盘最后一项）。 */
      quitApp: () => {
        quitting = true;
        app.quit();
      },
    },
    rebuildTray: (spec) => {
      if (!tray) return;
      tray.setContextMenu(Menu.buildFromTemplate(spec));
    },
  });

  /**
   * 偏好端口（传给 `registerPetWindow` 的三件套）。
   *
   * <p>与 `main.cjs` 的 `petPrefsPort` **逐字段同形**：菜单点击、右键菜单、
   * `pet:prefs-set` 三条入口必须走同一条落盘路径，否则会出现"托盘保存了、右键没保存"。</p>
   */
  const petPrefsPort = {
    getPrefs: () => petPrefsWiring.getPrefs(),
    setPrefs: (patch) => petPrefsWiring.setPrefs(patch),
    onPrefsChange: (listener) => petPrefsWiring.onChange(listener),
  };

  // 与生产完全相同的接线：偏好端口 + 菜单构建器一起传下去。
  // 少传任何一个都会退化成"渲染层点了没反应、磁盘上什么都没有"（S4.1 修的就是这个）。
  pet = registerPetWindow({
    ipcMain,
    isDev: true,
    frontendRoot: CONFIG.frontendRoot,
    prefs: petPrefsPort,
    menu: petMenu,
  });
  console.log(`[pet-launcher] 偏好文件：${prefsFilePath}（来源：${reducedMotionProbe.source}）`);

  tray = new Tray(path.join(CONFIG.frontendRoot, 'electron', 'resources', 'icon.ico'));
  tray.setToolTip('LX pet preview');
  // 初始菜单与后续重建走**同一条**路径（与 `main.cjs` 的 setupTray 同构）
  rebuildTrayMenu();
  pet.onVisibilityChange(() => rebuildTrayMenu());

  pet.show();
  console.log(`[pet-launcher] 桌宠窗口已显示：${CONFIG.entryUrl}（右键托盘图标可切换/退出）`);
}

/** 第二个实例被唤起时把已有窗口提到前面，而不是再开一个。 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // 已有桌宠预览实例在跑：静默退出（退出码 0 = "已在运行，不是失败"）
  console.log('[pet-launcher] 已有桌宠预览实例在运行，本次不再开第二个窗口');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (pet) pet.show();
  });

  app.whenReady().then(async () => {
    // 探活：HTTP 200 **且**响应体命中桌宠指纹才算就绪。
    // 只看状态码会重演"桌宠窗口加载成主应用界面"——主应用 dev server 占着端口时
    // /pet.html 被 SPA history fallback 兜成 index.html，状态码照样是 200。
    const probe = await probePetDevServer({ url: CONFIG.entryUrl });

    if (process.env.PET_LAUNCHER_DRYRUN === '1') {
      console.log(`[pet-launcher] dry-run frontendRoot=${CONFIG.frontendRoot}`);
      console.log(`[pet-launcher] dry-run userData=${app.getPath('userData')}`);
      console.log(`[pet-launcher] dry-run entryUrl=${CONFIG.entryUrl}（来源：${CONFIG.originSource}）`);
      console.log(`[pet-launcher] dry-run probe.ok=${probe.ok} reason=${probe.reason}`);
      console.log(`[pet-launcher] dry-run message=${probe.message}`);
      app.exit(probe.ok ? 0 : 1);
      return;
    }

    if (!probe.ok) {
      // 与 dev server 的 --ensure 同一口径：宁可不开窗，也不开错页面
      console.error(`[pet-launcher] 探活失败：${probe.message}`);
      if (probe.hint) console.error(`[pet-launcher] 处理建议：${probe.hint}`);
      try {
        dialog.showErrorBox('桌宠 dev server 未就绪', `${probe.message}\n\n${probe.hint || ''}`);
      } catch (err) {
        console.error(`[pet-launcher] 错误弹窗失败（无 GUI 环境？）：${(err && err.message) || err}`);
      }
      quitting = true;
      app.exit(typeof probe.exitCode === 'number' && probe.exitCode > 0 ? probe.exitCode : 1);
      return;
    }

    startPetWindow();
  });
}

app.on('window-all-closed', () => {
  // 没在退出流程里（例如用户把窗口藏掉了）就保持托盘活着；退出流程里则结束进程
  if (!quitting) return;
  app.quit();
});
