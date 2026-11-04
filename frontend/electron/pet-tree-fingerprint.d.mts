/**
 * `pet-tree-fingerprint.mjs` 的类型声明。
 *
 * <p><b>为什么需要它：</b>`vite.pet.config.ts` 会 import 这个纯 ESM 的 `.mjs` 来挂树指纹插件
 * （`0f1c9fc6` 引入）。`.mjs` 没有任何类型信息，而 `tsconfig.node.json` 的 `include` 含
 * `vite.pet.config.ts`，于是 `vue-tsc -b`（以及 `npm run build` = `vue-tsc -b && vite build`）
 * 直接报 TS7016 "implicitly has an 'any' type"。</p>
 *
 * <p><b>为什么选声明文件而不是把实现迁到 `.ts`：</b>这个模块**必须**是 ESM——它被 Vite 配置
 * 用 esbuild 打成 ESM 再执行，若写成/内联成 CJS，`require('node:crypto')` 会变成动态 require
 * 垫片并抛 `Dynamic require of "node:crypto" is not supported`（`0f1c9fc6` 踩过）。
 * 声明文件与 `.mjs` 同目录同名（`.mjs` → `.d.mts` 是 TypeScript 的既定配对规则，
 * 与既有 `pet-dev-endpoint.cjs` → `pet-dev-endpoint.d.cts` 完全一致），
 * 既拿到强类型又不改变运行时语义。</p>
 *
 * <p><b>防漂移：</b>本文件声明的导出名/导出种类、以及三态联合的字面量，由
 * `tests/petDevIdentity.test.cjs` 里的"声明 ↔ 实现一致性"用例逐个对账（真 `import()` 出来
 * 的对象与本文本解析结果比对）。实现里加/删导出而声明没跟上就会红；
 * 变异体 `declaration-export-removed` 与 `declaration-identity-union-drift` 守住这条守卫本身。</p>
 *
 * <p><b>口径：</b>声明只描述**导出的形状**，不描述内部实现（`sha256` / `listDirFiles` /
 * `fetchText` 等均为私有）。为了让宿主环境（Node 与将来的其他运行时）都能解析，
 * 这里不引用 DOM 或 undici 的全局 `fetch` 类型，改用结构化的 {@link FetchLike}。</p>
 */

/** 身份对账结论（三态，与运行时 `TREE_IDENTITY` 的取值必须逐字一致）。 */
export type TreeIdentityStatus = 'own' | 'foreign' | 'undecidable';

/**
 * 判定的证据来源。
 *
 * <ul>
 *   <li>`meta`：页面里注入了 `<meta name="lx-pet-tree">`，两边现算摘要一致 ⇒ 强证据；</li>
 *   <li>`json-bytes`：没有 meta，退到清单字节比对 ⇒ 弱证据；</li>
 *   <li>`none`：页面都取不到，判不了。</li>
 * </ul>
 */
export type TreeIdentityEvidence = 'meta' | 'json-bytes' | 'none';

/** 参与指纹的单个文件。 */
export interface TreeFingerprintFile {
  /** 相对 frontend 根的路径（正斜杠）。 */
  readonly path: string;
  /** 文件字节数。 */
  readonly bytes: number;
  /** 文件内容的 SHA-256（64 位十六进制）。 */
  readonly sha256: string;
}

/** 整棵源码树的指纹。 */
export interface TreeFingerprint {
  /** 整棵树的摘要（`相对路径\0文件摘要\n` 按路径排序后整体哈希，64 位十六进制）。 */
  readonly digest: string;
  /** 参与哈希的文件清单（按路径排序）。 */
  readonly files: readonly TreeFingerprintFile[];
  /** 参与哈希的总字节数。 */
  readonly totalBytes: number;
  /** 声明参与指纹、但磁盘上不存在的散文件（相对 frontend 根）。 */
  readonly missing: readonly string[];
}

/** 注入树指纹的 Vite 插件（结构上可直接放进 `plugins` 数组）。 */
export interface TreeFingerprintPlugin {
  /** 插件名，固定 `lx-pet-tree-fingerprint`。 */
  readonly name: string;
  /**
   * 往页面 `<head>` 注入 `<meta name="lx-pet-tree" content="<摘要>">`。
   *
   * <p>dev 下每次请求都会跑，所以总是反映磁盘当前内容；算不出指纹时原样返回 HTML
   * （绝不把页面搞挂——守卫那边会落到"弱指纹 / 无法判定"）。</p>
   *
   * @param html 原始 HTML
   * @returns 注入后的 HTML
   */
  transformIndexHtml(html: string): string;
}

/** `fetch` 的最小结构化形状（避免依赖 DOM / undici 的全局类型）。 */
export type FetchLike = (
  url: string,
  init?: { readonly redirect?: 'manual' | 'follow' | 'error'; readonly signal?: AbortSignal },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** {@link verifyOwnTree} 的选项。 */
export interface VerifyOwnTreeOptions {
  /** dev server 源，必填，形如 `http://127.0.0.1:5275`（结尾斜杠会被剥掉）。 */
  readonly origin: string;
  /** 入口页文件名（默认 `pet.html`；调用方应从单一真源取）。 */
  readonly entryPage?: string;
  /** frontend 根目录（默认本文件所在目录的上一级）。 */
  readonly frontendRoot?: string;
  /** 单次 HTTP 请求超时（毫秒，默认 3000）。 */
  readonly timeoutMs?: number;
  /** `fetch` 实现（测试可注入）。 */
  readonly fetchImpl?: FetchLike;
}

/** 端口上那棵树的服务端证据（三种形状对应三种判定路径）。 */
export type RemoteTreeEvidence =
  | { readonly digest: string }
  | { readonly mismatches: readonly string[] }
  | { readonly compared: number }
  | null;

/** {@link verifyOwnTree} 的判定结果。 */
export interface TreeIdentityResult {
  /** 三态结论。只有 `own` 允许被当成通过。 */
  readonly status: TreeIdentityStatus;
  /** 证据来源。 */
  readonly evidence: TreeIdentityEvidence;
  /** 证据强度：`true` 表示只做了清单字节比对（弱证据），建议重启 dev server 启用强指纹。 */
  readonly weak: boolean;
  /** 人读的原因（中文）。 */
  readonly message: string;
  /** 判定失败/无法判定时的修法提示；`own` 时为空串。 */
  readonly hint: string;
  /** 本地算出的指纹（算不出来时 `null`）。 */
  readonly local: TreeFingerprint | null;
  /** 服务端证据（`none` 时为 `null`）。 */
  readonly remote: RemoteTreeEvidence;
  /** 与本地不一致的清单文件（仅 `json-bytes` 路径会非空）。 */
  readonly mismatches: readonly string[];
}

/** 注入进 `pet.html` 的 meta 名，固定 `lx-pet-tree`。 */
export declare const TREE_META_NAME: string;
/** 参与指纹的目录（相对 frontend 根，已冻结）。 */
export declare const TREE_FINGERPRINT_DIRS: readonly string[];
/** 参与指纹的散文件（相对 frontend 根，已冻结）。 */
export declare const TREE_FINGERPRINT_FILES: readonly string[];
/** 三态结论常量（冻结对象）。 */
export declare const TREE_IDENTITY: {
  /** 已证明是本地这棵树。 */
  readonly OWN: 'own';
  /** 明确是另一棵树：必须失败，绝不允许当成 PASS。 */
  readonly FOREIGN: 'foreign';
  /** 判不了：调用方只能 SKIP，且必须打印原因与修法。 */
  readonly UNDECIDABLE: 'undecidable';
};

/**
 * 计算整棵源码树的指纹。
 *
 * @param frontendRoot frontend 根目录（省略时取本文件所在目录的上一级）
 * @returns 指纹结果
 * @throws {Error} 一个文件都没收集到时抛出（拒绝产出空指纹）
 */
export declare function computeTreeFingerprint(frontendRoot?: string): TreeFingerprint;

/**
 * 从页面文本里读注入的树指纹。
 *
 * @param html 页面文本
 * @returns 64 位十六进制摘要；没有该 meta 时 `null`
 */
export declare function readTreeMeta(html: string): string | null;

/**
 * 生成注入树指纹的 Vite 插件（只在桌宠 config 里挂）。
 *
 * @param frontendRoot frontend 根目录（省略时取本文件所在目录的上一级）
 * @returns Vite 插件
 */
export declare function createTreeFingerprintPlugin(frontendRoot?: string): TreeFingerprintPlugin;

/**
 * 判定端口上的 dev server 是否**本地这棵树**。
 *
 * @param options 选项（`origin` 必填；省略整个参数时 `origin` 非法会抛错）
 * @returns 判定结果（三态，`undecidable` 表示无法判定）
 * @throws {TypeError} `origin` 非法，或运行时没有 `fetch` 且未注入 `fetchImpl`
 */
export declare function verifyOwnTree(options?: VerifyOwnTreeOptions): Promise<TreeIdentityResult>;
