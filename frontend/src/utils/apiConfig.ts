/**
 * API 服务地址配置中心。
 *
 * 解决桌面客户端 (Electron) 与 Web 端在生产环境下的接口寻址问题：
 * - 桌面客户端或生产构建中没有 Vite 开发代理，需直连后端服务 (默认 http://localhost:8088)。
 * - 支持用户在通用设置中自定义后端地址 (例如连接局域网/远程服务器)。
 * - Web 开发环境未配置时仍走 Vite 代理 (空相对路径)。
 */

const STORAGE_KEY_API_BASE_URL = 'lingxi_api_base_url';

/** 检测当前是否运行在桌面客户端环境 (Electron) */
export function isDesktopApp(): boolean {
  // electronAPI 的类型见 utils/platform.ts 的 declare global 块，无需类型逃逸
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

/** 获取当前生效的 API Base URL */
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';

  // 1. 用户自定义配置优先
  const userConfigured = localStorage.getItem(STORAGE_KEY_API_BASE_URL)?.trim();
  if (userConfigured) {
    return userConfigured.replace(/\/+$/, '');
  }

  // 2. 环境变量 (VITE_API_BASE_URL)
  const envUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL)?.trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  // 3. 桌面端模式或生产静态构建：默认直连本地后端 8088
  if (isDesktopApp() || (typeof import.meta !== 'undefined' && import.meta.env?.PROD)) {
    return 'http://localhost:8088';
  }

  // 4. Web 开发环境：默认走 Vite 代理
  return '';
}

/** 设置并持久化自定义 API Base URL */
export function setApiBaseUrl(url: string): void {
  const cleanUrl = url.trim().replace(/\/+$/, '');
  if (!cleanUrl) {
    localStorage.removeItem(STORAGE_KEY_API_BASE_URL);
  } else {
    localStorage.setItem(STORAGE_KEY_API_BASE_URL, cleanUrl);
  }
}

/** 重置为默认后端地址 */
export function resetApiBaseUrl(): void {
  localStorage.removeItem(STORAGE_KEY_API_BASE_URL);
}

/** 将相对路径拼接为完整 API 请求地址 */
export function resolveApiUrl(path: string): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}
