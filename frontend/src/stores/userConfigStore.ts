import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { UserConfigAPI } from '../services/userConfig';
import { isOk } from '../utils/api';
import {
  normalizeAccessMode,
  normalizeCommandApprovalPolicy,
  normalizeReasoningEffort,
  normalizeWorkspaceEnvType,
} from '../utils/enum';
import type {
  AgentAccessMode,
  CommandApprovalPolicyType,
  ReasoningEffort,
  UserConfigVO,
  WorkspaceEnvType,
} from '../types/chat';

/**
 * UserConfigStore：全局配置的唯一真源。
 *
 * <p>对应后端单例表 {@code user_configs}（固定 {@code id=1}）。此前同一份配置散落在
 * useChatWorkspace / useReasoningEffort / useGeneralTab / WorkspaceModal 四处，
 * 各自独立读后端、各自维护本地 ref，互不同步 —— 本 store 是收口点。</p>
 *
 * <p><b>读写约定</b>：读全部走这里；写走 {@link patch} 的乐观更新（先改本地、再 PUT），
 * 失败回滚到写前值并返回 false，由调用方决定提示文案。所有字段都由本 store 落库，
 * 组件不要自行调 {@link UserConfigAPI.updateCurrent}。</p>
 */
export const useUserConfigStore = defineStore('userConfig', () => {
  /** 是否已从后端成功载入过一次。 */
  const loaded = ref(false);
  /** 载入失败时的可见文案（区别于「确实为空」）。 */
  const loadError = ref('');
  /** 正在保存的字段名集合：用于禁用交互，避免连点打并发请求。 */
  const savingKeys = ref(new Set<string>());

  const modelId = ref<string | number | null>(null);
  const agentId = ref<string | number | null>(null);
  const accessMode = ref<AgentAccessMode>('IN_WORKSPACE');
  const reasoningEffort = ref<ReasoningEffort>('low');
  const maxTokens = ref<number | null>(null);
  const commandApprovalPolicy = ref<CommandApprovalPolicyType | null>(null);
  const planMaxReminders = ref<number>(3);
  const envType = ref<WorkspaceEnvType>('SAND_BOX');
  const renderTheme = ref<'LIGHT' | 'DARK'>('LIGHT');

  /**
   * 已落库的思考强度（与 {@link reasoningEffort} 区分）。
   *
   * <p>{@link reasoningEffort} 会被乐观更新抢在请求之前，这个字段记「后端确认过的值」，
   * 是失败回滚的依据，也是连续调整时判断是否追平的基准。</p>
   */
  let persistedEffort: ReasoningEffort = 'low';

  /**
   * 思考强度是否可交互。
   *
   * <p>未载入完成或正在保存时为 true —— 输入区的滑块据此禁用，避免在未知真值上操作。</p>
   */
  const reasoningEffortPending = computed(
    () => !loaded.value || savingKeys.value.has('reasoningEffort'),
  );

  /**
   * 用一份 VO 覆盖全部字段（载入与回滚共用）。
   *
   * <p>枚举一律过 {@code utils/enum} 的规范化函数，不做 {@code as} 强转：
   * 后端下发值一旦出现大小写/空格偏差，强转会把非法值写进状态。</p>
   */
  const applyConfig = (config?: UserConfigVO | null): void => {
    modelId.value = config?.modelId ?? null;
    agentId.value = config?.agentId ?? null;
    accessMode.value = normalizeAccessMode(config?.accessMode, 'IN_WORKSPACE') ?? 'IN_WORKSPACE';
    reasoningEffort.value = normalizeReasoningEffort(config?.reasoningEffort, 'low') ?? 'low';
    persistedEffort = reasoningEffort.value;
    maxTokens.value = config?.maxTokens ?? null;
    commandApprovalPolicy.value =
      normalizeCommandApprovalPolicy(config?.commandApprovalPolicy) ?? null;
    planMaxReminders.value = config?.planMaxReminders ?? 3;
    // NONE = 未设置，语义上不同于沙箱，界面据此显示「未知」而不是假装沙箱
    envType.value = normalizeWorkspaceEnvType(config?.type) ?? 'NONE';
    renderTheme.value = String(config?.renderTheme).toUpperCase() === 'DARK' ? 'DARK' : 'LIGHT';
  };

  /** 从后端拉一次全量配置。同一时刻只允许一个在途请求，避免重复回表。 */
  let loading: Promise<boolean> | null = null;
  const load = async (force = false): Promise<boolean> => {
    if (loading) return loading;
    if (loaded.value && !force) return true;
    loading = (async () => {
      loadError.value = '';
      try {
        const result = await UserConfigAPI.current();
        if (!isOk(result.code)) throw new Error('读取全局配置失败');
        applyConfig(result.data);
        loaded.value = true;
        return true;
      } catch (error) {
        console.error('载入全局配置失败:', error);
        loadError.value = '全局配置加载失败，请检查后端服务';
        return false;
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  /**
   * 可乐观更新的字段名集合。
   *
   * <p>键刻意用 store 自己的字段名而不是后端字段名 —— 后端把环境类型叫 {@code type}、
   * store 叫 {@code envType}，用后端名做键必然出现「键值对不上」的静默 bug。</p>
   */
  type PatchableField =
    | 'modelId'
    | 'agentId'
    | 'accessMode'
    | 'reasoningEffort'
    | 'maxTokens'
    | 'commandApprovalPolicy'
    | 'planMaxReminders'
    | 'envType'
    | 'renderTheme';

  /** 读某字段的当前值（回滚快照用）。 */
  const readField = (field: PatchableField): unknown => {
    switch (field) {
      case 'modelId': return modelId.value;
      case 'agentId': return agentId.value;
      case 'accessMode': return accessMode.value;
      case 'reasoningEffort': return reasoningEffort.value;
      case 'maxTokens': return maxTokens.value;
      case 'commandApprovalPolicy': return commandApprovalPolicy.value;
      case 'planMaxReminders': return planMaxReminders.value;
      case 'envType': return envType.value;
      case 'renderTheme': return renderTheme.value;
    }
  };

  /** 写某字段（乐观更新与回滚共用同一条路径）。 */
  const writeField = (field: PatchableField, value: unknown): void => {
    switch (field) {
      case 'modelId': modelId.value = value as string | number | null; break;
      case 'agentId': agentId.value = value as string | number | null; break;
      case 'accessMode': accessMode.value = value as AgentAccessMode; break;
      case 'reasoningEffort': reasoningEffort.value = value as ReasoningEffort; break;
      case 'maxTokens': maxTokens.value = value as number | null; break;
      case 'commandApprovalPolicy': commandApprovalPolicy.value = value as CommandApprovalPolicyType | null; break;
      case 'planMaxReminders': planMaxReminders.value = value as number; break;
      case 'envType': envType.value = value as WorkspaceEnvType; break;
      case 'renderTheme': renderTheme.value = value as 'LIGHT' | 'DARK'; break;
    }
  };

  /**
   * 思考强度的连续调整（拖动滑块）。
   *
   * <p>与 {@link patch} 的区别：拖动期间会连续触发，必须**串行并合并** ——
   * 每次都立即发请求会让先发的旧值后到、覆盖用户最后选中的档位。
   * 做法是记住所需保存的目标，保存中的请求结束后若目标又变了就续存一轮，
   * 直到追平当前值为止（{@link reasoningEffort} 一直领先于已落库值）。</p>
   *
   * @param value 用户当前选中的档位（可与已落库值不同）
   * @returns 是否已追平并保存成功
   */
  const setReasoningEffort = async (value: ReasoningEffort): Promise<boolean> => {
    if (!loaded.value) return false;

    reasoningEffort.value = value;
    // 已在保存循环里：新值会被循环尾部自动追平，这里直接返回。
    if (savingKeys.value.has('reasoningEffort')) return true;

    let ok = true;
    savingKeys.value = new Set(savingKeys.value).add('reasoningEffort');
    try {
      while (reasoningEffort.value !== persistedEffort) {
        const target = reasoningEffort.value;
        const result = await UserConfigAPI.updateCurrent({ reasoningEffort: target });
        if (!isOk(result.code)) throw new Error('思考强度保存失败');
        persistedEffort = target;
      }
    } catch (error) {
      console.error('保存思考强度失败:', error);
      reasoningEffort.value = persistedEffort;
      ok = false;
    } finally {
      const next = new Set(savingKeys.value);
      next.delete('reasoningEffort');
      savingKeys.value = next;
    }
    return ok;
  };

  /**
   * 乐观更新一个字段并落库。
   *
   * <p>先改本地（界面立即响应），PUT 失败则回滚到写前值并返回 false，**不抛异常** ——
   * 调用方多数是事件处理器，抛错会变成未捕获异常。</p>
   *
   * @param field store 字段名，同时作为「正在保存」的标识
   * @param value 新值（已规范化，调用方负责）
   * @param payload 提交给后端的请求体（字段名与后端不一致时由调用方给出，如 envType → type）
   * @returns 是否保存成功
   */
  const patch = async (
    field: PatchableField,
    value: unknown,
    payload: Partial<UserConfigVO>,
  ): Promise<boolean> => {
    // 思考强度走专用通道：它有「连续拖动需串行合并」的语义，
    // 走普通 patch 会让 persistedEffort 失同步，保存循环的追平判断随之失效。
    if (field === 'reasoningEffort') {
      return setReasoningEffort(value as ReasoningEffort);
    }

    const previous = readField(field);
    writeField(field, value);
    savingKeys.value = new Set(savingKeys.value).add(field);
    try {
      const result = await UserConfigAPI.updateCurrent(payload);
      if (!isOk(result.code)) throw new Error('保存全局配置失败');
      return true;
    } catch (error) {
      console.error(`保存全局配置失败(${field}):`, error);
      writeField(field, previous);
      return false;
    } finally {
      const next = new Set(savingKeys.value);
      next.delete(field);
      savingKeys.value = next;
    }
  };

  return {
    // 状态
    loaded,
    loadError,
    savingKeys,
    modelId,
    agentId,
    accessMode,
    reasoningEffort,
    maxTokens,
    commandApprovalPolicy,
    planMaxReminders,
    envType,
    renderTheme,
    // 派生
    reasoningEffortPending,
    // 行为
    load,
    applyConfig,
    patch,
    setReasoningEffort,
  };
});
