import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';
import {compileTemplate, parse} from 'vue/compiler-sfc';

/**
 * 回归用例的**变异源码加载器**。
 *
 * <p>为什么需要它：`tsx --test` 里没有 vite transform 通道，无法像 `.smoke.cjs` 那样用
 * plugin 改写源码。这里退一步：按 `--mutation=xxx` 把目标文件读出来、用补丁函数注回缺陷，
 * 落到系统临时目录后再导入或解析。真实源码一个字都不动，临时目录用完即删
 * （用例的 `after` 钩子负责），因此工作区不会留下任何变异产物。</p>
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 前端根目录（tests/support 的上两级）。 */
export const FRONTEND_ROOT = path.resolve(HERE, '../..');

/** 单条变异：把正常源码改写成「缺陷注回」的源码。 */
export type MutationPatcher = (source: string) => string;

/** 变异名 → 补丁函数。 */
export type MutationTable = Record<string, MutationPatcher>;

let tempDir: string | null = null;
const writtenModules = new Map<string, string>();

/**
 * 从进程参数或环境变量读取变异开关。
 *
 * <p>`node --test` 会把每个测试文件放进子进程执行，**不转发**自定义命令行参数，
 * 因此同时支持 `LX_MUTATION` 环境变量；`--mutation=xxx` 在直接执行
 * （`npx tsx tests/xxx.test.ts --mutation=xxx`）时生效。</p>
 *
 * @param argv 进程参数（默认取 process.argv）
 * @returns 变异名；未指定时为空串（= 正常模式，读真实源码）
 */
export function readMutationFlag(argv: readonly string[] = process.argv): string {
  const matched = argv.find(argument => argument.startsWith('--mutation='));
  if (matched && matched.length > '--mutation='.length) {
    return matched.slice('--mutation='.length);
  }
  return (process.env.LX_MUTATION ?? '').trim();
}

/**
 * 变异产物的**语法护栏**：载入 / 解析前必须先通过一次真实语法解析。
 *
 * <p>为什么必须有它：补丁写错（少一个括号、多一个 `}`）时，测试会以「编译错误」的形式变红，
 * 在报告里长得和「断言成立」一模一样 —— 这种假红比没有变异测试更糟，因为它证明不了用例
 * 有任何咬合力。因此这里一旦解析不过就当场 fail，并明确指出「自检无效」。</p>
 *
 * @param relativePath 相对前端根目录的文件路径（据扩展名选择解析器）
 * @param source 变异产物源码
 * @param mutation 变异名（用于报告定位）
 */
function assertMutantSourceParses(relativePath: string, source: string, mutation: string): void {
  try {
    if (relativePath.endsWith('.vue')) {
      const parsed = parse(source, {filename: relativePath});
      const template = parsed.descriptor.template;
      const compiled = template
        ? compileTemplate({source: template.content, filename: relativePath, id: 'mutant-check'})
        : {errors: [] as unknown[]};
      const errors = [...parsed.errors, ...compiled.errors];
      assert.equal(errors.length, 0, errors.map(error => String((error as Error).message ?? error)).join('; '));
      return;
    }
    // TS 走编译器自身的语法诊断（只查语法、不做类型检查）：与真实编译同一套 parser，
    // 且 typescript 是本仓库的一等 devDependency，不依赖传递依赖。
    const transpiled = ts.transpileModule(source, {
      reportDiagnostics: true,
      fileName: path.basename(relativePath),
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
    });
    const diagnostics = transpiled.diagnostics ?? [];
    assert.equal(diagnostics.length, 0,
      diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('; '));
  } catch (error) {
    assert.fail(`变异 ${mutation} 的补丁生成了非法代码，自检无效（语法解析失败）：${
      error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 把源码里某个导出函数整体替换成给定实现。
 *
 * <p>闭区间靠**大括号配平**定位，不靠 `indexOf('\\n}\\n')` 这类文本锚点 ——
 * 文本锚点对 CRLF 与「函数体最后一行恰好是 `}`」两种情况都会错位，历史上正是它把原来
 * 的收尾 `}` 留了下来，生成 `}` 重复的非法源码（假红）。</p>
 *
 * @param source 原始源码
 * @param name 导出函数名
 * @param replacement 完整替换文本（含 `export function ...` 与结尾大括号）
 * @returns 替换后的源码
 */
export function replaceExportedFunction(source: string, name: string, replacement: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `补丁锚点失效：找不到函数 ${name}`);
  // 本仓库被替换的判据函数参数里没有解构，第一个 `{` 就是函数体开口。
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `补丁锚点失效：找不到函数 ${name} 的函数体`);
  const close = findMatchingBrace(source, open);
  assert.ok(close > open, `补丁锚点失效：函数 ${name} 的大括号未配平`);
  return `${source.slice(0, start)}${replacement}${source.slice(close + 1)}`;
}

/**
 * 从 `{` 开始做括号配平，跳过字符串、模板字符串、注释与正则字面量。
 *
 * @param source 源码
 * @param openIndex `{` 所在下标
 * @returns 与之配平的 `}` 下标；未配平返回 -1
 */
function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] ?? '';
    if (char === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (char === '/' && next === '*') {
      const blockEnd = source.indexOf('*/', index + 2);
      index = blockEnd < 0 ? source.length : blockEnd + 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** 跳过一段引号内容，返回收尾引号下标。 */
function skipQuoted(source: string, startIndex: number, quote: string): number {
  for (let index = startIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) {
      return index;
    }
  }
  return source.length - 1;
}

/**
 * 读取（可能被注回缺陷的）源码文本。
 *
 * <p>变异表里没有该变异名时按正常源码返回 —— 一条变异通常只针对一个文件，
 * 其余文件在同一个变异下保持真实实现。「变异名打错」由各用例文件里
 * 「变异名必须在表内」的守卫用例拦住。</p>
 *
 * @param relativePath 相对前端根目录的文件路径
 * @param mutation 变异名
 * @param patches 变异表
 * @returns 源码文本
 * @throws 补丁没改到任何内容（防止「变异静默失效」），或产物语法非法（防止假红）
 */
export function readMutantSource(relativePath: string, mutation: string, patches: MutationTable): string {
  const source = fs.readFileSync(path.join(FRONTEND_ROOT, relativePath), 'utf8');
  if (!mutation) {
    return source;
  }
  const patch = patches[mutation];
  if (!patch) {
    return source;
  }
  const mutated = patch(source);
  if (mutated === source) {
    throw new Error(`变异 ${mutation} 没有改动任何内容，说明补丁锚点已失效`);
  }
  // 护栏：产物必须先解析通过，否则「编译错误」会冒充「断言失败」。
  assertMutantSourceParses(relativePath, mutated, mutation);
  return mutated;
}

/**
 * 导入（可能被注回缺陷的）纯 TS 模块。
 *
 * <p>只适用于**没有运行时 import** 的模块（类型导入在编译期被擦除）：
 * 单独复制一个文件到临时目录就能独立加载。</p>
 *
 * @param relativePath 相对前端根目录的模块路径
 * @param mutation 变异名
 * @param patches 变异表
 * @returns 模块导出对象
 */
export async function importMutantModule<T>(
  relativePath: string,
  mutation: string,
  patches: MutationTable,
): Promise<T> {
  const source = readMutantSource(relativePath, mutation, patches);
  const key = `${mutation || 'clean'}:${relativePath}`;
  const cached = writtenModules.get(key);
  if (cached) {
    return await import(pathToFileURL(cached).href) as T;
  }
  if (!tempDir) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-mutant-'));
  }
  const target = path.join(tempDir, `${writtenModules.size}-${path.basename(relativePath)}`);
  fs.writeFileSync(target, source, 'utf8');
  writtenModules.set(key, target);
  return await import(pathToFileURL(target).href) as T;
}

/**
 * 导入（可能被注回缺陷的）**有运行时依赖**的 TS 模块。
 *
 * <p>只复制目标文件，其余依赖仍指向真实实现：把副本里的相对导入改写成绝对 `file://` URL，
 * 于是 `processViewModel.ts` 这类「层二」模块被变异时，它 import 的 `processSegments` /
 * `processHeadline` 依然是生产代码 —— 变异只改被测那一层，不制造影子依赖。</p>
 *
 * @param relativePath 相对前端根目录的模块路径
 * @param mutation 变异名
 * @param patches 变异表
 * @returns 模块导出对象
 */
export async function importMutantModuleWithDeps<T>(
  relativePath: string,
  mutation: string,
  patches: MutationTable,
): Promise<T> {
  const source = readMutantSource(relativePath, mutation, patches);
  const key = `deps:${mutation || 'clean'}:${relativePath}`;
  const cached = writtenModules.get(key);
  if (cached) {
    return await import(pathToFileURL(cached).href) as T;
  }
  const sourceFile = path.join(FRONTEND_ROOT, relativePath);
  const rewritten = source.replace(/from\s+'(\.[^']+)'/g, (_matched, specifier: string) =>
    `from '${resolveSpecifierUrl(sourceFile, specifier)}'`);
  if (!tempDir) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-mutant-'));
  }
  const target = path.join(tempDir, `${writtenModules.size}-${path.basename(relativePath)}`);
  fs.writeFileSync(target, rewritten, 'utf8');
  writtenModules.set(key, target);
  return await import(pathToFileURL(target).href) as T;
}

/**
 * 把源码里的相对导入说明符解析成绝对 file URL（补 `.ts` 或 `/index.ts`）。
 *
 * @param sourceFile 引用方文件的绝对路径
 * @param specifier 相对说明符（如 `./processSegments`）
 * @returns 可直接 import 的绝对 URL
 */
function resolveSpecifierUrl(sourceFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.mts`, path.join(base, 'index.ts')];
  const resolved = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) {
    throw new Error(`变异副本无法解析依赖 ${specifier}（来自 ${sourceFile}）`);
  }
  return pathToFileURL(resolved).href;
}

/** 删除临时目录；用例的 `after` 钩子必须调用它，保证不留变异产物。 */
export function cleanupMutantTemp(): void {
  writtenModules.clear();
  if (!tempDir) {
    return;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
}
