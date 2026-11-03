'use strict';
/**
 * 桌宠启动器的守卫：**仓外启动器已收敛进仓库**，本测试守住收敛后的三条底线。
 *
 * <p><b>为什么要测这个：</b>启动器原来住 `.lingxi/tools/pet-launcher.cjs`（仓外、被 gitignore），
 * 里面有三处 `D:/Code/LingXi/...` 硬编码绝对路径与一份自己猜的端口。换机器、换用户名、
 * 换 worktree 目录就失效，而且 CI 根本看不到它（文件不在仓库里）。
 * 现在逻辑进了 `electron/pet-launcher.cjs` + `electron/pet-launcher-config.cjs`：
 * 路径相对 `__dirname`、端口与入口页只从单一真源取。</p>
 *
 * <p>纯 Node 可跑（不 require electron）：{@link module:'electron/pet-launcher-config'} 被特意
 * 拆成不依赖 electron 的纯函数，就是为了让"路径/端口怎么解析"这件事能被单测覆盖。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const ENDPOINT = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-endpoint.cjs'));
const LAUNCHER_CONFIG = require(path.join(FRONTEND_ROOT, 'electron', 'pet-launcher-config.cjs'));

/**
 * 读取前端目录下的相对文件。
 *
 * @param {string} relative 相对 frontend/ 的路径
 * @returns {string} 文件内容
 */
function read(relative) {
  return fs.readFileSync(path.join(FRONTEND_ROOT, relative), 'utf8');
}

/**
 * 去掉注释，只留代码（扫描硬编码时不该把"注释里讲历史"算成违规）。
 *
 * <p>够用即可：本仓库的启动器只有 `//` 与块注释两种写法，且字符串里没有 `//` 片段的用法。</p>
 *
 * @param {string} source 源码
 * @returns {string} 去掉注释的源码
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('配置解析：默认 origin 来自单一真源，入口地址挂在真源的入口页上', () => {
  const config = LAUNCHER_CONFIG.resolveLauncherConfig({ dirname: path.join(FRONTEND_ROOT, 'electron'), env: {} });
  assert.equal(config.origin, ENDPOINT.buildDevOrigin());
  assert.equal(config.originSource, 'single-source');
  assert.equal(config.entryPage, ENDPOINT.DEV_ENDPOINT.entryPage);
  assert.equal(config.entryUrl, `${ENDPOINT.buildDevOrigin()}/${ENDPOINT.DEV_ENDPOINT.entryPage}`);
});

test('配置解析：ELECTRON_URL 合法时可覆盖（排障用），并去掉结尾斜杠', () => {
  const config = LAUNCHER_CONFIG.resolveLauncherConfig({
    dirname: path.join(FRONTEND_ROOT, 'electron'),
    env: { ELECTRON_URL: ' http://127.0.0.1:5399/// ' },
  });
  assert.equal(config.origin, 'http://127.0.0.1:5399');
  assert.equal(config.originSource, 'env');
  assert.equal(config.entryUrl, `http://127.0.0.1:5399/${ENDPOINT.DEV_ENDPOINT.entryPage}`);
  assert.deepEqual(config.notes, []);
});

test('配置解析：非法覆盖值一律回退真源并给出可读说明（不抛错、不猜）', () => {
  for (const bad of ['not a url', 'ftp://127.0.0.1:1', 'file:///tmp/x', '   ']) {
    const resolved = LAUNCHER_CONFIG.resolveLauncherOrigin(bad);
    assert.equal(resolved.origin, ENDPOINT.buildDevOrigin(), `非法值 ${JSON.stringify(bad)} 必须回退真源`);
    assert.equal(resolved.source, 'single-source');
    if (bad.trim().length > 0) assert.ok(resolved.note.length > 0, `非法值 ${JSON.stringify(bad)} 必须给出说明`);
  }
});

test('路径解析：前端根来自 dirname、userData 落在仓外 tmp 目录，且可被 PET_USER_DATA 覆盖', () => {
  const dirname = path.join(FRONTEND_ROOT, 'electron');
  const config = LAUNCHER_CONFIG.resolveLauncherConfig({ dirname, env: {} });
  assert.equal(config.frontendRoot, FRONTEND_ROOT);
  assert.equal(config.repoRoot, path.dirname(FRONTEND_ROOT));
  const expectedUserData = path.join(config.repoRoot, '.lingxi', 'tmp', LAUNCHER_CONFIG.DEFAULT_USER_DATA_NAME);
  assert.equal(config.userDataDir, expectedUserData);
  assert.equal(config.userDataDir.startsWith(config.frontendRoot), false, 'userData 不许落在源码树里');

  const overridden = LAUNCHER_CONFIG.resolveLauncherConfig({
    dirname,
    env: { PET_USER_DATA: path.join(config.repoRoot, '.lingxi', 'tmp', 'other-profile') },
  });
  assert.equal(overridden.userDataDir, path.join(config.repoRoot, '.lingxi', 'tmp', 'other-profile'));
});

test('路径解析：dirname 非法当场抛 TypeError（不允许静默解析出错误目录）', () => {
  assert.throws(() => LAUNCHER_CONFIG.resolveLauncherPaths(''), TypeError);
  assert.throws(() => LAUNCHER_CONFIG.resolveLauncherPaths(null), TypeError);
});

test('启动器源码：不得写死绝对路径（收敛前的老缺陷）', () => {
  const offenders = [];
  for (const relative of ['electron/pet-launcher.cjs', 'electron/pet-launcher-config.cjs']) {
    // 只看代码，不看注释：注释里写"以前这里硬编码 D:/Code/LingXi/..."是正当的历史说明
    const code = stripComments(read(relative));
    for (const marker of ['D:/', 'D:\\', 'C:/', 'C:\\', '/Code/LingXi', '\\Code\\LingXi']) {
      if (code.includes(marker)) offenders.push(`${relative} 含绝对路径片段 ${marker}`);
    }
  }
  assert.deepEqual(offenders, [], `启动器里出现硬编码绝对路径：\n${offenders.join('\n')}`);
});

test('启动器源码：走单一真源（require 端点模块）+ 单实例锁，不自己猜端口', () => {
  const configSource = read('electron/pet-launcher-config.cjs');
  assert.match(configSource, /require\('\.\/pet-dev-endpoint\.cjs'\)/, '配置层必须 require 端点真源');
  assert.match(configSource, /buildDevOrigin\(\)/, '默认 origin 必须来自真源的 buildDevOrigin()');
  assert.match(configSource, /DEV_ENDPOINT\.entryPage/, '入口页必须取自 DEV_ENDPOINT.entryPage');

  const launcherSource = read('electron/pet-launcher.cjs');
  assert.match(launcherSource, /require\('\.\/pet-launcher-config\.cjs'\)/, '启动器必须走配置层，不许自己解析');
  assert.match(launcherSource, /requestSingleInstanceLock\(\)/, '必须用单实例锁，否则会开出两个桌宠窗口');
  assert.match(launcherSource, /probePetDevServer\(/, '启动窗口前必须做内容指纹探活');
});

test('入口：package.json 提供 pet:dev，且薄壳 pet-up.cmd 只是转调它', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = pkg.scripts['pet:dev'];
  assert.equal(typeof script, 'string', 'package.json 缺少 pet:dev 脚本');
  assert.match(script, /scripts\/pet-dev-server\.cjs --ensure/, 'pet:dev 必须先确保 dev server 就绪');
  assert.match(script, /electron electron\/pet-launcher\.cjs/, 'pet:dev 必须拉起仓内启动器');

  const shell = read('pet-up.cmd');
  assert.match(shell, /npm run pet:dev/, 'pet-up.cmd 只允许转调 npm run pet:dev');
  assert.equal(/node\s+.*\.cjs/.test(shell), false, 'pet-up.cmd 不许再自己跑 node 脚本（逻辑必须待在仓库里的模块中）');
  assert.equal(shell.includes(String(ENDPOINT.DEV_ENDPOINT.port)), false, 'pet-up.cmd 不许出现端口字面量');
});
