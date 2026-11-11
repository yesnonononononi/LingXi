import type {ComputedRef, InjectionKey, Ref} from 'vue';

export type PreviewPanelMode = 'file' | 'page' | 'design';
export type ProjectPageRejectReason = 'empty' | 'malformed' | 'protocol' | 'credentials';
export type ProjectPageUrlResult = {ok: true; url: string; origin: string} | {ok: false; reason: ProjectPageRejectReason};
export type ProjectPageLoadState = 'idle' | 'loading' | 'loaded' | 'timeout' | 'failed' | 'stopped';

/** 标签身份与浏览状态来自主进程，不能由前端构造替代实例。 */
export interface ProjectPageTab {
  id: string;
  url: string;
  title: string;
  favicon: string;
  loadState: ProjectPageLoadState;
  isLoading: boolean;
  errorCode: number;
  errorDescription: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 版本号保证事件与操作回执乱序到达时不会回退状态。 */
export interface ProjectPageState {
  generation: number;
  revision: number;
  activeTabId: string;
  tabs: ProjectPageTab[];
}

export type ProjectPageAction = 'sync' | 'create' | 'activate' | 'close-tab' | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'show-with-agent';
export interface ProjectPageCommandRequest {
  generation: number;
  action: ProjectPageAction;
  tabId?: string;
  url?: string;
  selectionText?: string;
}

export interface ShowWithAgentPayload {
  tabId: string;
  url: string;
  title?: string;
  selectionText?: string;
  /** 主进程回传的 PNG 字节；必须是 ArrayBuffer 支撑（Blob 构造要求），不是 SharedArrayBuffer。 */
  imageBuffer: Uint8Array<ArrayBuffer>;
}

/** 坐标使用主页面 CSS 像素，主进程负责按缩放比例转换。 */
export interface ProjectPageLayout {
  visible: boolean;
  bounds: {x: number; y: number; width: number; height: number};
}
export interface ProjectPageLayoutRequest extends ProjectPageLayout { generation: number; }
export type ProjectPageIpcResult<T> = {ok: true; data: T} | {ok: false; error: string};

/** ChatView 持有唯一实例，面板只渲染主进程状态与本地地址草稿。 */
export interface ProjectPagePreviewApi {
  readonly open: Ref<boolean>;
  readonly tabs: Ref<ProjectPageTab[]>;
  readonly activeTabId: Ref<string>;
  readonly activeTab: ComputedRef<ProjectPageTab | undefined>;
  readonly addressInput: ComputedRef<string>;
  readonly committedUrl: ComputedRef<string>;
  readonly loadState: ComputedRef<ProjectPageLoadState>;
  readonly generation: Ref<number>;
  readonly addressError: Ref<string>;
  readonly statusText: ComputedRef<string>;
  readonly diagnoseText: ComputedRef<string>;
  openAddress: (address?: string) => void;
  updateAddress: (value: string) => void;
  createTab: () => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  showWithAgent: (tabId?: string, selectionText?: string) => void;
  /**
   * 收起面板：只让原生视图让位，主进程里的标签、登录态与表单仍在，重开即恢复。
   *
   * <p>与文件标签的收起语义对齐（`useFilePreview.fileTabs` 收起后也不清空）。</p>
   */
  hide: () => void;
  /**
   * 销毁会话：标签实例与主进程状态一起释放，代次前进一代。
   *
   * <p>只用于隔离边界（切换会话 / 工作区）与宿主卸载；用户点面板 ✕ 属于收起，必须走 {@link hide}，
   * 否则「收起再打开」会丢掉正在浏览的网页。</p>
   */
  close: () => void;
  updateLayout: (layout: ProjectPageLayout) => void;
  applyState: (state: ProjectPageState) => void;
}
export const PROJECT_PAGE_PREVIEW_KEY: InjectionKey<ProjectPagePreviewApi> = Symbol('project-page-preview');
