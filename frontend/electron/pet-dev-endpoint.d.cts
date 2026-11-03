/**
 * `pet-dev-endpoint.cjs` 的类型声明。
 *
 * <p>`vite.pet.config.ts` 需要从 CJS 真源取端口/严格端口/appType，而 `vue-tsc -b`
 * 不允许 import 一个没有类型的 `.cjs`。声明与实现放在同目录，TypeScript 的
 * `.cjs` → `.d.cts` 解析规则会自动配对，无需额外配置。</p>
 */

/** 桌宠 dev server 端点配置。 */
export interface PetDevEndpoint {
  /** 监听地址（只绑回环）。 */
  readonly host: string;
  /** 端口（唯一真源）。 */
  readonly port: number;
  /** 入口页文件名，如 `pet.html`。 */
  readonly entryPage: string;
  /** `pet.html` 头部的身份标记。 */
  readonly appMetaMarker: string;
  /** `pet.html` body 里的唯一 DOM 锚点。 */
  readonly rootMarker: string;
}

/** 探活必须命中的全部内容指纹。 */
export declare const PET_PAGE_MARKERS: readonly string[];
/** 端口合法区间下界。 */
export declare const MIN_PORT: number;
/** 端口合法区间上界。 */
export declare const MAX_PORT: number;
/** 端点真源。 */
export declare const DEV_ENDPOINT: PetDevEndpoint;

/** 校验端点配置，非法时抛 TypeError。 */
export declare function assertEndpoint(endpoint: PetDevEndpoint): PetDevEndpoint;
/** 来源地址，形如 `http://127.0.0.1:5275`。 */
export declare function buildDevOrigin(endpoint?: PetDevEndpoint): string;
/** 入口页完整 URL，形如 `http://127.0.0.1:5275/pet.html`。 */
export declare function buildEntryUrl(endpoint?: PetDevEndpoint): string;

/** Vite 配置片段。 */
export interface PetViteOverrides {
  /** 固定 `'mpa'`：关闭 history fallback。 */
  readonly appType: string;
  /** dev server 选项。 */
  readonly server: {
    readonly host: string;
    readonly port: number;
    /** 固定 `true`：端口被占硬失败。 */
    readonly strictPort: boolean;
    readonly open: boolean;
  };
}

/** 生成 `vite.pet.config.ts` 的覆盖项。 */
export declare function createPetViteOverrides(endpoint?: PetDevEndpoint): PetViteOverrides;
