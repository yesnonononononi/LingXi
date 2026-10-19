// 渲染进程与主进程之间唯一的桥。只暴露桌宠需要的最小能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  openMenu: () => ipcRenderer.send('pet:open-menu'),
  getConfig: () => ipcRenderer.invoke('pet:get-config'),
  setScale: (scale) => ipcRenderer.invoke('pet:set-scale', scale),
  quit: () => ipcRenderer.send('pet:quit'),
});
