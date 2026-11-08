import type {ComputedRef, InjectionKey, Ref} from 'vue';

/**
 * 预览面板的两种内容模式。
 *
 * <ul>
 *   <li>{@code file}：现有的文件标签 + 代码预览（阶段一不改变其行为）。</li>
 *   <li>{@code page}：项目页面 iframe 预览。</li>
 * </ul>
 */
export type PreviewPanelMode = 'file' | 'page';

/** 地址校验失败的原因码（文案由 i18n 决定，纯函数只回码）。 */
export type ProjectPageRejectReason =
  | 'empty'
  | 'malformed'
  | 'protocol'
  | 'credentials';

/** 地址校验结果：成功时带规范化 URL 与 origin，失败时只带原因码。 */
export type ProjectPageUrlResult =
  | {ok: true; url: string; origin: string}
  | {ok: false; reason: ProjectPageRejectReason};

/**
 * 加载状态，只有计划书允许的四种表达 + 初始空闲。
 *
 * <p>注意：iframe 的 {@code load} 事件与 HTTP 200 都不等于业务可用，
 * 因此 {@code loaded} 的界面文案只能写「已收到页面加载事件」。</p>
 */
export type ProjectPageLoadState = 'idle' | 'loading' | 'loaded' | 'timeout' | 'failed';

/** 主进程上报的诊断事件类型。 */
export type ProjectPageDiagnosticType = 'did-start-loading' | 'did-finish-load' | 'did-fail-load';

/** 渲染层发给主进程的订阅请求（带 generation，用于丢弃迟到结果）。 */
export interface ProjectPageWatchRequest {
  /** 目标页面 origin（主进程据此只匹配该 origin 的**子 frame**）。 */
  origin: string;
  /** 加载尝试序号；事件原样回传，渲染层丢弃非当前代的事件。 */
  generation: number;
}

/** 主进程推送到渲染层的诊断事件。 */
export interface ProjectPageDiagnosticEvent {
  type: ProjectPageDiagnosticType;
  generation: number;
  /** 目标 frame 的地址（did-start-loading 可能为空）。 */
  url?: string;
  /** did-fail-load 的 Chromium 错误码。 */
  errorCode?: number;
  /** did-fail-load 的错误描述（Electron 原文，不翻译、不改写）。 */
  errorDescription?: string;
}

/** 主进程订阅成功后的回执。 */
export interface ProjectPageWatchResult {
  origin: string;
  generation: number;
}

/** 页面预览 IPC 的统一返回形状。 */
export type ProjectPageIpcResult<T> = {ok: true; data: T} | {ok: false; error: string};

/**
 * 页面预览的公开 API（ChatView 持有唯一实例并通过 {@link PROJECT_PAGE_PREVIEW_KEY} 注入）。
 *
 * <p>状态命名说明：{@code open} 是**布尔状态**（面板是否可见），打开动作叫
 * {@code openAddress} —— 同名会被模板真值判断（`pagePreview.open`）吃掉一个概念。</p>
 */
export interface ProjectPagePreviewApi {
  /** 面板是否打开（页面预览这条链路自己的可见性真源）。 */
  readonly open: Ref<boolean>;
  /** 地址输入框的当前内容（用户可编辑，未提交）。 */
  readonly addressInput: Ref<string>;
  /** 已提交且被接受的页面地址；空串表示还没成功提交过。 */
  readonly committedUrl: Ref<string>;
  /** 已提交地址的 origin，用于主进程 frame 匹配。 */
  readonly committedOrigin: Ref<string>;
  /** 当前加载状态。 */
  readonly loadState: Ref<ProjectPageLoadState>;
  /** 当前加载尝试序号；iframe 以它作 key，reload 即换代重建实例。 */
  readonly generation: Ref<number>;
  /** 地址校验失败的可见文案（空串表示没有错误）。 */
  readonly addressError: Ref<string>;
  /** 已确认失败时主进程给出的错误描述（空串表示没有诊断）。 */
  readonly failureDetail: Ref<string>;
  /** 状态行的文案 key 对应的当前语言文本。 */
  readonly statusText: ComputedRef<string>;
  /** 诊断提示（可空）：超时提示 / 已确认失败的原因与检查建议。 */
  readonly diagnoseText: ComputedRef<string>;

  /**
   * 打开面板；给了地址就校验并立即开始一次加载尝试。
   *
   * @param address 可选的目标地址；省略时只把面板打开（显示地址输入）。
   */
  openAddress: (address?: string) => void;
  /** 更新地址输入内容并清掉上一次的校验错误。 */
  updateAddress: (value: string) => void;
  /** 用当前已提交地址重新发起一次加载尝试（换代重建 iframe）。 */
  reload: () => void;
  /** 关闭并销毁页面实例、释放订阅；地址输入内容保留。 */
  close: () => void;
  /** iframe 自身 load 事件入口（弱证据，失败已被确认时不得覆盖）。 */
  handleFrameLoad: () => void;
  /** 主进程诊断事件的唯一归并入口（内含 generation 失效保护）。 */
  applyDiagnosticEvent: (event: ProjectPageDiagnosticEvent) => void;
}

/** 页面预览状态的注入 key（由 ChatView provide，预览组件 inject）。 */
export const PROJECT_PAGE_PREVIEW_KEY: InjectionKey<ProjectPagePreviewApi> =
  Symbol('project-page-preview');
