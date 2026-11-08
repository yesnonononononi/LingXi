#!/usr/bin/env node
/**
 * 框架锁文件体检（framework lock doctor）—— 「本地漂移 + 远端可达」哨兵。
 *
 * <p><b>为什么需要这个脚本</b>：`framework-deps.lock.json` 是业务仓与框架仓之间的唯一约定，
 * 但它有两个只在「出事时」才暴露的失效方向：</p>
 * <ol>
 *   <li><b>本地漂移</b>：本机编译用的框架是 `HEAD`（或某个手工检出的提交），而锁文件写的是另一个 ——
 *       结果就是「只有我这台机器能编译」，且会持续跨特性存在而无人察觉（CI 只验锁文件自身的自洽）。</li>
 *   <li><b>远端不可达</b>：锁文件指向一个<b>还没推送</b>的本地提交。CI 会在 `backend:verify` 深处
 *       克隆时失败，报错埋在 git 输出里，看不出根因是「这一行锁写早了」。</li>
 * </ol>
 *
 * <p>本脚本用两组可独立开关的检查分别覆盖它们：</p>
 * <ul>
 *   <li><b>本地漂移检查</b>（默认开启，给开发者用）：读锁文件 → 解析每个框架的本地仓 → 比对
 *       （a）ref 本地是否存在（b）ref 是否已在远端跟踪分支上（c）HEAD 与 ref 的关系。
 *       本地没有对应框架仓时 <b>SKIP 而非 FAIL</b>：CI 机器上本来就没有这些仓。</li>
 *   <li><b>远端可达性检查</b>（`--remote`，给 CI 用）：临时目录 `git init` + `git fetch --depth=1 <url> <ref>`，
 *       失败即 FAIL —— 这是「锁指向的 commit 根本拉不到」的硬门禁。临时目录无论如何都会清理。</li>
 * </ul>
 *
 * <p><b>退出码</b>：有 FAIL → 1；只有 WARN/SKIP → 0；`--strict` 时 WARN 也算 1（给 pre-push 用）。</p>
 *
 * <p><b>可测性约定</b>：判定与文案全部是<b>纯函数</b>（{@link parseFrameworkLock} /
 * {@link classifyLocalProbe} / {@link classifyRemoteProbe} / {@link summarizeResults} /
 * {@link resolveExitCode} / {@link formatReport}），`git`、`fs`、临时目录等副作用集中在
 * {@link main} 的 `deps` 注入点上 —— 单测只喂假实现，不碰网络、不碰真实 git 仓。</p>
 *
 * <p>本脚本<b>只读</b>：不修改 `framework-deps.lock.json`（锁定动作属于发版流
 * `npm run framework:lock`），也不写任何工作树内文件。</p>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** 检查结果状态。 */
export const STATUS = Object.freeze({
  /** 一致 / 可达。 */
  OK: 'OK',
  /** 能继续，但该处理（本地框架比锁文件新）。 */
  WARN: 'WARN',
  /** 必须处理（锁定的提交不可用 / 不可达）。 */
  FAIL: 'FAIL',
  /** 本机不适用（没有该框架仓），不算失败。 */
  SKIP: 'SKIP',
});

/** 锁文件名（固定位于仓库根）。 */
export const LOCK_FILE_NAME = 'framework-deps.lock.json';

/**
 * 本地框架仓的内置默认路径。
 *
 * <p>只覆盖当前团队的两台约定位置；其它机器请用环境变量
 * `LINGXI_FRAMEWORK_<ID大写下划线>`（如 `LINGXI_FRAMEWORK_HARNESS`）覆盖，
 * 未命中默认表且没有环境变量时按 SKIP 处理（CI 上就是这种情况）。</p>
 */
export const DEFAULT_FRAMEWORK_PATHS = Object.freeze({
  harness: 'D:/code/starter/lingxi-harness-agent',
  ddd: 'D:/code/starter/dev-framework-ddd-starter',
});

/** GitHub 仓库 slug（`owner/repo`）→ 可 clone 的 URL。 */
const remoteUrlOf = (repository) => `https://github.com/${repository}.git`;

/** 取 ref 的短形式用于文案（完整 40 位放在括号外的说明里太占地）。 */
const shortRef = (ref) => (typeof ref === 'string' ? ref.slice(0, 8) : String(ref));

/** 状态的中文标签（表格与总判定用）。 */
const STATUS_LABEL = Object.freeze({
  OK: '一致',
  WARN: '警告',
  FAIL: '失败',
  SKIP: '跳过',
});

/* ------------------------------------------------------------------ */
/* 纯函数：锁文件解析                                                  */
/* ------------------------------------------------------------------ */

/**
 * 解析并校验框架锁文件。
 *
 * <p>校验口径与 `framework-deps.mjs` 的 `readFrameworkLock` 保持一致（schemaVersion=1、
 * 每个条目 repository / 完整 40 位 commit / 版本号均合法），但<b>不要求</b>框架集合恰好是
 * `harness + ddd`：体检脚本的职责是「漂移与可达性」，条目集合的强约束属于 `framework:lock` /
 * `build-backend`（它们已经在 CI 里跑）。这样将来新增框架时，体检脚本不会成为新的阻塞点。</p>
 *
 * @param {string|object} input 锁文件文本，或已解析的对象
 * @returns {{schemaVersion: number, frameworks: Array<{id: string, repository: string, ref: string, version: string}>}}
 * @throws {Error} 文本非法 JSON、结构不符、或任一条目字段不合法
 */
export function parseFrameworkLock(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      throw new Error(`框架锁定文件不是合法 JSON: ${error.message}`);
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('框架锁定文件格式不正确：顶层必须是对象');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`框架锁定文件版本不支持: schemaVersion=${String(raw.schemaVersion)}，期望 1`);
  }
  const frameworks = raw.frameworks;
  if (frameworks === null || typeof frameworks !== 'object' || Array.isArray(frameworks)) {
    throw new Error('框架锁定文件格式不正确：缺少 frameworks 对象');
  }
  const ids = Object.keys(frameworks);
  if (ids.length === 0) throw new Error('框架锁定文件格式不正确：frameworks 为空');
  const parsed = [];
  for (const id of ids) {
    const entry = frameworks[id];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`框架锁定项不正确: framework=${id}，条目必须是对象`);
    }
    const {repository, ref, version} = entry;
    if (typeof repository !== 'string' || !/^[\w-]+\/[\w.-]+$/.test(repository)) {
      throw new Error(`框架锁定项不正确: framework=${id}，repository 必须形如 owner/repo`);
    }
    if (typeof ref !== 'string' || !/^[a-f0-9]{40}$/.test(ref)) {
      throw new Error(`框架锁定项不正确: framework=${id}，ref 必须是完整的 40 位 commit SHA`);
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
      throw new Error(`框架锁定项不正确: framework=${id}，version 必须形如 1.2.3 或 1.2.3-SNAPSHOT`);
    }
    parsed.push({id, repository, ref, version});
  }
  return {schemaVersion: 1, frameworks: parsed};
}

/**
 * 解析某框架的本地仓路径。
 *
 * <p>优先级：环境变量 `LINGXI_FRAMEWORK_<ID大写下划线>` → 内置默认表 → `null`（本机没有该仓，
 * 调用方据此 SKIP，<b>不要</b>转成 FAIL：CI 上没有这些仓）。</p>
 *
 * @param {string} id 框架 id（如 `harness`）
 * @param {Record<string, string|undefined>} env 环境变量表（默认 `process.env`，测试可注入）
 * @returns {string|null} 本地仓绝对/相对路径；未知且无默认值时返回 null
 */
export function resolveFrameworkPath(id, env = process.env) {
  if (typeof id !== 'string' || id.trim() === '') return null;
  const envKey = `LINGXI_FRAMEWORK_${id.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const fromEnv = env?.[envKey];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const fallback = DEFAULT_FRAMEWORK_PATHS[id.trim()];
  return typeof fallback === 'string' && fallback !== '' ? fallback : null;
}

/* ------------------------------------------------------------------ */
/* 纯函数：判定与文案                                                  */
/* ------------------------------------------------------------------ */

/**
 * 根据本地探测结果判定该框架的本地漂移状态并生成中文说明。
 *
 * <p>探测结果由薄壳（{@link probeLocalFramework}）填好，本函数只做判定与措辞 ——
 * 这样「什么算 WARN、什么算 FAIL、文案怎么写」可以在单测里穷举，不必造真实 git 仓。</p>
 *
 * @param {{id: string, ref: string, refPresent: boolean, remoteContains: boolean,
 *   fetchOk?: boolean,
 *   head: string|null, refIsAncestorOfHead: boolean, headIsAncestorOfRef: boolean,
 *   commitsAhead: number|null}} probe 探测结果
 * @returns {{id: string, scope: string, status: string, message: string}}
 */
export function classifyLocalProbe(probe) {
  const {id, ref, refPresent, remoteContains, head} = probe;
  const base = {id, scope: '本地'};
  if (!refPresent) {
    return {...base, status: STATUS.FAIL,
      message: `锁定的 commit ${shortRef(ref)} 本地不存在：先 git fetch，或核对锁文件是否写错 ref`};
  }
  if (!remoteContains) {
    return {...base, status: STATUS.FAIL,
      message: `锁定向未推送的 commit ${shortRef(ref)}：别人 clone 拉不到，先 push 再重新锁定`};
  }
  if (probe.fetchOk === false) {
    // 查到了「包含」，但这次没能刷新远端引用 —— 那个结论可能来自陈旧引用，
    // 不足以支撑「已推送」。宁可报 WARN 说清不确定性，也不要给出假的安心。
    return {...base, status: STATUS.WARN,
      message: `已推送状态无法确认（git fetch 失败，远端跟踪分支可能已陈旧）：${shortRef(ref)}；联网后重跑本检查，或用 --remote 权威核对`};
  }
  if (!head) {
    return {...base, status: STATUS.FAIL,
      message: '本地框架仓没有可用 HEAD（空仓？）：无法比对漂移，先在框架仓检出分支'};
  }
  if (head === ref) {
    return {...base, status: STATUS.OK, message: `本地框架与锁文件一致（${shortRef(ref)}）`};
  }
  if (probe.refIsAncestorOfHead) {
    const ahead = Number.isInteger(probe.commitsAhead) && probe.commitsAhead >= 0 ? probe.commitsAhead : null;
    const howMany = ahead === null ? '若干' : String(ahead);
    return {...base, status: STATUS.WARN,
      message: `本地框架比锁文件新 ${howMany} 个提交（HEAD=${shortRef(head)}，锁=${shortRef(ref)}）：改完记得 npm run framework:lock 并推送`};
  }
  if (probe.headIsAncestorOfRef) {
    return {...base, status: STATUS.FAIL,
      message: `本地框架落后于锁文件（HEAD=${shortRef(head)}，锁=${shortRef(ref)}）：先 git pull 到锁定提交`};
  }
  return {...base, status: STATUS.FAIL,
    message: `本地框架与锁文件无共同祖先（HEAD=${shortRef(head)}，锁=${shortRef(ref)}）：历史可能被改写，核对仓库来源`};
}

/**
 * 远端可达性判定。
 *
 * @param {{id: string, ref: string, repository: string, fetched: boolean, detail?: string|null}} probe
 * @returns {{id: string, scope: string, status: string, message: string}}
 */
export function classifyRemoteProbe(probe) {
  const base = {id: probe.id, scope: '远端'};
  const url = remoteUrlOf(probe.repository);
  if (probe.fetched) {
    return {...base, status: STATUS.OK, message: `远端可达：${shortRef(probe.ref)} 可从 ${probe.repository} 拉取`};
  }
  const detail = typeof probe.detail === 'string' && probe.detail.trim() !== ''
    ? `（${probe.detail.trim().split(/\r?\n/)[0]}）`
    : '';
  return {...base, status: STATUS.FAIL,
    message: `锁定的 commit 远端拉不到：git fetch --depth=1 ${url} ${shortRef(probe.ref)} 失败${detail}；先 push 或重新锁定`};
}

/** 本机没有该框架仓时的 SKIP 结果（CI 上属正常）。 */
export function skipResult(id, scope, repoPath) {
  const where = repoPath ? `本地未发现框架仓: ${repoPath}` : '本地未发现框架仓（无环境变量、无内置默认路径）';
  return {id, scope, status: STATUS.SKIP, message: `${where}；CI 上属正常`};
}

/**
 * 汇总：状态计数 + 总判定。
 *
 * @param {Array<{status: string}>} results 各项检查结果
 * @returns {{counts: {OK: number, WARN: number, FAIL: number, SKIP: number}, verdict: 'PASS'|'WARN'|'FAIL'}}
 * @throws {Error} 出现未知状态（说明调用方传错了，宁可炸也不静默忽略）
 */
export function summarizeResults(results) {
  const counts = {OK: 0, WARN: 0, FAIL: 0, SKIP: 0};
  for (const result of Array.isArray(results) ? results : []) {
    const status = result?.status;
    if (!Object.prototype.hasOwnProperty.call(counts, status)) {
      throw new Error(`未知的检查状态: ${String(status)}`);
    }
    counts[status] += 1;
  }
  const verdict = counts.FAIL > 0 ? 'FAIL' : (counts.WARN > 0 ? 'WARN' : 'PASS');
  return {counts, verdict};
}

/**
 * 退出码规则：有 FAIL → 1；只有 WARN/SKIP → 0；`--strict` 时 WARN 也算 1。
 *
 * @param {{counts: {FAIL: number, WARN: number}}} summary {@link summarizeResults} 的结果
 * @param {{strict?: boolean}} [options] strict 模式（pre-push 用）
 * @returns {number} 0 或 1
 */
export function resolveExitCode(summary, options = {}) {
  const counts = summary?.counts ?? {FAIL: 0, WARN: 0};
  if (counts.FAIL > 0) return 1;
  if (options.strict === true && counts.WARN > 0) return 1;
  return 0;
}

/** 终端显示宽度：CJK 全角字符按 2 列算，否则表格会错位。 */
const displayWidth = (text) => {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
};

/** 按显示宽度右补空格。 */
const padDisplay = (text, width) => {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
};

/**
 * 输出中文表格化摘要（每框架每项一行：框架 / 检查 / 状态 / 说明），末行给总判定。
 *
 * @param {{results: Array<object>, summary: object, strict?: boolean, checks?: string[]}} input 报告内容
 * @returns {string} 可直接 console.log 的多行文本
 */
export function formatReport(input) {
  const results = Array.isArray(input?.results) ? input.results : [];
  const summary = input?.summary ?? summarizeResults(results);
  const strict = input?.strict === true;
  const checks = Array.isArray(input?.checks) && input.checks.length > 0 ? input.checks : ['本地'];
  const header = `框架锁文件体检（${checks.map((check) => (check === '本地' ? '本地漂移' : '远端可达性')).join(' + ')}）`;
  const idWidth = Math.max(displayWidth('框架'), ...results.map((row) => displayWidth(row.id)));
  const scopeWidth = Math.max(displayWidth('检查'), ...results.map((row) => displayWidth(row.scope)));
  const statusWidth = Math.max(displayWidth('状态'), ...results.map((row) => displayWidth(STATUS_LABEL[row.status] ?? row.status)));
  const lines = [header];
  if (results.length === 0) {
    lines.push('（没有任何检查项：锁文件为空？）');
  } else {
    lines.push([
      padDisplay('框架', idWidth),
      padDisplay('检查', scopeWidth),
      padDisplay('状态', statusWidth),
      '说明',
    ].join('  '));
    for (const row of results) {
      lines.push([
        padDisplay(row.id, idWidth),
        padDisplay(row.scope, scopeWidth),
        padDisplay(STATUS_LABEL[row.status] ?? row.status, statusWidth),
        row.message,
      ].join('  '));
    }
  }
  const {counts} = summary;
  lines.push(`合计：一致 ${counts.OK} / 警告 ${counts.WARN} / 失败 ${counts.FAIL} / 跳过 ${counts.SKIP}`);
  if (summary.verdict === 'FAIL') {
    lines.push('总判定：失败 —— 先修好上面的失败项（锁文件改由 npm run framework:lock 走发版流完成）');
  } else if (summary.verdict === 'WARN') {
    lines.push(strict
      ? '总判定：失败（--strict：警告按失败计）—— 本地框架已领先锁文件，跑完发版流再推送'
      : '总判定：通过（有警告）—— 加 --strict 会让警告变成失败');
  } else {
    lines.push('总判定：通过');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 薄壳：git / fs / 临时目录（这些是唯一有副作用的部分）                */
/* ------------------------------------------------------------------ */

/**
 * 默认 git 执行器：同步、非交互、永不等待凭据输入。
 *
 * @param {string[]} args git 参数（不含 `git` 本身）
 * @param {string} cwd 工作目录
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
export function createGitRunner(spawn = spawnSync) {
  return (args, cwd) => {
    const result = spawn('git', args, {
      cwd,
      encoding: 'utf8',
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'},
    });
    return {
      status: typeof result?.status === 'number' ? result.status : null,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : (result?.error?.message ?? ''),
    };
  };
}

/**
 * 探测一个框架的本地漂移（薄壳：只负责调 git 与拼 {@link classifyLocalProbe} 的入参）。
 *
 * @param {{id: string, ref: string}} entry 锁文件条目
 * @param {{repoPath: string, git: Function}} deps 本地仓路径与 git 执行器
 * @returns {{id: string, scope: string, status: string, message: string}}
 */
export function probeLocalFramework(entry, deps) {
  const {repoPath, git} = deps;
  const {ref} = entry;
  const run = (args) => git(args, repoPath);

  const refPresent = run(['cat-file', '-e', `${ref}^{commit}`]).status === 0;
  if (!refPresent) {
    // ref 都不在，后续探测没有意义：直接给出 FAIL，避免一串无意义的失败输出。
    return classifyLocalProbe({
      id: entry.id, ref, refPresent: false, remoteContains: false, head: null,
      refIsAncestorOfHead: false, headIsAncestorOfRef: false, commitsAhead: null,
    });
  }

  const containsOf = () => {
    const result = run(['branch', '-r', '--contains', ref]);
    return result.status === 0 && result.stdout.trim() !== '';
  };
  // 远端跟踪分支可能是滞后的，而且**两个方向都会错**：
  //   - 查到「不包含」时若不抓：把「其实已推送」误报成 FAIL；
  //   - 查到「包含」时若不抓：本地残留的旧引用仍可能包含该提交，于是把
  //     「根本没推送」误判成「已推送」（实测撞到过：锁定的 commit 远端三个分支
  //     全都不含它，本地哨兵却因为陈旧引用报了 WARN）。
  // 所以一律先抓一次再判，并把抓取是否成功带进判定：抓不动就不能宣称「已推送」。
  const fetchResult = run(['fetch', '--prune', 'origin']);
  const fetchOk = fetchResult.status === 0;
  const remoteContains = containsOf();

  const headResult = run(['rev-parse', 'HEAD']);
  const head = headResult.status === 0 ? headResult.stdout.trim() : '';
  const refIsAncestorOfHead = head !== '' && head !== ref
    && run(['merge-base', '--is-ancestor', ref, 'HEAD']).status === 0;
  const headIsAncestorOfRef = head !== '' && head !== ref
    && run(['merge-base', '--is-ancestor', 'HEAD', ref]).status === 0;
  let commitsAhead = null;
  if (refIsAncestorOfHead) {
    const countResult = run(['rev-list', '--count', `${ref}..HEAD`]);
    if (countResult.status === 0) {
      const parsed = Number.parseInt(countResult.stdout.trim(), 10);
      commitsAhead = Number.isInteger(parsed) ? parsed : null;
    }
  }

  return classifyLocalProbe({
    id: entry.id, ref, refPresent: true, remoteContains, fetchOk, head,
    refIsAncestorOfHead, headIsAncestorOfRef, commitsAhead,
  });
}

/**
 * 本地漂移检查（按锁文件顺序，逐框架一行）。
 *
 * @param {{entries: Array<object>, env?: object, exists: Function, git: Function}} deps 依赖
 * @returns {Array<object>} 每框架一条结果（OK/WARN/FAIL/SKIP）
 */
export function evaluateLocal(deps) {
  const {entries, env = process.env, exists, git} = deps;
  return entries.map((entry) => {
    const repoPath = resolveFrameworkPath(entry.id, env);
    if (!repoPath || !exists(repoPath)) return skipResult(entry.id, '本地', repoPath);
    try {
      return probeLocalFramework(entry, {repoPath, git});
    } catch (error) {
      return {id: entry.id, scope: '本地', status: STATUS.FAIL, message: `本地探测抛异常: ${error.message}`};
    }
  });
}

/**
 * 远端可达性检查：临时目录 `git init` + `git fetch --depth=1 <url> <ref>`。
 *
 * <p><b>临时目录在 finally 里删</b>：失败也要清理干净，绝不往工作树或系统临时区留垃圾。</p>
 *
 * @param {{entries: Array<object>, git: Function, makeTempDir: Function, removeTempDir: Function}} deps 依赖
 * @returns {Array<object>} 每框架一条结果（OK/FAIL）
 */
export function evaluateRemote(deps) {
  const {entries, git, makeTempDir, removeTempDir} = deps;
  return entries.map((entry) => {
    let directory = null;
    try {
      directory = makeTempDir(entry.id);
      const init = git(['init'], directory);
      if (init.status !== 0) {
        return classifyRemoteProbe({
          id: entry.id, ref: entry.ref, repository: entry.repository, fetched: false,
          detail: `临时仓库初始化失败 ${init.stderr}`,
        });
      }
      const fetched = git(['fetch', '--depth=1', remoteUrlOf(entry.repository), entry.ref], directory);
      return classifyRemoteProbe({
        id: entry.id, ref: entry.ref, repository: entry.repository,
        fetched: fetched.status === 0,
        detail: fetched.status === 0 ? null : (fetched.stderr || fetched.stdout),
      });
    } catch (error) {
      return classifyRemoteProbe({
        id: entry.id, ref: entry.ref, repository: entry.repository, fetched: false,
        detail: error.message,
      });
    } finally {
      if (directory) {
        try {
          removeTempDir(directory);
        } catch {
          // 清理失败不应改变判定结论：结果已经算出来了，安静收尾即可。
        }
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = [
  '用法: node scripts/framework-lock-doctor.mjs [--remote] [--strict] [--no-local] [--help]',
  '',
  '  （默认）      本地漂移检查：每个框架的本地仓是否与锁文件一致',
  '  --remote     额外做远端可达性检查（CI 用）：锁定的 commit 能否从 GitHub 拉取',
  '  --strict     警告（WARN）也按失败计（pre-push 用）',
  '  --no-local   只做远端检查（配合 --remote）',
  '  --help       显示本帮助',
  '',
  '环境变量: LINGXI_FRAMEWORK_<ID大写下划线> 指定本地框架仓路径（如 LINGXI_FRAMEWORK_HARNESS）',
].join('\n');

/**
 * 解析命令行参数（纯函数）。
 *
 * @param {string[]} argv 参数列表（不含 node 与脚本路径）
 * @returns {{local: boolean, remote: boolean, strict: boolean, help: boolean}}
 * @throws {Error} 出现未知参数（拼错的开关不该静默失效）
 */
export function parseArgs(argv) {
  const options = {local: true, remote: false, strict: false, help: false};
  for (const raw of Array.isArray(argv) ? argv : []) {
    const arg = String(raw);
    if (arg === '--remote') options.remote = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--no-local') options.local = false;
    else if (arg === '--local') options.local = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}\n${USAGE}`);
  }
  return options;
}

/**
 * 默认依赖：真实 fs / git / 临时目录。测试全部注入替身，不会走到这里。
 *
 * @param {string} repoRoot 仓库根
 * @returns {object} deps
 */
function defaultDeps(repoRoot) {
  return {
    repoRoot,
    env: process.env,
    exists: (target) => fs.existsSync(target),
    readFile: (target) => fs.readFileSync(target, 'utf8'),
    git: createGitRunner(),
    makeTempDir: (id) => fs.mkdtempSync(path.join(os.tmpdir(), `lingxi-lock-doctor-${id}-`)),
    removeTempDir: (directory) => fs.rmSync(directory, {recursive: true, force: true}),
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  };
}

/**
 * 主流程（副作用集中在这里，全部可注入）。
 *
 * @param {string[]} [argv] 命令行参数
 * @param {object} [overrides] 依赖覆盖（测试用）
 * @returns {number} 退出码：0 通过 / 1 失败
 */
export function main(argv = process.argv.slice(2), overrides = {}) {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRootGuess = overrides.repoRoot ?? path.resolve(path.dirname(scriptPath), '../..');
  const deps = {...defaultDeps(repoRootGuess), ...overrides};
  const {out, err} = deps;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(error.message);
    return 1;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (!options.local && !options.remote) {
    err('没有任何启用的检查：--no-local 需要同时给 --remote');
    return 1;
  }

  let lock;
  try {
    lock = parseFrameworkLock(deps.readFile(path.join(deps.repoRoot, LOCK_FILE_NAME)));
  } catch (error) {
    err(`框架锁文件体检失败: ${error.message}`);
    return 1;
  }

  const results = [];
  const checks = [];
  if (options.local) {
    checks.push('本地');
    results.push(...evaluateLocal({entries: lock.frameworks, env: deps.env, exists: deps.exists, git: deps.git}));
  }
  if (options.remote) {
    checks.push('远端');
    results.push(...evaluateRemote({
      entries: lock.frameworks, git: deps.git,
      makeTempDir: deps.makeTempDir, removeTempDir: deps.removeTempDir,
    }));
  }

  let summary;
  try {
    summary = summarizeResults(results);
  } catch (error) {
    err(`框架锁文件体检失败: ${error.message}`);
    return 1;
  }
  const exitCode = resolveExitCode(summary, {strict: options.strict});
  out(formatReport({results, summary, strict: options.strict, checks}));
  return exitCode;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main(process.argv.slice(2));
}
