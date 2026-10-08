'use strict';

/**
 * 应用自动更新（主进程）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 设计取舍：为什么用 electron-updater + Release 正文，而不是自建 version.json
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 用户最初的诉求是一份 `version.json`（version / changeLog / downloadurl /
 * forceupdate）驱动更新。经安全与发布两条线独立评估后改为：
 *
 *   electron-builder（--publish always）
 *     ├─ 产出并上传 latest.yml  ← 含每个文件的 sha512，electron-updater 自动校验
 *     ├─ 产出并上传 LX.Setup.<version>.exe
 *     └─ 创建 GitHub Release，正文 = changeLog
 *   electron-updater（应用内）
 *     └─ 解析 feed → 比对版本 → 下载 → **用 latest.yml 里的 sha512 校验** → NSIS 静默安装
 *
 * 不建 version.json 的理由：
 *   1. 它是「第四份版本信息」，与 package.json / git tag / latest.yml 并列，
 *      只会再制造一个漂移点（本项目已经因为版本漂移翻过车，见 scripts/check-version.mjs）。
 *   2. 自建清单意味着要自己实现「下载 → 校验 → 杀进程 → 替换 → 重启」，
 *      而这段代码是整个应用里最危险的路径，成熟实现更可靠。
 *   3. latest.yml 由 electron-builder 与二进制**同批产出**，天然不会失配。
 *
 * ⚠️ latest.yml 的 sha512 只保护**二进制**，不保护 Release 正文。
 *    所以正文里的 forceupdate / minSupportedVersion 必须走 Ed25519 签名，
 *    见 update-security.cjs 的 buildSignaturePayload。这是本模块最容易理解错的一点：
 *    「有 sha512 了为什么还要签名」—— 因为 sha512 在 latest.yml 里，
 *    而 forceupdate 在正文里，两者不是同一个信任域。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 安全边界（全部 fail-closed）
 * ═══════════════════════════════════════════════════════════════════════
 *   1. 下载 URL 白名单（https + github.com / objects.githubusercontent.com），
 *      经 session.webRequest 在**每一个实际请求**上校验 —— 302 之后同样生效
 *   2. 版本只升不降 + minSupportedVersion
 *   3. forceupdate / minSupportedVersion 必须验签通过，否则整体拒绝
 *   4. 只在主进程执行；渲染层只能发意图、只能读状态
 *   5. 开发态默认完全禁用（开发者的当前版本往往比线上高，且会装坏本机）
 */

const path = require('path');
const sec = require('./update-security.cjs');

/**
 * ⚠️ 与 frontend/package.json 的 build.publish 必须一致。
 *    不一致的后果：白名单会拒绝真实下载地址 → 更新永久失败。
 *    scripts/check-version.mjs 会校验这两处一致，改动时两处一起改。
 */
const UPDATE_FEED = Object.freeze({ owner: 'yesnonononononi', repo: 'LingXi' });

/**
 * ⚠️ 发布侧签名公钥。私钥不进仓库（保存于本地 ~/.lingxi/keys/，或 CI secret）。
 *
 * 替换方式：跑 `node scripts/generate-update-key.mjs` 生成密钥对，把输出的 PEM 粘到这里，
 * 私钥交给发布流程。**换公钥等于换信任根**：旧版本客户端无法验证新公钥签的内容，
 * 因此换公钥需要保留旧公钥一段时间做双公钥验证（见 VERIFY_KEYS）。
 */
const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1TDWtzZJQEeH1yDggdeuoBKjqRfXE/qGqJHu1nyziWI=
-----END PUBLIC KEY-----`;

/**
 * ⚠️ 占位公钥：仅在「尚未生成正式密钥」时使用。
 *    该私钥的种子硬编码在 scripts/generate-update-key.mjs 的文档里，**任何人都能签**，
 *    因此带此公钥的构建**不会启用强制更新**（见 verifyClaim 的 placeholder 分支）——
 *    允许验签通过但不允许 forceupdate，避免用假密钥把用户锁死在强制升级里。
 *
 * ⚠️ 已于 2026-10-08 换用正式公钥（上面那个），故此处**刻意置空**：
 *    verifyClaim 的判据是 `UPDATE_PUBLIC_KEY_PEM === PLACEHOLDER_PUBLIC_KEY_PEM`，
 *    置空后该分支恒为 false，强制更新即生效。**不要把它重新赋成上面那个常量**，
 *    那会悄悄把 forceupdate 关掉。
 */
const PLACEHOLDER_PUBLIC_KEY_PEM = '';

/** 检查更新的间隔（6 小时）。太短会打 GitHub API 限流（未认证 60 次/小时/IP）。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后多久做首次检查：错开启动高峰，别和后端冷启动抢资源 */
const FIRST_CHECK_DELAY_MS = 20 * 1000;

/** 已挂载守卫的 session 集合：挂载是幂等的，但重复挂会叠加处理器 */
const guardedSessions = new WeakSet();

/**
 * 在 electron-updater 实际发请求的 session 上安装 URL 守卫。
 *
 * 为什么用 webRequest 而不是「检查 downloadUrl 字符串」：
 *   更新器内部会自己拼 URL、自己跟随重定向。只在调用点检查一遍挡不住 302 ——
 *   302 的目标在请求发生时才知道，只有 webRequest 层能看到**最终**被访问的地址。
 *   这里对每个请求（含重定向产生的）逐一校验，等价于「重定向后重新校验」。
 *
 * @param {import('electron').Session} targetSession
 * @param {(detail: {url:string, reason:string}) => void} onBlocked
 */
function installUrlGuard(targetSession, onBlocked) {
  if (!targetSession || !targetSession.webRequest) {
    // 拿不到 session 就不能声称「守卫已安装」—— 静默跳过等于更新链路裸奔
    throw new Error('无法安装下载守卫：session 不可用');
  }
  if (guardedSessions.has(targetSession)) return;
  guardedSessions.add(targetSession);

  targetSession.webRequest.onBeforeRequest((details, callback) => {
    // 只拦截更新链路上的 http(s) 请求；file:// 等协议与本地资源不涉及
    if (!details.url.startsWith('http://') && !details.url.startsWith('https://')) {
      return callback({ cancel: false });
    }

    const verdict = sec.validateDownloadUrl(details.url);
    if (verdict.ok) {
      return callback({ cancel: false });
    }

    onBlocked({ url: details.url, reason: verdict.reason });
    // 取消请求：绝不 downgrade 为「放行但记日志」——那是白名单失效的一种写法
    return callback({ cancel: true });
  });
}

/**
 * 创建更新器控制器。
 *
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {() => import('electron').BrowserWindow|null} deps.getWindow
 * @param {(state: object) => void} deps.broadcast  把状态推给渲染层
 * @param {object} [deps.logger]
 */
function createUpdater({ app, getWindow, broadcast, logger }) {
  const log = logger || { info() {}, warn() {}, error() {} };

  /** @type {import('electron-updater').AppUpdater|null} */
  let updater = null;
  let timer = null;
  let firstTimer = null;
  /** 本轮已解析出的更新信息（含验签结论），供 renderer 展示与安装时复用 */
  let pending = null;
  let stopped = false;

  /**
   * 当前处于状态机的哪一阶段。
   *
   * ⚠️ 为什么单独存一份而不是让渲染层从 pending 猜：
   *    pending 只描述「解析出了什么更新」，它无法表达「下载到了几成」「装没装」。
   *    历史缺口：getState 只回版本与 pending，渲染层重开设置页时把任何 pending
   *    都还原成 available —— 后台已下载完成的会被显示成「待下载」，
   *    下载中的进度条消失，出错后重开则显示成一切正常。阶段必须由主进程持有。
   */
  let phase = 'idle';
  /** 下载进度（0-100）与速度，供 getState 恢复下载中的界面 */
  let downloadProgress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 };
  /** 最近一次错误文案（phase==='error' 时有效） */
  let lastError = '';

  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

  /** 状态机：idle → checking → (available | not-available | error) → downloading → downloaded → installing */
  function emit(state, extra = {}) {
    // ⚠️ phase 是第一真源：每个 emit 都把最新阶段记下来，
    //    getState 直接回它，避免「广播过什么」与「查得回什么」两套口径。
    phase = state;
    const payload = {
      state,
      currentVersion: app.getVersion(),
      ...(pending
        ? {
            availableVersion: pending.version,
            releaseNotes: pending.changeLog,
            forceupdate: pending.forceupdate,
            mandatory: pending.mandatory,
            // 是否「可安装」：验签失败 / 版本被拒时仍想让用户看到「有新版本但不可用」
            installable: pending.installable,
            rejectReason: pending.rejectReason || null,
          }
        : {}),
      ...extra,
    };
    try {
      broadcast(payload);
    } catch (err) {
      log.warn(`[updater] 状态广播失败: ${(err && err.message) || err}`);
    }
    return payload;
  }

  /**
   * 校验来自远端的更新声明。
   *
   * 输入是 electron-updater 已经解析好的 UpdateInfo（版本、文件、sha512 来自 latest.yml，
   * releaseNotes 来自 Release 正文）。这里负责把「正文里的不可信字段」用签名钉死。
   *
   * @param {import('electron-updater').UpdateInfo} info
   * @returns {{ ok:boolean, forceupdate?:boolean, minSupportedVersion?:string, reason?:string }}
   */
  function verifyClaim(info) {
    const notes = sec.normalizeReleaseNotes(info.releaseNotes);
    const claim = sec.parseUpdateClaim(notes);

    const hasSignature = typeof claim.signature === 'string' && claim.signature.length > 0;
    if (!hasSignature) {
      // 没签名 → 不信任正文里的任何声明。仍允许普通（非强制）更新，
      // 因为二进制本身有 latest.yml 的 sha512 保护；
      // 但 forceupdate 一律视为 false —— 否则任何人改正文即可强制全量升级。
      log.warn('[updater] Release 正文无 lx-update 签名块，忽略正文声明（forceupdate 视为 false）');
      return { ok: true, forceupdate: false, minSupportedVersion: undefined, unsigned: true };
    }

    // 取本版本对应的文件摘要：electron-updater 已从 latest.yml 解析，
    // 这里直接用，不做二次下载 —— digest 的来源是受 sha512 保护的清单，可信。
    const fileSha = (info.files && info.files[0] && info.files[0].sha512) || info.sha512 || '';

    const forceupdate = claim.forceupdate === 'true';
    const minSupportedVersion = claim.minSupportedVersion || undefined;

    const payload = sec.buildSignaturePayload({
      version: info.version,
      sha512: fileSha,
      forceupdate,
      minSupportedVersion,
    });

    const verdict = sec.verifySignature({
      payload,
      signature: claim.signature,
      publicKeyPem: UPDATE_PUBLIC_KEY_PEM,
    });

    if (!verdict.ok) {
      // 验签失败是**高危信号**：要么发布流程出错，要么 Release 被篡改。
      // 一律拒绝整次更新，并明确告知用户 —— 静默忽略会让被攻击的客户端一直以为自己是最新的。
      log.error(`[updater] 更新声明验签失败: ${verdict.reason}`);
      return { ok: false, reason: `更新清单签名校验失败（${verdict.reason}），已拒绝本次更新` };
    }

    // 占位公钥下不允许强制更新：占位私钥是公开的，forceupdate 需最高信任级别
    if (UPDATE_PUBLIC_KEY_PEM === PLACEHOLDER_PUBLIC_KEY_PEM && forceupdate) {
      log.warn('[updater] 使用占位公钥，拒绝采信 forceupdate=true');
      return { ok: true, forceupdate: false, minSupportedVersion };
    }

    return { ok: true, forceupdate, minSupportedVersion };
  }

  /** 处理一次检查结果 */
  async function handleCheckResult(result) {
    if (!result || !result.updateInfo) {
      pending = null;
      emit('not-available');
      return;
    }

    const info = result.updateInfo;
    log.info(`[updater] 远端版本 ${info.version}（当前 ${app.getVersion()}）`);

    // ① 版本门槛：只升不降 + 最低支持版本
    const claimed = verifyClaim(info);
    if (!claimed.ok) {
      pending = {
        version: info.version,
        changeLog: sec.normalizeReleaseNotes(info.releaseNotes),
        forceupdate: false,
        installable: false,
        rejectReason: claimed.reason,
      };
      emit('error', { error: claimed.reason });
      return;
    }

    const gate = sec.isUpdateAllowed({
      currentVersion: app.getVersion(),
      targetVersion: info.version,
      minSupportedVersion: claimed.minSupportedVersion,
    });
    if (!gate.allowed) {
      pending = {
        version: info.version,
        changeLog: sec.normalizeReleaseNotes(info.releaseNotes),
        forceupdate: false,
        installable: false,
        rejectReason: gate.reason,
      };
      emit('not-available');
      return;
    }

    pending = {
      version: info.version,
      changeLog: sec.normalizeReleaseNotes(info.releaseNotes),
      forceupdate: !!claimed.forceupdate,
      installable: true,
      rejectReason: null,
      // 强制更新时不允许用户「稍后」。
      // ⚠️ 两个来源合流：发布方主动声明 forceupdate，或当前版本已低于
      //    minSupportedVersion（不受支持的版本，升级不是可选项）。
      mandatory: !!claimed.forceupdate || !!gate.mandatory,
    };

    emit('available');
    // 强制更新：不等用户点，直接开始下载（节省用户等待）
    if (pending.mandatory) {
      log.info('[updater] 强制更新，自动开始下载');
      startDownload().catch((err) => log.error(`[updater] 自动下载失败: ${(err && err.message) || err}`));
    }
  }

  /** 开始下载 */
  async function startDownload() {
    if (!updater || !pending || !pending.installable) {
      throw new Error('当前没有可安装的更新');
    }
    downloadProgress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 };
    emit('downloading', { percent: 0 });
    // 返回的文件路径数组，下载完成后 electron-updater 内部已用 latest.yml 的 sha512 校验过；
    // 校验失败会走 'error' 事件而不是 'update-downloaded'
    await updater.downloadUpdate();
  }

  /**
   * 安装并重启。
   *
   * ⚠️ 前置条件是**已完成下载并通过 sha512 校验**（phase === 'downloaded'），
   *    不是「存在 pending」。
   *    历史缺口：这里原先只查 pending.installable，于是「刚发现新版本、还没下载」
   *    也会返回 true 去调 quitAndInstall —— 拿一个不存在的安装包去启动 NSIS，
   *    用户看到的是「点了没反应」或安装器报错，却没有任何可读反馈。
   *    返回 { ok, error } 让 IPC 层能把真实原因回给渲染层。
   *
   * @returns {{ ok: boolean, error?: string }}
   */
  function install() {
    if (!updater || !pending || !pending.installable) {
      return { ok: false, error: '当前没有可安装的更新' };
    }
    if (phase !== 'downloaded') {
      return { ok: false, error: '更新尚未下载完成，无法安装' };
    }
    emit('installing');
    // isSilent=false 让 NSIS 显示安装界面（oneClick:false，用户可看到进度）
    // isForceRunAfter=true 安装完成后自动拉起应用
    setImmediate(() => {
      try {
        updater.quitAndInstall(false, true);
      } catch (err) {
        const msg = (err && err.message) || String(err);
        log.error(`[updater] 启动安装失败: ${msg}`);
        // 启动失败必须落回 error 阶段：否则界面会永远停在「正在安装…」
        lastError = `启动安装失败：${msg}`;
        emit('error', { error: lastError });
      }
    });
    return { ok: true };
  }

  /** 执行一次检查（用户手动触发与定时触发共用） */
  async function check({ manual = false } = {}) {
    if (!updater) {
      if (manual) emit('error', { error: '当前环境不支持自动更新' });
      return null;
    }
    emit('checking');
    try {
      const result = await updater.checkForUpdates();
      await handleCheckResult(result);
      return result;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      log.warn(`[updater] 检查更新失败: ${msg}`);
      // 手动检查必须把错误暴露给用户；定时检查静默（网络抖动是常态，不该弹窗）
      if (manual) emit('error', { error: msg });
      else emit('idle');
      return null;
    }
  }

  /** 初始化：仅在打包态启用 */
  function start() {
    if (isDev) {
      log.info('[updater] 开发态，自动更新已禁用');
      emit('disabled', { reason: 'development' });
      return;
    }
    if (process.platform !== 'win32') {
      // NSIS 目标只有 Windows；其他平台没有配套产物，启用会拿到错误 feed
      log.info(`[updater] 平台 ${process.platform} 无更新产物，已禁用`);
      emit('disabled', { reason: 'platform' });
      return;
    }

    let autoUpdater;
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (err) {
      // 缺依赖不能让整个应用起不来 —— 更新是可选能力
      log.error(`[updater] 无法加载 electron-updater: ${(err && err.message) || err}`);
      emit('disabled', { reason: 'missing-dependency' });
      return;
    }

    updater = autoUpdater;

    // ① 安全：URL 守卫必须挂在**更新器真正发请求的那个 session** 上。
    //    ⚠️ 不能挂 session.defaultSession —— electron-updater 内部用的是
    //    session.fromPartition('electron-updater')（见 electron-updater 的
    //    electronHttpExecutor.getNetSession）。挂错 session 的后果有两层：
    //      1) 更新下载完全绕过白名单守卫（守卫形同虚设，但仍能通过「代码里调用了
    //         installUrlGuard」的静态检查）；
    //      2) defaultSession 上还跑着应用自身的网络请求，挂那里会误拦正常流量。
    //    这里通过 updater.netSession 取到它实际使用的 session，保证守卫一定生效。
    try {
      const guardSession = updater.netSession;
      installUrlGuard(guardSession, ({ url, reason }) => {
        log.error(`[updater] 已拦截非白名单请求: ${url}（${reason}）`);
        emit('error', { error: `已拦截非白名单下载地址（${reason}）` });
      });
    } catch (err) {
      // 取不到 netSession 说明 electron-updater 版本与预期不符 —— 此时继续跑
      // 等于在没有守卫的情况下下载可执行文件，必须失败关闭。
      log.error(`[updater] 无法取得更新器 session，为安全起见禁用更新: ${(err && err.message) || err}`);
      emit('disabled', { reason: 'guard-unavailable' });
      return;
    }

    // ② 只检查不自动下载：让用户知情（forceupdate 场景在 handleCheckResult 里另行自动下载）
    updater.autoDownload = false;
    // ③ 不自动装：安装会重启应用，必须由用户显式同意（除非强制更新）
    updater.autoInstallOnAppQuit = false;
    // ④ 只升不降（electron-updater 默认 false，显式写出来表明这是**有意的安全设定**，不是默认值兜底）
    updater.allowDowngrade = false;
    // ⑤ 关闭差分下载：本项目安装包 56% 是后端产物，差分收益不稳定，
    //    且差分需要额外下载 blockmap，弱网下反而更慢。保持简单可预期。
    updater.disableDifferentialDownload = true;
    // ⑥ 需要完整 changelog（Release 正文）来读 lx-update 声明块
    updater.fullChangelog = false;

    updater.logger = {
      info: (m) => log.info(`[updater] ${m}`),
      warn: (m) => log.warn(`[updater] ${m}`),
      error: (m) => log.error(`[updater] ${m}`),
      debug: () => {},
    };

    // ── 事件接线 ──────────────────────────────────────────────
    updater.on('checking-for-update', () => emit('checking'));

    updater.on('update-available', () => {
      // 具体字段在 checkForUpdates() 的返回值里处理（那里能拿到 UpdateInfo）
      log.info('[updater] 发现新版本');
    });

    updater.on('update-not-available', () => {
      pending = null;
      emit('not-available');
    });

    updater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
      downloadProgress = {
        percent,
        bytesPerSecond: progress.bytesPerSecond || 0,
        transferred: progress.transferred || 0,
        total: progress.total || 0,
      };
      emit('downloading', downloadProgress);
    });

    updater.on('update-downloaded', (event) => {
      // 走到这里说明 electron-updater 已用 latest.yml 的 sha512 校验通过
      if (pending) {
        pending.downloadedFile = (event && event.downloadedFile) || null;
      }
      downloadProgress = { ...downloadProgress, percent: 100 };
      emit('downloaded', { percent: 100 });
      // 强制更新：下载完直接进安装，不给「稍后」的机会
      if (pending && pending.mandatory) {
        log.info('[updater] 强制更新已下载完成，自动安装');
        install();
      }
    });

    updater.on('error', (err) => {
      const msg = (err && err.message) || String(err);
      log.error(`[updater] 更新器错误: ${msg}`);
      lastError = msg;
      emit('error', { error: msg });
    });

    // feed 显式设置：不依赖运行时从 app-update.yml 反查，
    // 便于 check-version.mjs 做一致性断言，也让行为可审计
    updater.setFeedURL({
      provider: 'github',
      owner: UPDATE_FEED.owner,
      repo: UPDATE_FEED.repo,
    });

    log.info(`[updater] 已启用，feed=${UPDATE_FEED.owner}/${UPDATE_FEED.repo}，当前 ${app.getVersion()}`);

    // 首次检查延后，避免与应用冷启动（后端 JVM + Spring 上下文）抢 IO
    firstTimer = setTimeout(() => {
      if (!stopped) check().catch(() => {});
    }, FIRST_CHECK_DELAY_MS);
    if (firstTimer.unref) firstTimer.unref();

    timer = setInterval(() => {
      if (!stopped) check().catch(() => {});
    }, CHECK_INTERVAL_MS);
    if (timer.unref) timer.unref();

    emit('idle');
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    timer = null;
    firstTimer = null;
  }

  return {
    start,
    stop,
    check,
    startDownload,
    install,
    /**
     * 返回可完整恢复界面的状态快照。
     *
     * ⚠️ 必须带 phase 与进度：渲染层重开设置页时靠它还原「下载中 / 已下载 / 出错」，
     *    若只回 pending，任何 pending 都会被还原成 available（历史缺口）。
     */
    getState: () => ({
      currentVersion: app.getVersion(),
      phase,
      error: lastError || null,
      progress: { ...downloadProgress },
      pending,
    }),
    isEnabled: () => !!updater,
  };
}

module.exports = { createUpdater, UPDATE_FEED, UPDATE_PUBLIC_KEY_PEM, installUrlGuard };
