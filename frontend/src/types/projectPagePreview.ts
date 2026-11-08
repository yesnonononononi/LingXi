import type {ComputedRef, InjectionKey, Ref} from 'vue';

/**
 * 预览面板的两种内容模式。
 *
 * <ul>
 *   <li>{@code file}：现有的文件标签 + 代码预览（阶段一不改变其行为）。</li>
 *   <li>{@code page}：项目页面原生视图预览。</li>
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
 * <p>注意：页面加载事件与 HTTP 200 都不等于业务可用，
 * 因此 {@code loaded} 的界面文案只能写「已收到页面加载事件」。</p>
 */
export type ProjectPageLoadState = 'idle' | 'loading' | 'loaded' | 'timeout' | 'failed';

/** 主进程上报的诊断事件类型。 */
export type ProjectPageDiagnosticType = 'did-start-loading' | 'did-finish-load' | 'did-fail-load' | 'did-navigate';

/** 换代加载，迟到的旧页面事件不能影响当前地址。 */
export interface ProjectPageNavigateRequest {
  url: string;
  generation: number;
}

/** 坐标以主页面 CSS 像素传递，主进程按缩放比例转换。 */
export interface ProjectPageLayout {
  visible: boolean;
  bounds: {x: number; y: number; width: number; height: number};
}

export interface ProjectPageLayoutRequest extends ProjectPageLayout {
  generation: number;
}

/** 主进程推送到渲染层的诊断事件。 */
export interface ProjectPageDiagnosticEvent {
  type: ProjectPageDiagnosticType;
  generation: number;
  /** 当前网页的地址（did-start-loading 可能为空）。 */
  url?: string;
  /** did-fail-load 的 Chromium 错误码。 */
  errorCode?: number;
  /** did-fail-load 的错误描述（Electron 原文，不翻译、不改写）。 */
  errorDescription?: string;
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
  /** 当前网页的 origin。 */
  readonly committedOrigin: Ref<string>;
  /** 当前加载状态。 */
  readonly loadState: Ref<ProjectPageLoadState>;
  /** 当前加载尝试序号；旧原生视图的迟到事件据此失效。 */
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
  /** 用当前网页地址重新加载。 */
  reload: () => void;
  /** 关闭并释放原生视图；地址输入内容保留。 */
  close: () => void;
  /** 隐藏只改变视图可见性，不能销毁页面输入和登录状态。 */
  updateLayout: (layout: ProjectPageLayout) => void;
  /** 主进程诊断事件的唯一归并入口（内含 generation 失效保护）。 */
  applyDiagnosticEvent: (event: ProjectPageDiagnosticEvent) => void;
}

/** 页面预览状态的注入 key（由 ChatView provide，预览组件 inject）。 */
export const PROJECT_PAGE_PREVIEW_KEY: InjectionKey<ProjectPagePreviewApi> =
  Symbol('project-page-preview');
