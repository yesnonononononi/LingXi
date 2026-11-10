import {defineStore} from 'pinia';
import {computed, ref} from 'vue';
import {UserConfigAPI} from '../services/userConfig';
import {notifySettingsChanged} from '../services/settingsBroadcast';
import {isOk} from '../utils/api';
import {t} from '../i18n';
import type {FontScalePreset} from '../utils/enum';
import {
    normalizeAccessMode,
    normalizeCommandApprovalPolicy,
    normalizeFontScale,
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
import {useFontScale} from '../composables/useFontScale';

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
  /** 数据存储目录（后端已解析成生效值，直接展示即可）。 */
  const dataDir = ref<string>('');
  /** 技能根目录（同上）；空表示未启用 Skill。 */
  const skillDir = ref<string>('');
  /** 团队最大成员数（同上）。 */
  const teamSize = ref<number | null>(null);
  /** 专用压缩模型（关联 model_config.id）；null 表示沿用对话模型做摘要。 */
  const compactModelId = ref<string | number | null>(null);
  const imageModelId = ref<string | number | null>(null);
  const imageGenerationMaxCalls = ref<number | null>(null);
  /** 普通模型请求是否流式输出；后端在缺省时归一为 true。 */
  const streamChat = ref<boolean>(true);
  /** 数据目录已改但本进程还没重启：为 true 时界面必须提示重启并拦住继续对话。 */
  const dataDirRestartRequired = ref(false);
  /**
   * 全局字号档位（后端 user_configs.font_scale 的真源镜像）。
   *
   * <p>store 是**后端真源**，`useFontScale` 是**渲染应用层**：两边各自只做一件事，
   * 由 {@link applyFontScaleToDocument} 单向把档位翻译成缩放倍数，避免两处各写一份默认值。</p>
   */
  const fontScale = ref<FontScalePreset>('MEDIUM');

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
   * 字号下拉是否不可交互。
   *
   * <p>与 {@link reasoningEffortPending} 同构：未载入完成时下拉显示的是本地兜底档而非后端真值，
   * 正在保存时连点会打出并发请求。两者都会让用户误以为「选了没生效」。</p>
   */
  const fontScalePending = computed(
    () => !loaded.value || savingKeys.value.has('fontScale'),
  );

  /**
   * 把当前档位应用到渲染层（`--lx-font-scale`）。
   *
   * <p><b>单向数据流</b>：本函数是 store → 渲染的唯一驱动点，`applyConfig`（载入/回读）与
   * `writeField`（乐观更新与失败回滚都会走它）各调用一次。不在设置页里另调一次
   * `useFontScale`，否则回滚路径会漏（回滚改的是 store 值，不会经过设置页的点击处理器）。</p>
   */
  const applyFontScaleToDocument = (): void => {
    useFontScale().setPreset(fontScale.value);
  };

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
    dataDir.value = config?.dataDir ?? '';
    skillDir.value = config?.skillDir ?? '';
    teamSize.value = config?.teamSize ?? null;
    compactModelId.value = config?.compactModelId ?? null;
    imageModelId.value = config?.imageModelId ?? null;
    imageGenerationMaxCalls.value = config?.imageGenerationMaxCalls ?? null;
    streamChat.value = config?.streamChat !== false;
    dataDirRestartRequired.value = config?.dataDirRestartRequired === true;
    // 非法/缺省一律回落 MEDIUM（后端虽已归一，前端仍要能吃住脏数据而不把界面撑坏）
    fontScale.value = normalizeFontScale(config?.fontScale, 'MEDIUM') ?? 'MEDIUM';
    applyFontScaleToDocument();
  };

  /**
   * 与后端重新对齐已落库的设置。
   *
   * <p>设置在服务端只有一份，但每个窗口各持一份镜像：另一个窗口改档位后，本窗口的滑杆会继续
   * 显示旧值，而真正生效的是新值 —— 显示与实际不一致，比没有显示更坏。</p>
   *
   * <p><b>保存中一律跳过</b>：此时本地值领先于后端（乐观更新），回读会把用户刚选的档位打回去。
   * 未载入完成也跳过——那是 {@link load} 的职责。</p>
   */
  const reconcile = async (): Promise<void> => {
    if (!loaded.value || savingKeys.value.size > 0) return;
    try {
      const result = await UserConfigAPI.current();
      if (!isOk(result.code)) return;
      // 回读期间用户可能已经开始改下一项：这时整份覆盖会丢掉他的选择。
      if (savingKeys.value.size > 0) return;
      applyConfig(result.data);
    } catch (error) {
      // 对齐失败不打扰用户：本地值仍可用，下一次焦点/广播还会再来一次。
      console.error('回读全局配置失败:', error);
    }
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
                if (!isOk(result.code)) throw new Error(t('config.readFailed'));
        applyConfig(result.data);
        loaded.value = true;
        return true;
      } catch (error) {
        console.error('载入全局配置失败:', error);
        loadError.value = t('config.loadFailed');
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
    | 'renderTheme'
    | 'dataDir'
    | 'skillDir'
    | 'teamSize'
    | 'compactModelId'
    | 'imageModelId'
    | 'imageGenerationMaxCalls'
    | 'streamChat'
    | 'fontScale';

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
      case 'dataDir': return dataDir.value;
      case 'skillDir': return skillDir.value;
      case 'teamSize': return teamSize.value;
      case 'compactModelId': return compactModelId.value;
      case 'imageModelId': return imageModelId.value;
      case 'imageGenerationMaxCalls': return imageGenerationMaxCalls.value;
      case 'streamChat': return streamChat.value;
      case 'fontScale': return fontScale.value;
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
      case 'dataDir': dataDir.value = value as string; break;
      case 'skillDir': skillDir.value = value as string; break;
      case 'teamSize': teamSize.value = value as number | null; break;
      case 'compactModelId': compactModelId.value = value as string | number | null; break;
      case 'imageModelId': imageModelId.value = value as string | number | null; break;
      case 'imageGenerationMaxCalls': imageGenerationMaxCalls.value = value as number | null; break;
      case 'streamChat': streamChat.value = value as boolean; break;
      case 'fontScale': fontScale.value = value as FontScalePreset; break;
    }
    // 字号是唯一「写状态即改渲染」的字段：乐观更新与失败回滚都必须立刻反映到 --lx-font-scale，
    // 否则回滚后界面会停留在失败的那一档（store 值与画面不一致）。
    if (field === 'fontScale') applyFontScaleToDocument();
  };

  /**
   * 落库后需要回读的字段。
   *
   * <p>目录类字段后端会做搬迁与路径归一（还可能带回「待重启」标记），本地乐观值
   * 与真值不一定一致，必须回读一次，否则界面会继续显示一个并不生效的路径。</p>
   */
  const reloadAfterSave: ReadonlySet<PatchableField> = new Set<PatchableField>(['dataDir', 'skillDir', 'teamSize']);


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
        if (!isOk(result.code)) throw new Error(t('config.effortSaveFailed'));
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
    // 追平后通知其它窗口回读：它们的内存镜像此刻已经落后于后端真值。
    if (ok) notifySettingsChanged();
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
      if (!isOk(result.code)) throw new Error(t('config.saveFailed'));
      // 目录类字段的真值由后端裁剪/归一（搬迁后的生效路径、待重启标记），必须回读一次。
      if (reloadAfterSave.has(field)) {
        await load(true);
      }
      notifySettingsChanged();
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
    dataDir,
    skillDir,
    teamSize,
    compactModelId,
    imageModelId,
    imageGenerationMaxCalls,
    streamChat,
    dataDirRestartRequired,
    fontScale,
    // 派生
    reasoningEffortPending,
    fontScalePending,
    // 行为
    load,
    applyConfig,
    reconcile,
    patch,
    setReasoningEffort,
  };
});
