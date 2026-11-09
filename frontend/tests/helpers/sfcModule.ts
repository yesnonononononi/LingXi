/**
 * 组件级测试的 SFC 编译基建。
 *
 * 背景：`node --test`（tsx）不能直接 import `.vue`。想在进程内挂载真组件，必须把 SFC 编译成
 * 临时 `.mjs` 再动态 import，并把编译产物里的相对导入改写成可加载的 file:// URL。
 *
 * 这里放**唯一一份**实现：`toolSettingsDisplay.test.ts`（AgentsTab 等）与
 * `mcpConnectComponent.test.ts`（McpTab + McpServiceCard）共用。此前两处各写一份，
 * 其中一份不支持 `.vue` 相对导入，导致卡片一拆子组件测试就直接炸在路径解析上。
 */
import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileScript, parse} from '@vue/compiler-sfc';
import ts from 'typescript';
import type test from 'node:test';

/** frontend 根目录（`tests/helpers/` 的上两级）。 */
export const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmpDir = resolve(frontendRoot, 'node_modules/.tmp');

/**
 * 源文件绝对路径 → 编译产出的临时 .mjs 路径。
 *
 * 两个作用：①同一组件被多处引用时只编译一次；②**打断循环引用** ——
 * 必须先登记再递归编译，否则 A → B → A 会无限递归。
 */
const compiledModules = new Map<string, string>();

/**
 * 把一条相对导入解析成可直接 import 的 file:// URL。
 *
 * 三条分支对应源码里真实存在的三类导入：
 * - `.vue` 结尾：单文件组件，递归编译成临时 .mjs。**绝不能拼 `/index.ts`**（它是文件不是目录）。
 * - 已带真实扩展名（ts/js/mjs/cjs/json）：原样指向。
 * - 无扩展名：依次试 `base+.ts` / `base+.js` / `base/index.ts` / `base/index.js`；
 *   全不存在时抛错并列出所有尝试过的路径 —— 静默拼一个必然不存在的路径，
 *   错误信息会指向 `Foo.vue/index.ts` 这种假路径，排查成本极高。
 */
export function resolveImportUrl(componentPath: string, relative: string, context: test.TestContext): string {
  const base = resolve(dirname(componentPath), relative);

  if (/\.vue$/i.test(base)) {
    if (!existsSync(base)) {
      throw new Error(`无法解析导入 '${relative}'（来自 ${componentPath}）：.vue 文件不存在于 ${base}`);
    }
    return pathToFileURL(compileVueModule(base, context)).href;
  }

  if (/\.(ts|js|mjs|cjs|json)$/i.test(base)) {
    if (!existsSync(base)) {
      throw new Error(`无法解析导入 '${relative}'（来自 ${componentPath}）：文件不存在于 ${base}`);
    }
    return pathToFileURL(base).href;
  }

  const candidates = [base + '.ts', base + '.js', resolve(base, 'index.ts'), resolve(base, 'index.js')];
  const hit = candidates.find(candidate => existsSync(candidate));
  if (!hit) {
    throw new Error(
      `无法解析导入 '${relative}'（来自 ${componentPath}）：` +
        `已尝试 ${candidates.join(' / ')} 均不存在。` +
        '若目标是 .vue 单文件组件，请在导入语句里显式写出 .vue 扩展名。'
    );
  }
  return pathToFileURL(hit).href;
}

/** 重写编译产物里的全部相对导入，使其指向真实可加载的模块。 */
export function rewriteRelativeImports(source: string, componentPath: string, context: test.TestContext): string {
  return source.replace(/from ['"](\.[^'"]+)['"]/g, (_match, relative: string) =>
    `from '${resolveImportUrl(componentPath, relative, context)}'`
  );
}

/** 把 .vue 编译成临时 .mjs 并返回其路径；同一源文件只编译一次，用后由 context.after 清理。 */
export function compileVueModule(sourcePath: string, context: test.TestContext): string {
  const cached = compiledModules.get(sourcePath);
  if (cached) return cached;

  const temporary = resolve(
    tmpDir,
    sourcePath.replace(frontendRoot, '').replace(/[\\/]+/g, '-').replace(/^-/, '') + '.mjs'
  );
  // 先登记再递归：A → B → A 时 B 能拿到 A 已登记的产物路径，不会无限递归。
  compiledModules.set(sourcePath, temporary);

  const descriptor = parse(readFileSync(sourcePath, 'utf8'), { filename: sourcePath }).descriptor;
  const script = compileScript(descriptor, { id: sourcePath, inlineTemplate: true });
  const source = rewriteRelativeImports(script.content, sourcePath, context);
  mkdirSync(dirname(temporary), { recursive: true });
  writeFileSync(
    temporary,
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
  );
  context.after(() => {
    compiledModules.delete(sourcePath);
    if (existsSync(temporary)) unlinkSync(temporary);
  });
  return temporary;
}

/** 编译并动态 import 一个组件（`path` 相对 `src/`）。 */
export async function loadComponent(path: string, context: test.TestContext): Promise<any> {
  const temporary = compileVueModule(resolve(frontendRoot, 'src', path), context);
  return (await import(pathToFileURL(temporary).href)).default;
}
