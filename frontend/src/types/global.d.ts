/**
 * 浏览器 / Electron 非标准 API 的全局类型声明。
 *
 * <p>这些成员（`showDirectoryPicker`、`webkitGetAsEntry`、`File.path`）都是宿主提供的扩展，
 * 不在 TypeScript 标准 `lib.dom.d.ts` 里。此前各调用点用 `as any` 绕过，于是调用方既拿不到
 * 自动补全、也丢掉类型检查 —— 例如把 `webkitGetAsEntry` 拼错成 `webkitGetAsEnrty` 也能编译通过。
 * 声明到全局后，调用点直接按类型访问即可，`as any` 全部可以删掉。</p>
 *
 * <p><b>注意</b>：`window.electronAPI` 的声明不在这里，而在 `utils/platform.ts` 的
 * `declare global` 块中（类型为 {@link ElectronAPI}，带完整的文件预览 / 通知 / 标题栏方法签名）。
 * 本仓库已存在该声明，重复声明会造成 TS2717 冲突，故此处不再声明。</p>
 */

/** Chromium 的拖放条目接口；标准 `DataTransferItem` 不含这些成员。 */
interface FileSystemEntry {
  readonly isDirectory: boolean;
  readonly name: string;
}

interface DataTransferItemWithEntry {
  webkitGetAsEntry?: () => FileSystemEntry | null;
}

/** Electron 在 `File` 上追加的绝对路径；Web 端不存在。 */
interface FileWithPath {
  readonly path?: string;
}

/** File System Access API 的目录选择器；返回句柄对象，目录名在 `name` 上。 */
interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
}

interface DirectoryHandleLike {
  readonly name: string;
}

interface Window {
  /** 目录选择器（File System Access API）；非安全上下文下不存在。 */
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<DirectoryHandleLike>;
}
