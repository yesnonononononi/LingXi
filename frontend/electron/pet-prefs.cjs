/**
 * M3 S1 · 偏好持久化（schema v1 + **逐字段降级** + **原子写**）：纯逻辑，可注入 `fs`。
 *
 * <p><b>这个文件守的两件事：</b></p>
 * <ol>
 *   <li><b>坏文件不许炸启动</b>：需求方明确"偏好丢失不该阻塞启动"，所以读路径**永不抛**——
 *       文件缺失 / JSON 坏 / 版本不识别 / 字段类型错，一律**逐字段**降级到默认值并把原因
 *       收进 `problems[]`（不是"整文件回默认"：`follow` 缺失时 `roam: true` 必须还在）；</li>
 *   <li><b>写一半不许留半个文件</b>：写 `<file>.tmp` → `renameSync` 覆盖。断电/崩溃发生在
 *       写临时文件阶段时，真正生效的旧文件仍然完整（下次启动读到的是"上一版偏好"，
 *       而不是"半截 JSON"⇒ 又触发一次降级）。</li>
 * </ol>
 *
 * <p><b>路径由调用方注入</b>（本模块**不**自己拼 `app.getPath('userData')`）：
 * 主进程用 `path.join(app.getPath('userData'), 'pet-prefs.json')`，测试用临时目录。
 * 这样这个模块在 node 里可独立单测，不需要 Electron。</p>
 *
 * <p><b>与位置文件完全独立</b>（设计 §9.2 最后一行）：`pet-window-state.json` 坏掉只影响
 * 下次落点，本文件坏掉只影响两个开关的默认值，互不连坐。</p>
 *
 * <p><b>U-M4 的落点：</b>`prefers-reduced-motion` 时**默认**关掉 `roam` 与 `follow`
 * （`defaultPrefs({ prefersReducedMotion: true })`），但**不静默改写用户选择**——
 * 只影响"首次生成默认值"这一段，用户手动勾选照样能开（S2 接线时只调这个默认值函数）。</p>
 *
 * @module electron/pet-prefs
 */

'use strict';

const nodeFs = require('node:fs');

/** 当前 schema 版本（v1）。 */
const PREFS_VERSION = 1;

/**
 * 出厂默认值（设计 §9.1 + 主理人裁决 U-M2）。
 *
 * <p>`roam: true` 是**产品裁决**：桌宠不动就等于没做 M3；`follow: false` 是"不打扰用户"。</p>
 */
const DEFAULT_PREFS = Object.freeze({ version: PREFS_VERSION, follow: false, roam: true });

/** 文件里**允许**存在的字段（白名单：未知字段一律不落盘，前向兼容时静默忽略）。 */
const KNOWN_FIELDS = Object.freeze(['version', 'follow', 'roam', 'updatedAt']);

/**
 * `problems[]` 里的原因码（**机器可读**；文案给人看）。
 *
 * <p>用原因码而不是纯中文句子的理由：门禁与单测要断言"降级的原因对不对"，
 * 断言中文句子会在改文案时假红；断言码则稳定。</p>
 */
const PREF_PROBLEMS = Object.freeze({
  MISSING_FILE: 'prefs-missing-file',
  BAD_JSON: 'prefs-bad-json',
  BAD_ROOT: 'prefs-bad-root',
  UNKNOWN_VERSION: 'prefs-unknown-version',
  NEWER_VERSION: 'prefs-newer-version',
  BAD_FIELD: 'prefs-bad-field',
  CORRUPT_RENAMED: 'prefs-corrupt-renamed',
  WRITE_FAILED: 'prefs-write-failed',
  BAD_INPUT: 'prefs-bad-input',
  /** 系统偏好探针不可用（信息码：不是失败，只说明"没做任何降级覆盖"）。 */
  MOTION_PROBE_UNAVAILABLE: 'prefs-reduced-motion-unavailable',
  /** 首次无偏好文件且系统要求减少动态效果（信息码：默认关掉两个开关，仍可手动开启）。 */
  REDUCED_MOTION_DEFAULTS: 'prefs-reduced-motion-defaults',
});

/**
 * 生成默认偏好（唯一入口；U-M4 的 reduced-motion 降级落在这里）。
 *
 * @param {{prefersReducedMotion?: boolean}} [options] 选项
 * @returns {{version: number, follow: boolean, roam: boolean}} 默认偏好（新对象，可安全改）
 */
function defaultPrefs(options = {}) {
  const prefersReducedMotion = options && options.prefersReducedMotion === true;
  return {
    version: PREFS_VERSION,
    follow: false,
    // U-M4：系统要求"减少动态效果"时默认不漫游（但仍可被菜单手动开启，不是永久禁用）
    roam: prefersReducedMotion ? false : DEFAULT_PREFS.roam,
  };
}

/**
 * 把任意读到的对象**逐字段**归一成合法 `PetPrefs`（纯函数，不碰文件）。
 *
 * <p>降级表（逐条对应设计 §9.2 与门禁 G-M10）：</p>
 * <ul>
 *   <li>根不是对象（`null` / 字符串 / 数组）⇒ 全默认 + `prefs-bad-root`；</li>
 *   <li>`version` 缺失 ⇒ 视作 1（前向兼容的最小假设，不报问题）；</li>
 *   <li>`version` 是整数且 &gt; 1 ⇒ 只读已知字段、`writable:false`（**不许**旧版程序把新版
 *       字段抹掉）+ `prefs-newer-version`；</li>
 *   <li>`version` 是其它值（0 / 负数 / 小数 / 字符串）⇒ 视作 1 + `prefs-unknown-version`；</li>
 *   <li>`follow` / `roam` 不是布尔 ⇒ 该字段降级默认 + `prefs-bad-field:&lt;字段&gt;`（**其它字段照用**）；</li>
 *   <li>`updatedAt` 不是字符串 ⇒ 丢弃该字段 + `prefs-bad-field:updatedAt`（它只是排障信息）。</li>
 * </ul>
 *
 * @param {unknown} raw 从文件读到的值
 * @param {{defaults?: {version: number, follow: boolean, roam: boolean}}} [options] 选项
 * @returns {{prefs: {version: number, follow: boolean, roam: boolean, updatedAt?: string},
 *   problems: string[], status: 'ok'|'corrupt'|'newer', writable: boolean}} 归一结果
 */
function normalizePrefs(raw, options = {}) {
  const base = options && options.defaults ? options.defaults : defaultPrefs();
  const prefs = { version: base.version, follow: base.follow, roam: base.roam };
  const problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { prefs, problems: [PREF_PROBLEMS.BAD_ROOT], status: 'corrupt', writable: true };
  }
  const source = /** @type {Record<string, unknown>} */ (raw);
  let writable = true;
  let status = 'ok';
  const rawVersion = source.version;
  if (rawVersion !== undefined) {
    if (typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion > PREFS_VERSION) {
      // 版本更高：只读已知字段，且**不许回写**（回写会把新版的字段抹掉）
      writable = false;
      status = 'newer';
      problems.push(`${PREF_PROBLEMS.NEWER_VERSION}:${rawVersion}`);
    } else if (rawVersion !== PREFS_VERSION) {
      problems.push(`${PREF_PROBLEMS.UNKNOWN_VERSION}:${JSON.stringify(rawVersion)}`);
    }
  }
  for (const field of ['follow', 'roam']) {
    if (!(field in source)) continue;
    const value = source[field];
    if (typeof value === 'boolean') {
      prefs[field] = value;
      continue;
    }
    problems.push(`${PREF_PROBLEMS.BAD_FIELD}:${field}`);
  }
  if ('updatedAt' in source) {
    if (typeof source.updatedAt === 'string' && source.updatedAt.length > 0) {
      prefs.updatedAt = source.updatedAt;
    } else {
      problems.push(`${PREF_PROBLEMS.BAD_FIELD}:updatedAt`);
    }
  }
  return { prefs, problems, status, writable };
}

/**
 * 只挑**已知字段**组装"要落盘的对象"（未知字段绝不写进去）。
 *
 * @param {Record<string, unknown>} prefs 归一后的偏好
 * @returns {{version: number, follow: boolean, roam: boolean, updatedAt?: string}} 落盘载荷
 */
function toPersistedPrefs(prefs) {
  const payload = {
    version: PREFS_VERSION,
    follow: prefs.follow === true,
    roam: prefs.roam !== false,
  };
  if (typeof prefs.updatedAt === 'string' && prefs.updatedAt.length > 0) {
    payload.updatedAt = prefs.updatedAt;
  }
  return payload;
}

/**
 * 读偏好文件（**永不抛**）。
 *
 * @param {{filePath: string, fs?: object, defaults?: {version: number, follow: boolean, roam: boolean}}} options 选项
 *   `filePath` 由调用方注入（本模块不拼路径）；`fs` 缺省用 `node:fs`（测试可注入假 fs）
 * @returns {{prefs: object, problems: string[], status: 'ok'|'missing'|'corrupt'|'newer',
 *   writable: boolean, renamedCorrupt: boolean}} 读取结果
 * @throws {TypeError} 只对"调用方连路径都没给"这种编程错误抛（不是文件状态错误）
 */
function readPrefs(options) {
  if (options === null || typeof options !== 'object' || typeof options.filePath !== 'string' || options.filePath.length === 0) {
    throw new TypeError('[pet-prefs] readPrefs 需要 {filePath: string}（路径由调用方注入）');
  }
  const fs = options.fs || nodeFs;
  const defaults = options.defaults || defaultPrefs(options.defaultsOptions || {});
  const filePath = options.filePath;

  if (!fs.existsSync(filePath)) {
    return {
      prefs: { ...defaults },
      problems: [PREF_PROBLEMS.MISSING_FILE],
      status: 'missing',
      writable: true,
      renamedCorrupt: false,
    };
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // 读不动（权限/占用）：照默认值走，但**不**把文件当成"坏 JSON"改名（换台机器可能就好了）
    return {
      prefs: { ...defaults },
      problems: [`${PREF_PROBLEMS.WRITE_FAILED}:read:${error && error.code ? error.code : 'unknown'}`],
      status: 'corrupt',
      writable: true,
      renamedCorrupt: false,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 坏 JSON：全部走默认值；原文件改名成 `.corrupt` **只做一次**（避免每次启动都覆盖第一现场）
    const renamedCorrupt = renameToCorrupt(fs, filePath);
    return {
      prefs: { ...defaults },
      problems: renamedCorrupt
        ? [PREF_PROBLEMS.BAD_JSON, PREF_PROBLEMS.CORRUPT_RENAMED]
        : [PREF_PROBLEMS.BAD_JSON],
      status: 'corrupt',
      writable: true,
      renamedCorrupt,
    };
  }
  const normalized = normalizePrefs(parsed, { defaults });
  return {
    prefs: normalized.prefs,
    problems: normalized.problems,
    status: normalized.status,
    writable: normalized.writable,
    renamedCorrupt: false,
  };
}

/**
 * 把坏文件改名成 `<filePath>.corrupt`（**只在它还不存在时**改一次）。
 *
 * @param {object} fs 文件系统端口
 * @param {string} filePath 原文件路径
 * @returns {boolean} 是否真的改名了
 */
function renameToCorrupt(fs, filePath) {
  const corruptPath = `${filePath}.corrupt`;
  try {
    if (fs.existsSync(corruptPath)) return false;
    fs.renameSync(filePath, corruptPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写偏好文件（**原子**：临时文件 + rename；**永不抛**）。
 *
 * <p>失败只返回 `{ok:false, problems:[...]}`——调用方（主进程）只 `console.warn`，
 * 偏好丢失不该阻塞启动，也不该让菜单点击抛异常。</p>
 *
 * @param {{filePath: string, prefs: object, fs?: object, now?: () => string,
 *   stampUpdatedAt?: boolean}} options 选项
 * @returns {{ok: boolean, problems: string[], path: string}} 写入结果
 * @throws {TypeError} 只对"没给路径 / 没给偏好"这种编程错误抛
 */
function writePrefs(options) {
  if (options === null || typeof options !== 'object' || typeof options.filePath !== 'string' || options.filePath.length === 0) {
    throw new TypeError('[pet-prefs] writePrefs 需要 {filePath: string}（路径由调用方注入）');
  }
  if (options.prefs === null || typeof options.prefs !== 'object') {
    throw new TypeError('[pet-prefs] writePrefs 需要 {prefs: object}');
  }
  const fs = options.fs || nodeFs;
  const filePath = options.filePath;
  const tmpPath = `${filePath}.tmp`;
  const problems = [];
  const source = /** @type {Record<string, unknown>} */ (options.prefs);
  const prefs = {
    version: PREFS_VERSION,
    follow: source.follow === true,
    roam: source.roam !== false,
  };
  if (typeof source.follow !== 'boolean') problems.push(`${PREF_PROBLEMS.BAD_INPUT}:follow`);
  if (typeof source.roam !== 'boolean') problems.push(`${PREF_PROBLEMS.BAD_INPUT}:roam`);
  if (options.stampUpdatedAt === true) {
    const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    const stamp = now();
    if (typeof stamp === 'string' && stamp.length > 0) prefs.updatedAt = stamp;
  } else if (typeof source.updatedAt === 'string' && source.updatedAt.length > 0) {
    prefs.updatedAt = source.updatedAt;
  }
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // 失败要收拾临时文件，否则下次启动会看到残留（也会被测试断言抓到）
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* 清理失败不再抛：这是尽力而为 */
    }
    problems.push(`${PREF_PROBLEMS.WRITE_FAILED}:${error && error.code ? error.code : 'unknown'}`);
    return { ok: false, problems, path: filePath };
  }
  return { ok: true, problems, path: filePath };
}

/**
 * 造一个偏好仓库（路径与 `fs` 都可注入）。
 *
 * @param {{filePath: string, fs?: object, defaults?: object, now?: () => string}} options 选项
 * @returns {{read: () => object, write: (prefs: object) => object, path: () => string,
 *   update: (patch: object) => {ok: boolean, problems: string[], prefs: object}}} 仓库
 * @throws {TypeError} 没给路径
 */
function createPrefsStore(options) {
  if (options === null || typeof options !== 'object' || typeof options.filePath !== 'string' || options.filePath.length === 0) {
    throw new TypeError('[pet-prefs] createPrefsStore 需要 {filePath: string}');
  }
  const filePath = options.filePath;
  const fs = options.fs || nodeFs;
  const defaults = options.defaults || defaultPrefs();
  const now = options.now;
  return {
    /**
     * 读偏好。
     *
     * @returns {{prefs: object, problems: string[], status: string, writable: boolean}} 读取结果
     */
    read() {
      return readPrefs({ filePath, fs, defaults });
    },
    /**
     * 写偏好（原子）。
     *
     * @param {object} prefs 偏好
     * @returns {{ok: boolean, problems: string[], path: string}} 写入结果
     */
    write(prefs) {
      return writePrefs({ filePath, prefs, fs, now, stampUpdatedAt: true });
    },
    /**
     * 读 → 合并补丁 → 写（菜单点击的唯一路径；先落盘再广播）。
     *
     * <p>版本更高的文件**拒绝回写**（`writable:false`）：旧版程序不该把新版字段抹掉。</p>
     *
     * @param {{follow?: boolean, roam?: boolean}} patch 只接受布尔；其它键忽略（前向兼容）
     * @returns {{ok: boolean, problems: string[], prefs: object}} 结果
     */
    update(patch) {
      const current = readPrefs({ filePath, fs, defaults });
      if (!current.writable) {
        return { ok: false, problems: current.problems, prefs: current.prefs };
      }
      const next = { ...current.prefs };
      if (patch && typeof patch.follow === 'boolean') next.follow = patch.follow;
      if (patch && typeof patch.roam === 'boolean') next.roam = patch.roam;
      const written = writePrefs({ filePath, prefs: next, fs, now, stampUpdatedAt: true });
      return { ok: written.ok, problems: [...current.problems, ...written.problems], prefs: next };
    },
    /**
     * 文件路径（排障与测试用）。
     *
     * @returns {string} 路径
     */
    path() {
      return filePath;
    },
  };
}

/**
 * 读系统"减少动态效果"偏好（**探针，永不抛**；拿不到就"不动"）。
 *
 * <p><b>U-M4 的口径（主理人裁定）：</b>`prefers-reduced-motion` 为真时，<b>首次</b>
 * 无偏好文件 ⇒ 默认 `roam:false`、`follow:false`；<b>已有偏好文件时一律以文件为准</b>。</p>
 *
 * <p><b>探针顺序（Electron 没有一等公民的 reduced-motion API，所以必须防御式探测）：</b></p>
 * <ol>
 *   <li>`systemPreferences.getAnimationSettings()` 的 `shouldRenderRichAnimation === false`
 *       —— Windows 上"关闭动画效果"会同时关掉它，这是最接近的可用信号；</li>
 *   <li>`app.getSystemPreferences?.()` —— 某些 Electron 版本/平台若提供，按
 *       `{reducedMotion}` 或 `{prefersReducedMotion}` 读；</li>
 *   <li><b>都拿不到 ⇒ 降级为「不动」</b>：即<b>不做任何随之而来的默认值覆盖</b>
 *       （`reducedMotion:false`、`source:'unavailable-fallback-no-override'`）。
 *       理由：把"探测不到"当成"用户要求减少动效"，会让每台机器的首启
 *       `roam/follow` 都被静默关掉（桌宠永远不动），与 U-M2「`roam` 默认开」直接冲突。
 *       <b>要翻转这个判断只需改这一处返回值</b>，并在 `petPrefs.test.cjs` 的 P13 同步改期望。</li>
 * </ol>
 *
 * @param {{app?: object, systemPreferences?: object}} [electronApi] Electron 侧的可用接口
 *   （测试注入假对象；本模块**不** require electron）
 * @returns {{reducedMotion: boolean, source: string}} 结果与来源（来源用于日志与断言）
 */
function detectReducedMotion(electronApi) {
  const api = electronApi && typeof electronApi === 'object' ? electronApi : {};
  try {
    const systemPreferences = api.systemPreferences;
    if (systemPreferences && typeof systemPreferences.getAnimationSettings === 'function') {
      const settings = systemPreferences.getAnimationSettings();
      if (settings && typeof settings.shouldRenderRichAnimation === 'boolean') {
        return {
          reducedMotion: settings.shouldRenderRichAnimation === false,
          source: 'systemPreferences.getAnimationSettings',
        };
      }
    }
  } catch {
    /* 探针失败不阻塞启动：落到下一档 */
  }
  try {
    const app = api.app;
    if (app && typeof app.getSystemPreferences === 'function') {
      const value = app.getSystemPreferences();
      if (value && typeof value === 'object') {
        if (typeof value.reducedMotion === 'boolean') {
          return { reducedMotion: value.reducedMotion, source: 'app.getSystemPreferences.reducedMotion' };
        }
        if (typeof value.prefersReducedMotion === 'boolean') {
          return {
            reducedMotion: value.prefersReducedMotion,
            source: 'app.getSystemPreferences.prefersReducedMotion',
          };
        }
      }
    }
  } catch {
    /* 同上 */
  }
  // 见函数文档第 3 条：探测不到 ⇒ 不动（不覆盖默认值）
  return { reducedMotion: false, source: 'unavailable-fallback-no-override' };
}

/**
 * 把 `problems[]` 拼成**一条**给人看的日志（主进程只 `console.warn` 一次）。
 *
 * <p>为什么拼成一条：读一次偏好文件可能同时触发"版本不识别 + 某字段类型错"，
 * 分多条 warn 会在启动日志里刷屏，而用户只需要知道"哪几个字段被降级了"。</p>
 *
 * @param {string[]} problems 原因码列表
 * @returns {string} 单行文案（空列表返回空串）
 */
function formatPrefsProblems(problems) {
  if (!Array.isArray(problems) || problems.length === 0) return '';
  return problems.join('; ');
}

/**
 * 调一次 warn（**只调一次**；`warn` 不是函数时静默跳过，绝不反过来把启动搞崩）。
 *
 * @param {Function|undefined} warn 日志函数（通常是 `console.warn`）
 * @param {string} message 文案
 * @returns {void}
 */
function warnOnce(warn, message) {
  if (typeof warn !== 'function' || typeof message !== 'string' || message.length === 0) return;
  try {
    warn(message);
  } catch {
    /* 日志失败不许影响主流程 */
  }
}

/**
 * 启动时装载偏好（**U-M4 的两条路径都在这里，且只在这里**）。
 *
 * <p>规则（顺序即优先级）：</p>
 * <ol>
 *   <li>读文件；<b>只要文件存在</b>（`status !== 'missing'`，含坏 JSON / 版本更高 /
 *       字段类型错的降级结果）⇒ <b>一律以文件（或它的逐字段降级结果）为准</b>，
 *       `reducedMotion` 只作为日志信息，<b>绝不改写用户选择</b>；</li>
 *   <li>文件不存在（首次运行）+ `prefersReducedMotion === true` ⇒ `roam:false`、`follow:false`，
 *       `source:'reduced-motion-default'`（用户之后手动勾选照样能开，不是永久禁用）；</li>
 *   <li>文件不存在 + 未要求减少动效 ⇒ U-M2 默认（`follow:false` / `roam:true`）。</li>
 * </ol>
 *
 * <p>读失败（坏 JSON / 字段类型错 / 读不动）时**记一条 warn**：不许静默吞掉
 * （"为什么我的设置没了"必须能在日志里找到答案）。文件缺失是正常状态，不 warn。</p>
 *
 * @param {{store: {read: () => object}, prefersReducedMotion?: boolean,
 *   warn?: Function}} options 选项
 * @returns {{prefs: {version: number, follow: boolean, roam: boolean}, problems: string[],
 *   status: string, writable: boolean, source: 'file'|'default'|'reduced-motion-default',
 *   appliedReducedMotion: boolean}} 装载结果
 * @throws {TypeError} `store` 不可用（编程错误）
 */
function loadInitialPrefs(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-prefs] loadInitialPrefs 需要 {store, prefersReducedMotion?, warn?} 对象');
  }
  const store = options.store;
  if (!store || typeof store.read !== 'function') {
    throw new TypeError('[pet-prefs] loadInitialPrefs.store 必须是 createPrefsStore() 的返回物');
  }
  const warn = options.warn;
  const read = store.read();

  // ① 文件存在：以文件为准（绝不因为系统偏好静默改写用户选择）
  if (read.status !== 'missing') {
    // 只有真出问题时才 warn（健康的 'ok' 文件不该在启动日志里刷一条"降级"）
    if (read.problems.length > 0) {
      warnOnce(
        warn,
        `[pet-prefs] 偏好文件读取降级（status=${read.status}）：${formatPrefsProblems(read.problems)}` +
          `；已逐字段回落到默认值，文件保留原样（坏 JSON 会改名为 .corrupt）`,
      );
    }
    return {
      prefs: read.prefs,
      problems: read.problems,
      status: read.status,
      writable: read.writable,
      source: 'file',
      appliedReducedMotion: false,
    };
  }

  // ② 首次无文件 + 系统要求减少动效：默认两项都关
  if (options.prefersReducedMotion === true) {
    return {
      prefs: defaultPrefs({ prefersReducedMotion: true }),
      problems: [...read.problems, PREF_PROBLEMS.REDUCED_MOTION_DEFAULTS],
      status: read.status,
      writable: read.writable,
      source: 'reduced-motion-default',
      appliedReducedMotion: true,
    };
  }

  // ③ 首次无文件：U-M2 默认（follow=false / roam=true）
  return {
    prefs: read.prefs,
    problems: read.problems,
    status: read.status,
    writable: read.writable,
    source: 'default',
    appliedReducedMotion: false,
  };
}

/**
 * 应用一次偏好变更（**菜单点击的唯一路径**：先落盘，再交给调用方重建菜单）。
 *
 * <p>设计 §9.1 的顺序纪律：<b>先落盘 → 再广播给渲染层 → 最后重建托盘</b>。
 * 本函数只负责第一步（落盘）并返回新值；后两步由 `main.cjs` 按顺序做
 * （任何一步失败都不影响另两步，最坏是"菜单勾选与行为不同步一笔"，下次点击即纠正）。</p>
 *
 * <p>写盘失败**必须记一条 warn**（不许静默吞掉：用户点了勾却没保存，日志里要能查到）；
 * 同时仍然把新值返回给调用方——本轮菜单照常反映用户刚点的状态，下一次成功写入即对齐。</p>
 *
 * @param {{store: {write: (prefs: object) => object}, prefs: object, patch: object,
 *   warn?: Function}} options 选项
 * @returns {{prefs: {version: number, follow: boolean, roam: boolean}, ok: boolean,
 *   problems: string[], changed: boolean}} 新偏好与写入结果
 * @throws {TypeError} `store` / `prefs` / `patch` 不可用（编程错误）
 */
function applyPrefsPatch(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-prefs] applyPrefsPatch 需要 {store, prefs, patch} 对象');
  }
  const store = options.store;
  if (!store || typeof store.write !== 'function') {
    throw new TypeError('[pet-prefs] applyPrefsPatch.store 必须是 createPrefsStore() 的返回物');
  }
  const current = options.prefs;
  if (current === null || typeof current !== 'object') {
    throw new TypeError('[pet-prefs] applyPrefsPatch.prefs 必须是对象');
  }
  const patch = options.patch === null || options.patch === undefined ? {} : options.patch;
  if (typeof patch !== 'object') {
    throw new TypeError('[pet-prefs] applyPrefsPatch.patch 必须是对象');
  }
  const next = {
    version: PREFS_VERSION,
    follow: current.follow === true,
    roam: current.roam !== false,
  };
  if (typeof current.updatedAt === 'string' && current.updatedAt.length > 0) {
    next.updatedAt = current.updatedAt;
  }
  const before = `${next.follow}|${next.roam}`;
  // 只接受布尔：其它类型（含 undefined）一律忽略，前向兼容（未知键静默忽略）
  if (typeof patch.follow === 'boolean') next.follow = patch.follow;
  if (typeof patch.roam === 'boolean') next.roam = patch.roam;
  const changed = `${next.follow}|${next.roam}` !== before;

  const written = store.write(next);
  if (!written || written.ok !== true) {
    warnOnce(
      options.warn,
      `[pet-prefs] 偏好写入失败（本轮只在内存生效，重启后会回到上一次成功保存的值）：` +
        `${formatPrefsProblems(written && written.problems)}`,
    );
  }
  return {
    prefs: next,
    ok: Boolean(written && written.ok),
    problems: (written && written.problems) || [],
    changed,
  };
}

module.exports = {
  PREFS_VERSION,
  DEFAULT_PREFS,
  KNOWN_FIELDS,
  PREF_PROBLEMS,
  defaultPrefs,
  detectReducedMotion,
  normalizePrefs,
  toPersistedPrefs,
  readPrefs,
  writePrefs,
  createPrefsStore,
  formatPrefsProblems,
  loadInitialPrefs,
  applyPrefsPatch,
};
