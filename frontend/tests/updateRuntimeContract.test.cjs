'use strict';

/**
 * 更新器运行期契约测试（跨文件 + 真实 provider 行为）。
 *
 * 为什么必须存在（这些不是普通单测）：
 *   updateSecurity.test.cjs 只覆盖纯函数；updateSignatureContract.test.cjs 只覆盖
 *   payload 格式。两者都**不碰** updater.cjs 的编排、不碰 electron-updater 的
 *   真实 provider 行为、不碰工作流。而 2026-10-09 的审计里，10 项缺口有 9 项
 *   正好落在这个盲区 —— 单测全绿，线上却一步都走不通。
 *
 * 本文件用 vm 沙箱把 updater.cjs 加载进受控环境（mock electron / electron-updater），
 * 并对 **真实** 的 GitHubProvider.computeReleaseNotes 喂真实形态的输入，
 * 让「HTML 声明」「301 落点主机」「session 挂载点」这类跨边界缺陷能被测出来。
 *
 * ⚠️ 每条断言都必须能因缺陷回退而变红（变异纪律见 AGENTS.md）。
 *    每条测试都标注了变异方式：按标注改实现 → 必须红 → 再改回。
 *
 * 运行：node --test tests/updateRuntimeContract.test.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const frontendRoot = path.resolve(__dirname, '..');
const sec = require('../electron/update-security.cjs');
const updaterSource = fs.readFileSync(path.join(frontendRoot, 'electron', 'updater.cjs'), 'utf8');

// ---------------------------------------------------------------- 沙箱装配

const keyPair = crypto.generateKeyPairSync('ed25519');
const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });

/**
 * 把 updater.cjs 加载进沙箱并启动。
 *
 * 关键模拟点：
 *   - electron.session.fromPartition：返回 updaterSession（electron-updater 真正用的）
 *   - electron.session.defaultSession：返回 defaultSession（用于断言「没有被误挂」）
 *   - electron-updater 的 autoUpdater：一个 EventEmitter，netSession 指向 updaterSession
 *   - 公钥被替换成测试密钥对，以便构造「有效签名」的正对照
 */
function setup(releaseNotes, currentVersion = '0.0.1') {
  const defaultSession = { webRequest: { onBeforeRequest(fn) { this.handler = fn; } } };
  const updaterSession = { webRequest: { onBeforeRequest(fn) { this.handler = fn; } } };
  const engine = new EventEmitter();
  engine.netSession = updaterSession;
  engine.setFeedURL = (feed) => { engine.feed = feed; };
  engine.checkForUpdates = async () => ({
    updateInfo: { version: '0.0.2', files: [{ sha512: 'test-digest' }], releaseNotes },
  });
  engine.downloadUpdate = async () => [];
  // 探针/测试绝不允许真的启动安装器
  engine.quitAndInstall = () => { throw new Error('测试不得启动安装'); };

  const sandbox = {
    module: { exports: {} },
    process: { platform: 'win32', env: {}, argv: [] },
    require(name) {
      if (name === 'electron') {
        return {
          session: {
            defaultSession,
            // electron-updater 内部调用 fromPartition('electron-updater', {cache:false})
            fromPartition: () => updaterSession,
          },
          net: {},
        };
      }
      if (name === 'electron-updater') return { autoUpdater: engine };
      if (name === './update-security.cjs') return sec;
      return require(name);
    },
    setTimeout: () => ({ unref() {} }),
    setInterval: () => ({ unref() {} }),
    clearTimeout() {},
    clearInterval() {},
    setImmediate() {},
  };

  // 替换硬编码公钥为测试密钥，才能构造「验签通过」的正对照
  const isolated = updaterSource.replace(
    /const UPDATE_PUBLIC_KEY_PEM = `[\s\S]*?`;/,
    `const UPDATE_PUBLIC_KEY_PEM = ${JSON.stringify(publicPem)};`
  );
  vm.runInNewContext(isolated, sandbox, { filename: 'updater.cjs' });

  const states = [];
  const controller = sandbox.module.exports.createUpdater({
    app: { getVersion: () => currentVersion },
    getWindow: () => null,
    broadcast: (state) => states.push(state),
  });
  controller.start();
  return { controller, engine, states, defaultSession, updaterSession, exports: sandbox.module.exports };
}

/** 构造带有效签名的 lx-update 声明（Markdown 围栏形态） */
function signedNotes(forceupdate, minSupportedVersion) {
  const payload = sec.buildSignaturePayload({
    version: '0.0.2',
    sha512: 'test-digest',
    forceupdate,
    minSupportedVersion,
  });
  const signature = crypto.sign(null, Buffer.from(payload), keyPair.privateKey).toString('base64');
  return (
    '```lx-update\nforceupdate=' + forceupdate +
    '\nminSupportedVersion=' + (minSupportedVersion || '') +
    '\nsignature=' + signature + '\n```'
  );
}

/** 把声明字段包成 GitHubProvider 实际产出的 HTML 形态 */
function toProviderHtml(fields) {
  const { computeReleaseNotes } = require(
    path.join(frontendRoot, 'node_modules/electron-updater/out/providers/GitHubProvider.js')
  );
  const html = '<pre><code class="language-lx-update">' + fields + '\n</code></pre>';
  // 走真实 provider：这一步就是「HTML 而非 Markdown」的来源
  return computeReleaseNotes('0.0.1', false, null, { elementValueOrEmpty: () => html });
}

// ================================================================ 1. 正对照

test('正对照：有效 Markdown 声明的更新可安装（证明控制器链路本身是通的）', async () => {
  const probe = setup(signedNotes(false, ''));
  await probe.controller.check();
  assert.equal(probe.controller.getState().pending.installable, true);
});

test('同版检查是正常结果，但下载与安装仍被禁止', async () => {
  const probe = setup('同版更新说明', '0.0.2');
  await probe.controller.check();
  const snapshot = probe.controller.getState();
  assert.equal(snapshot.phase, 'not-available');
  assert.equal(snapshot.pending.rejectReason, null);
  assert.equal(snapshot.pending.installable, false);
  assert.equal(probe.states.at(-1).rejectReason, null);
  await assert.rejects(probe.controller.startDownload(), /当前没有可安装的更新/);
  assert.equal(probe.controller.install().ok, false);
});

test('设置重开时查询到的更新正文与广播一致', async () => {
  const probe = setup('<h2>修复</h2><p>优化更新界面</p>');
  await probe.controller.check();
  assert.equal(probe.controller.getState().pending.releaseNotes, probe.states.at(-1).releaseNotes);
});

test('降级拒绝仍保留具体故障原因', async () => {
  const probe = setup('旧版本', '0.0.3');
  await probe.controller.check();
  assert.match(probe.controller.getState().pending.rejectReason, /拒绝降级/);
});

// ================================================================ 2. feed 真源

test('客户端 feed 必须与 electron-builder publish 相同', () => {
  const probe = setup('');
  const pkg = JSON.parse(fs.readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'));
  // 变异：把 updater.cjs 的 UPDATE_FEED.owner 改掉 → 本测试红
  assert.equal(probe.engine.feed.owner, pkg.build.publish[0].owner);
  assert.equal(probe.engine.feed.repo, pkg.build.publish[0].repo);
});

test('check-version 必须直接解析客户端 feed 真源（不是自造常量）', () => {
  const src = fs.readFileSync(path.join(frontendRoot, 'scripts', 'check-version.mjs'), 'utf8');
  // 断言脚本确实读取了 updater.cjs 并解析 UPDATE_FEED —— 防止回退成「比对自造常量」
  assert.match(src, /electron['"`,\s]*['"`]?updater\.cjs|['"]electron['"],\s*['"]updater\.cjs['"]/);
  assert.match(src, /UPDATE_FEED/);
  assert.match(src, /clientFeed/);
});

// ================================================================ 3. URL 守卫挂载点

test('URL 守卫必须挂到更新器实际使用的 session，且不误挂 defaultSession', () => {
  const probe = setup('');
  // 核心：electron-updater 用的是 fromPartition('electron-updater')，守卫必须在这里
  // 变异：把 installUrlGuard(updater.netSession, …) 改回 session.defaultSession → 本测试红
  assert.equal(
    typeof probe.updaterSession.webRequest.handler,
    'function',
    '守卫未挂到更新器实际使用的 session —— 下载链路完全绕过白名单'
  );
  // defaultSession 上跑着应用自身的网络请求，挂那里会误拦正常流量
  assert.equal(
    typeof probe.defaultSession.webRequest.handler,
    'undefined',
    '守卫被误挂到 defaultSession —— 会拦截非更新请求'
  );
});

// ================================================================ 4. HTML 声明解析

test('GitHub provider 返回的 HTML 声明必须能被解析出签名', () => {
  const notes = signedNotes(true, '0.0.2');
  const rendered = toProviderHtml(notes.split('\n').slice(1, -1).join('\n'));
  // 变异：parseUpdateClaim 删掉 htmlRe 分支 → 本测试红（signature 变 undefined）
  assert.ok(
    sec.parseUpdateClaim(rendered).signature,
    'HTML 形态的声明被误判为未签名 —— 强制更新声明会被静默忽略'
  );
});

test('HTML 声明能覆盖签名错误：错误签名必须被拒绝，不能退成普通更新', async () => {
  const badFields =
    'forceupdate=true\nminSupportedVersion=0.0.2\nsignature=' +
    Buffer.alloc(64).toString('base64');

  // 正对照：Markdown 形态下错误签名被拒
  const markdown = setup('```lx-update\n' + badFields + '\n```');
  await markdown.controller.check();
  assert.equal(
    markdown.controller.getState().pending.installable,
    false,
    '正对照：Markdown 错误签名应被拒绝（若这里也放行，测试本身失效）'
  );

  // 被测：HTML 形态下错误签名必须同样被拒
  // 变异：parseUpdateClaim 只认 Markdown → HTML 变「无签名」→ installable 变 true → 本测试红
  const html = setup(toProviderHtml(badFields));
  await html.controller.check();
  assert.equal(
    html.controller.getState().pending.installable,
    false,
    'HTML 错误签名被当成「无签名」而放行 —— 验签防线在 HTML 形态下失效'
  );
});

// ================================================================ 5. 重定向主机

test('真实 GitHub 资产重定向主机必须在白名单内', () => {
  // ⚠️ 这里是**实测抓到的真实响应**，不是凭印象写死的常量。
  //    2026-10-09 对线上 LX.Setup.0.0.0.exe 发 HEAD：status=302，
  //    Location 主机 = release-assets.githubusercontent.com。
  //    （原始响应快照曾存于 target/github-update-audit/transport.json，
  //      但该目录被 Git 忽略，正式测试不能依赖它，故内联如下。）
  const realRedirect = { status: 302, redirectHost: 'release-assets.githubusercontent.com' };

  assert.equal(realRedirect.status, 302, '样本必须来自真实 HEAD 响应');
  // 变异：从 ALLOWED_DOWNLOAD_HOSTS 删掉 release-assets.githubusercontent.com → 本测试红
  const verdict = sec.validateDownloadUrl('https://' + realRedirect.redirectHost + '/release/asset.exe');
  assert.equal(verdict.ok, true, `真实重定向主机 ${realRedirect.redirectHost} 被白名单拒绝 —— 下载必然失败`);
});

// ================================================================ 6. 最低支持版本强制语义

test('当前版本低于 minSupportedVersion 时必须判定为强制更新', async () => {
  // 当前 0.0.1，目标 0.0.2，min=0.0.2 → 当前版本已不受支持，必须升级
  const probe = setup(signedNotes(false, '0.0.2'));
  await probe.controller.check();
  const pending = probe.controller.getState().pending;
  // 变异：把 handleCheckResult 的 mandatory 改回仅 !!claimed.forceupdate → 本测试红
  assert.equal(pending.mandatory, true, '低于最低支持版本却未标记强制更新');
  // forceupdate 仍是 false：两个来源语义不同，但都会让 mandatory 为真
  assert.equal(pending.forceupdate, false);
});

test('isUpdateAllowed 在低于最低支持版本时显式返回 mandatory', () => {
  const gate = sec.isUpdateAllowed({
    currentVersion: '0.0.1',
    targetVersion: '0.0.2',
    minSupportedVersion: '0.0.2',
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.mandatory, true);
  // 反例：满足最低版本的普通升级不应强制
  const normal = sec.isUpdateAllowed({
    currentVersion: '0.0.2',
    targetVersion: '0.0.3',
    minSupportedVersion: '0.0.1',
  });
  assert.equal(normal.mandatory, false);
});

// ================================================================ 7. 状态恢复

test('已下载完成的状态必须能被重新查询到（不能退化成 available）', async () => {
  const probe = setup(signedNotes(false, ''));
  await probe.controller.check();
  probe.engine.emit('update-downloaded', { downloadedFile: 'test.exe' });
  assert.equal(probe.states.at(-1).state, 'downloaded');
  // 变异：把 getState 的 phase 改回只回 pending → 本测试红
  assert.equal(probe.controller.getState().phase, 'downloaded');
});

test('下载中的阶段与进度必须能被重新查询到', async () => {
  const probe = setup(signedNotes(false, ''));
  await probe.controller.check();
  probe.engine.emit('download-progress', { percent: 42, bytesPerSecond: 1024, transferred: 42, total: 100 });
  const s = probe.controller.getState();
  assert.equal(s.phase, 'downloading');
  assert.equal(s.progress.percent, 42);
});

test('出错后的阶段必须能被重新查询到', async () => {
  const probe = setup(signedNotes(false, ''));
  await probe.controller.check();
  probe.engine.emit('error', new Error('网络中断'));
  const s = probe.controller.getState();
  assert.equal(s.phase, 'error');
  assert.match(s.error, /网络中断/);
});

// ================================================================ 8. 安装前置

test('安装入口必须拒绝尚未下载的更新，并回传可读原因', async () => {
  const probe = setup(signedNotes(false, ''));
  await probe.controller.check();
  const result = probe.controller.install();
  // 变异：install 去掉 phase==='downloaded' 前置 → 本测试红
  assert.equal(result.ok, false, '未下载却接受安装意图 —— 用户点了没反应');
  assert.match(result.error, /尚未下载/);
});

test('下载完成后才允许安装', async () => {
  const probe = setup(signedNotes(false, ''));
  await probe.controller.check();
  probe.engine.emit('update-downloaded', { downloadedFile: 'test.exe' });
  const result = probe.controller.install();
  // 安装会 setImmediate 调 quitAndInstall；沙箱里 setImmediate 是空实现，安全
  assert.equal(result.ok, true, '已下载完成却拒绝安装');
});

// ================================================================ 9. 发布工作流

test('发布工作流在 electron-builder 之前必须构建前端产物（frontend/dist）', () => {
  const yaml = require(path.join(frontendRoot, 'node_modules/js-yaml'));
  const workflow = yaml.load(
    fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
  );
  const steps = workflow.jobs.release.steps;
  const hasBuild = (items) => items.some((s) => /npm run build(?:\s|$)/.test(s.run || ''));

  // 正对照：确保扫描器本身有效（否则「没找到」的结论可能是假绿）
  assert.equal(hasBuild([{ run: 'npm run build' }]), true, '正对照未命中：扫描器失效');

  const packagingIndex = steps.findIndex((s) => (s.run || '').includes('electron-builder'));
  assert.ok(packagingIndex > 0, '未找到 electron-builder 步骤');
  // 变异：把 npm run build 步骤从工作流删掉 → 本测试红
  assert.equal(
    hasBuild(steps.slice(0, packagingIndex)),
    true,
    '打包前没有构建 frontend/dist —— 干净 runner 上 dist 不存在，产物为空'
  );
});
