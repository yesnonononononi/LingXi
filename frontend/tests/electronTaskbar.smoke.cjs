const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const electron = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
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
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return { ...electron, app, BrowserWindow: ProbeWindow, ipcMain: { handle() {} } };
      if (name === './backend.cjs') return {};
      if (name === './file-preview.cjs') return { registerFilePreview: () => () => {} };
      if (name === './notification-window.cjs') return { registerNotificationWindow: () => ({}) };
      // 主页背景 IPC（L2）：主进程新增的模块，这里只需桩掉注册入口，本用例不关心它
      if (name === './background-images.cjs') return { registerBackgroundImages: () => ({ close() {} }) };
      if (name === './updater.cjs') return { createUpdater: () => ({}) };
      return require(name);
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
