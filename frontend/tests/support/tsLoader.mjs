/**
 * 用 Node 自带的类型剥离跑 TS / SFC 用例的最小加载器。
 *
 * <p><b>为什么不用 tsx</b>：`package.json` 的 test 脚本写的是 `npx tsx --test`，但本机
 * 沙箱里 `npx` 起不来（spawn EPERM），仓库里也没装 tsx。Node 24 已经能直接执行 `.ts`
 * （类型剥离是内建的），缺的只有两件事：①无扩展名的相对导入解析；②`.vue` 单文件组件。
 * 这个钩子只补这两件，判定逻辑一律复用 `@vue/compiler-sfc`（与 tests/helpers/sfcModule 同源）。</p>
 *
 * <p>注册方式：`node --import ./tests/support/tsRegister.mjs --test tests/xxx.test.ts`。</p>
 */
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, resolve as resolvePath} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileScript, parse} from '@vue/compiler-sfc';

/** 只有真文件才算命中：目录（例如 `../../i18n`）必须继续走补扩展名 / 找 index 的分支。 */
function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

const CANDIDATE_SUFFIXES = ['.ts', '.js', '.mjs', '.cjs', '.vue'];

function resolveFile(base) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && !candidate.endsWith('.d.ts')) return candidate;
  }
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = resolvePath(base, `index${suffix}`);
    if (existsSync(candidate) && !candidate.endsWith('.d.ts')) return candidate;
  }
  return null;
}

/** 相对导入解析：`.vue` 原样交给 load 钩子编译，无扩展名按 TS 习惯补全或找 index。 */
export async function resolve(specifier, context, next) {
  const parent = context.parentURL;
  if (specifier.startsWith('.') && parent?.startsWith('file:')) {
    const base = resolvePath(dirname(fileURLToPath(parent)), specifier);
    const hit = isFile(base) ? base : resolveFile(base);
    if (hit) return {url: pathToFileURL(hit).href, shortCircuit: true};
  }
  return next(specifier, context);
}

/**
 * `.vue` 载入：脚本 + 内联模板编译成 ESM。
 *
 * <p>不回写相对导入 —— 编译产物的 URL 就是 `.vue` 文件本身，上面的 resolve 钩子会以它为
 * 基准解析，与 tsx 的处理语义一致（改写反而要重复一遍路径逻辑）。</p>
 */
export async function load(url, context, next) {
  if (url.endsWith('.vue')) {
    const filename = fileURLToPath(url);
    const descriptor = parse(readFileSync(filename, 'utf8'), {filename}).descriptor;
    const script = compileScript(descriptor, {id: filename, inlineTemplate: true});
    return {format: 'module', source: script.content, shortCircuit: true};
  }
  return next(url, context);
}
