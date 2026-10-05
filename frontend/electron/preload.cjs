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
});
