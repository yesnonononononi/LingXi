/**
 * 生产构建的**桌宠静态资产隔离**（M2 线A任务 2 的唯一真源）。
 *
 * <p><b>要解决的问题：</b>`vite build` 会把整个 `public/` 目录原样拷进 `dist/`，
 * 而 `public/live2d/` 下全部是桌宠的静态资产（`pet-p1` / `pet-poses` / `pet-sequences` / `pet-v3`，
 * 合计约 9 MiB、132 个文件）。安装版**不展示桌宠**（`electron/pet-feature-gate.cjs` 的打包态恒关），
 * 这些字节就是纯粹的包体浪费：主包被撑大三成以上，却一个字节都用不到。</p>
 *
 * <p><b>为什么隔离放在构建尾巴上、而不是改 `publicDir`：</b>`publicDir` 是**开发态与构建态共用**的语义
 * （dev server 直接从它读文件、`electron/main.cjs` 的 `lxa://` extraBases 在开发态直接指向
 * `public/live2d`）。动它等于同时改三条开发链的行为——5275 的 `vite.pet.config.ts`、
 * electron 开发态的素材热更新、`pet.html` 的资产加载全都会退化。所以本模块只做一件事：
 * **构建写盘完成之后，把 `dist/live2d/` 下的 `pet-*` 目录删掉**，其它路径一概不碰。</p>
 *
 * <p><b>判定口径（按目录名前缀，不按具体名单）：</b>任何名为 `pet-*` 的目录都算桌宠静态资产。
 * 不写死 `pet-poses`/`pet-sequences`/`pet-v3` 这类名单：将来美术新增 `pet-face2` 时，
 * 名单式写法会静默漏删（而且漏掉的正是最新最大的那批）。</p>
 *
 * <p><b>为什么"删目录"是安全的：</b>打包态的 `lxa://` 协议与桌宠窗口都不注册
 * （`electron/main.cjs` 的 `petExposure.enabled` 为 false ⇒ 连 `require` 都不做），
 * 所以 `dist/live2d/pet-*` 在安装版里没有任何读取者。开发态读的是 `public/live2d`，
 * 与 `dist/` 无关。</p>
 *
 * @module scripts/pet-asset-isolation
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** `dist/` 下承载 live2d 资源的子目录名（与 `electron/lx-protocol.cjs` 的 `dist/live2d` 同源）。 */
export const LIVE2D_DIR_NAME = 'live2d';

/** 桌宠静态资产目录的**名前缀**（`pet-poses` / `pet-sequences` / `pet-p1` / `pet-v3` 全部命中）。 */
export const PET_ASSET_DIR_PREFIX = 'pet-';

/**
 * 目录名是否是桌宠静态资产目录。
 *
 * @param name 目录名（不是路径）
 * @returns 是否属于桌宠静态资产
 */
export function isPetAssetDirName(name) {
  return typeof name === 'string' && name.startsWith(PET_ASSET_DIR_PREFIX);
}

/**
 * 递归统计一个目录的文件数与字节数。
 *
 * @param dir 目录绝对路径
 * @returns {{files: number, bytes: number}} 统计结果（目录不存在时为 0/0）
 */
export function measureDirectory(dir) {
  const result = { files: 0, bytes: 0 };
  if (!existsSync(dir)) return result;
  /** 深度优先遍历。 */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      result.files += 1;
      result.bytes += statSync(absolute).size;
    }
  };
  walk(dir);
  return result;
}

/**
 * 列出 `dist/live2d/` 下的桌宠静态资产目录。
 *
 * @param distDir `dist` 目录绝对路径
 * @returns {string[]} 命中目录的绝对路径（按名字排序，便于日志稳定）
 */
export function listPetAssetDirs(distDir) {
  const live2dDir = resolve(String(distDir), LIVE2D_DIR_NAME);
  if (!existsSync(live2dDir)) return [];
  return readdirSync(live2dDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isPetAssetDirName(entry.name))
    .map((entry) => join(live2dDir, entry.name))
    .sort();
}

/**
 * 从生产产物里移除桌宠静态资产（**幂等**：没有可删的东西时返回空清单，不抛错）。
 *
 * @param distDir `dist` 目录绝对路径
 * @returns {{distDir: string, removed: Array<{name: string, files: number, bytes: number}>,
 *   removedFiles: number, removedBytes: number}} 移除报告
 */
export function isolatePetAssetsFromDist(distDir) {
  const target = resolve(String(distDir));
  const removed = [];
  for (const dir of listPetAssetDirs(target)) {
    const stats = measureDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
    removed.push({ name: basename(dir), files: stats.files, bytes: stats.bytes });
  }
  return {
    distDir: target,
    removed,
    removedFiles: removed.reduce((sum, item) => sum + item.files, 0),
    removedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
  };
}
