#!/usr/bin/env node
/**
 * 探活/端口隔离的**变异自检**：证明新增测试真的会红，而不是"写了个总能过的测试"。
 *
 * <p><b>为什么需要它：</b>"桌宠窗口加载成主应用界面"这个缺陷之所以能上线，是因为
 * 探活只看状态码——它永远不会红。修完以后如果新测试同样不会红，等于什么都没修。
 * 所以每次改动都用一个变异体（mutation）验证：把防护拿掉，测试<b>必须</b>挂。</p>
 *
 * <p>本脚本对每个变异体做三件事，缺一步就算 FAIL：</p>
 * <ol>
 *   <li>先跑一次目标测试文件，确认<b>绿</b>（否则后面的"红"毫无意义）；</li>
 *   <li>注入变异（字符串替换，要求命中<b>恰好一处</b>，命中数不为 1 直接中止）；</li>
 *   <li>再跑一次，要求<b>非 0 退出</b>且输出里出现预期断言文本。</li>
 * </ol>
 *
 * <p><b>安全约束：</b>变异只作用于源码文本，备份放在进程内存里；每个变异体结束后
 * 立刻按字节还原并比对 SHA-256，全部结束再跑一遍目标测试确认回到绿。
 * 中转路径不落任何临时文件，异常/中断也会尽量还原。</p>
 *
 * 用法：`npm run test:pet:mutate`
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 树身份判据（与守卫/启动器共用同一份实现，避免两套判据漂移）。
 *
 * <p>该模块是 **ESM**（Vite 配置只能加载 ESM：CJS 里的 `require('node:crypto')` 会被
 * esbuild 打成动态 require 垫片并抛错），所以用静态 `import` 载入，不能用
 * `createRequire`。变异体改的是磁盘源文件、由子进程加载，不污染本进程已载入的副本。</p>
 */
import { verifyOwnTree, TREE_IDENTITY } from '../electron/pet-tree-fingerprint.mjs';

/** 前端根目录（脚本位于 `frontend/scripts/`）。 */
const FRONTEND_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 仓库根目录（`.gitignore` 与美术资产都在这一层，git 命令一律 `-C` 到这里）。 */
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');

/** 桌宠端口真源（只在自检里用来判断"端口上是谁家的 dev server"，绝不写死端口）。 */
const { DEV_ENDPOINT, buildDevOrigin } = createRequire(import.meta.url)(
  path.join(FRONTEND_ROOT, 'electron', 'pet-dev-endpoint.cjs'),
);


/**
 * 变异体清单。
 *
 * <p>每个变异体都必须对应一条真实修复点，`expect` 里写的是"测试红起来时输出里必然出现的
 * 断言消息"——只判退出码不够：测试可能因为语法错误而红，那是假红。</p>
 */
/**
 * 入口页字面量（运行时拼出来）。
 *
 * <p><b>为什么不在源码里直接写：</b>本文件也在「单一真源扫描」的消费方清单里
 * （`tests/petDevEndpoint.test.cjs` 会扫描代码里的 `pet.html` 字面量），
 * 而变异体恰恰要**故意**造出一个硬编码。用拼接构造既能让变异体生效，
 * 又不会让扫描器误报自己。</p>
 *
 * @type {string}
 */
const ENTRY_PAGE_LITERAL = ['pet', 'html'].join('.');

const MUTATIONS = [
  {
    id: 'probe-no-fingerprint',
    goal: '探活退回"只看状态码"（原始缺陷）：200 + 主应用 index.html 必须被判失败',
    file: 'electron/pet-dev-probe.cjs',
    find: 'const missingMarkers = PET_PAGE_MARKERS.filter((marker) => !body.includes(marker));',
    replace: 'const missingMarkers = [];',
    testFile: 'tests/petDevProbe.test.cjs',
    expect: '200 但内容是主应用 index.html',
  },
  {
    id: 'strict-port-off',
    goal: '关掉 strictPort：端口被占时 Vite 会静默 +1 漂移，测试必须红',
    file: 'electron/pet-dev-endpoint.cjs',
    find: 'strictPort: true,',
    replace: 'strictPort: false,',
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: 'strictPort 必须是 true',
  },
  {
    id: 'app-type-spa',
    goal: `把 appType 改回 spa（history fallback 复活）：/${ENTRY_PAGE_LITERAL} 又会兜成 index.html`,
    file: 'electron/pet-dev-endpoint.cjs',
    find: "appType: 'mpa',",
    replace: "appType: 'spa',",
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: 'appType 必须是 mpa',
  },
  {
    id: 'ensure-starts-anyway',
    goal: '去掉"端口被非桌宠占用"的早退：会白抢一轮锁并多做一次探活，必须被抓住',
    file: 'scripts/pet-dev-server.cjs',
    find: '  if (first.reason !== PROBE_REASON.NO_SERVICE) {',
    replace: '  if (false) {',
    testFile: 'tests/petDevServer.test.cjs',
    expect: '端口被占用时不该白抢一次锁',
  },
  {
    id: 'entry-page-literal',
    goal: `K4 回退：窗口入口页改回字面量（dev 分支不再取真源 ${ENTRY_PAGE_LITERAL}）`,
    file: 'electron/pet-window.cjs',
    find: 'return { kind: \'url\', value: `${resolveDevEntryUrl(rawUrl)}${PET_ENTRY_PAGE}` };',
    replace: 'return { kind: \'url\', value: `${resolveDevEntryUrl(rawUrl)}' + ENTRY_PAGE_LITERAL + '` };',
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: '在代码里写死了入口页名',
  },
  {
    id: 'body-stall-as-network-error',
    goal: 'K1 回退：响应体停滞重新被判成 network-error（exit 6），与文档的 exit 5 冲突',
    file: 'electron/pet-dev-probe.cjs',
    find: 'return { reason: PROBE_REASON.TIMEOUT, cause: PROBE_CAUSE.BODY_TIMEOUT, detail: verdict.detail };',
    replace: 'return { reason: PROBE_REASON.NETWORK_ERROR, cause: PROBE_CAUSE.NETWORK_ERROR, detail: verdict.detail };',
    testFile: 'tests/petDevProbe.test.cjs',
    expect: '响应体停滞必须归入 timeout',
  },
  {
    id: 'lock-ignored-spawn-anyway',
    goal: 'K3 回退：拿不到锁也当拿到（并发时静默拉起第二个 dev server）',
    file: 'scripts/pet-dev-server.cjs',
    find: "    if (claim.acquired) return { acquired: true, lock: claim, reason: '' };",
    replace: "    if (true) return { acquired: true, lock: claim, reason: '' };",
    testFile: 'tests/petDevServer.test.cjs',
    expect: '拿不到锁时绝不允许 spawn 第二个 dev server',
  },
  // ---- M1 / T01：安装版门禁与产物守卫（用户硬约束 #3：打包态不得出现桌宠入口）----
  {
    id: 'gate-always-enabled',
    goal: '安装版门禁恒真（打包态返回 enabled:true）：装好的 LX 一启动就会冒出桌宠窗口',
    file: 'electron/pet-feature-gate.cjs',
    find: '  if (isPackaged) return { enabled: false, reason: PET_EXPOSURE_REASON.PACKAGED };',
    replace: '  if (isPackaged) return { enabled: true, reason: PET_EXPOSURE_REASON.DEV };',
    testFile: 'tests/petFeatureGate.test.cjs',
    expect: '安装版必须不暴露桌宠',
  },
  {
    id: 'pet-window-ungated',
    goal: "把 pet.show() 的门禁拆掉（require('./pet-window.cjs') 变无条件）：安装版也会创建桌宠窗口",
    file: 'electron/main.cjs',
    // 锚点用 \n 书写即可：applyMutation 会按目标文件的行尾风格自动适配（CRLF/LF 都吃得下）
    find:
      'const pet = petExposure.enabled\n' +
      "  ? require('./pet-window.cjs').registerPetWindow({ ipcMain, isDev, frontendRoot })\n" +
      '  : createDisabledPet();',
    replace: "const pet = require('./pet-window.cjs').registerPetWindow({ ipcMain, isDev, frontendRoot });",
    testFile: 'tests/petFeatureGate.test.cjs',
    expect: '桌宠窗口模块被无条件 require',
  },
  {
    id: 'pet-entry-back-in-build',
    goal: `pet 入口回流生产构建（vite input 加回 pet）：dist/${ENTRY_PAGE_LITERAL} 会跟着进安装包`,
    file: 'vite.config.ts',
    find: "        notification: resolve(__dirname, 'notification.html'),",
    // 入口页名运行时拼出来：本文件也在「单一真源扫描」的消费方清单里，
    // 源码里出现连续的入口页字面量会被 tests/petDevEndpoint.test.cjs 判成硬编码。
    replace:
      "        notification: resolve(__dirname, 'notification.html'),\n" +
      "        pet: resolve(__dirname, '" + ENTRY_PAGE_LITERAL + "'),",
    testFile: 'tests/petNotShipped.test.cjs',
    expect: '生产构建入口里仍有桌宠入口',
  },
  {
    id: 'pet-data-back-in-build-files',
    goal: 'build.files 回流 pet 数据（pet-geometry.json）：安装包里带上桌宠几何真源',
    file: 'package.json',
    find: '      "electron/**/*",\n      "package.json"',
    replace: '      "electron/**/*",\n      "pet-geometry.json",\n      "package.json"',
    testFile: 'tests/petNotShipped.test.cjs',
    expect: 'build.files 里仍有桌宠数据',
  },
  // ---------------------------------------------------------------- T03：表现层接入
  {
    id: 'face-layer-hidden',
    goal: '把"计划里有可见 face 层"判成 false（T03 断言 2 的反向）：layered 下不再换贴片，而是回落整帧',
    file: 'src/pet/presentation/layered-presentation.ts',
    find: 'return this.visibleLayerIds.has(FACE_LAYER_ID);',
    replace: 'return false;',
    testFile: 'tests/petFaceLayer.test.ts',
    expect: '脸层 src 必须指向该档贴片',
  },
  {
    id: 'fallback-removed',
    goal: '删掉整帧回落（partial/composite 下表情彻底看不见）：回落计数断言必须红',
    file: 'src/pet/presentation/layered-presentation.ts',
    find: '    base.apply(op);',
    replace: '    void base;',
    testFile: 'tests/petFaceLayer.test.ts',
    expect: 'partial 下表情必须回落压平帧',
  },
  {
    id: 'face-placement-dropped',
    goal: '挂载时不写 data-placement（T03 断言 1 的反向）：脸贴片会按 contain 错位摆放',
    file: 'src/pet/presentation/layered-presentation.ts',
    find: '    if (placement) applyRectPlacement(element, placement);',
    replace: '    if (placement) void placement;',
    testFile: 'tests/petFaceLayer.test.ts',
    expect: '挂载时就必须写 data-placement',
  },
  {
    id: 'face-tile-selection-off',
    goal: '关闭脸层贴片选择（§11.3 M5 的反向）：applyExpression 改用整帧 expressionUrls，子矩形层被 object-fit:fill 压扁',
    file: 'src/pet/presentation/layered-presentation.ts',
    find: '      const tileUrl = this.faceTiles[id];',
    replace: '      const tileUrl = this.deps.expressionUrls[id] ?? this.faceTiles[id];',
    testFile: 'tests/petFaceLayer.test.ts',
    expect: '脸层 angry 必须用贴片 URL',
  },
  // ---------------------------------------------------------------- T04：眨眼 / 行为
  {
    id: 'wink-takes-blink',
    goal: 'wink 顶替 blink（§5.2 第 2 条的反向）：回礼眨眼会被演成生理眨眼',
    file: 'src/pet/presentation/blink-driver.ts',
    find: "  wink: 'wink',",
    replace: "  wink: 'blink',",
    testFile: 'tests/petBlinkWink.test.ts',
    expect: 'wink 必须指向 wink 自己的贴片',
  },
  {
    id: 'half-back-to-sleepy',
    goal: '半闭帧退回 sleepy（E08 判据的反向）：每眨一次眼嘴型跟着抖一下',
    file: 'src/pet/presentation/blink-driver.ts',
    find: "  half: 'blinkHalf',",
    replace: "  half: 'sleepy',",
    testFile: 'tests/petBlinkWink.test.ts',
    expect: '半闭帧必须是独立档',
  },
  {
    id: 'long-drag-sad-removed',
    goal: '长拖拽不再委屈（§6 表 E04 的反向）：拖久了松手没有任何反馈',
    file: 'src/pet/behavior/state-machine.ts',
    find: '    if (dragMs >= SAD_DRAG_MS) {',
    replace: '    if (dragMs >= SAD_DRAG_MS && false) {',
    testFile: 'tests/petBehaviorTriggers.test.ts',
    expect: '长拖拽（≥1200ms）松手必须产出 sad 表情',
  },
  // ---------------------------------------------------------------- E08 / P4：困倦与真睡不得同形
  {
    id: 'sleep-expression-back-to-sleepy',
    goal: '真睡的表达式改回 sleepy（E08 两档同形的原始缺陷）：§6 的"两档不得同形"用例必须红',
    file: 'src/pet/behavior/state-machine.ts',
    find: "      expressionOp('blink', 0, 'behavior:sleep:expression', undefined, 'base'),",
    replace: "      expressionOp('sleepy', 0, 'behavior:sleep:expression', undefined, 'base'),",
    testFile: 'tests/petBehaviorTriggers.test.ts',
    expect: '真睡档必须是闭眼贴片',
  },
  {
    id: 'sleep-expression-back-to-sleepy-guard',
    goal: '同上变异，但验收层换成真实 offscreen 画面守卫：E08 sleepy-vs-sleeping（P4）那条必须变红',
    file: 'src/pet/behavior/state-machine.ts',
    find: "      expressionOp('blink', 0, 'behavior:sleep:expression', undefined, 'base'),",
    replace: "      expressionOp('sleepy', 0, 'behavior:sleep:expression', undefined, 'base'),",
    // 守卫只跑 E08/E03 组（快），截图落独立目录，避免覆盖正式验收的证据图
    command:
      'npm run guard:pet:face -- --only E08,E03 --out D:/Code/LingXi/.lingxi/tmp/pet-face-guard/mutant-p4',
    // 守卫会复用端口上已在跑的 dev server：端口属于别的工作区时，这条无法在本工作区复验
    requiresOwnDevServer: true,
    expect: 'FAIL(两档同形)',
  },
  {
    id: 'identity-meta-always-own',
    goal: '把树身份判据改成恒真（页面注入的指纹与本地不一致也判"自己人"）：守卫就会把别人的代码当成 PASS，身份用例必须变红',
    file: 'electron/pet-tree-fingerprint.mjs',
    find: '    const own = remoteDigest === local.digest;',
    replace: '    const own = true;',
    testFile: 'tests/petDevIdentity.test.cjs',
    expect: '另一棵树',
  },
  {
    id: 'identity-json-fallback-always-own',
    goal: '把兜底判据（没有注入指纹时比对清单字节）改成永不算不一致：另一棵树的 dev server 会被当成自己人，身份用例必须变红',
    file: 'electron/pet-tree-fingerprint.mjs',
    find: '    if (remote.body !== localText) mismatches.push(relFile);',
    replace: '    if (false) mismatches.push(relFile);',
    testFile: 'tests/petDevIdentity.test.cjs',
    expect: '另一棵树',
  },
  {
    id: 'identity-guard-foreign-branch-removed',
    goal: '判据算对了但守卫不处置：把 assertOwnTree 的 FOREIGN 分支从"抛错（退出码 2）"改成"打个日志继续测量"——这正是"验了别人的代码却报 PASS"的缺陷形态，接线断言必须变红',
    file: 'scripts/pet-face-visual-guard.cjs',
    find: '    throw new Error(`端口 ${origin} 上跑的是另一棵树，守卫无法证明自己验的是本地代码（已停止，不是 PASS）`);',
    replace: '    return;',
    testFile: 'tests/petDevIdentity.test.cjs',
    expect: 'FOREIGN 必须抛出',
  },
  // ---------------------------------------------------------------- 美术资产入库（不许再靠 git add -f）
  {
    id: 'gitignore-desktop-pet-exception-removed',
    goal: '把 .gitignore 退回"整目录忽略 docs/"（原始缺陷）：新批次资产会被静默吞掉，入库守卫必须红',
    // 规则文件在仓库根，`../` 相对 frontend/ 解析
    file: '../.gitignore',
    find: ['/docs/*', '!/docs/assets/', '/docs/assets/*', '!/docs/assets/desktop-pet/'].join('\n'),
    replace: 'docs/',
    testFile: 'tests/petAssetTracking.test.cjs',
    expect: '个资产被 .gitignore 吞掉',
  },
  {
    id: 'tracked-asset-removed-from-index',
    goal: '对已跟踪资产执行等价 `git rm --cached`（文件留在磁盘）："交付了但不可复现"必须被 Index 断言抓到',
    kind: 'index',
    indexPath: 'docs/assets/desktop-pet/v3/expr/E1_default.png',
    testFile: 'tests/petAssetTracking.test.cjs',
    expect: '个资产在磁盘上但没入库',
  },
  {
    id: 'delivered-prefix-missing-batch-emptied',
    goal:
      '模拟"DELIVERED_PREFIXES 漏加一个批次" + 该批次被整批清空索引（一次性的临时索引副本，工作区文件不动）：'
      + '以前这种情况只打一行 console 警告、测试仍绿；现在必须靠"git 历史里出现过该路径"这条断言变红',
    kind: 'batch-index',
    // 从 DELIVERED_PREFIXES 里删掉 poses/sit/（锚点带后缀逗号，保证命中恰好一处）
    file: 'tests/petAssetTracking.test.cjs',
    find: "'poses/sit/', ",
    replace: '',
    batchPath: 'docs/assets/desktop-pet/poses/sit',
    testFile: 'tests/petAssetTracking.test.cjs',
    expect: '在 git 历史里存在（曾交付过），但索引为空',
  },
  // ---------------------------------------------------------------- 启动器收敛（不许绕过单一真源 / 不许写死绝对路径）
  {
    id: 'launcher-port-literal',
    goal: '启动器配置层把默认 origin 写成端口字面量（绕过单一真源）：单一真源扫描必须红',
    file: 'electron/pet-launcher-config.cjs',
    find: "  if (text.length === 0) return { origin: buildDevOrigin(), source: 'single-source', note: '' };",
    // 端口真值在运行时从真源取：脚本自身因此不含端口字面量（它也在单一真源扫描清单里），
    // 但注入到目标文件里的是一段真正的字符串字面量，扫描器应当抓到。
    replace: `  if (text.length === 0) return { origin: 'http://127.0.0.1:${String(DEV_ENDPOINT.port)}', source: 'single-source', note: '' };`,
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: '出现端口字面量',
  },
  {
    id: 'launcher-absolute-path',
    goal: '启动器退回硬编码绝对路径（收敛前的老缺陷）：换机器就失效，启动器守卫必须红',
    file: 'electron/pet-launcher-config.cjs',
    find: "  const frontendRoot = path.resolve(dirname, '..');",
    replace: `  const frontendRoot = '${['D:', 'Code', 'LingXi', 'frontend'].join('/')}';`,
    testFile: 'tests/petLauncher.test.cjs',
    expect: '硬编码绝对路径',
  },
];

/** 当前在飞的变异：绝对路径 → 原始文本（进程被中断时据此还原）。 */
const INFLIGHT = new Map();

/**
 * 还原全部在飞变异。
 *
 * @returns {void}
 */
function restoreAll() {
  for (const [absPath, original] of INFLIGHT) {
    try {
      writeFileSync(absPath, original, 'utf8');
    } catch (err) {
      console.error(`[mutate] 还原失败：${absPath}（${(err && err.message) || err}）`);
    }
  }
  INFLIGHT.clear();
  // 索引变异没有"文件内容"可还原：把被摘出的文件重新 git add 回索引
  while (INFLIGHT_INDEX.length > 0) {
    const revert = INFLIGHT_INDEX.pop();
    try {
      revert();
    } catch (err) {
      console.error(`[mutate] 索引还原失败（请手动 git add 对应资产）：${(err && err.message) || err}`);
    }
  }
}

// 进程被信号打断时也必须还原，否则会把变异体留在工作区
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  restoreAll();
  console.error(`[mutate] 未捕获异常：${(err && err.stack) || err}`);
  process.exit(1);
});

/**
 * 计算文本 SHA-256（还原后逐字节比对用）。
 *
 * @param {string} text 文本
 * @returns {string} 十六进制摘要
 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 跑一个变异体的**验证目标**。
 *
 * <p>三种目标，按变异体声明择一：</p>
 * <ul>
 *   <li>`testFile`（`.cjs`）：`node --test` 原生跑；</li>
 *   <li>`testFile`（`.ts`）：过 `tsx`（node 原生不理解 TS，直接喂只会得到语法错误——
 *       那种"红"是假红，会污染变异自检的信噪比）；</li>
 *   <li>`command`：整条 shell 命令（用于 Electron offscreen 画面守卫这类
 *       **不是** node:test 用例的目标，例如 `npm run guard:pet:face -- --only E08,E03`）。</li>
 * </ul>
 *
 * @param {{testFile?: string, command?: string}} mutation 变异体
 * @param {Record<string, string>} [envOverride] 额外环境变量（整批索引变异用它把
 *   子进程的 `GIT_INDEX_FILE` 指到一次性索引副本；不传就用真实索引）
 * @returns {{ok: boolean, code: number, out: string, ms: number}} 运行结果
 */
function runTarget(mutation, envOverride) {
  const started = Date.now();
  const baseCommand = typeof mutation.command === 'string' && mutation.command.length > 0 ? mutation.command : null;
  // 画面守卫类变异体默认打端口真源（5275）。若该端口被**别的工作树**占着，自检没法在本工作区
  // 复验，只能 SKIP；这时可以用 `PET_GUARD_ORIGIN` 把守卫指向本树自己的实例（例如
  // `npx vite --config vite.pet.config.ts --port 5287`），让变异体真正跑起来。
  const selfOrigin = process.env.PET_GUARD_ORIGIN || '';
  const command = baseCommand && mutation.requiresOwnDevServer === true && selfOrigin
    ? `${baseCommand} --origin ${selfOrigin}`
    : baseCommand;
  const testFile = String(mutation.testFile || '');
  const env = envOverride ? { ...process.env, ...envOverride } : process.env;
  let proc;
  if (command) {
    proc = spawnSync(command, { cwd: FRONTEND_ROOT, encoding: 'utf8', shell: true, env });
  } else if (/\.(ts|mts|tsx)$/.test(testFile)) {
    proc = spawnSync(`npx tsx --test "${testFile}"`, { cwd: FRONTEND_ROOT, encoding: 'utf8', shell: true, env });
  } else {
    proc = spawnSync(process.execPath, ['--test', testFile], { cwd: FRONTEND_ROOT, encoding: 'utf8', env });
  }
  const code = typeof proc.status === 'number' ? proc.status : 1;
  return {
    ok: code === 0,
    code,
    out: `${proc.stdout || ''}${proc.stderr || ''}`,
    ms: Date.now() - started,
  };
}

/**
 * 把锚点文本的行尾统一成目标文件的行尾风格。
 *
 * <p><b>为什么必须有这一步：</b>同一份仓库里既有 CRLF 也有 LF（`core.autocrlf=true` 会把
 * checkout 出来的文件转成 CRLF，而脚本自己写出来的文件是 LF）。变异锚点写成写死的那一种，
 * 换台机器/换一次 checkout 就会"命中 0 处"，自检直接失效——而它失效的方式是**报错**，
 * 还算诚实；真正危险的是有人为了让它过而把锚点改短。所以这里按目标文件自动适配。</p>
 *
 * @param {string} text 锚点文本（用 `\n` 写即可）
 * @param {string} reference 目标文件全文（用来判定行尾风格）
 * @returns {string} 行尾与目标文件一致的文本
 */
function normalizeEol(text, reference) {
  const crlf = String(reference).includes('\r\n');
  const unified = String(text).replace(/\r\n/g, '\n');
  return crlf ? unified.replace(/\n/g, '\r\n') : unified;
}

/**
 * 注入一个变异体。
 *
 * @param {{file: string, find: string, replace: string}} mutation 变异体
 * @returns {{absPath: string, original: string}} 还原所需信息
 * @throws {Error} 命中数不为 1 时抛出
 */
function applyMutation(mutation) {
  const absPath = path.join(FRONTEND_ROOT, mutation.file);
  const original = readFileSync(absPath, 'utf8');
  const find = normalizeEol(mutation.find, original);
  const replace = normalizeEol(mutation.replace, original);
  const occurrences = original.split(find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.id}：变异锚点在 ${mutation.file} 命中 ${occurrences} 处（应为 1），源码结构可能已变，请同步脚本`);
  }
  INFLIGHT.set(absPath, original);
  writeFileSync(absPath, original.replace(find, replace), 'utf8');
  return { absPath, original };
}

/**
 * 还原一个变异体并校验逐字节一致。
 *
 * @param {string} absPath 文件绝对路径
 * @param {string} original 原始文本
 * @returns {boolean} 是否逐字节还原
 */
function restoreMutation(absPath, original) {
  writeFileSync(absPath, original, 'utf8');
  const now = readFileSync(absPath, 'utf8');
  INFLIGHT.delete(absPath);
  return sha256(now) === sha256(original);
}

/**
 * 在飞的**索引变异**还原栈（进程被中断时据此把索引恢复）。
 *
 * <p>索引变异不改变文件内容，只把文件从索引里摘掉；一旦进程被杀而没有还原，
 * 工作区就会留下"文件在磁盘上、索引里没有"的假象。所以这里单独维护一层还原栈。</p>
 *
 * @type {Array<() => void>}
 */
const INFLIGHT_INDEX = [];

/**
 * 跑一条 git 命令（变异自检内部用，只关心是否成功）。
 *
 * @param {string[]} args git 参数
 * @returns {{ok: boolean, out: string}} 结果
 */
function runGitForMutation(args) {
  const proc = spawnSync('git', ['-C', REPO_ROOT].concat(args), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return {
    ok: proc.status === 0,
    out: `${proc.stdout || ''}${proc.stderr || ''}`.trim(),
  };
}

/**
 * 注入"索引变异"：对已跟踪文件执行等价 `git rm --cached`（**不删磁盘文件**）。
 *
 * <p><b>为什么要这种变异体：</b>"交付了但不可复现"的原始形态就是"磁盘上有、索引里没有"。
 * 只测 ignore 规则抓不到它（规则明明放行了，只是没人 `git add`），
 * 必须靠逐文件比对索引的断言来抓。</p>
 *
 * @param {{indexPath: string}} mutation 变异体（`indexPath` 为仓库相对路径）
 * @returns {{indexPath: string, absPath: string, digest: string}} 还原所需信息
 * @throws {Error} 文件不在索引里、或 `git rm --cached` 失败时抛出
 */
function applyIndexMutation(mutation) {
  const indexPath = String(mutation.indexPath || '');
  if (!indexPath) throw new Error(`${mutation.id}：缺少 indexPath`);
  const absPath = path.join(REPO_ROOT, indexPath);
  if (!existsSync(absPath)) throw new Error(`${mutation.id}：磁盘上没有 ${indexPath}，变异体无法注入`);
  const tracked = runGitForMutation(['ls-files', '--', indexPath]);
  if (!tracked.ok || tracked.out.length === 0) {
    throw new Error(`${mutation.id}：${indexPath} 本来就不在索引里，无法演示"摘出索引"`);
  }
  const digest = sha256(readFileSync(absPath, 'utf8'));
  const removed = runGitForMutation(['rm', '--cached', '--quiet', '--', indexPath]);
  if (!removed.ok) throw new Error(`${mutation.id}：git rm --cached 失败：${removed.out}`);
  const revert = () => runGitForMutation(['add', '--', indexPath]);
  INFLIGHT_INDEX.push(revert);
  return { indexPath, absPath, digest, revert };
}

/**
 * 还原索引变异：把文件重新 `git add` 回索引，并校验磁盘字节未变、索引已恢复。
 *
 * @param {{indexPath: string, absPath: string, digest: string, revert: () => void}} info 还原信息
 * @returns {boolean} 是否逐字节一致且已回到索引
 */
function restoreIndexMutation(info) {
  const at = INFLIGHT_INDEX.indexOf(info.revert);
  if (at >= 0) INFLIGHT_INDEX.splice(at, 1);
  info.revert();
  const backInIndex = runGitForMutation(['ls-files', '--', info.indexPath]).out.length > 0;
  const digestNow = sha256(readFileSync(info.absPath, 'utf8'));
  return backInIndex && digestNow === info.digest;
}

/**
 * 取仓库的**临时目录根**（`.lingxi/tmp`，运行时产物一律落这里，绝不落源码目录）。
 *
 * @returns {string} 绝对路径（已确保存在）
 */
function tmpRoot() {
  const root = path.join(REPO_ROOT, '.lingxi', 'tmp');
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * 解析真实索引文件的位置（兼容 `.git` 是文件的工作树情形）。
 *
 * @returns {string} 索引文件绝对路径
 * @throws {Error} git 命令失败时抛出
 */
function resolveGitIndexPath() {
  const proc = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
  if (proc.status !== 0) throw new Error(`取不到 git 目录：${(proc.stderr || '').trim()}`);
  return path.join((proc.stdout || '').trim(), 'index');
}

/**
 * 注入"整批索引变异"：删掉 `DELIVERED_PREFIXES` 里的一条（模拟漏加前缀），
 * **并且**在一次性索引副本里把该批次整批 `git rm -r --cached`。
 *
 * <p><b>为什么用一次性索引副本（`GIT_INDEX_FILE`）：</b>变异自检可能与其他队员的任务并发跑，
 * 真实索引是共享资源——把 `poses/sit` 真从索引里摘掉十几秒，别人正好 `git commit` 就会把
 * "删掉 16 个资产"提交进去。副本索引只作用于本进程派生的子进程，工作区文件一个都不动。</p>
 *
 * @param {object} mutation 变异体（需要 `file` / `find` / `replace` / `batchPath`）
 * @returns {{absPath: string, original: string, batchPath: string, tempDir: string, env: Record<string,string>, revert: () => void}}
 *   还原所需信息
 * @throws {Error} 批次不在磁盘/索引、或清空失败时抛出（失败路径会把文本变异一起还原）
 */
function applyBatchIndexMutation(mutation) {
  const batchPath = String(mutation.batchPath || '');
  if (!batchPath) throw new Error(`${mutation.id}：缺少 batchPath`);
  if (!existsSync(path.join(REPO_ROOT, batchPath))) {
    throw new Error(`${mutation.id}：磁盘上没有 ${batchPath}，变异体无法注入`);
  }
  if (runGitForMutation(['ls-files', '--', batchPath]).out.length === 0) {
    throw new Error(`${mutation.id}：${batchPath} 本来就不在索引里，无法演示"整批清空"`);
  }

  // 1) 文本变异：把这一条从 DELIVERED_PREFIXES 里删掉（本任务要修的正是"漏加"）
  const text = applyMutation(mutation);
  const tempDir = mkdtempSync(path.join(tmpRoot(), 'mutate-index-'));
  const tempIndex = path.join(tempDir, 'index');
  try {
    // 2) 一次性索引副本：与真实索引无关
    copyFileSync(resolveGitIndexPath(), tempIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    const removed = spawnSync('git', ['-C', REPO_ROOT, 'rm', '-r', '--cached', '--quiet', '--', batchPath], {
      encoding: 'utf8',
      env,
    });
    if (removed.status !== 0) {
      throw new Error(`${mutation.id}：git rm -r --cached 失败：${(removed.stderr || removed.stdout || '').trim()}`);
    }
    const left = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '--', batchPath], { encoding: 'utf8', env });
    if ((left.stdout || '').trim().length > 0) {
      throw new Error(`${mutation.id}：临时索引里 ${batchPath} 仍有条目，清空失败`);
    }
    const revert = () => rmSync(tempDir, { recursive: true, force: true });
    // 中断兜底：临时索引目录必须清掉，否则会在 .lingxi/tmp 里留下垃圾
    INFLIGHT_INDEX.push(revert);
    return { ...text, batchPath, tempDir, env, revert };
  } catch (err) {
    // 失败路径：先把文本变异还原，绝不把半成品留在工作区
    restoreMutation(text.absPath, text.original);
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 还原"整批索引变异"：文本按字节写回、删除一次性索引副本，并确认真实索引没被动过。
 *
 * @param {{absPath: string, original: string, batchPath: string, tempDir: string, revert: () => void}} info 还原信息
 * @returns {boolean} 文本逐字节一致、临时目录已删、真实索引里该批次仍在
 */
function restoreBatchIndexMutation(info) {
  const textOk = restoreMutation(info.absPath, info.original);
  const at = INFLIGHT_INDEX.indexOf(info.revert);
  if (at >= 0) INFLIGHT_INDEX.splice(at, 1);
  info.revert();
  const tempGone = !existsSync(info.tempDir);
  const backInIndex = runGitForMutation(['ls-files', '--', info.batchPath]).out.length > 0;
  return textOk && tempGone && backInIndex;
}

/**
 * 按变异体的 `kind` 选择注入方式。
 *
 * @param {object} mutation 变异体
 * @returns {object} 还原所需信息
 */
function applyMutationByKind(mutation) {
  if (mutation.kind === 'index') return applyIndexMutation(mutation);
  if (mutation.kind === 'batch-index') return applyBatchIndexMutation(mutation);
  return applyMutation(mutation);
}

/**
 * 按变异体的 `kind` 选择还原方式。
 *
 * @param {object} mutation 变异体
 * @param {object} applied 注入时返回的还原信息
 * @returns {boolean} 是否还原干净
 */
function restoreMutationByKind(mutation, applied) {
  if (mutation.kind === 'index') return restoreIndexMutation(applied);
  if (mutation.kind === 'batch-index') return restoreBatchIndexMutation(applied);
  return restoreMutation(applied.absPath, applied.original);
}

/**
 * 判断桌宠端口上的 dev server 是谁拉起的。
 *
 * <p>画面守卫（`guard:pet:face`）**会复用已在跑的 dev server**；如果端口上是别的
 * 工作树（例如 `.lingxi/work/desktop-pet-visual` 那边的实例）拉起的，守卫看到的就不是
 * 本工作区的源码，注入的变异体自然"测不出来"——那种绿/红都是别人的。</p>
 *
 * <p>判定复用**产品代码同一套判据**（`electron/pet-tree-fingerprint.mjs` 的
 * {@link verifyOwnTree}）：先比 dev server 注入的 `lx-pet-tree` 指纹，退到清单字节比对。
 * 这里刻意不再自己写一套 HTTP 比对 —— 两套判据迟早会漂移，而"守卫与自检对同一件事得出
 * 不同结论"正是最难查的形态。</p>
 *
 * @returns {Promise<'own'|'foreign'|'absent'>} 归属判定（undecidable 归入 absent：守卫会尝试自己拉起）
 */
async function detectDevServerOwner() {
  try {
    const verdict = await verifyOwnTree({
      origin: process.env.PET_GUARD_ORIGIN || buildDevOrigin(),
      entryPage: DEV_ENDPOINT.entryPage,
      frontendRoot: FRONTEND_ROOT,
      timeoutMs: 3000,
    });
    if (verdict.status === TREE_IDENTITY.OWN) return 'own';
    if (verdict.status === TREE_IDENTITY.FOREIGN) return 'foreign';
    return 'absent';
  } catch (err) {
    return 'absent';
  }
}

/** 依次执行全部变异体并汇总。 */
async function main() {
  console.log('[mutate] 桌宠变异自检开始（探活/端口隔离 + 安装版门禁与产物守卫 + 表现层/行为/画面守卫 + 美术资产入库守卫 + 启动器收敛）');
  console.log(`[mutate] 前端根目录：${FRONTEND_ROOT}`);

  const results = [];
  /** 每个验证目标（测试文件 / 命令）的基线（绿）检查只做一次。 */
  const baseline = new Map();

  for (const mutation of MUTATIONS) {
    const targetKey = mutation.command || mutation.testFile;
    console.log('');
    console.log(`=== 变异体 ${mutation.id} ===`);
    console.log(`  目的：${mutation.goal}`);
    console.log(`  位置：${mutation.file || mutation.indexPath}${mutation.batchPath ? ` + 一次性索引副本清空 ${mutation.batchPath}` : ''}`);
    if (mutation.command) console.log(`  验证目标（命令）：${mutation.command}`);

    // 依赖真实 dev server 的变异体（画面守卫）：端口上是别人家的 server 就不要假装验证过
    if (mutation.requiresOwnDevServer === true) {
      const owner = await detectDevServerOwner();
      if (owner === 'foreign') {
        console.log('  跳过（环境）：桌宠端口上已有**其他工作区**拉起的 dev server，本工作区的变异无法被观测');
        console.log('        为什么无法判定：端口真源被别的树占用，守卫已改为"报错拒绝验证"而不是验错树（这是正确行为）');
        console.log('        怎么修（二选一）：a) 停掉那个实例后重跑；');
        console.log('                       b) 在本树起独立端口的 dev server：');
        console.log('                          npx vite --config vite.pet.config.ts --port 5287 --strictPort');
        console.log('                          然后 PET_GUARD_ORIGIN=http://127.0.0.1:5287 npm run test:pet:mutate');
        console.log('        （这里不会把它记成 PASS）');
        results.push({ id: mutation.id, passed: true, skipped: true, reason: '端口被其他工作区的 dev server 占用' });
        continue;
      }
      console.log(`  前置：dev server 归属=${owner}（absent 表示守卫会自己拉一个）`);
    }

    if (!baseline.has(targetKey)) {
      const green = runTarget(mutation);
      baseline.set(targetKey, green.ok);
      console.log(`  基线（变异前）：${green.ok ? '绿 OK' : '红 FAIL'}  用时 ${green.ms}ms`);
      if (!green.ok) {
        console.log(green.out);
        results.push({ id: mutation.id, passed: false, reason: `基线未通过：${targetKey}` });
        continue;
      }
    }

    let applied = null;
    let outcome;
    try {
      applied = applyMutationByKind(mutation);
      const red = runTarget(mutation, applied && applied.env);
      const sawExpected = red.out.includes(mutation.expect);
      console.log(`  变异后：退出码 ${red.code}（要求非 0）· 断言文本"${mutation.expect}" ${sawExpected ? '出现 OK' : '未出现 FAIL'}`);
      if (red.ok) {
        console.log(red.out);
      }
      outcome = {
        id: mutation.id,
        passed: !red.ok && sawExpected,
        reason: !red.ok
          ? (sawExpected ? '' : `退出码非 0 但未出现预期断言文本，可能是假红`)
          : '变异后仍然全绿：没有守住这条修复',
      };
    } catch (err) {
      outcome = { id: mutation.id, passed: false, reason: (err && err.message) || String(err) };
    } finally {
      if (applied) {
        const restored = restoreMutationByKind(mutation, applied);
        console.log(`  还原：${restored ? '逐字节一致 OK' : '不一致 FAIL'}`);
        if (!restored) outcome = { id: mutation.id, passed: false, reason: '还原后内容与原文不一致' };
      }
    }

    if (outcome.passed) {
      const greenAgain = runTarget(mutation);
      console.log(`  还原后重跑：${greenAgain.ok ? '绿 OK' : '红 FAIL'}`);
      if (!greenAgain.ok) {
        console.log(greenAgain.out);
        outcome = { id: mutation.id, passed: false, reason: '还原后未回到绿' };
      }
    }
    results.push(outcome);
    console.log(`  结论：${outcome.passed ? 'PASS（变异成功变红）' : `FAIL（${outcome.reason}）`}`);
  }

  console.log('');
  const skipped = results.filter((item) => item.skipped === true);
  const executed = results.filter((item) => item.skipped !== true);
  const failed = executed.filter((item) => !item.passed);
  console.log(
    `[mutate] 汇总：${executed.length - failed.length}/${executed.length} 个可执行变异体成功变红` +
      (skipped.length > 0 ? `（另有 ${skipped.length} 个因环境跳过，未计为 PASS）` : ''),
  );
  for (const item of results) {
    const status = item.skipped === true ? 'SKIP' : item.passed ? 'PASS' : 'FAIL';
    console.log(`  - ${status} ${item.id}${item.reason ? `：${item.reason}` : ''}`);
  }
  if (failed.length > 0) {
    console.error('[mutate] 变异自检未通过：新增测试没能守住对应的修复点');
    return 1;
  }
  console.log('[mutate] 变异自检通过');
  return 0;
}

process.exitCode = await main();
