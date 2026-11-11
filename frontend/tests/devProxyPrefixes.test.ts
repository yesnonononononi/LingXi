/**
 * dev server 的代理前缀必须覆盖后端全部 Controller 的 @RequestMapping 前缀。
 *
 * <p>为什么值得一条守卫：漏一个前缀**不会报错**。vite 的 SPA fallback 会把这个路径当成
 * 前端路由，回一份 index.html 且状态码 200 —— 前端拿到 HTML 解析成「没有数据」，
 * 现象就是「接口一直 200，功能永远空白」。指令预测就这么躺了一次：`/instruction`
 * 没进 API_PREFIXES，预测请求全被 vite 吞掉，界面上什么都不会发生。</p>
 *
 * <p>守卫分两步自证：先证明解析器能从合成样本里抓到前缀与后端控制器前缀（金丝雀正对照），
 * 再断言真实清单覆盖后端。只做后者的话，解析器哪天静默返回空数组，测试会假绿。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const repoRoot = path.resolve(frontendRoot, '..');
const viteConfigPath = path.join(frontendRoot, 'vite.config.ts');
const backendJavaRoot = path.join(repoRoot, 'src', 'main', 'java');

/** 从 vite.config.ts 取 API_PREFIXES 的字面量清单。 */
export function parseProxyPrefixes(source: string): string[] {
  const block = source.match(/const API_PREFIXES = \[([\s\S]*?)\] as const/);
  if (!block) throw new Error('vite.config.ts 里找不到 API_PREFIXES');
  return [...block[1].matchAll(/'(\/[^']*)'/g)].map(match => match[1]);
}

/**
 * 取一个后端 Controller 的类级前缀（第一段）。
 *
 * <p>只看类声明之前的注解：方法级 Mapping 是接口路径，不是前缀；
 * 一个 Controller 给了多个类级路径时，dev server 用第一段就够覆盖。</p>
 */
export function parseControllerPrefix(source: string): string | null {
  const classIndex = source.search(/\b(?:public\s+)?(?:class|interface)\s+\w+/);
  if (classIndex < 0) return null;
  const annotation = source.slice(0, classIndex).match(/@RequestMapping\(([^)]*)\)/);
  if (!annotation) return null;
  const first = annotation[1].match(/"(\/[^"]*)"/);
  if (!first) return null;
  const segment = first[1].split('/').filter(Boolean)[0];
  return segment ? `/${segment}` : null;
}

/** 后端前缀里没有被代理覆盖的部分（空数组才算通过）。 */
export function missingPrefixes(backendPrefixes: string[], proxyPrefixes: string[]): string[] {
  return [...new Set(backendPrefixes)].filter(prefix => !proxyPrefixes.includes(prefix)).sort();
}

function collectJavaFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJavaFiles(full, collected);
    else if (entry.name.endsWith('.java') && full.includes(`${path.sep}controller${path.sep}`)) {
      collected.push(full);
    }
  }
  return collected;
}

test('解析器金丝雀：能从合成样本里抓到代理前缀与控制器前缀', () => {
  const synthetic = 'const API_PREFIXES = [\n  \'/a\',\n  \'/instruction\',\n] as const';
  assert.deepEqual(parseProxyPrefixes(synthetic), ['/a', '/instruction']);
  assert.equal(parseControllerPrefix('@RequestMapping({"/instruction"})\npublic class X {}'), '/instruction');
  assert.equal(parseControllerPrefix('@RequestMapping("/a")\n@RestController\npublic class Y {}\n'), '/a');
  // 只有方法级 Mapping 的类没有前缀可判，必须返回 null 而不是瞎猜。
  assert.equal(parseControllerPrefix('@RestController\npublic class Z {\n @GetMapping("/x")\n}\n'), null);
});

test('判定函数金丝雀：漏掉前缀时必须报出来', () => {
  assert.deepEqual(missingPrefixes(['/instruction', '/session'], ['/session']), ['/instruction']);
  assert.deepEqual(missingPrefixes(['/session'], ['/session', '/instruction']), []);
});

test('后端每个 Controller 前缀都被 dev server 代理覆盖', () => {
  const proxyPrefixes = parseProxyPrefixes(fs.readFileSync(viteConfigPath, 'utf8'));
  assert.ok(proxyPrefixes.length > 10, `代理前缀清单异常: ${proxyPrefixes.join(',')}`);

  const controllers = collectJavaFiles(backendJavaRoot);
  assert.ok(controllers.length > 10, `没找到后端 Controller，扫描可能失效: ${controllers.length}`);

  const backendPrefixes = controllers
    .map(file => parseControllerPrefix(fs.readFileSync(file, 'utf8')))
    .filter((prefix): prefix is string => prefix != null);
  assert.ok(backendPrefixes.length > 10, `解析出的 Controller 前缀异常: ${backendPrefixes.join(',')}`);

  assert.deepEqual(missingPrefixes(backendPrefixes, proxyPrefixes), [],
    'dev server 缺这些前缀的代理：vite 会回 index.html（状态码 200），前端只会拿到空数据');
});
