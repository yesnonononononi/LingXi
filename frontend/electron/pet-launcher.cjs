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
const { app, ipcMain, Tray, Menu, dialog } = require('electron');

const { resolveLauncherConfig } = require('./pet-launcher-config.cjs');
const { probePetDevServer } = require('./pet-dev-probe.cjs');
const { registerPetWindow } = require('./pet-window.cjs');
const lx = require('./lx-protocol.cjs');

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

  pet = registerPetWindow({ ipcMain, isDev: true, frontendRoot: CONFIG.frontendRoot });

  const buildMenu = () =>
    Menu.buildFromTemplate([
      {
        label: 'Show pet',
        type: 'checkbox',
        checked: pet.isVisible(),
        click: () => pet.toggle(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);

  tray = new Tray(path.join(CONFIG.frontendRoot, 'electron', 'resources', 'icon.ico'));
  tray.setToolTip('LX pet preview');
  tray.setContextMenu(buildMenu());
  pet.onVisibilityChange(() => tray.setContextMenu(buildMenu()));

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
