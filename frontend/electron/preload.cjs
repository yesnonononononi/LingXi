const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  previewFile: (request) => ipcRenderer.invoke('file-preview:read', request),
  openFile: (request) => ipcRenderer.invoke('file-preview:open', request),
  revealFile: (request) => ipcRenderer.invoke('file-preview:reveal', request),
  unwatchFile: (watchId) => ipcRenderer.invoke('file-preview:unwatch', watchId),
  onFileChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('file-preview:changed', listener);
    return () => ipcRenderer.removeListener('file-preview:changed', listener);
  },
  /** 调起系统原生目录选择器，返回所选文件夹绝对物理路径 */
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  /** 发送系统原生通知 (Windows 10/11 横幅通知) */
  notify: (options) => ipcRenderer.invoke('notify', options),
  setTitleBarTheme: (isDark) => ipcRenderer.invoke('window:set-titlebar-theme', isDark),
  // 窗口创建参数不会随页面热更新，不能凭接口存在就展示第二层标题栏。
  customTitleBar: process.argv.includes('--lingxi-custom-titlebar'),
  /** 当前宿主系统平台 (win32 / darwin / linux) */
  platform: process.platform,

  // ────────────────────────────────────────────────────────────
  // 自动更新
  // ⚠️ 渲染层只能「读状态」和「发意图」。所有下载/校验/安装都在主进程完成，
  //    这里不做任何 URL 拼接、不做任何文件操作 —— 那是最容易被注入利用的部分。
  // ────────────────────────────────────────────────────────────
  updater: {
    /** 拉取当前更新状态初值；主进程会校验调用来源，非法来源返回 null */
    getState: () => ipcRenderer.invoke('update:get-state'),
    /** 手动检查更新 */
    check: () => ipcRenderer.invoke('update:check'),
    /** 下载已发现的更新 */
    download: () => ipcRenderer.invoke('update:download'),
    /** 安装并重启应用 */
    install: () => ipcRenderer.invoke('update:install'),
    /** 在文件管理器中定位更新日志（排障用） */
    openLog: () => ipcRenderer.invoke('update:open-log'),
    /**
     * 订阅更新状态。返回取消订阅函数。
     * 回调收到 { state, currentVersion, availableVersion?, releaseNotes?, forceupdate?, ... }
     */
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('update:state', listener);
      return () => ipcRenderer.removeListener('update:state', listener);
    },
  },
});
