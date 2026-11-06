/**
 * `scripts/pet-asset-isolation.mjs` 的类型声明（供 `vite.config.ts` 在 `tsc -b` 下静态引用）。
 *
 * <p>为什么需要这个文件：`tsconfig.node.json` 没有开 `allowJs`，而 `vite.config.ts`
 * 要在构建期插件里调用同一个隔离函数（**单一真源**，守卫脚本与本插件不许各写一份判定）。
 * 声明文件是 `.mjs` 的类型搭档（`pet-asset-isolation.d.mts`），只描述公开导出面，
 * 与实现分离，不引入 `allowJs` 这种全局开关。</p>
 *
 * @module scripts/pet-asset-isolation
 */

/** `dist/` 下承载 live2d 资源的子目录名。 */
export declare const LIVE2D_DIR_NAME: string;

/** 桌宠静态资产目录的名字前缀。 */
export declare const PET_ASSET_DIR_PREFIX: string;

/**
 * 目录名是否是桌宠静态资产目录。
 *
 * @param name 目录名
 * @returns 是否属于桌宠静态资产
 */
export declare function isPetAssetDirName(name: unknown): boolean;

/**
 * 递归统计一个目录的文件数与字节数。
 *
 * @param dir 目录绝对路径
 * @returns 文件数与字节数
 */
export declare function measureDirectory(dir: string): { files: number; bytes: number };

/**
 * 列出 `dist/live2d/` 下的桌宠静态资产目录。
 *
 * @param distDir `dist` 目录绝对路径
 * @returns 命中目录的绝对路径
 */
export declare function listPetAssetDirs(distDir: string): string[];

/**
 * 从生产产物里移除桌宠静态资产（幂等）。
 *
 * @param distDir `dist` 目录绝对路径
 * @returns 移除报告
 */
export declare function isolatePetAssetsFromDist(distDir: string): {
  distDir: string;
  removed: Array<{ name: string; files: number; bytes: number }>;
  removedFiles: number;
  removedBytes: number;
};
