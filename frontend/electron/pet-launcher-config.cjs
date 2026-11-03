'use strict';
/**
 * 桌宠启动器的**纯配置解析**（不 require electron，可在 node 里直接单测）。
 *
 * <p><b>为什么要单独一层：</b>启动器原本在仓外（`.lingxi/tools/pet-launcher.cjs`），
 * 里面有三处 `D:/Code/LingXi/...` 硬编码绝对路径，还有一份自己猜的端口。换机器、换用户名、
 * 换 worktree 目录全部失效，而且 CI 完全验不到（文件不在仓库里）。</p>
 *
 * <p>现在把"路径怎么解析、origin 取哪里"这些可以出错的东西搬进仓库并做成纯函数：
 * Electron 无法在单测里跑，但这一层可以。真正的窗口/托盘逻辑留在
 * `electron/pet-launcher.cjs`，它只负责调用本模块。</p>
 *
 * <p><b>端口与入口页的唯一真源</b>是 `electron/pet-dev-endpoint.cjs`：本模块只做
 * "取真源 + 允许排障覆盖 + 非法值回退"，绝不写死端口或页名
 * （`tests/petDevEndpoint.test.cjs` 的单一真源扫描会检查这里）。</p>
 *
 * @module electron/pet-launcher-config
 */

const path = require('node:path');

const { DEV_ENDPOINT, buildDevOrigin } = require('./pet-dev-endpoint.cjs');

/** 允许的协议（排障用的 ELECTRON_URL 覆盖）。 */
const ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);
/** 覆盖地址的环境变量名。 */
const ENV_ENTRY_URL = 'ELECTRON_URL';
/** 覆盖 userData 的环境变量名。 */
const ENV_USER_DATA = 'PET_USER_DATA';
/** 运行时产物目录（相对仓库根）：不进源码树。 */
const TMP_DIR_SEGMENTS = Object.freeze(['.lingxi', 'tmp']);
/** 默认 userData 目录名。 */
const DEFAULT_USER_DATA_NAME = 'pet-preview-userdata';

/**
 * 从启动器所在目录解析出前端根、仓库根与默认 userData。
 *
 * @param {string} dirname 启动器所在目录（`frontend/electron`）
 * @returns {{frontendRoot: string, repoRoot: string, userDataDir: string}} 解析结果
 * @throws {TypeError} `dirname` 不是非空字符串时抛出
 */
function resolveLauncherPaths(dirname) {
  if (typeof dirname !== 'string' || dirname.trim().length === 0) {
    throw new TypeError('resolveLauncherPaths：dirname 必须是非空字符串');
  }
  const frontendRoot = path.resolve(dirname, '..');
  const repoRoot = path.resolve(frontendRoot, '..');
  const userDataDir = path.join(repoRoot, ...TMP_DIR_SEGMENTS, DEFAULT_USER_DATA_NAME);
  return { frontendRoot, repoRoot, userDataDir };
}

/**
 * 解析窗口入口 origin：默认取单一真源，允许排障覆盖。
 *
 * @param {unknown} raw 原始覆盖值（通常来自 `process.env.ELECTRON_URL`）
 * @returns {{origin: string, source: 'single-source'|'env', note: string}} 解析结果
 */
function resolveLauncherOrigin(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return { origin: buildDevOrigin(), source: 'single-source', note: '' };
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch (err) {
    return {
      origin: buildDevOrigin(),
      source: 'single-source',
      note: `${ENV_ENTRY_URL} 不是合法 URL（原值="${text}"），已回退到 ${buildDevOrigin()}`,
    };
  }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return {
      origin: buildDevOrigin(),
      source: 'single-source',
      note: `${ENV_ENTRY_URL} 协议不受支持（${parsed.protocol}），已回退到 ${buildDevOrigin()}`,
    };
  }
  return { origin: text.replace(/\/+$/, ''), source: 'env', note: '' };
}

/**
 * 一次性解析启动器需要的全部配置。
 *
 * @param {{dirname: string, env?: Record<string, string|undefined>}} input 入参
 * @returns {{frontendRoot: string, repoRoot: string, userDataDir: string,
 *   origin: string, originSource: 'single-source'|'env', entryUrl: string,
 *   entryPage: string, notes: string[]}} 配置
 * @throws {TypeError} `dirname` 非法时抛出（由 {@link resolveLauncherPaths} 抛出）
 */
function resolveLauncherConfig(input) {
  const options = input || {};
  const env = options.env || {};
  const paths = resolveLauncherPaths(options.dirname);
  const resolvedOrigin = resolveLauncherOrigin(env[ENV_ENTRY_URL]);
  const configuredUserData = typeof env[ENV_USER_DATA] === 'string' ? env[ENV_USER_DATA].trim() : '';
  const userDataDir = configuredUserData.length > 0 ? path.resolve(configuredUserData) : paths.userDataDir;
  const entryPage = DEV_ENDPOINT.entryPage;
  const notes = [];
  if (resolvedOrigin.note) notes.push(resolvedOrigin.note);
  return {
    frontendRoot: paths.frontendRoot,
    repoRoot: paths.repoRoot,
    userDataDir,
    origin: resolvedOrigin.origin,
    originSource: resolvedOrigin.source,
    entryUrl: `${resolvedOrigin.origin}/${entryPage}`,
    entryPage,
    notes,
  };
}

module.exports = {
  ALLOWED_PROTOCOLS,
  DEFAULT_USER_DATA_NAME,
  ENV_ENTRY_URL,
  ENV_USER_DATA,
  resolveLauncherConfig,
  resolveLauncherOrigin,
  resolveLauncherPaths,
};
