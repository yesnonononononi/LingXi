'use strict';

/**
 * 主页背景「可替换表面」契约（L2）回归测试。
 *
 * <p>锁五件事：
 *  1. <b>契约形状</b>：`BACKGROUND_SLOTS_KEY` 是真 Symbol，`ChatBackgroundSlots` 只有可选的 `surface`
 *     —— 没有 props、没有主题状态，才谈得上「按字段判空即回落」；
 *  2. <b>注册点唯一</b>：`provide(BACKGROUND_SLOTS_KEY` 全仓只有 `ChatView.vue` 一处，
 *     否则「谁决定表面」就有两个答案，切背景会出现两份真值；
 *  3. <b>按字段判空</b>：消费端必须是 `slotOverrides?.surface ?? Default`，不能是
 *     `slots ? slots.surface : Default`（宿主 provide `{}` 时后者会渲染空占位而不是回落）；
 *  4. <b>画布根不漂移</b>：`var(--lx-canvas)` 与 `var(--lx-canvas-image, none)` 必须还在
 *     `ChatBackground.vue` 的 `.lx-chat-background` 上（换肤与插件背景图的既有护栏）；
 *  5. <b>无主题分支</b>：`background/` 下两个表面与 `ChatBackground.vue` 都不得出现 `isDark` / `useTheme`。
 *
 * <p>另外覆盖 `electron/background-images.cjs` 的纯函数与假 `ipcMain` 注册（安全边界的一部分）：
 * 文件名白名单矩阵、data URL 前缀、目录列举/删除只碰白名单、三条 channel、未授权来源全拒、退出注销。
 *
 * <p>不启动 Electron，也不要求先 build：`--verify` 那类依赖 dist 的检查一律不在这里做。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(FRONTEND_ROOT, 'src');

const BACKGROUND_IMAGES = require('../electron/background-images.cjs');
const {
  sanitizeFileName,
  listStoredBackgrounds,
  removeStoredBackgrounds,
  backgroundsDir,
  toDataUrl,
  registerBackgroundImages,
  MAX_BYTES,
  MAX_EDGE,
  ALLOWED_EXTENSIONS,
} = BACKGROUND_IMAGES;

/** 读取 frontend 下的文件。 */
function read(rel) {
  return fs.readFileSync(path.join(FRONTEND_ROOT, rel), 'utf8');
}

/**
 * 剥掉注释（块注释 / HTML 注释 / 行注释）。
 *
 * <p>本仓的文件头注释里大量出现契约名与变量名，不剥会把注释当成真代码 ——
 * 本项目已经踩过「注释导致假绿」的坑。</p>
 */
function stripComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:：])\/\/[^\n]*/g, '$1');
}

/** 递归列出目录下指定后缀的文件（绝对路径）。 */
function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** src 下所有源码文件（含去注释文本），供跨文件扫描断言复用。 */
const SRC_FILES = walkFiles(SRC_ROOT)
  .filter((file) => /\.(ts|mts|js|mjs|cjs|vue|css)$/.test(file))
  .map((file) => ({
    abs: file,
    rel: path.relative(FRONTEND_ROOT, file).split(path.sep).join('/'),
    base: path.basename(file),
    code: stripComments(fs.readFileSync(file, 'utf8')),
  }));

const chatView = SRC_FILES.find((f) => f.rel === 'src/views/chat/ChatView.vue');
const chatBackground = SRC_FILES.find((f) => f.rel === 'src/components/chat/ChatBackground.vue');
const tokenBackground = SRC_FILES.find((f) => f.rel === 'src/components/background/TokenBackground.vue');
const imageBackground = SRC_FILES.find((f) => f.rel === 'src/components/background/ImageBackground.vue');
const preferenceComposable = SRC_FILES.find((f) => f.rel === 'src/composables/useBackgroundPreference.ts');

/* ------------------------------------------------------------------ *
 * 0. 金丝雀：扫描器本身必须命中目标文件，否则后面的断言全是空转
 * ------------------------------------------------------------------ */

test('金丝雀：源码扫描器命中全部被测文件（否则后续断言空转）', () => {
  assert.ok(SRC_FILES.length > 50, `src 扫描出的文件数异常：${SRC_FILES.length}`);
  for (const [label, file] of [
    ['ChatView.vue', chatView],
    ['ChatBackground.vue', chatBackground],
    ['TokenBackground.vue', tokenBackground],
    ['ImageBackground.vue', imageBackground],
    ['useBackgroundPreference.ts', preferenceComposable],
  ]) {
    assert.ok(file, `未扫描到 ${label}`);
    assert.ok(file.code.length > 0, `${label} 去注释后为空，剥离规则可能把代码也剥掉了`);
  }
  // 去注释必须真的生效：注释里出现过 isDark 之类的词，剥完不该有裸注释痕迹
  assert.ok(!chatBackground.code.includes('/*'), 'ChatBackground.vue 的块注释未被剥净');
});

/* ------------------------------------------------------------------ *
 * 1. 契约形状：真 Symbol + 只有 surface 字段
 * ------------------------------------------------------------------ */

/**
 * 把 `src/types/backgroundSlots.ts` 转成 CommonJS 并在沙箱里求值，拿到真实的 `BACKGROUND_SLOTS_KEY`。
 * 运行期不允许真的 require 任何模块（文件里只有 `import type`，编译后应被擦除）。
 *
 * @returns {Record<string, unknown>} 模块导出
 */
function evaluateBackgroundSlotsContract() {
  const source = read('src/types/backgroundSlots.ts');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  const fakeRequire = (id) => {
    throw new Error(`契约模块在运行期不得 require（实际：${id}）——import type 应被擦除`);
  };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'require', outputText)(module.exports, module, fakeRequire);
  return module.exports;
}

const contractModule = evaluateBackgroundSlotsContract();
const BACKGROUND_SLOTS_KEY = contractModule.BACKGROUND_SLOTS_KEY;

test('契约：BACKGROUND_SLOTS_KEY 存在且是 Symbol（不是字符串 / 不是 Symbol.for 全局名）', () => {
  assert.equal(typeof BACKGROUND_SLOTS_KEY, 'symbol', `BACKGROUND_SLOTS_KEY 必须是 Symbol，实际 ${typeof BACKGROUND_SLOTS_KEY}`);
  assert.equal(String(BACKGROUND_SLOTS_KEY), 'Symbol(chat-background-slots)', 'Symbol 描述必须稳定可读，便于 devtools 排查');
  const again = evaluateBackgroundSlotsContract().BACKGROUND_SLOTS_KEY;
  assert.notEqual(again, BACKGROUND_SLOTS_KEY, '两次求值应得到不同 Symbol：用 Symbol() 而不是 Symbol.for()，避免全局键域冲突');
});

test('契约：ChatBackgroundSlots 只有可选的 surface 字段（无 props、无主题字段）', () => {
  const source = stripComments(read('src/types/backgroundSlots.ts'));
  assert.match(source, /interface\s+ChatBackgroundSlots\b/, '缺少 ChatBackgroundSlots 接口');
  assert.match(source, /surface\?\s*:\s*Component\b/, 'surface 必须是可选（surface?:）的 Vue Component');
  const body = /interface\s+ChatBackgroundSlots\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(body, '无法解析接口体');
  const fields = [...body[1].matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)].map((m) => m[1]);
  assert.deepEqual(fields, ['surface'], `接口字段必须只有 surface，实际：${JSON.stringify(fields)}`);
});

/* ------------------------------------------------------------------ *
 * 2. 注册点唯一 + 消费端 inject
 * ------------------------------------------------------------------ */

test('注册点：provide(BACKGROUND_SLOTS_KEY 全仓只有 ChatView.vue 一处', () => {
  const providers = SRC_FILES.filter((file) => /provide\s*\(\s*BACKGROUND_SLOTS_KEY/.test(file.code));
  assert.deepEqual(
    providers.map((file) => file.rel),
    ['src/views/chat/ChatView.vue'],
    `注册点必须唯一且是 ChatView.vue，实际：${JSON.stringify(providers.map((f) => f.rel))}`,
  );
  const occurrences = chatView.code.split('provide(BACKGROUND_SLOTS_KEY').length - 1;
  assert.equal(occurrences, 1, `ChatView.vue 内 provide(BACKGROUND_SLOTS_KEY) 应恰好 1 次，实际 ${occurrences}`);
});

test('注册点：ChatView 用 shallowReactive 切换表面，并在 hasBackground 变化时同步', () => {
  assert.match(chatView.code, /shallowReactive\s*<[^>]*surface[^>]*>\s*\(\s*\{/, '注册值必须是 shallowReactive 的可变对象（否则用户选图后表面不会立刻换）');
  assert.match(chatView.code, /surface\s*:\s*hasBackgroundImage\.value\s*\?\s*ImageBackground\s*:\s*TokenBackground/,
    '初始表面必须按 hasBackground 选择 ImageBackground / TokenBackground');
  assert.match(chatView.code, /watch\s*\(\s*hasBackgroundImage/, '必须 watch hasBackground 才能在清除后回到默认表面');
  assert.match(chatView.code, /import\s+ImageBackground\s+from\s+'\.\.\/\.\.\/components\/background\/ImageBackground\.vue'/,
    'ChatView 必须导入 ImageBackground（否则「选图后换表面」不可达）');
});

test('消费端：ChatBackground.vue 用 inject 取插槽，而不是自己 provide 或硬编码', () => {
  assert.match(chatBackground.code, /inject\s*<[^>]*>\s*\(\s*BACKGROUND_SLOTS_KEY/, 'ChatBackground 必须 inject BACKGROUND_SLOTS_KEY');
  assert.doesNotMatch(chatBackground.code, /provide\s*\(/, 'ChatBackground 不得自己 provide（注册点只允许 ChatView）');
  assert.doesNotMatch(chatBackground.code, /defineProps/, 'ChatBackground 必须无 props');
});

/* ------------------------------------------------------------------ *
 * 3. 按字段判空（不是对象真值）
 * ------------------------------------------------------------------ */

test('判空语义：ChatBackground 用 `?.surface ?? Default`（按字段判空）', () => {
  assert.match(chatBackground.code, /slotOverrides\?\.\s*surface\s*\?\?/, '必须写成 `slotOverrides?.surface ?? TokenBackground`');
  assert.match(chatBackground.code, /<component\s+:is=/, '必须用动态组件渲染可替换表面');
  assert.doesNotMatch(chatBackground.code, /\b\w+\s*\?\s*\w+\.surface\s*:\s*/,
    '不得用三元真值判断（宿主 provide {} 时会渲染空占位而不是回落）：应改为 `?.surface ?? 默认实现`');
});

/* ------------------------------------------------------------------ *
 * 4. 画布根不许漂移
 * ------------------------------------------------------------------ */

test('画布根：底色与背景图仍走 var(--lx-canvas) / var(--lx-canvas-image, none)', () => {
  assert.match(chatBackground.code, /background-color:\s*var\(--lx-canvas\)/,
    '底色必须取 var(--lx-canvas)，写死色值会让亮色主题仍是黑底');
  assert.match(chatBackground.code, /background-image:\s*var\(--lx-canvas-image,\s*none\)/,
    '缺少 background-image: var(--lx-canvas-image, none) 扩展点（插件背景图靠它）');
  assert.match(chatBackground.code, /background-size:\s*var\(--lx-canvas-fit,\s*cover\)/,
    '填充方式必须由偏好变量驱动，且回落 cover');
  assert.match(chatBackground.code, /pointer-events-none|pointer-events:\s*none/, '画布根必须能点穿');
  assert.match(chatBackground.code, /aria-hidden="true"/, '纯装饰层必须对辅助技术隐身');
});

/* ------------------------------------------------------------------ *
 * 5. 无主题分支
 * ------------------------------------------------------------------ */

for (const [label, file] of [
  ['ChatBackground.vue', () => chatBackground],
  ['TokenBackground.vue', () => tokenBackground],
  ['ImageBackground.vue', () => imageBackground],
]) {
  test(`无主题分支：${label} 不出现 isDark / useTheme`, () => {
    const target = label === 'ChatBackground.vue' ? chatBackground : (label === 'TokenBackground.vue' ? tokenBackground : imageBackground);
    assert.ok(target, `未找到 ${label}`);
    assert.doesNotMatch(target.code, /isDark/, `${label} 不得读 isDark（明暗只由 tokens.css 两套作用域承担）`);
    assert.doesNotMatch(target.code, /useTheme/, `${label} 不得依赖 useTheme`);
    assert.doesNotMatch(target.code, /v-if/, `${label} 不得按主题分支渲染`);
  });
}

/* ------------------------------------------------------------------ *
 * 6. CSS 变量单一写入口
 * ------------------------------------------------------------------ */

const VARIABLE_NAMES = ['--lx-canvas-image', '--lx-background-scrim', '--lx-canvas-fit'];

for (const variable of VARIABLE_NAMES) {
  test(`单一写入口：${variable} 只在 useBackgroundPreference.ts 里被写`, () => {
    // 1) 任何「写」都要出现 setProperty，且只能出现在组合式函数里
    const writers = SRC_FILES.filter((file) => /setProperty/.test(file.code) && file.code.includes(variable));
    assert.deepEqual(
      writers.map((file) => file.rel),
      ['src/composables/useBackgroundPreference.ts'],
      `${variable} 的写入口必须唯一，实际：${JSON.stringify(writers.map((f) => f.rel))}`,
    );
    // 2) 也不许用样式表 / 内联 style 对象再开一条写路径（`--x: value` 声明）
    const declarationRe = new RegExp(`${variable}['"]?\\s*:`);
    const declarers = SRC_FILES.filter((file) => declarationRe.test(file.code));
    assert.deepEqual(declarers.map((file) => file.rel), [],
      `${variable} 不得在样式表或内联 style 里再声明一次，实际：${JSON.stringify(declarers.map((f) => f.rel))}`);
  });
}

test('单一写入口：三个变量都通过常量名写（setProperty(IMAGE_VAR/SCRIM_VAR/FIT_VAR)，不散落字面量）', () => {
  assert.match(preferenceComposable.code, /const\s+IMAGE_VAR\s*=\s*'--lx-canvas-image'/, 'IMAGE_VAR 常量缺失');
  assert.match(preferenceComposable.code, /const\s+SCRIM_VAR\s*=\s*'--lx-background-scrim'/, 'SCRIM_VAR 常量缺失');
  assert.match(preferenceComposable.code, /const\s+FIT_VAR\s*=\s*'--lx-canvas-fit'/, 'FIT_VAR 常量缺失');
  assert.match(preferenceComposable.code, /setProperty\s*\(\s*IMAGE_VAR/, '写 --lx-canvas-image 必须走 setProperty(IMAGE_VAR)');
  assert.match(preferenceComposable.code, /setProperty\s*\(\s*SCRIM_VAR/, '写 --lx-background-scrim 必须走 setProperty(SCRIM_VAR)');
  assert.match(preferenceComposable.code, /setProperty\s*\(\s*FIT_VAR/, '写 --lx-canvas-fit 必须走 setProperty(FIT_VAR)');
});

/* ------------------------------------------------------------------ *
 * 7. background-images.cjs 纯函数
 * ------------------------------------------------------------------ */

/** 建一个临时目录，测试结束必删（不留垃圾）。 */
function withTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sanitizeFileName：非法输入矩阵全部拒绝', () => {
  const illegal = [
    ['../x.png', '目录穿越'],
    ['..\\x.png', '反斜杠穿越'],
    ['a/b.png', '子路径'],
    ['C:\\x.png', '绝对路径（反斜杠）'],
    ['C:/x.png', '绝对路径（正斜杠）'],
    ['.hidden.png', '隐藏文件'],
    ['.', '当前目录'],
    ['..', '上级目录'],
    ['x.svg', '非白名单扩展名 svg'],
    ['x.gif', '非白名单扩展名 gif'],
    ['x.bmp', '非白名单扩展名 bmp'],
    ['x', '无扩展名'],
    ['x.png ', '尾随空格'],
    [' x.png', '前导空格'],
    ['x.p"ng', '引号'],
    ['x:png.png', '冒号'],
    ['', '空串'],
    ['a'.repeat(129) + '.png', '超过 128 字符'],
    [null, 'null'],
    [undefined, 'undefined'],
    [42, '数字'],
    [{}, '对象'],
    [['x.png'], '数组'],
  ];
  for (const [input, label] of illegal) {
    assert.equal(sanitizeFileName(input), null, `${label} 应被拒绝，实际通过：${JSON.stringify(input)}`);
  }
});

test('sanitizeFileName：合法名逐个通过（含边界长度与大小写扩展名）', () => {
  const legal = [
    'a.png',
    'photo-1.jpg',
    'photo_2.jpeg',
    'x.y.webp',
    'A1.PNG',
    'b.WebP',
    'a'.repeat(124) + '.png', // 恰好 128 字符，边界内
  ];
  for (const input of legal) {
    assert.equal(sanitizeFileName(input), input, `合法名被误拒：${input}`);
  }
});

test('toDataUrl：前缀与编码正确（未知扩展名回落 octet-stream）', () => {
  const buffer = Buffer.from([1, 2, 3]);
  assert.equal(toDataUrl(buffer, 'png'), 'data:image/png;base64,AQID');
  assert.match(toDataUrl(buffer, 'jpg'), /^data:image\/jpeg;base64,/);
  assert.match(toDataUrl(buffer, 'jpeg'), /^data:image\/jpeg;base64,/);
  assert.match(toDataUrl(buffer, 'webp'), /^data:image\/webp;base64,/);
  assert.match(toDataUrl(buffer, 'gif'), /^data:application\/octet-stream;base64,/,
    '未知扩展名必须回落 application/octet-stream（不得凭空当图片）');
});

test('listStoredBackgrounds：只命中白名单图片（目录不存在返回空数组）', (t) => {
  const dir = withTempDir(t, 'lx-bg-list-');
  assert.deepEqual(listStoredBackgrounds(path.join(dir, 'nope')), [], '目录不存在必须返回空数组而不是抛错');

  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'b.JPG'), 'x');
  fs.writeFileSync(path.join(dir, 'c.webp'), 'x');
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'x.svg'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'd.png'), 'x');

  const listed = listStoredBackgrounds(dir).sort();
  assert.deepEqual(listed, ['a.png', 'b.JPG', 'c.webp'], `只应命中白名单图片，实际：${JSON.stringify(listed)}`);
  assert.ok(!listed.includes('ignore.txt'), '非白名单文件不得被列举（否则清除会误删用户文件）');
  assert.ok(!listed.includes('x.svg'), '非白名单扩展名不得被列举');
});

test('removeStoredBackgrounds：只删白名单图片，非白名单文件保留（返回删除数）', (t) => {
  const dir = withTempDir(t, 'lx-bg-remove-');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'b.jpeg'), 'x');
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'keep.png'), 'x');

  const removed = removeStoredBackgrounds(dir);
  assert.equal(removed, 2, `删除数应为 2，实际 ${removed}`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ignore.txt', 'sub'], '非白名单文件与子目录必须保留（不得递归）');
  assert.ok(fs.existsSync(path.join(dir, 'sub', 'keep.png')), '子目录内的图片不得被删（不递归）');
});

test('常量与导出：MAX_BYTES / MAX_EDGE / ALLOWED_EXTENSIONS 契约稳定', () => {
  assert.equal(MAX_BYTES, 5 * 1024 * 1024, '大小上限必须与可行性评估一致（5MB）');
  assert.equal(MAX_EDGE, 2560, '长边上限必须与可行性评估一致（2560）');
  assert.deepEqual([...ALLOWED_EXTENSIONS], ['png', 'jpg', 'jpeg', 'webp']);
  assert.ok(Object.isFrozen(ALLOWED_EXTENSIONS), 'ALLOWED_EXTENSIONS 必须冻结，避免被运行期改写');
  for (const name of ['registerBackgroundImages', 'sanitizeFileName', 'listStoredBackgrounds',
    'removeStoredBackgrounds', 'backgroundsDir', 'toDataUrl']) {
    assert.equal(typeof BACKGROUND_IMAGES[name], 'function', `未导出 ${name}`);
  }
});

test('模块自洽：background-images.cjs 不 require electron（可被普通 node 直接测）', () => {
  // 必须剥注释：文件头注释里恰好写着「不 require('electron')」，不剥会让这条断言假红（本轮已踩过一次）。
  const source = stripComments(read('electron/background-images.cjs'));
  assert.doesNotMatch(source, /require\(\s*['"]electron['"]\s*\)/, '不得 require electron，否则本测试根本无法在普通 node 下跑');
  assert.match(source, /require\(\s*['"]node:fs['"]\s*\)/, '金丝雀：剥注释后应仍能看到真实的 require（否则剥离规则把代码也吃了）');
});

/* ------------------------------------------------------------------ *
 * 8. 假 ipcMain 注册与注销
 * ------------------------------------------------------------------ */

/**
 * 用桩注册三条背景 IPC。
 *
 * @param {object} [options] 覆盖项
 * @param {boolean} [options.trusted] 来源是否可信
 * @returns {{handlers: Map<string, Function>, api: object, closeChannels: string[], dir: string, cleanup: Function}} 桩与句柄
 */
function registerWithStubIpc(options = {}) {
  const trusted = options.trusted !== undefined ? options.trusted : true;
  const handlers = new Map();
  const closeChannels = [];
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-bg-ipc-'));
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { closeChannels.push(channel); handlers.delete(channel); },
  };
  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  };
  const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
  const api = registerBackgroundImages({
    ipcMain,
    dialog,
    nativeImage,
    userDataDir,
    getWindow: () => null,
    assertTrustedSender: () => trusted,
  });
  const cleanup = () => fs.rmSync(userDataDir, { recursive: true, force: true });
  return { handlers, api, closeChannels, dir: backgroundsDir(userDataDir), cleanup };
}

test('IPC 注册：三条 channel 名恰为 pick / load / clear，目录在 userData/backgrounds 下', (t) => {
  const stub = registerWithStubIpc();
  try {
    assert.deepEqual([...stub.handlers.keys()], ['background:pick', 'background:load', 'background:clear'],
      `channel 名必须与 preload 一一对应，实际：${JSON.stringify([...stub.handlers.keys()])}`);
    assert.equal(stub.api.dir, stub.dir, '返回的 dir 必须是 backgrounds 目录');
    assert.match(stub.dir.split(path.sep).join('/'), /\/backgrounds$/, '图片目录必须是 userData/backgrounds');
    assert.equal(typeof stub.api.close, 'function', '必须返回 close() 供退出时注销');
  } finally {
    stub.cleanup();
  }
});

test('IPC 来源校验：未授权来源三条 handler 全拒', async (t) => {
  const stub = registerWithStubIpc({ trusted: false });
  try {
    const event = {};
    for (const [channel, args] of [
      ['background:pick', []],
      ['background:load', ['a.png']],
      ['background:clear', []],
    ]) {
      const handler = stub.handlers.get(channel);
      assert.equal(typeof handler, 'function', `未注册 ${channel}`);
      const result = await handler(event, ...args);
      assert.equal(result.ok, false, `${channel} 对未授权来源必须拒绝，实际：${JSON.stringify(result)}`);
      assert.match(String(result.error), /未授权/, `${channel} 的拒绝文案必须说明来源未授权`);
    }
  } finally {
    stub.cleanup();
  }
});

test('IPC background:load：未授权来源即便文件名合法也拒绝（先校验来源）', async (t) => {
  const stub = registerWithStubIpc({ trusted: false });
  try {
    const handler = stub.handlers.get('background:load');
    const result = await handler({}, 'a.png');
    assert.equal(result.ok, false);
    assert.match(String(result.error), /未授权/, `必须先校验来源，实际：${JSON.stringify(result)}`);
    assert.doesNotMatch(String(result.error), /非法文件名/, '不得把来源问题误报成文件名问题');
  } finally {
    stub.cleanup();
  }
});

test('IPC background:load：非法文件名矩阵全拒（穿越 / 隐藏 / 非白名单扩展名）', async (t) => {
  const stub = registerWithStubIpc({ trusted: true });
  try {
    const handler = stub.handlers.get('background:load');
    const illegal = ['../x.png', 'a/b.png', 'C:\\x.png', '.hidden.png', 'x.svg', 'x.gif', '', 'a'.repeat(129) + '.png', null];
    for (const name of illegal) {
      const result = await handler({}, name);
      assert.equal(result.ok, false, `非法名必须拒绝：${JSON.stringify(name)}`);
      assert.match(String(result.error), /非法文件名/, `拒绝理由应为「非法文件名」，实际：${JSON.stringify(result.error)}`);
    }
  } finally {
    stub.cleanup();
  }
});

test('IPC background:load：合法但文件不存在 ⇒ ok:false（渲染层据此静默回落）', async (t) => {
  const stub = registerWithStubIpc({ trusted: true });
  try {
    const handler = stub.handlers.get('background:load');
    const result = await handler({}, 'missing.png');
    assert.equal(result.ok, false, '不存在文件必须返回 ok:false');
    assert.match(String(result.error), /不存在/, `错误文案应说明文件不存在，实际：${JSON.stringify(result.error)}`);
  } finally {
    stub.cleanup();
  }
});

test('IPC background:clear：只删白名单图片，非白名单文件保留', async (t) => {
  const stub = registerWithStubIpc({ trusted: true });
  try {
    fs.mkdirSync(stub.dir, { recursive: true });
    fs.writeFileSync(path.join(stub.dir, 'old.png'), 'x');
    fs.writeFileSync(path.join(stub.dir, 'ignore.txt'), 'x');
    const handler = stub.handlers.get('background:clear');
    const result = await handler({});
    assert.equal(result.ok, true);
    assert.equal(result.removed, 1, `应只删 1 张白名单图片，实际 ${result.removed}`);
    assert.deepEqual(fs.readdirSync(stub.dir), ['ignore.txt'], '非白名单文件必须保留');
  } finally {
    stub.cleanup();
  }
});

test('IPC 注销：close() 把三个 channel 全部 removeHandler，且不抛错', (t) => {
  const stub = registerWithStubIpc();
  try {
    stub.api.close();
    assert.deepEqual(stub.closeChannels.sort(),
      ['background:clear', 'background:load', 'background:pick'].sort(),
      `退出时必须注销三条 handler，实际：${JSON.stringify(stub.closeChannels)}`);
    assert.equal(stub.handlers.size, 0, 'close() 后不得残留 handler');
    // 幂等：重复 close 不得抛错（退出流程可能被多次触发）
    assert.doesNotThrow(() => stub.api.close(), 'close() 必须可重复调用而不抛错');
    assert.doesNotThrow(() => stub.api.close(), 'close() 必须可重复调用而不抛错');
  } finally {
    stub.cleanup();
  }
});
