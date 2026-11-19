/** 内置浏览器本地 MCP（可选能力）的启停、同步与配置管理。 */
import {ref} from 'vue';
import {McpAPI} from '../services/mcp';
import type {McpRequest, McpVO} from '../types/chat';
import {isOk} from '../utils/api';
import {isElectron, type BrowserMcpServerStatus} from '../utils/platform';

export const BROWSER_MCP_SERVER_NAME = 'lingxi-browser';
export const BROWSER_MCP_DESCRIPTION =
  'Built-in desktop browser & Design Canvas automation: navigate URLs, click/fill by ref or CSS selector, inspect elements/console/network/JS, capture screenshots, and inspect/capture/resolve comments in the active Design Canvas.';

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
 * 桌面端启动时若用户已安装并启用内置浏览器 MCP，则拉起本地服务并同步新端口与 Token。
 * 未安装或已停用时保持静默，不占用本地端口。
 */
export async function syncBrowserMcpOnStartup(): Promise<void> {
  if (!isElectron() || !window.electronAPI?.browserMcp) return;
  try {
    const listRes = await McpAPI.list(1, 100);
    if (!isOk(listRes.code) || !listRes.data?.records) return;
    const existing = findBrowserMcpRecord(listRes.data.records);
    if (!existing || existing.status !== 1) return;

    const startRes = await window.electronAPI.browserMcp.start();
    if (!startRes.ok || !startRes.data?.url || !startRes.data?.token) return;

    const updateRes = await McpAPI.update(
      buildBrowserMcpRequest(startRes.data.url, startRes.data.token, existing),
    );
    if (isOk(updateRes.code)) {
      await McpAPI.reconnect({...existing, url: startRes.data.url}).catch(() => undefined);
    }
  } catch {
    // 启动同步静默兜底，避免影响主应用启动。
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
