import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveMaven, runMaven } from './maven-runtime.mjs';

const definitions = {
  harness: { property: 'lingxi-starter', artifact: 'lingXi-harness-agent' },
  ddd: { property: 'ddd-starter', artifact: 'dev-framework-ddd-helper' },
};

function readField(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = xml.match(new RegExp(`<${escaped}>\\s*([^<]+?)\\s*</${escaped}>`))?.[1];
  if (!value) throw new Error(`POM 缺少 ${name}`);
  return value;
}

export function readFrameworkLock(repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'framework-deps.lock.json'), 'utf8'));
  if (lock.schemaVersion !== 1 || !lock.frameworks || Object.keys(lock.frameworks).sort().join(',') !== 'ddd,harness') {
    throw new Error('框架锁定文件格式不正确，必须包含 harness 和 ddd');
  }
  const business = fs.readFileSync(path.join(repoRoot, 'pom.xml'), 'utf8');
  for (const [id, entry] of Object.entries(lock.frameworks)) {
    if (!/^[\w-]+\/[\w.-]+$/.test(entry.repository) || !/^[a-f0-9]{40}$/.test(entry.ref) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version)) {
      throw new Error(`框架锁定项不正确: framework=${id}，仓库、完整 commit SHA 和版本均不能为空`);
    }
    const version = readField(business, definitions[id].property);
    if (version !== entry.version) throw new Error(`框架版本与业务 POM 不一致: framework=${id}, lock=${entry.version}, pom=${version}`);
  }
  return lock;
}

function git(args, cwd, allowFailure = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error(`框架源码操作失败: ${(result.error?.message || result.stderr).trim()}`);
  }
  return result;
}

export function checkoutFramework(repoRoot, id, entry, options = {}) {
  const directory = path.join(repoRoot, '.run/frameworks', `${id}-${entry.ref}`);
  const remote = options.remote ?? `https://github.com/${entry.repository}.git`;
  if (!fs.existsSync(path.join(directory, '.git'))) {
    if (options.offline) throw new Error(`离线模式缺少锁定源码: framework=${id}, ref=${entry.ref}`);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.readdirSync(directory).length) throw new Error(`框架源码目录非空，请检查: ${directory}`);
    git(['init', directory], repoRoot);
    git(['remote', 'add', 'origin', remote], directory);
  }
  if (git(['remote', 'get-url', 'origin'], directory).stdout.trim() !== remote) throw new Error(`框架源码仓库不匹配: framework=${id}`);
  const head = git(['rev-parse', '--verify', 'HEAD'], directory, true);
  if (head.status !== 0) {
    if (options.offline) throw new Error(`离线模式缺少锁定提交: framework=${id}`);
    git(['fetch', '--depth=1', 'origin', entry.ref], directory);
    git(['checkout', '--detach', 'FETCH_HEAD'], directory);
  }
  if (git(['rev-parse', 'HEAD'], directory).stdout.trim() !== entry.ref) throw new Error(`框架源码提交不匹配: framework=${id}`);
  if (git(['status', '--porcelain', '--untracked-files=normal'], directory).stdout.trim()) throw new Error(`锁定框架源码存在本地修改，请另行保存: ${directory}`);
  validateFrameworkSource(directory, id, entry.version);
  return directory;
}

export function validateFrameworkSource(directory, id, version) {
  const pom = fs.readFileSync(path.join(directory, 'pom.xml'), 'utf8');
  const header = pom.split('<dependencies>')[0];
  if (readField(header, 'groupId') !== 'io.github.yesnonononononi' || readField(header, 'artifactId') !== definitions[id].artifact) throw new Error(`框架 Maven 坐标不正确: framework=${id}`);
  if (readField(header, 'version') !== version) throw new Error(`锁定提交的源码版本不正确: framework=${id}, expected=${version}, actual=${readField(header, 'version')}`);
  if (id === 'harness') {
    if (readField(pom, 'lingxi-harness.version') !== version) throw new Error('Harness 模块依赖版本与锁定版本不一致');
    for (const match of pom.matchAll(/<module>\s*([^<]+)\s*<\/module>/g)) {
      const module = match[1].trim();
      if (!/^[\w-]+$/.test(module)) throw new Error('Harness 模块路径不正确');
      const modulePom = fs.readFileSync(path.join(directory, module, 'pom.xml'), 'utf8');
      const parent = modulePom.match(/<parent>([\s\S]*?)<\/parent>/)?.[1] ?? '';
      if (readField(parent, 'version') !== version) throw new Error(`Harness 子模块版本不一致: module=${module}`);
    }
  }
}

export function prepareFrameworks(repoRoot, maven, options = {}) {
  const lock = readFrameworkLock(repoRoot);
  const fingerprint = createHash('sha256').update(JSON.stringify(lock)).digest('hex').slice(0, 16);
  const repository = path.join(repoRoot, '.run/maven', fingerprint);
  const sources = Object.entries(lock.frameworks).map(([id, entry]) => ({ id, entry, directory: (options.checkout ?? checkoutFramework)(repoRoot, id, entry, options) }));
  fs.mkdirSync(repository, { recursive: true });
  for (const source of sources) {
    console.log(`准备锁定框架: framework=${source.id}, version=${source.entry.version}, ref=${source.entry.ref}`);
    (options.runMaven ?? runMaven)(maven, ['-B', '-ntp', ...(options.offline ? ['-o'] : []), `-Dmaven.repo.local=${repository}`, '-f', path.join(source.directory, 'pom.xml'), '-Dgpg.skip=true', '-Dmaven.javadoc.skip=true', 'clean', 'install'], repoRoot);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = sources.map(({ id, entry }) => `| ${id} | ${entry.version} | ${entry.ref} |`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### 框架源码来源\n\n| 框架 | 版本 | commit |\n|---|---|---|\n${rows}\n`);
  }
  return repository;
}

export function updateFrameworkLock(repoRoot, id, ref, options = {}) {
  if (!definitions[id] || !/^[a-f0-9]{40}$/.test(ref ?? '')) throw new Error('用法: framework:lock -- harness|ddd <完整 commit SHA>');
  const lock = readFrameworkLock(repoRoot);
  const entry = { ...lock.frameworks[id], ref };
  (options.checkout ?? checkoutFramework)(repoRoot, id, entry, options);
  lock.frameworks[id] = entry;
  fs.writeFileSync(path.join(repoRoot, 'framework-deps.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log(`更新框架锁定: framework=${id}, version=${entry.version}, ref=${ref}`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(path.dirname(scriptPath), '../..');
  try {
    const [action, id, ref] = process.argv.slice(2);
    if (action === 'lock') updateFrameworkLock(repoRoot, id, ref);
    else if (action === 'prepare') console.log(`框架 Maven 仓库: ${prepareFrameworks(repoRoot, resolveMaven(repoRoot), { offline: process.argv.includes('--offline') })}`);
    else throw new Error('用法: framework-deps.mjs prepare [--offline] | lock harness|ddd <完整 commit SHA>');
  } catch (error) {
    console.error(`框架依赖准备失败: ${error.message}`);
    process.exitCode = 1;
  }
}
