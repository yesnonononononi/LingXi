import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {McpAPI} from '../../../services/api';
import {ApiError} from '../../../services/interceptor';
import type {McpConnectionStateVO, McpConnectionVO, McpRequest, McpVO} from '../../../types/chat';
import {MCP_PROTOCOL_VERSION_MAX_LENGTH, MCP_PROTOCOL_VERSION_PATTERN,} from '../../../types/chat';
import {isOk} from '../../../utils/api';
import {isMcpAuthorizationRequired, nextMcpStatus} from '../../../utils/mcpStatus';
import {useConfirm} from '../../../composables/useConfirm';
import {useI18n} from '../../../i18n';

const MCP_DEFAULT_INIT_TIMEOUT = 30_000;
const MCP_DEFAULT_EXEC_TIMEOUT = 60_000;
const MCP_DEFAULT_MAX_OUTPUT = 20_000;
/** 授权进度轮询间隔：回调通常在浏览器里几秒内完成，2s 足够且不会打满后端 */
const AUTHORIZE_POLL_INTERVAL = 2_000;
/** 与后端 pending 授权的有效期一致，超时后不再轮询而是提示重新发起 */
const AUTHORIZE_POLL_TIMEOUT = 5 * 60 * 1000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 「自动健康检查」三态取值：unset = 不下发（沿用库默认），on / off = 显式下发布尔值。 */
export type McpTriState = 'unset' | 'on' | 'off';

/** 请求头键值对编辑项：页面按 Key : Value 分框填入，提交时再加工为请求头映射。 */
export interface McpHeaderItem {
  key: string;
  value: string;
}

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
  /** 共享连接运行状态，按 id 索引；与「测试连接」结果分开，后者不代表运行中的连接。 */
  const mcpStates = ref<Record<string, McpConnectionStateVO>>({});
  /**
   * 状态表请求是否在途。
   *
   * 列表与状态是两次请求：列表先回、卡片先渲染，此时 `mcpStates` 还是空的。
   * 不把这段空窗期显式标成「检查中」，卡片只能落到兜底的「未连接」——那是假事实。
   */
  const isMcpStatesLoading = ref(false);
  const mcpReconnecting = ref<Record<string, boolean>>({});
  /** 授权进行中的行：等待回调期间按钮保持 busy，避免连点开出多个浏览器窗口 */
  const mcpAuthorizing = ref<Record<string, boolean>>({});
  /** 卸载后不再轮询：组件已经销毁，回调结果无处可展示 */
  let disposed = false;
  const mcpToast = ref('');
  let mcpToastTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 表单模型。
   * `headerItems` 是「Key : Value」键值对列表编辑态；`commandLines` 是 stdio
   * 启动命令的「一行一段 argv」编辑态——argv 逐段传给子进程，不做 shell 拼接，
   * 段内空格无需转义；`envLines` 是「一行一个 KEY=VALUE」的环境变量编辑态。
   * `headersUnchanged` / env 同理：记录本次是否改动，未改动则整体不提交该字段，
   * 由后端保留库中原值（避免把脱敏掩码写回库）。
   */
  const mcpForm = ref({
    name: '',
    transport: 'streamable-http' as string,
    url: '',
    headerItems: [{ key: '', value: '' }] as McpHeaderItem[],
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
    /**
     * 认证方式：`none` 只用请求头里的静态凭据（历史行为），`oauth` 由浏览器授权在运行时取令牌。
     * 后三项只在 oauth 下有意义，留空即交给服务端发现——能自动拿到的不该让用户手填。
     */
    authMode: 'none' as 'none' | 'oauth',
    authClientId: '',
    authScopes: '',
    authServer: '',
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
    if (mcpToastTimer) clearTimeout(mcpToastTimer);
    mcpToastTimer = setTimeout(() => {
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
        void loadMcpStates();
            } else {
        mcpErrorMsg.value = res.errMsg || t('settings.mcp.errLoadList');
      }
    } catch {
      mcpErrorMsg.value = t('settings.mcp.errLoadList');
    } finally {
      isMcpLoading.value = false;
    }
  };

  /** 状态查询失败不影响列表展示，只是不显示状态徽标。 */
  const loadMcpStates = async () => {
    const ids = mcpList.value.map((item) => item.id);
    if (ids.length === 0) {
      mcpStates.value = {};
      return;
    }
    isMcpStatesLoading.value = true;
    try {
      const res = await McpAPI.listStates(ids);
      if (!isOk(res.code)) return;
      const next: Record<string, McpConnectionStateVO> = {};
      for (const state of res.data ?? []) next[String(state.id)] = state;
      mcpStates.value = next;
    } catch {
      // 保留上一次状态，避免一次抖动把徽标全部清空。
    } finally {
      isMcpStatesLoading.value = false;
    }
  };

  const handleReconnectMcp = async (item: McpVO) => {
    const key = String(item.id);
    if (mcpReconnecting.value[key]) return;
    mcpReconnecting.value[key] = true;
    try {
      const res = await McpAPI.reconnect(item);
      if (isOk(res.code) && res.data) {
        mcpStates.value[key] = res.data;
        // 未授权的 oauth 服务不会真的去握手：这时报「已重新连接」是假话，指向「去授权」才对。
        showMcpToast(isMcpAuthorizationRequired(res.data.state)
          ? t('settings.mcp.stateAuthorizationRequired')
          : t('settings.mcp.toastReconnected'));
      } else {
        showMcpToast(res.errMsg || t('settings.mcp.errReconnect'));
      }
    } catch (error: unknown) {
      showMcpToast(error instanceof ApiError && error.kind === 'network'
        ? t('settings.mcp.errConnectNetwork')
        : error instanceof Error ? error.message : t('settings.mcp.errReconnect'));
    } finally {
      mcpReconnecting.value[key] = false;
      // 失败原因由后端记入状态，重新拉取才能显示。
      await loadMcpStates();
    }
  };

  /**
   * 等后端把回调换成令牌。
   *
   * <p>轮询而不是长连接：授权是用户手工完成的一次性动作，进度只有三态，用不上流式通道。
   * 卸载标记必须参与循环条件，否则关掉设置页之后还在打后端。</p>
   */
  const waitForAuthorization = async (id: number | string): Promise<'AUTHORIZED' | 'FAILED' | 'TIMEOUT'> => {
    const deadline = Date.now() + AUTHORIZE_POLL_TIMEOUT;
    while (!disposed && Date.now() < deadline) {
      await sleep(AUTHORIZE_POLL_INTERVAL);
      if (disposed) break;
      try {
        const res = await McpAPI.oauthState(id);
        const state = isOk(res.code) ? res.data?.state ?? null : null;
        if (state === 'AUTHORIZED') return 'AUTHORIZED';
        if (state === 'FAILED') return 'FAILED';
      } catch {
        // 单次查询抖动不该终止等待：回调已经完成，下一次查询就会拿到 AUTHORIZED
      }
    }
    return 'TIMEOUT';
  };

  /**
   * 打开系统浏览器完成授权，成功后自动重连。
   *
   * <p>授权地址由后端给：它会先起好回调端口再拼 URL，顺序反过来回调就落不到本地。
   * 浏览器交给主进程开（`session.setWindowOpenHandler` 把 http(s) 外链转给系统浏览器），
   * 应用内不会导航到第三方登录页。</p>
   */
  const handleAuthorizeMcp = async (item: McpVO) => {
    const key = String(item.id);
    if (mcpAuthorizing.value[key]) return;
    mcpAuthorizing.value[key] = true;
    try {
      const res = await McpAPI.authorizeById(item.id);
      const url = isOk(res.code) ? res.data ?? '' : '';
      if (!url) {
        showMcpToast(res.errMsg || t('settings.mcp.errAuthorize'));
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      const outcome = await waitForAuthorization(item.id);
      if (outcome === 'AUTHORIZED') {
        showMcpToast(t('settings.mcp.toastAuthorized'));
        await handleReconnectMcp(item);
        return;
      }
      showMcpToast(t('settings.mcp.errAuthorize'));
    } catch (error: unknown) {
      showMcpToast(error instanceof ApiError && error.kind === 'network'
        ? t('settings.mcp.errConnectNetwork')
        : error instanceof Error ? error.message : t('settings.mcp.errAuthorize'));
    } finally {
      mcpAuthorizing.value[key] = false;
      await loadMcpStates();
    }
  };

  /** 把请求头对象渲染成「Key / Value」行列表；值为掩码时原样保留，供后端识别「未改动」 */
  const headersToItems = (headers?: Record<string, string>): McpHeaderItem[] => {
    const entries = headers ? Object.entries(headers) : [];
    if (entries.length === 0) return [{ key: '', value: '' }];
    return entries.map(([key, value]) => ({ key, value }));
  };

  /** 把「Key / Value」行列表加工为请求头对象；自动剔除空行和 Key 末尾误填的冒号，非法项抛错 */
  const itemsToHeaders = (items: McpHeaderItem[]): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const item of items) {
      const key = item.key.trim().replace(/[:：]+$/, '').trim();
      const value = item.value.trim();
      if (!key && !value) continue;
      if (!key) throw new Error(t('settings.mcp.errHeaderKeyEmpty', { line: value }));
      if (!value) throw new Error(t('settings.mcp.errHeaderValueEmpty', { key }));
      if (key.includes(':') || key.includes('：') || /\s/.test(key)) {
        throw new Error(t('settings.mcp.errHeaderLineFormat', { line: `${key}: ${value}` }));
      }
      result[key] = value;
    }
    return result;
  };

  const addMcpHeader = () => {
    mcpForm.value.headerItems.push({ key: '', value: '' });
    mcpHeadersPristine.value = false;
  };

  const removeMcpHeader = (index: number) => {
    mcpForm.value.headerItems.splice(index, 1);
    mcpHeadersPristine.value = false;
  };

  const markMcpHeadersDirty = () => {
    mcpHeadersPristine.value = false;
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
      headerItems: [{ key: '', value: '' }] as McpHeaderItem[],
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
      authMode: 'none',
      authClientId: '',
      authScopes: '',
      authServer: '',
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
      headerItems: headersToItems(item.headers),
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
      authMode: item.auth?.mode === 'oauth' ? 'oauth' : 'none',
      authClientId: item.auth?.clientId ?? '',
      authScopes: (item.auth?.scopes ?? []).join(' '),
      authServer: item.auth?.authorizationServer ?? '',
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
          headers = itemsToHeaders(mcpForm.value.headerItems);
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

    // stdio 没有 HTTP 授权语义，后端会直接拒绝；表单在 stdio 下也藏了选择器，
    // 这里按「用户此刻看到的」提交 none，而不是留一个他改不掉的 oauth。
    const authorizationServer = mcpForm.value.authServer.trim();
    const usesOauth = mcpForm.value.authMode === 'oauth' && !isStdio;
    if (usesOauth && authorizationServer !== '' && !/^https?:\/\/.+/i.test(authorizationServer)) {
      mcpFormError.value = t('settings.mcp.errAuthServerScheme');
      return null;
    }
    // none 也要显式下发：否则把服务从 oauth 改回静态凭据时，库里会一直留着 oauth。
    const auth = usesOauth
      ? {
        mode: 'oauth',
        clientId: mcpForm.value.authClientId.trim() || null,
        scopes: mcpForm.value.authScopes.split(/[\s,]+/).filter((scope) => scope.length > 0),
        authorizationServer: authorizationServer || null,
      }
      : {mode: 'none', clientId: null, scopes: [], authorizationServer: null};

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
      auth,
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
    // 方向只由 nextMcpStatus 决定，toast 也读同一个值：两处各判一次迟早会出现
    // 「提示已启用、实际下发 0」这种自相矛盾。
    const nextStatus = nextMcpStatus(item.status);
    try {
      const res = await McpAPI.update({
        id: item.id,
        status: nextStatus,
      });
      if (isOk(res.code)) {
        showMcpToast(nextStatus === 1 ? t('settings.mcp.toastEnabled') : t('settings.mcp.toastDisabled'));
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
    disposed = true;
    connectionRequest++;
    mcpRowConnections.value = {};
    if (mcpToastTimer) clearTimeout(mcpToastTimer);
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
    mcpStates,
    isMcpStatesLoading,
    mcpReconnecting,
    mcpAuthorizing,
    loadMcpStates,
    handleReconnectMcp,
    handleAuthorizeMcp,
    mcpToast,
    mcpForm,
    mcpAutoHealthCheckMode,
    mcpHeadersPristine,
    addMcpHeader,
    removeMcpHeader,
    markMcpHeadersDirty,
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
