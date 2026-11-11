const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const electron = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
// 主进程脚本里的 require 语义以 electron/ 为基准，桩函数必须沿用同一基准。
const electronRequire = createRequire(path.join(frontendRoot, 'electron', 'main.cjs'));
let source = fs.readFileSync(path.join(frontendRoot, 'electron/main.cjs'), 'utf8');
if (process.argv.includes('--omit-taskbar-details')) {
  const original = source;
  source = source.replace('mainWindow.setAppDetails({', 'void ({');
  assert.notEqual(source, original, '变异必须确实撤掉任务栏属性注册');
}
electron.app.on('window-all-closed', () => {});

// 读取 Shell 实际收到的属性，避免仅断言调用参数而漏掉原生层未生效的问题。
function readTaskbarProperties(window) {
  const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
  const script = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaskbarProperties {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface PropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out PropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
  public static string Read(long hwnd, uint pid) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    PropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(hwnd), ref iid, out store));
    try {
      PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = pid };
      PropVariant value;
      Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
      try { return value.vt == 31 ? Marshal.PtrToStringUni(value.pointer) : null; }
      finally { PropVariantClear(ref value); }
    } finally { Marshal.ReleaseComObject(store); }
  }
}
'@
@{
  command = [TaskbarProperties]::Read(${handle}, 2)
  icon = [TaskbarProperties]::Read(${handle}, 3)
  name = [TaskbarProperties]::Read(${handle}, 4)
  appId = [TaskbarProperties]::Read(${handle}, 5)
} | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function createMainWindow(isPackaged) {
  let window;
  let processAppId;
  // 仅隔离后端、页面加载与自动启动，窗口和 setAppDetails 使用真实 Electron 实现。
  class ProbeWindow extends electron.BrowserWindow {
    constructor(options) { super(options); window = this; }
    loadURL() {}
    loadFile() {}
  }
  const app = {
    isPackaged,
    setAppUserModelId(id) { processAppId = id; },
    setPath() {}, getPath: () => electron.app.getPath('temp'),
    getAppPath: () => 'D:\\LingXi Development\\frontend',
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }), on() {},
  };
  // 主进程自己的模块（经 electronRequire 真加载）同样会 require('electron')，
  // 所以桩必须挂在「按 electron/ 解析」这条路径上，而不只是 vm 里的 require。
  const ipcMain = {
    handle() { return ipcMain; }, on() { return ipcMain; }, once() { return ipcMain; },
    removeHandler() {}, removeAllListeners() {},
  };
  // protocol 的方案特权注册必须在 app ready 之前完成，本冒烟是在 ready 之后才执行主进程脚本，
  // 真实模块会直接抛错；任务栏用例不关心协议层，桩掉即可。
  const protocol = {
    registerSchemesAsPrivileged() {}, handle() {}, unhandle() {},
    registerBufferProtocol() {}, registerFileProtocol() {}, registerStringProtocol() {},
  };
  const electronStub = { ...electron, app, BrowserWindow: ProbeWindow, ipcMain, protocol };
  const stubRequire = name => name === 'electron' ? electronStub : electronRequire(name);
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electronStub;
      if (name === './backend.cjs') return {};
      if (name === './file-preview.cjs') return { registerFilePreview: () => () => {} };
      if (name === './notification-window.cjs') return { registerNotificationWindow: () => ({}) };
      // 主页背景 IPC（L2）：主进程新增的模块，这里只需桩掉注册入口，本用例不关心它
      if (name === './background-images.cjs') return { registerBackgroundImages: () => ({ close() {} }) };
      if (name === './updater.cjs') return { createUpdater: () => ({}) };
      // lx 自定义协议的特权注册只能在 app ready 之前调用，模块内部自己 require('electron')，
      // 拿不到本桩的真实模块会在 ready 之后抛错；任务栏用例与协议层无关，桩掉两个注册入口。
      if (name === './lx-protocol.cjs') {
        return { registerLxSchemePrivileges() {}, registerLxProtocol() {} };
      }
      // 主进程的裸相对 require 必须按 electron/ 目录解析：这里是 vm 里的桩，
      // 直接调本文件的 require 会把 './x.cjs' 解析成 tests/x.cjs（MODULE_NOT_FOUND）。
      return stubRequire(name);
    },
    __dirname: path.join(frontendRoot, 'electron'),
    process: { platform: 'win32', execPath: process.execPath, argv: [], env: {} },
    console,
  });
  vm.runInContext(source, context);
  vm.runInContext('createWindow()', context);
  return { window, processAppId };
}

electron.app.whenReady().then(() => {
  for (const isPackaged of [false, true]) {
    const { window, processAppId } = createMainWindow(isPackaged);
    try {
      const properties = readTaskbarProperties(window);
      const expectedId = isPackaged ? 'com.lingxi.lx' : 'com.lingxi.lx.development';
      assert.equal(processAppId, expectedId);
      assert.equal(properties.appId, expectedId);
      assert.equal(properties.name, isPackaged ? 'LX' : 'LX 开发版');
      const expectedIcon = isPackaged ? process.execPath : path.join(frontendRoot, 'electron/resources/icon.ico');
      assert.equal(properties.icon, `${expectedIcon},0`);
      assert.ok(fs.existsSync(expectedIcon));
      if (!isPackaged) assert.equal(electron.nativeImage.createFromPath(expectedIcon).isEmpty(), false);
      assert.equal(properties.command, isPackaged ? `"${process.execPath}"`
        : `"${process.execPath}" "D:\\LingXi Development\\frontend" --dev`);
    } finally { window.destroy(); }
  }
  console.log('开发版与安装版任务栏属性验证通过');
  electron.app.exit(0);
}).catch(error => {
  console.error(error);
  electron.app.exit(1);
});
