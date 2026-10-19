const { contextBridge, ipcRenderer } = require('electron');

/**
 * 通知窗口的桥。
 *
 * <p>刻意做得极窄：这个窗口只显示主进程推来的一段文本，渲染层拿不到任何
 * 文件、网络或窗口能力。数据也只进不出 —— 回给主进程的只有「悬停 / 点击 / 关闭」
 * 三个无参意图，会话 id 始终留在主进程手里，避免渲染层伪造跳转目标。</p>
 */
contextBridge.exposeInMainWorld('notificationAPI', {
  /** 订阅主进程推来的通知数据；返回取消订阅函数。 */
  onData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('notification:data', listener);
    return () => ipcRenderer.removeListener('notification:data', listener);
  },
  /** 鼠标进入/离开卡片：暂停或恢复自动消失计时。 */
  setHover: (hovered) => ipcRenderer.invoke('notification:set-hover', hovered === true),
  /** 点击卡片主体：唤起主窗口并跳转到对应会话。 */
  activate: () => ipcRenderer.invoke('notification:activate'),
  /** 点关闭按钮。 */
  dismiss: () => ipcRenderer.invoke('notification:dismiss'),
});
 
