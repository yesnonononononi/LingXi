import { ref, onMounted, computed, type Ref } from 'vue';
import { chatApi } from '../../services/api';
import { toPositiveInt } from '../../utils/api';
import { useUserConfigStore } from '../../stores/userConfigStore';
import type { AgentAccessMode, ChatSession, ModelConfig, WorkspaceRequest, WorkspaceVO } from '../../types/chat';
import { normalizeSettingsTab, type SettingsTabKey } from '../../utils/enum';
import { isElectron, openDirectoryPicker } from '../../utils/platform';
import { extractDirName } from '../../utils/path';

export interface ChatWorkspaceOptions {
  localSessions: Ref<ChatSession[]>;
  localModels: Ref<ModelConfig[]>;
  localWorkspaces: Ref<WorkspaceVO[]>;
  localActiveWorkspaceId: Ref<string | number | null>;
  /** 初始化完成后的收尾钩子（会话模块据以清空当前选中会话）。 */
  onInitialized?: () => void;
}

/**
 * 工作空间与模型/权限配置：初始化加载、设置弹窗、模型与权限档位持久化。
 *
 * <p>模型选中、访问档位、思考强度、主题的真值都在 {@link useUserConfigStore}
 * （后端 {@code user_configs}），本模块只负责「加载列表 + 触发写入」，
 * 不再各自持有配置 ref。</p>
 */
export function useChatWorkspace(options: ChatWorkspaceOptions) {
  const {
    localSessions,
    localModels,
    localWorkspaces,
    localActiveWorkspaceId,
    onInitialized,
  } = options;

  const userConfig = useUserConfigStore();

  const isWorkspaceModalOpen = ref(false);
  const isSidebarCollapsed = ref(false);
  const isSettingsOpen = ref(false);
  // 与 SettingsModal 共用同一份 tab 白名单来源，避免两处字面量联合类型各自漂移
  const settingsInitialTab = ref<SettingsTabKey>('models');
  const initLoadError = ref('');

  /** 选中的模型：直接读全局配置，模型列表尚未载入时回落第一项。 */
  const selectedModelId = computed<string | number>(() => {
    const configured = userConfig.modelId;
    if (configured != null && localModels.value.some(m => String(m.id) === String(configured))) {
      return configured;
    }
    return localModels.value[0]?.id ?? '';
  });

  const handleSelectWorkspace = (ws: WorkspaceVO | null) => {
    localActiveWorkspaceId.value = ws ? ws.id ?? null : null;
  };

  // 工作空间创建后不可变更（宿主机目录 + 镜像即容器身份），因此这里只有新增分支
  const handleSaveWorkspace = async (data: WorkspaceRequest) => {
    try {
      // 环境类型决定 workDir 推导（本地=宿主机路径 / 沙箱=容器内路径），真值在全局配置
      const created = await chatApi.createWorkspace(data, userConfig.envType);
      if (created) {
        localWorkspaces.value.push(created);
        localActiveWorkspaceId.value = created.id ?? null;
        isWorkspaceModalOpen.value = false;
      }
    } catch (err: any) {
      window.alert(err?.message || '创建项目失败，请检查工作目录及后端连接');
    }
  };

  const handleOpenNewWorkspace = async () => {
    // 桌面端 (Electron) 原生体验：直接调起系统文件选择框，选择即创建，无需手动输入路径
    if (isElectron()) {
      try {
        const selectedPath = await openDirectoryPicker();
        if (selectedPath) {
          const folderName = extractDirName(selectedPath) || '工作空间';
          await handleSaveWorkspace({ name: folderName, hostDir: selectedPath });
        }
        return;
      } catch (err) {
        console.error('[handleOpenNewWorkspace] 调起原生目录选择器失败，回退到弹窗:', err);
      }
    }

    isWorkspaceModalOpen.value = true;
  };

  const handleDeleteWorkspace = async (id: string | number) => {
    const ok = await chatApi.deleteWorkspace(id);
    if (ok) {
      localWorkspaces.value = localWorkspaces.value.filter(w => String(w.id) !== String(id));
      if (String(localActiveWorkspaceId.value) === String(id)) {
        localActiveWorkspaceId.value = localWorkspaces.value[0]?.id ?? null;
      }
    }
  };

  const handleQuickStart = async () => {
    if (localWorkspaces.value.length > 0) {
      localActiveWorkspaceId.value = localWorkspaces.value[0].id ?? null;
      return;
    }
    // 没有项目时引导创建：桌面端优先唤起原生选择器，否则唤起新建弹窗
    await handleOpenNewWorkspace();
  };

  /** 切换选中的模型：写全局配置（乐观更新，失败由 store 回滚）。 */
  const handleUpdateModel = (modelId: string | number) => {
    const id = toPositiveInt(modelId, 0);
    if (!id) return;
    void userConfig.patch('modelId', id, { modelId: id });
  };

  /** 切换会话访问档位：写全局配置。 */
  const handleUpdateAccessMode = (accessMode: AgentAccessMode) => {
    void userConfig.patch('accessMode', accessMode, { accessMode });
  };

  const handleOpenSettings = () => {
    isSettingsOpen.value = true;
  };
  const handleOpenModels = () => { settingsInitialTab.value = 'models'; isSettingsOpen.value = true; };
  const handleOpenSettingsTab = (tab: string) => {
    settingsInitialTab.value = normalizeSettingsTab(tab);
    isSettingsOpen.value = true;
  };
  const handleCloseSettings = () => { isSettingsOpen.value = false; };

  // 模型管理中更新/增删模型后，刷新本地模型列表；全局配置由 store 自行维护真值。
  const handleModelUpdated = async () => {
    const modelsRes = await chatApi.fetchModels();
    if (modelsRes.ok) localModels.value = modelsRes.data;
  };

  /**
   * 初始化数据加载（仅页面挂载时调用一次）：
   * 每个 fetch* 返回判别结构，失败时置可见失败态，**不再静默显示为空**（与「确实为空」区分）。
   */
  const loadInitialData = async () => {
    initLoadError.value = '';
    try {
      const sessionsRes = await chatApi.fetchSessions();
      if (sessionsRes.ok) localSessions.value = sessionsRes.data;
      const workspacesRes = await chatApi.fetchWorkspaces();
      if (workspacesRes.ok) localWorkspaces.value = workspacesRes.data;
      const modelsRes = await chatApi.fetchModels();
      if (modelsRes.ok) localModels.value = modelsRes.data;
      // 配置真值统一由 store 载入（会话/模型/工作空间列表仍属视图自有状态）。
      const configOk = await userConfig.load();

      if (!sessionsRes.ok || !modelsRes.ok || !configOk) {
        initLoadError.value = '会话数据加载失败，请检查后端服务';
      }

      if (localWorkspaces.value.length > 0 && !localActiveWorkspaceId.value) {
        localActiveWorkspaceId.value = localWorkspaces.value[0].id ?? null;
      }
      onInitialized?.();
    } catch (err) {
      console.error('初始化会话与推断默认选中模型失败:', err);
      initLoadError.value = '初始化数据加载失败，请稍后刷新页面';
    }
  };

  onMounted(() => {
    void loadInitialData();
  });

  return {
    isWorkspaceModalOpen,
    isSidebarCollapsed,
    isSettingsOpen,
    settingsInitialTab,
    initLoadError,
    selectedModelId,
    handleSelectWorkspace,
    handleSaveWorkspace,
    handleOpenNewWorkspace,
    handleDeleteWorkspace,
    handleQuickStart,
    handleUpdateModel,
    handleUpdateAccessMode,
    handleOpenSettings,
    handleOpenModels,
    handleOpenSettingsTab,
    handleCloseSettings,
    handleModelUpdated,
    loadInitialData,
  };
}
