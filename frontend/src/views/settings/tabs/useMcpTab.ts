import { ref, onMounted, onBeforeUnmount } from 'vue';
import { McpAPI } from '../../../services/api';
import type { McpVO } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { useConfirm } from '../../../composables/useConfirm';

const MCP_DEFAULT_INIT_TIMEOUT = 30_000;
const MCP_DEFAULT_EXEC_TIMEOUT = 60_000;
const MCP_DEFAULT_MAX_OUTPUT = 20_000;

export function useMcpTab() {
  const mcpList = ref<McpVO[]>([]);
  const isMcpLoading = ref(false);
  const mcpErrorMsg = ref('');
  const isEditingOrAddingMcp = ref(false);
  const editingMcpId = ref<number | string | null>(null);
  const mcpFormError = ref('');
  const isSubmittingMcp = ref(false);
  const mcpToast = ref('');
  let mcpToastTimer: number | undefined;

  /**
   * 表单模型。
   * `headerLines` 是「一行一个 Key: Value」的纯文本编辑态——比做成键值对表格控件简单得多，
   * 提交时再解析成对象；`headersUnchanged` 记录本次是否改动了请求头，
   * 未改动则整体不提交该字段，由后端保留库中原值（避免把脱敏掩码写回库）。
   */
  const mcpForm = ref({
    name: '',
    transport: 'streamable-http' as string,
    url: '',
    headerLines: '',
    toolNamePrefix: '',
    initializationTimeout: MCP_DEFAULT_INIT_TIMEOUT as number | null,
    executionTimeout: MCP_DEFAULT_EXEC_TIMEOUT as number | null,
    maxOutput: MCP_DEFAULT_MAX_OUTPUT as number | null,
    enabled: true,
  });
  /** 编辑态下请求头是否保持原样（未改动则不提交 headers 字段） */
  const mcpHeadersPristine = ref(false);

  const showMcpToast = (msg: string) => {
    mcpToast.value = msg;
    if (mcpToastTimer) window.clearTimeout(mcpToastTimer);
    mcpToastTimer = window.setTimeout(() => {
      mcpToast.value = '';
    }, 2500);
  };

  const loadMcp = async () => {
    isMcpLoading.value = true;
    mcpErrorMsg.value = '';
    try {
      const res = await McpAPI.list(1, 100);
      if (isOk(res.code)) {
        mcpList.value = res.data?.records ?? [];
      } else {
        mcpErrorMsg.value = res.errMsg || '加载 MCP 服务列表失败，请稍后重试';
      }
    } catch {
      mcpErrorMsg.value = '加载 MCP 服务列表失败，请稍后重试';
    } finally {
      isMcpLoading.value = false;
    }
  };

  /** 把请求头对象渲染成「Key: Value」多行文本；值为掩码时原样保留，供后端识别「未改动」 */
  const headersToLines = (headers?: Record<string, string>) => {
    if (!headers) return '';
    return Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  };

  /** 解析多行文本为请求头对象；非法行抛错由调用方转为表单错误 */
  const linesToHeaders = (text: string): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const sep = line.indexOf(':');
      if (sep <= 0) throw new Error(`请求头格式应为 "名称: 值"，无法解析: ${line}`);
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim();
      if (!key) throw new Error(`请求头名称不能为空: ${line}`);
      if (!value) throw new Error(`请求头 ${key} 的值不能为空`);
      result[key] = value;
    }
    return result;
  };

  const startAddMcp = () => {
    editingMcpId.value = null;
    mcpForm.value = {
      name: '',
      transport: 'streamable-http',
      url: '',
      headerLines: '',
      toolNamePrefix: '',
      initializationTimeout: MCP_DEFAULT_INIT_TIMEOUT,
      executionTimeout: MCP_DEFAULT_EXEC_TIMEOUT,
      maxOutput: MCP_DEFAULT_MAX_OUTPUT,
      enabled: true,
    };
    mcpHeadersPristine.value = false;
    mcpFormError.value = '';
    isEditingOrAddingMcp.value = true;
  };

  const startEditMcp = (item: McpVO) => {
    editingMcpId.value = item.id;
    mcpForm.value = {
      name: item.name || '',
      transport: item.transport || 'streamable-http',
      url: item.url || '',
      headerLines: headersToLines(item.headers),
      toolNamePrefix: item.toolNamePrefix || '',
      initializationTimeout: item.initializationTimeout ?? MCP_DEFAULT_INIT_TIMEOUT,
      executionTimeout: item.executionTimeout ?? MCP_DEFAULT_EXEC_TIMEOUT,
      maxOutput: item.maxOutput ?? MCP_DEFAULT_MAX_OUTPUT,
      enabled: item.status !== 0,
    };
    mcpHeadersPristine.value = true;
    mcpFormError.value = '';
    isEditingOrAddingMcp.value = true;
  };

  const cancelMcpForm = () => {
    isEditingOrAddingMcp.value = false;
    editingMcpId.value = null;
    mcpFormError.value = '';
    mcpHeadersPristine.value = false;
  };

  const handleSaveMcp = async () => {
    mcpFormError.value = '';
    const trimmedName = mcpForm.value.name.trim();
    const trimmedUrl = mcpForm.value.url.trim();

    if (!trimmedName) {
      mcpFormError.value = '请填写服务名称';
      return;
    }
    if (trimmedName.length > 64) {
      mcpFormError.value = '服务名称长度不能超过 64 个字符';
      return;
    }
    if (!trimmedUrl) {
      mcpFormError.value = '请填写服务地址';
      return;
    }
    if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
      mcpFormError.value = '服务地址必须以 http:// 或 https:// 开头';
      return;
    }
    if (mcpForm.value.toolNamePrefix && mcpForm.value.toolNamePrefix.length > 64) {
      mcpFormError.value = '工具名前缀长度不能超过 64 个字符';
      return;
    }
    if (mcpForm.value.initializationTimeout !== null && mcpForm.value.initializationTimeout <= 0) {
      mcpFormError.value = '初始化超时必须大于 0';
      return;
    }
    if (mcpForm.value.executionTimeout !== null && mcpForm.value.executionTimeout <= 0) {
      mcpFormError.value = '执行超时必须大于 0';
      return;
    }
    if (mcpForm.value.maxOutput !== null && mcpForm.value.maxOutput <= 0) {
      mcpFormError.value = '输出上限必须大于 0';
      return;
    }

    // 仅在用户改动过请求头时才提交该字段，否则后端保留库中原值
    let headers: Record<string, string> | undefined;
    const headersChanged = !mcpHeadersPristine.value;
    if (headersChanged) {
      try {
        headers = linesToHeaders(mcpForm.value.headerLines);
      } catch (e: any) {
        mcpFormError.value = e?.message || '请求头格式不正确';
        return;
      }
    }

    const payload = {
      name: trimmedName,
      transport: mcpForm.value.transport,
      url: trimmedUrl,
      headers,
      toolNamePrefix: mcpForm.value.toolNamePrefix.trim() || undefined,
      initializationTimeout: mcpForm.value.initializationTimeout ?? undefined,
      executionTimeout: mcpForm.value.executionTimeout ?? undefined,
      maxOutput: mcpForm.value.maxOutput ?? undefined,
      status: mcpForm.value.enabled ? 1 : 0,
    };

    isSubmittingMcp.value = true;
    try {
      if (editingMcpId.value) {
        const res = await McpAPI.update({ id: editingMcpId.value, ...payload });
        if (isOk(res.code)) {
          showMcpToast('MCP 服务已成功更新');
          isEditingOrAddingMcp.value = false;
          await loadMcp();
        } else {
          mcpFormError.value = res.errMsg || '更新 MCP 服务失败，请稍后重试';
        }
      } else {
        const res = await McpAPI.add(payload);
        if (isOk(res.code)) {
          showMcpToast('MCP 服务已成功创建');
          isEditingOrAddingMcp.value = false;
          await loadMcp();
        } else {
          mcpFormError.value = res.errMsg || '创建 MCP 服务失败，请稍后重试';
        }
      }
    } catch (e: any) {
      mcpFormError.value = e?.message || '保存 MCP 服务失败，请稍后重试';
    } finally {
      isSubmittingMcp.value = false;
    }
  };

  const { confirm } = useConfirm();

  const handleDeleteMcp = async (item: McpVO) => {
    const confirmed = await confirm({
      title: '删除 MCP 服务',
      content: `确定要删除 MCP 服务「${item.name}」吗？此操作无法撤销。`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
    });
    if (!confirmed) return;

    try {
      const res = await McpAPI.delById(item.id);
      if (isOk(res.code)) {
        showMcpToast('MCP 服务已删除');
        await loadMcp();
      } else {
        showMcpToast(res.errMsg || '删除 MCP 服务失败，请稍后重试');
      }
    } catch {
      showMcpToast('删除 MCP 服务异常');
    }
  };

  /** 列表内快速启停，不必进编辑表单 */
  const handleToggleMcp = async (item: McpVO) => {
    const nextEnabled = item.status === 0;
    try {
      const res = await McpAPI.update({
        id: item.id,
        name: item.name,
        transport: item.transport,
        url: item.url,
        status: nextEnabled ? 1 : 0,
      });
      if (isOk(res.code)) {
        showMcpToast(nextEnabled ? '已启用' : '已停用');
        await loadMcp();
      } else {
        showMcpToast(res.errMsg || '状态更新失败，请稍后重试');
      }
    } catch {
      showMcpToast('状态更新异常');
    }
  };

  /** 请求头数量，仅用于列表展示（值已脱敏，不展示内容） */
  const headerCountOf = (item: McpVO) => Object.keys(item.headers || {}).length;

  onMounted(() => {
    loadMcp();
  });

  onBeforeUnmount(() => {
    if (mcpToastTimer) window.clearTimeout(mcpToastTimer);
  });

  return {
    mcpList,
    isMcpLoading,
    mcpErrorMsg,
    isEditingOrAddingMcp,
    editingMcpId,
    mcpFormError,
    isSubmittingMcp,
    mcpToast,
    mcpForm,
    mcpHeadersPristine,
    loadMcp,
    startAddMcp,
    startEditMcp,
    cancelMcpForm,
    handleSaveMcp,
    handleDeleteMcp,
    handleToggleMcp,
    headerCountOf,
  };
}
