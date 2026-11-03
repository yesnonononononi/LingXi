/**
 * 运行时立绘加载器：`decode()` + 超时 + 降级 + 性能打点。
 *
 * <p><b>为什么用 `decode()` 而不是 `load` 事件：</b>`load` 只代表"字节到齐"，
 * 此时图片还没解码；直接 `hidden=false` 会出现"先在桌面上画一块空白/半成品再刷新"。
 * `decode()` 在解码完成后 resolve，才是真正可以上屏的时刻（设计文档 §7.2.2）。</p>
 *
 * <p><b>为什么要超时：</b>`lxa://` 读的是本地文件，理论上不会挂；但自定义协议的 handler 是异步的，
 * 一旦 handler 抛错没有响应，Promise 会永远 pending——桌宠就永久留在"加载中"。
 * 3s 超时后走降级（@1x 或错误提示），比空窗口好。</p>
 *
 * @module pet/assets/loader
 */

/** 默认超时（毫秒）。 */
export const DEFAULT_DECODE_TIMEOUT_MS = 3000;

/** 性能打点前缀（`performance.measure` 的名字可被验收脚本采集）。 */
export const LOAD_MARK_PREFIX = 'pet-art';

/** 加载结果。 */
export interface ArtLoadResult {
  /** 是否成功（含降级成功）。 */
  readonly ok: boolean;
  /** 最终使用的 URL。 */
  readonly url: string;
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number;
  /** 是否超时。 */
  readonly timedOut: boolean;
  /** 是否用了降级 URL。 */
  readonly usedFallback: boolean;
  /** 失败原因（成功时为 undefined）。 */
  readonly error?: string;
}

/** 加载选项。 */
export interface ArtLoadOptions {
  /** 首选 URL（通常是 @2x）。 */
  readonly primaryUrl: string;
  /** 降级 URL（通常是 @1x）；不提供则不降级。 */
  readonly fallbackUrl?: string;
  /** 单次解码超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 打点标签（默认 `pet-art`）。 */
  readonly markLabel?: string;
}

/**
 * 取消/打点用的性能接口（缺失时静默降级为无打点）。
 *
 * @returns `performance` 对象或 null
 */
function performanceApi(): Performance | null {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function' ? performance : null;
}

/**
 * 安全打点（不支持时静默跳过，绝不影响加载流程）。
 *
 * @param name 打点名
 */
function mark(name: string): void {
  try {
    performanceApi()?.mark(name);
  } catch {
    // 打点失败不影响加载
  }
}

/**
 * 安全测量。
 *
 * @param name 测量名
 * @param startMark 起点打点
 * @param endMark 终点打点
 */
function measure(name: string, startMark: string, endMark: string): void {
  try {
    const api = performanceApi();
    if (!api || typeof api.measure !== 'function') return;
    api.measure(name, startMark, endMark);
  } catch {
    // 同上：测量失败不影响加载
  }
}

/**
 * 在超时约束下解码一张图片。
 *
 * @param image 目标 `<img>`
 * @param url 图片 URL
 * @param timeoutMs 超时毫秒
 * @returns 是否成功与是否超时
 */
async function decodeWithTimeout(
  image: HTMLImageElement,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; timedOut: boolean; error?: string }> {
  if (image.getAttribute('src') !== url) {
    image.src = url;
  }
  let timer = 0;
  const timeout = new Promise<{ ok: boolean; timedOut: boolean; error?: string }>((resolveTimeout) => {
    timer = globalThis.setTimeout(() => resolveTimeout({ ok: false, timedOut: true, error: `解码超时(${timeoutMs}ms)` }), timeoutMs) as unknown as number;
  });
  const decoding = (async (): Promise<{ ok: boolean; timedOut: boolean; error?: string }> => {
    try {
      if (typeof image.decode === 'function') {
        await image.decode();
      } else {
        // 老内核兜底：等 load/error 事件
        await new Promise<void>((resolveLoad, rejectLoad) => {
          image.addEventListener('load', () => resolveLoad(), { once: true });
          image.addEventListener('error', () => rejectLoad(new Error('load 失败')), { once: true });
        });
      }
      return { ok: true, timedOut: false };
    } catch (err) {
      return { ok: false, timedOut: false, error: String((err as Error)?.message ?? err) };
    }
  })();
  const result = await Promise.race([decoding, timeout]);
  if (timer) globalThis.clearTimeout(timer);
  return result;
}

/**
 * 加载立绘：先试首选档，失败/超时再试降级档。
 *
 * @param image 目标 `<img>`（调用方负责初始 `hidden`）
 * @param options 加载选项
 * @returns 加载结果
 */
export async function loadArt(image: HTMLImageElement, options: ArtLoadOptions): Promise<ArtLoadResult> {
  if (!image) throw new TypeError('loadArt 需要一个 <img> 元素');
  const primaryUrl = typeof options?.primaryUrl === 'string' ? options.primaryUrl : '';
  if (primaryUrl.length === 0) throw new TypeError('loadArt 需要 primaryUrl');
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? (options.timeoutMs as number)
      : DEFAULT_DECODE_TIMEOUT_MS;
  const label = options.markLabel ?? LOAD_MARK_PREFIX;
  const startMark = `${label}-start`;
  const endMark = `${label}-end`;

  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  mark(startMark);

  const primary = await decodeWithTimeout(image, primaryUrl, timeoutMs);
  if (primary.ok) {
    mark(endMark);
    measure(label, startMark, endMark);
    return {
      ok: true,
      url: primaryUrl,
      elapsedMs: typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started,
      timedOut: false,
      usedFallback: false,
    };
  }

  const fallbackUrl = typeof options.fallbackUrl === 'string' ? options.fallbackUrl : '';
  if (fallbackUrl.length > 0 && fallbackUrl !== primaryUrl) {
    const fallback = await decodeWithTimeout(image, fallbackUrl, timeoutMs);
    mark(endMark);
    measure(label, startMark, endMark);
    const elapsedMs = typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started;
    if (fallback.ok) {
      return { ok: true, url: fallbackUrl, elapsedMs, timedOut: false, usedFallback: true };
    }
    return {
      ok: false,
      url: fallbackUrl,
      elapsedMs,
      timedOut: fallback.timedOut,
      usedFallback: true,
      error: fallback.error,
    };
  }

  mark(endMark);
  measure(label, startMark, endMark);
  return {
    ok: false,
    url: primaryUrl,
    elapsedMs: typeof performance !== 'undefined' ? performance.now() - started : Date.now() - started,
    timedOut: primary.timedOut,
    usedFallback: false,
    error: primary.error,
  };
}
