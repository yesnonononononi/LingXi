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

/** 当前 Electron 暴露的内置浏览器 MCP 通道；非桌面端为 undefined。 */
function browserMcpApi() {
  if (!isElectron()) return undefined;
  return window.electronAPI?.browserMcp;
}

/**
 * 确保本地内置浏览器 MCP 服务已启动，并把最新端口、Token 与描述同步到后端记录。
 *
 * 失败直接抛错：旧实现返回 null，调用方沿用旧记录去重连，用户只看到「连不上」，
 * 真正的「本地服务没起来」被吞掉了。
 *
 * 返回值是后端权威记录（回读一次），不是前端拼的视图对象——令牌与脱敏口径以服务端为准。
 */
export async function syncBrowserMcpRecord(existing: McpVO): Promise<McpVO> {
  const api = browserMcpApi();
  if (!api) throw new Error('内置浏览器 MCP 只在桌面端可用');
  const startRes = await api.start();
  if (!startRes.ok || !startRes.data?.url || !startRes.data?.token) {
    throw new Error(startRes.ok ? '本地浏览器 MCP 启动返回空地址' : startRes.error);
  }

  const updateRes = await McpAPI.update(buildBrowserMcpRequest(startRes.data.url, startRes.data.token, existing));
  if (!isOk(updateRes.code)) {
    throw new Error(updateRes.errMsg || '同步内置浏览器 MCP 配置失败');
  }

  const readRes = await McpAPI.findById(existing.id);
  if (!isOk(readRes.code) || !readRes.data) {
    throw new Error(readRes.errMsg || '同步后读取内置浏览器 MCP 配置失败');
  }
  return readRes.data;
}

/**
 * 桌面端启动时若用户已安装并启用内置浏览器 MCP，则拉起本地服务并同步新端口与 Token。
 * 后端启动通常晚于渲染层挂载，因此遇到网络/启动期异常时按退避重试，避免永久保留旧端口。
 */
export async function syncBrowserMcpOnStartup(
  retryDelaysMs: number[] = [0, 1500, 3000, 5000, 8000],
): Promise<void> {
  if (!browserMcpApi()) return;
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
      await McpAPI.reconnect(synced).catch(() => undefined);
      return;
    } catch {
      // 后端尚未就绪时继续下一次退避重试
    }
  }
}

export function useBrowserMcp(options?: { onChanged?: () => Promise<void> | void }) {
  const supported = Boolean(browserMcpApi());
  const isBusy = ref(false);
  const errorMsg = ref('');
  const serverStatus = ref<BrowserMcpServerStatus | null>(null);

  const refreshStatus = async (): Promise<void> => {
    const api = browserMcpApi();
    if (!api) return;
    try {
      const res = await api.getStatus();
      if (res.ok) serverStatus.value = res.data;
    } catch {
      // 忽略状态读取异常
    }
  };

  /**
   * 启用：先起本地服务，再把地址写进后端记录。
   *
   * 写库失败必须把本地服务停掉：否则留一个没人知道的监听端口，而后端继续捏着
   * 旧端口旧令牌，正好撞上 ClosedChannelException。
   */
  const enableBrowserMcp = async (existing?: McpVO): Promise<boolean> => {
    const api = browserMcpApi();
    if (!api) return false;
    isBusy.value = true;
    errorMsg.value = '';
    try {
      const startRes = await api.start();
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
        await api.stop().catch(() => undefined);
        serverStatus.value = null;
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

  /**
   * 停用：先停本地服务再删记录；删不掉就把服务拉回来，别留一条指向死端口的记录。
   */
  const disableBrowserMcp = async (existing?: McpVO): Promise<boolean> => {
    const api = browserMcpApi();
    if (!api) return false;
    isBusy.value = true;
    errorMsg.value = '';
    try {
      const stopRes = await api.stop();
      if (!stopRes.ok) {
        errorMsg.value = stopRes.error;
        return false;
      }
      serverStatus.value = stopRes.data;
      if (existing) {
        const delRes = await McpAPI.delById(existing.id);
        if (!isOk(delRes.code)) {
          errorMsg.value = delRes.errMsg || '移除内置浏览器 MCP 失败';
          await api.start().catch(() => undefined);
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
