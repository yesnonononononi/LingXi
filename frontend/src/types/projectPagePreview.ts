import type {ComputedRef, InjectionKey, Ref} from 'vue';

export type PreviewPanelMode = 'file' | 'page';
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

export type ProjectPageAction = 'sync' | 'create' | 'activate' | 'close-tab' | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'close';
export interface ProjectPageCommandRequest {
  generation: number;
  action: ProjectPageAction;
  tabId?: string;
  url?: string;
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
  close: () => void;
  updateLayout: (layout: ProjectPageLayout) => void;
  applyState: (state: ProjectPageState) => void;
}
export const PROJECT_PAGE_PREVIEW_KEY: InjectionKey<ProjectPagePreviewApi> = Symbol('project-page-preview');
