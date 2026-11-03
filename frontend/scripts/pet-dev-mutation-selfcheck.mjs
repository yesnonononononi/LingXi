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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 前端根目录（脚本位于 `frontend/scripts/`）。 */
const FRONTEND_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 仓库根目录（`.gitignore` 与美术资产都在这一层，git 命令一律 `-C` 到这里）。 */
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');

/** 桌宠端口真源（只在自检里用来判断"端口上是谁家的 dev server"，绝不写死端口）。 */
const { DEV_ENDPOINT } = createRequire(import.meta.url)(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-endpoint.cjs'));

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
  // ---------------------------------------------------------------- 启动器收敛（不许绕过单一真源 / 不许写死绝对路径）
  {
    id: 'launcher-port-literal',
    goal: '启动器配置层把默认 origin 写成端口字面量（绕过单一真源）：单一真源扫描必须红',
    file: 'electron/pet-launcher-config.cjs',
    find: "  if (text.length === 0) return { origin: buildDevOrigin(), source: 'single-source', note: '' };",
    replace: `  if (text.length === 0) return { origin: 'http://127.0.0.1:' + ['52', '75'].join(''), source: 'single-source', note: '' };`,
    testFile: 'tests/petDevEndpoint.test.cjs',
    expect: '出现端口字面量',
  },
  {
    id: 'launcher-absolute-path',
    goal: '启动器退回硬编码绝对路径（收敛前的老缺陷）：换机器就失效，启动器守卫必须红',
    file: 'electron/pet-launcher-config.cjs',
    find: '  const frontendRoot = path.resolve(dirname, \'..\');',
    replace: `  const frontendRoot = ['D:', 'Code', 'LingXi', 'frontend'].join('/');`,
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
 * @returns {{ok: boolean, code: number, out: string, ms: number}} 运行结果
 */
function runTarget(mutation) {
  const started = Date.now();
  const command = typeof mutation.command === 'string' && mutation.command.length > 0 ? mutation.command : null;
  const testFile = String(mutation.testFile || '');
  let proc;
  if (command) {
    proc = spawnSync(command, { cwd: FRONTEND_ROOT, encoding: 'utf8', shell: true });
  } else if (/\.(ts|mts|tsx)$/.test(testFile)) {
    proc = spawnSync(`npx tsx --test "${testFile}"`, { cwd: FRONTEND_ROOT, encoding: 'utf8', shell: true });
  } else {
    proc = spawnSync(process.execPath, ['--test', testFile], { cwd: FRONTEND_ROOT, encoding: 'utf8' });
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
 * 判断桌宠端口上的 dev server 是谁拉起的。
 *
 * <p>画面守卫（`guard:pet:face`）**会复用已在跑的 dev server**；如果端口上是别的
 * 工作树（例如 `.lingxi/work/desktop-pet-vision` 那边的实例）拉起的，守卫看到的就不是
 * 本工作区的源码，注入的变异体自然"测不出来"——那种绿/红都是别人的。</p>
 *
 * <p>判定手段：Vite dev server 会按 root 直接吐 `package.json`，把它与**本工作区**的
 * 逐字节比对即可区分"自家人"与"外人"。端口取自单一真源，不写死。</p>
 *
 * @returns {'own'|'foreign'|'absent'} 归属判定
 */
function detectDevServerOwner() {
  const script = [
    'const http=require("http");',
    'const fs=require("fs");',
    'const own=fs.readFileSync(process.argv[1],"utf8");',
    'const q=http.get("http://127.0.0.1:"+process.argv[2]+"/package.json",(res)=>{',
    '  let b="";res.on("data",(d)=>{b+=d});',
    '  res.on("end",()=>{console.log(res.statusCode===200&&b===own?"own":"foreign")});',
    '});',
    'q.on("error",()=>console.log("absent"));',
    'q.setTimeout(3000,()=>{q.destroy();console.log("absent")});',
  ].join('');
  const proc = spawnSync(process.execPath, ['-e', script, path.join(FRONTEND_ROOT, 'package.json'), String(DEV_ENDPOINT.port)], {
    encoding: 'utf8',
  });
  const verdict = (proc.stdout || '').trim();
  return verdict === 'own' || verdict === 'foreign' ? verdict : 'absent';
}

/** 依次执行全部变异体并汇总。 */
function main() {
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
    console.log(`  位置：${mutation.file || mutation.indexPath}`);
    if (mutation.command) console.log(`  验证目标（命令）：${mutation.command}`);

    // 依赖真实 dev server 的变异体（画面守卫）：端口上是别人家的 server 就不要假装验证过
    if (mutation.requiresOwnDevServer === true) {
      const owner = detectDevServerOwner();
      if (owner === 'foreign') {
        console.log('  跳过（环境）：桌宠端口上已有**其他工作区**拉起的 dev server，本工作区的变异无法被观测');
        console.log('        处置：停掉那个实例后重跑本变异体（这里不会把它记成 PASS）');
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
      applied = mutation.kind === 'index' ? applyIndexMutation(mutation) : applyMutation(mutation);
      const red = runTarget(mutation);
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
        const restored = mutation.kind === 'index' ? restoreIndexMutation(applied) : restoreMutation(applied.absPath, applied.original);
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

process.exitCode = main();
