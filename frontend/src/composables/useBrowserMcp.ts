/** 内置浏览器本地 MCP（可选能力）的启停、同步与配置管理。 */
import {ref} from 'vue';
import {McpAPI} from '../services/mcp';
import type {McpRequest, McpVO} from '../types/chat';
import {isOk} from '../utils/api';
import {isElectron, type BrowserMcpServerStatus} from '../utils/platform';

export const BROWSER_MCP_SERVER_NAME = 'lingxi-browser';
/** 后端 Mcp.DESCRIPTION_MAX_LENGTH 上限为 200 字符，描述必须严格低于该阈值。 */
export const BROWSER_MCP_DESCRIPTION =
  'Built-in browser & Design Canvas MCP: navigate, click/fill by ref, inspect DOM/console/network/JS, capture screenshots, and sync Design Canvas.';

export function findBrowserMcpRecord(list: McpVO[]): McpVO | undefined {
  return list.find(item => item.name === BROWSER_MCP_SERVER_NAME);
}

export function buildBrowserMcpRequest(
  url: string,
  token: string,
  existing?: McpVO,
): McpRequest {
  const payload: McpRequest = {
    name: BROWSER_MCP_SERVER_NAME,
    transport: 'streamable-http',
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    description: BROWSER_MCP_DESCRIPTION,
    status: 1,
    protocolVersion: '2025-11-25',
    autoHealthCheck: false,
  };
  if (existing?.id !== undefined) {
    payload.id = existing.id;
  }
  return payload;
}

/**
 * 确保本地内置浏览器 MCP 服务已启动，并把最新端口、Token 与描述同步到后端记录。
 * 供启动同步、以及设置页对 `lingxi-browser` 执行「重新连接 / 测试连接」前调用，
 * 避免后端继续连向旧进程遗留的失效端口导致 ClosedChannelException。
 */
export async function syncBrowserMcpRecord(existing: McpVO): Promise<McpVO | null> {
  if (!isElectron() || !window.electronAPI?.browserMcp) return null;
  const startRes = await window.electronAPI.browserMcp.start();
  if (!startRes.ok || !startRes.data?.url || !startRes.data?.token) return null;

  const payload = buildBrowserMcpRequest(startRes.data.url, startRes.data.token, existing);
  const updateRes = await McpAPI.update(payload);
  if (!isOk(updateRes.code)) {
    throw new Error(updateRes.errMsg || '同步内置浏览器 MCP 配置失败');
  }
  return {
    ...existing,
    url: startRes.data.url,
    description: BROWSER_MCP_DESCRIPTION,
    status: 1,
  };
}

/**
 * 桌面端启动时若用户已安装并启用内置浏览器 MCP，则拉起本地服务并同步新端口与 Token。
 * 后端启动通常晚于渲染层挂载，因此遇到网络/启动期异常时按退避重试，避免永久保留旧端口。
 */
export async function syncBrowserMcpOnStartup(
  retryDelaysMs: number[] = [0, 1500, 3000, 5000, 8000],
): Promise<void> {
  if (!isElectron() || !window.electronAPI?.browserMcp) return;
  for (let i = 0; i < retryDelaysMs.length; i++) {
    const delay = retryDelaysMs[i] ?? 0;
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      const listRes = await McpAPI.list(1, 100);
      if (!isOk(listRes.code) || !listRes.data?.records) continue;
      const existing = findBrowserMcpRecord(listRes.data.records);
      if (!existing || existing.status !== 1) return;

      const synced = await syncBrowserMcpRecord(existing);
      if (synced) {
        await McpAPI.reconnect(synced).catch(() => undefined);
      }
      return;
    } catch {
      // 后端尚未就绪时继续下一次退避重试
    }
  }
}

export function useBrowserMcp(options?: { onChanged?: () => Promise<void> | void }) {
  const supported = isElectron() && Boolean(window.electronAPI?.browserMcp);
  const isBusy = ref(false);
  const errorMsg = ref('');
  const serverStatus = ref<BrowserMcpServerStatus | null>(null);

  const refreshStatus = async (): Promise<void> => {
    if (!supported || !window.electronAPI?.browserMcp) return;
    try {
      const res = await window.electronAPI.browserMcp.getStatus();
      if (res.ok) serverStatus.value = res.data;
    } catch {
      // 忽略状态读取异常
    }
  };

  const enableBrowserMcp = async (existing?: McpVO): Promise<boolean> => {
    if (!supported || !window.electronAPI?.browserMcp) return false;
    isBusy.value = true;
    errorMsg.value = '';
    try {
      const startRes = await window.electronAPI.browserMcp.start();
      if (!startRes.ok || !startRes.data?.url || !startRes.data?.token) {
        errorMsg.value = startRes.ok ? '本地浏览器 MCP 启动返回空地址' : startRes.error;
        return false;
      }
      serverStatus.value = startRes.data;
      const payload = buildBrowserMcpRequest(startRes.data.url, startRes.data.token, existing);
      const saveRes = existing
        ? await McpAPI.update(payload)
        : await McpAPI.add(payload);
      if (!isOk(saveRes.code)) {
        errorMsg.value = saveRes.errMsg || '注册内置浏览器 MCP 失败';
        return false;
      }
      await options?.onChanged?.();
      return true;
    } catch (error) {
      errorMsg.value = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      isBusy.value = false;
    }
  };

  const disableBrowserMcp = async (existing?: McpVO): Promise<boolean> => {
    if (!supported || !window.electronAPI?.browserMcp) return false;
    isBusy.value = true;
    errorMsg.value = '';
    try {
      const stopRes = await window.electronAPI.browserMcp.stop();
      if (stopRes.ok) serverStatus.value = stopRes.data;
      if (existing) {
        const delRes = await McpAPI.delById(existing.id);
        if (!isOk(delRes.code)) {
          errorMsg.value = delRes.errMsg || '移除内置浏览器 MCP 失败';
          return false;
        }
      }
      await options?.onChanged?.();
      return true;
    } catch (error) {
      errorMsg.value = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      isBusy.value = false;
    }
  };

  return {
    supported,
    isBusy,
    errorMsg,
    serverStatus,
    refreshStatus,
    enableBrowserMcp,
    disableBrowserMcp,
  };
}
