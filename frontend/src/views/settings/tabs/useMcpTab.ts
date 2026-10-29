import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { McpAPI } from '../../../services/api';
import { ApiError } from '../../../services/interceptor';
import {
  MCP_PROTOCOL_VERSION_MAX_LENGTH,
  MCP_PROTOCOL_VERSION_PATTERN,
} from '../../../types/chat';
import type { McpVO, McpRequest, McpConnectionVO } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { useConfirm } from '../../../composables/useConfirm';
import { useI18n } from '../../../i18n';

const MCP_DEFAULT_INIT_TIMEOUT = 30_000;
const MCP_DEFAULT_EXEC_TIMEOUT = 60_000;
const MCP_DEFAULT_MAX_OUTPUT = 20_000;

/** 「自动健康检查」三态取值：unset = 不下发（沿用库默认），on / off = 显式下发布尔值。 */
export type McpTriState = 'unset' | 'on' | 'off';

/**
 * 把数字输入框的原始取值收敛为「毫秒数或 null」。
 *
 * `<input type="number">` 被清空时 `v-model.number` 会留下空串，运行时类型与声明的
 * `number | null` 并不一致，因此这里统一兜底：空串/空白/NaN/其它类型一律视为
 * 「未设置」= null（契约 2.2：null 就是 null，绝不补默认值）。
 *
 * @param raw 输入框原始取值
 * @returns 毫秒数；未设置时返回 null
 */
function toNullableMilliseconds(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function useMcpTab() {
  const { t } = useI18n();
  const mcpList = ref<McpVO[]>([]);
  const isMcpLoading = ref(false);
  const mcpErrorMsg = ref('');
  const isEditingOrAddingMcp = ref(false);
  const editingMcpId = ref<number | string | null>(null);
  const mcpFormError = ref('');
  const isSubmittingMcp = ref(false);
  const isConnectingMcp = ref(false);
  const mcpConnectionResult = ref<McpConnectionVO | null>(null);
  const mcpConnectionError = ref('');
  let connectionRequest = 0;
  const mcpRowConnections = ref<Record<string, { loading: boolean; success: boolean; error: string }>>({});
  const mcpToast = ref('');
  let mcpToastTimer: number | undefined;

  /**
   * 表单模型。
   * `headerLines` 是「一行一个 Key: Value」的请求头编辑态；`commandLines` 是 stdio
   * 启动命令的「一行一段 argv」编辑态——argv 逐段传给子进程，不做 shell 拼接，
   * 段内空格无需转义；`envLines` 是「一行一个 KEY=VALUE」的环境变量编辑态。
   * `headersUnchanged` / env 同理：记录本次是否改动，未改动则整体不提交该字段，
   * 由后端保留库中原值（避免把脱敏掩码写回库）。
   */
  const mcpForm = ref({
    name: '',
    transport: 'streamable-http' as string,
    url: '',
    headerLines: '',
    commandLines: '',
    envLines: '',
    description: '',
    initializationTimeout: MCP_DEFAULT_INIT_TIMEOUT as number | null,
    executionTimeout: MCP_DEFAULT_EXEC_TIMEOUT as number | null,
    maxOutput: MCP_DEFAULT_MAX_OUTPUT as number | null,
    /**
     * 高级连接容错四项（契约 2.1 / 2.2）。全部可选，留空即 null = 不下发 =
     * 沿用库默认行为，与服务改造前完全一致；这里**没有**任何业务默认值。
     * `protocolVersion` 用空串表示「未设置」，提交时归一成 null。
     */
    protocolVersion: '' as string,
    autoHealthCheck: null as boolean | null,
    healthCheckInterval: null as number | null,
    reconnectInterval: null as number | null,
    enabled: true,
  });

  /** 「自动健康检查」三态下拉的视图模型：字符串态 ⇄ 表单里的 boolean | null */
  const mcpAutoHealthCheckMode = computed<McpTriState>({
    get: (): McpTriState => {
      const value = mcpForm.value.autoHealthCheck;
      if (value === true) return 'on';
      if (value === false) return 'off';
      return 'unset';
    },
    set: (mode: McpTriState): void => {
      mcpForm.value.autoHealthCheck = mode === 'unset' ? null : mode === 'on';
    },
  });
  /** 编辑态下请求头是否保持原样（未改动则不提交 headers 字段） */
  const mcpHeadersPristine = ref(false);
  /** 编辑态下环境变量是否保持原样（未改动则不提交 env 字段） */
  const mcpEnvPristine = ref(false);

  // 表单改动后旧结果失效，迟到响应不能把另一份配置标成连接成功。
  watch(mcpForm, () => {
    connectionRequest++;
    mcpConnectionResult.value = null;
    mcpConnectionError.value = '';
  }, { deep: true, flush: 'sync' });

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
        mcpRowConnections.value = {};
            } else {
        mcpErrorMsg.value = res.errMsg || t('settings.mcp.errLoadList');
      }
    } catch {
      mcpErrorMsg.value = t('settings.mcp.errLoadList');
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
            if (sep <= 0) throw new Error(t('settings.mcp.errHeaderLineFormat', { line }));
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim();
      if (!key) throw new Error(t('settings.mcp.errHeaderKeyEmpty', { line }));
      if (!value) throw new Error(t('settings.mcp.errHeaderValueEmpty', { key }));
      result[key] = value;
    }
    return result;
  };

  /** 把环境变量对象渲染成「KEY=VALUE」多行文本 */
  const envToLines = (env?: Record<string, string>) => {
    if (!env) return '';
    return Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  };

  /** 解析「KEY=VALUE」多行文本为环境变量对象；值允许空串 */
  const linesToEnv = (text: string): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const sep = line.indexOf('=');
            if (sep <= 0) throw new Error(t('settings.mcp.errEnvLineFormat', { line }));
      const key = line.slice(0, sep).trim();
      if (!key) throw new Error(t('settings.mcp.errEnvKeyEmpty', { line }));
      result[key] = line.slice(sep + 1).trim();
    }
    return result;
  };

  /** 把「一行一段」文本解析为 argv 列表；段内空格合法（argv 不做 shell 拼接） */
  const linesToCommand = (text: string): string[] => {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  const startAddMcp = () => {
    editingMcpId.value = null;
    mcpForm.value = {
      name: '',
      transport: 'streamable-http',
      url: '',
      headerLines: '',
      commandLines: '',
      envLines: '',
      description: '',
      initializationTimeout: MCP_DEFAULT_INIT_TIMEOUT,
      executionTimeout: MCP_DEFAULT_EXEC_TIMEOUT,
      maxOutput: MCP_DEFAULT_MAX_OUTPUT,
      protocolVersion: '',
      autoHealthCheck: null,
      healthCheckInterval: null,
      reconnectInterval: null,
      enabled: true,
    };
    mcpHeadersPristine.value = false;
    mcpEnvPristine.value = false;
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
      commandLines: (item.command || []).join('\n'),
      envLines: envToLines(item.env),
      description: item.description || '',
      initializationTimeout: item.initializationTimeout ?? MCP_DEFAULT_INIT_TIMEOUT,
      executionTimeout: item.executionTimeout ?? MCP_DEFAULT_EXEC_TIMEOUT,
      maxOutput: item.maxOutput ?? MCP_DEFAULT_MAX_OUTPUT,
      // 容错参数回填必须保真：库里是 null 就回填「未设置」，不得替换成任何默认值。
      protocolVersion: item.protocolVersion ?? '',
      autoHealthCheck: item.autoHealthCheck ?? null,
      healthCheckInterval: item.healthCheckInterval ?? null,
      reconnectInterval: item.reconnectInterval ?? null,
      enabled: item.status !== 0,
    };
    mcpHeadersPristine.value = true;
    mcpEnvPristine.value = true;
    mcpFormError.value = '';
    isEditingOrAddingMcp.value = true;
  };

  const cancelMcpForm = () => {
    connectionRequest++;
    mcpConnectionResult.value = null;
    mcpConnectionError.value = '';
    isEditingOrAddingMcp.value = false;
    editingMcpId.value = null;
    mcpFormError.value = '';
    mcpHeadersPristine.value = false;
    mcpEnvPristine.value = false;
  };

  const buildMcpPayload = (): McpRequest | null => {
    mcpFormError.value = '';
    const trimmedName = mcpForm.value.name.trim();
    const isStdio = mcpForm.value.transport === 'stdio';

        if (!trimmedName) {
      mcpFormError.value = t('settings.mcp.errNameRequired');
      return null;
    }
    if (trimmedName.length > 64) {
      mcpFormError.value = t('settings.mcp.errNameTooLong');
      return null;
    }

    // 连接参数按传输方式分派：http 系填地址，stdio 填启动命令
    let command: string[] | undefined;
    let env: Record<string, string> | undefined;
    let headers: Record<string, string> | undefined;
    let url: string | undefined;

    if (isStdio) {
      command = linesToCommand(mcpForm.value.commandLines);
            if (command.length === 0) {
        mcpFormError.value = t('settings.mcp.errCommandRequired');
        return null;
      }
      // 仅在用户改动过环境变量时才提交该字段，否则后端保留库中原值
      if (!mcpEnvPristine.value) {
        try {
          env = linesToEnv(mcpForm.value.envLines);
        } catch (e: any) {
          mcpFormError.value = e?.message || t('settings.mcp.errEnvFormat');
          return null;
        }
      }
    } else {
      const trimmedUrl = mcpForm.value.url.trim();
            if (!trimmedUrl) {
        mcpFormError.value = t('settings.mcp.errUrlRequired');
        return null;
      }
      if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
        mcpFormError.value = t('settings.mcp.errUrlScheme');
        return null;
      }
      url = trimmedUrl;
      // 仅在用户改动过请求头时才提交该字段，否则后端保留库中原值
      if (!mcpHeadersPristine.value) {
        try {
          headers = linesToHeaders(mcpForm.value.headerLines);
        } catch (e: any) {
          mcpFormError.value = e?.message || t('settings.mcp.errHeadersFormat');
          return null;
        }
      }
    }

        if (mcpForm.value.description && mcpForm.value.description.length > 200) {
      mcpFormError.value = t('settings.mcp.errDescriptionTooLong');
      return null;
    }
    if (mcpForm.value.initializationTimeout !== null && mcpForm.value.initializationTimeout <= 0) {
      mcpFormError.value = t('settings.mcp.errInitTimeout');
      return null;
    }
    if (mcpForm.value.executionTimeout !== null && mcpForm.value.executionTimeout <= 0) {
      mcpFormError.value = t('settings.mcp.errExecTimeout');
      return null;
    }
    if (mcpForm.value.maxOutput !== null && mcpForm.value.maxOutput <= 0) {
      mcpFormError.value = t('settings.mcp.errMaxOutput');
      return null;
    }

    // 高级连接容错四项：留空 = null = 不下发 = 沿用库默认（契约 2.2），
    // 护栏按契约 2.3，错误文案与后端 McpValidator 保持一致的口径。
    const protocolVersionText = (mcpForm.value.protocolVersion ?? '').trim();
    const protocolVersion: string | null = protocolVersionText === '' ? null : protocolVersionText;
    if (protocolVersion !== null
      && (protocolVersion.length > MCP_PROTOCOL_VERSION_MAX_LENGTH
        || !MCP_PROTOCOL_VERSION_PATTERN.test(protocolVersion))) {
      mcpFormError.value = t('settings.mcp.errProtocolVersionFormat');
      return null;
    }
    const healthCheckInterval = toNullableMilliseconds(mcpForm.value.healthCheckInterval);
    if (healthCheckInterval !== null && (!Number.isInteger(healthCheckInterval) || healthCheckInterval < 1)) {
      mcpFormError.value = t('settings.mcp.errHealthCheckInterval');
      return null;
    }
    const reconnectInterval = toNullableMilliseconds(mcpForm.value.reconnectInterval);
    if (reconnectInterval !== null && (!Number.isInteger(reconnectInterval) || reconnectInterval < 1)) {
      mcpFormError.value = t('settings.mcp.errReconnectInterval');
      return null;
    }

    const payload = {
      name: trimmedName,
      transport: mcpForm.value.transport,
      url,
      headers,
      command,
      env,
      description: mcpForm.value.description.trim() || undefined,
      initializationTimeout: mcpForm.value.initializationTimeout ?? undefined,
      executionTimeout: mcpForm.value.executionTimeout ?? undefined,
      maxOutput: mcpForm.value.maxOutput ?? undefined,
      // 四项容错参数提交 null 就是 null（显式下发），以便用户能把已配置的值清空回库默认。
      protocolVersion,
      autoHealthCheck: mcpForm.value.autoHealthCheck ?? null,
      healthCheckInterval,
      reconnectInterval,
      status: mcpForm.value.enabled ? 1 : 0,
    };

    return payload;
  };

  const handleConnectMcp = async () => {
    if (isConnectingMcp.value || isSubmittingMcp.value) return;
    const payload = buildMcpPayload();
    if (!payload) return;
    if (editingMcpId.value !== null) payload.id = editingMcpId.value;
    const request = ++connectionRequest;
    mcpConnectionResult.value = null;
    mcpConnectionError.value = '';
    isConnectingMcp.value = true;
    try {
      const res = await McpAPI.connect(payload);
      if (request !== connectionRequest) return;
      if (isOk(res.code) && res.data) {
        mcpConnectionResult.value = res.data;
      } else {
                mcpConnectionError.value = res.errMsg || t('settings.mcp.errConnectFailed');
      }
    } catch (error: unknown) {
      if (request === connectionRequest) {
        mcpConnectionError.value = error instanceof ApiError && error.kind === 'network'
          ? t('settings.mcp.errConnectNetwork')
          : error instanceof Error ? error.message : t('settings.mcp.errConnectGeneric');
      }
    } finally {
      isConnectingMcp.value = false;
    }
  };

  const handleConnectSavedMcp = async (item: McpVO) => {
    const key = String(item.id);
    if (mcpRowConnections.value[key]?.loading) return;
    mcpRowConnections.value[key] = { loading: true, success: false, error: '' };
    const state = mcpRowConnections.value[key]!;
    try {
      // 凭据由后端按真实 ID 读取，不能把列表中的脱敏值当作令牌发送。
      const res = await McpAPI.connect({
        id: item.id, name: item.name, transport: item.transport,
        // 非当前传输的空字段也会触发后端校验，因此只提交实际使用的连接参数。
        ...(item.transport === 'stdio' ? { command: item.command } : { url: item.url }),
        initializationTimeout: item.initializationTimeout,
        executionTimeout: item.executionTimeout, maxOutput: item.maxOutput, status: item.status,
        // 容错参数跟随已保存配置，测试连接才与真实运行时的行为一致。
        protocolVersion: item.protocolVersion ?? null,
        autoHealthCheck: item.autoHealthCheck ?? null,
        healthCheckInterval: item.healthCheckInterval ?? null,
        reconnectInterval: item.reconnectInterval ?? null,
      });
      if (mcpRowConnections.value[key] !== state) return;
      state.success = isOk(res.code) && !!res.data;
            if (!state.success) state.error = res.errMsg || t('settings.mcp.errConnectFailed');
    } catch (error: unknown) {
      if (mcpRowConnections.value[key] !== state) return;
      state.error = error instanceof ApiError && error.kind === 'network'
        ? t('settings.mcp.errConnectNetwork')
        : error instanceof Error ? error.message : t('settings.mcp.errConnectGeneric');
    } finally {
      state.loading = false;
    }
  };

  const handleSaveMcp = async () => {
    if (isSubmittingMcp.value || isConnectingMcp.value) return;
    const payload = buildMcpPayload();
    if (!payload) return;

    isSubmittingMcp.value = true;
    try {
      if (editingMcpId.value) {
        const res = await McpAPI.update({ id: editingMcpId.value, ...payload });
                if (isOk(res.code)) {
          showMcpToast(t('settings.mcp.toastUpdated'));
          isEditingOrAddingMcp.value = false;
          await loadMcp();
        } else {
          mcpFormError.value = res.errMsg || t('settings.mcp.errUpdate');
        }
      } else {
        const res = await McpAPI.add(payload);
                if (isOk(res.code)) {
          showMcpToast(t('settings.mcp.toastCreated'));
          isEditingOrAddingMcp.value = false;
          await loadMcp();
        } else {
          mcpFormError.value = res.errMsg || t('settings.mcp.errCreate');
        }
      }
    } catch (e: any) {
      mcpFormError.value = e?.message || t('settings.mcp.errSave');
    } finally {
      isSubmittingMcp.value = false;
    }
  };

  const { confirm } = useConfirm();

  const handleDeleteMcp = async (item: McpVO) => {
        const confirmed = await confirm({
      title: t('settings.mcp.confirmDeleteTitle'),
      content: t('settings.mcp.confirmDeleteContent', { name: item.name }),
      type: 'danger',
      confirmText: t('common.confirmDelete'),
      cancelText: t('common.cancel'),
    });
    if (!confirmed) return;

    try {
      const res = await McpAPI.delById(item.id);
      if (isOk(res.code)) {
        showMcpToast(t('settings.mcp.toastDeleted'));
        await loadMcp();
      } else {
        showMcpToast(res.errMsg || t('settings.mcp.errDelete'));
      }
    } catch {
      showMcpToast(t('settings.mcp.errDeleteException'));
    }
  };

  /**
   * 列表内快速启停，不必进编辑表单。
   * 只提交 id 与 status——后端按「缺省字段保持原值」处理，避免把另一传输方式的
   * 连接参数（url/command）误传回库。
   */
  const handleToggleMcp = async (item: McpVO) => {
    const nextEnabled = item.status === 0;
    try {
      const res = await McpAPI.update({
        id: item.id,
        status: nextEnabled ? 1 : 0,
      });
            if (isOk(res.code)) {
        showMcpToast(nextEnabled ? t('settings.mcp.toastEnabled') : t('settings.mcp.toastDisabled'));
        await loadMcp();
      } else {
        showMcpToast(res.errMsg || t('settings.mcp.toastStatusFailed'));
      }
    } catch {
      showMcpToast(t('settings.mcp.toastStatusException'));
    }
  };

  /** 请求头数量，仅用于列表展示（值已脱敏，不展示内容） */
  const countHeaders = (item: McpVO) => Object.keys(item.headers || {}).length;

  /** 环境变量数量，仅用于列表展示（值已脱敏，不展示内容） */
  const countEnvVars = (item: McpVO) => Object.keys(item.env || {}).length;

  /** 列表卡片的连接信息：http 系显示端点，stdio 显示启动命令 */
  const resolveConnectionLabel = (item: McpVO) => {
    if (item.transport === 'stdio') return (item.command || []).join(' ');
    return item.url || '';
  };

  onMounted(() => {
    loadMcp();
  });

  onBeforeUnmount(() => {
    connectionRequest++;
    mcpRowConnections.value = {};
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
    isConnectingMcp,
    mcpConnectionResult,
    mcpConnectionError,
    mcpRowConnections,
    mcpToast,
    mcpForm,
    mcpAutoHealthCheckMode,
    mcpHeadersPristine,
    mcpEnvPristine,
    loadMcp,
    startAddMcp,
    startEditMcp,
    cancelMcpForm,
    handleSaveMcp,
    handleConnectMcp,
    handleConnectSavedMcp,
    handleDeleteMcp,
    handleToggleMcp,
    countHeaders,
    countEnvVars,
    resolveConnectionLabel,
  };
}
