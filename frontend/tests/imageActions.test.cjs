/**
 * 图片右键动作主进程侧（`electron/image-actions.cjs`）的单测。
 *
 * <p>为什么能在 node 里跑：那个模块刻意不 require('electron')，deps 全部注入。这里用假的
 * ipcMain / dialog / clipboard / nativeImage 直接调两个 handler，验证「字节怎么进门、写盘写到哪、
 * 未授权与非法载荷会不会被挡住」—— 这些才是用户可见契约，真 Electron 冒烟只多验一层系统集成。</p>
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { registerImageActions, sanitizeSuggestedName, MAX_BYTES } = require('../electron/image-actions.cjs');

/** 1x1 透明 PNG，用来喂 nativeImage 假实现。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAAABgADNjd8qAAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 装一台假的主进程。
 *
 * @param {object} [options] 覆盖点
 * @param {boolean} [options.trusted] 来源校验结果
 * @param {object} [options.saveResult] showSaveDialog 的返回
 * @param {boolean} [options.decodable] nativeImage 能否解出图
 * @returns {{handlers: Map<string, Function>, clipboardWrites: any[], dialogCalls: any[]}}
 */
function createHarness(options = {}) {
  const { trusted = true, saveResult = { canceled: true }, decodable = true } = options;
  const handlers = new Map();
  const clipboardWrites = [];
  const dialogCalls = [];
  const deps = {
    ipcMain: {
      handle: (channel, callback) => handlers.set(channel, callback),
      removeHandler: (channel) => handlers.delete(channel),
    },
    dialog: {
      showSaveDialog: async (...args) => {
        dialogCalls.push(args);
        return saveResult;
      },
    },
    clipboard: {
      writeImage: (image) => clipboardWrites.push(image),
    },
    nativeImage: {
      createFromBuffer: () => ({ isEmpty: () => !decodable }),
    },
    downloadsDir: path.join(os.tmpdir(), 'lx-image-actions-test'),
    getWindow: () => null,
    assertTrustedSender: () => trusted,
  };
  const controller = registerImageActions(deps);
  return { handlers, clipboardWrites, dialogCalls, controller };
}

/** 直接取某个通道的 handler。 */
function handler(harness, channel) {
  const found = harness.handlers.get(channel);
  assert.ok(found, `通道未注册：${channel}`);
  return found;
}

test('IA-1 复制：字节写进系统剪贴板', async () => {
  const harness = createHarness();
  const result = await handler(harness, 'image:copy')({}, new Uint8Array(PNG_BYTES));
  assert.deepEqual(result, { ok: true });
  assert.equal(harness.clipboardWrites.length, 1, '剪贴板必须被写入一次');
});

test('IA-2 复制：来源未授权直接拒绝，不碰剪贴板', async () => {
  const harness = createHarness({ trusted: false });
  const result = await handler(harness, 'image:copy')({}, new Uint8Array(PNG_BYTES));
  assert.equal(result.ok, false);
  assert.equal(harness.clipboardWrites.length, 0, '未授权时绝不能改用户剪贴板');
});

test('IA-3 复制：非法载荷、空内容与超限都被挡住', async () => {
  const harness = createHarness();
  const copy = handler(harness, 'image:copy');
  assert.equal((await copy({}, 'not-bytes')).ok, false, '字符串载荷必须被拒绝');
  assert.equal((await copy({}, new Uint8Array(0))).ok, false, '空内容必须被拒绝');
  assert.equal((await copy({}, new Uint8Array(MAX_BYTES + 1))).ok, false, '超限必须被拒绝');
  assert.equal(harness.clipboardWrites.length, 0);
});

test('IA-4 复制：解不出图时报错，不往剪贴板塞空图', async () => {
  const harness = createHarness({ decodable: false });
  const result = await handler(harness, 'image:copy')({}, new Uint8Array(PNG_BYTES));
  assert.equal(result.ok, false);
  assert.match(result.error, /无法解码/);
  assert.equal(harness.clipboardWrites.length, 0);
});

test('IA-5 保存：用户取消时不写盘，返回 canceled', async () => {
  const harness = createHarness({ saveResult: { canceled: true } });
  const result = await handler(harness, 'image:save')({}, new Uint8Array(PNG_BYTES), 'foo.png');
  assert.deepEqual(result, { ok: false, canceled: true });
  assert.equal(harness.dialogCalls.length, 1, '必须真的弹过一次保存对话框');
});

test('IA-6 保存：选定路径后写盘，返回实际路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-image-save-'));
  const target = path.join(dir, 'shot.png');
  const harness = createHarness({ saveResult: { canceled: false, filePath: target } });
  const result = await handler(harness, 'image:save')({}, new Uint8Array(PNG_BYTES), 'shot.png');
  assert.deepEqual(result, { ok: true, path: target });
  assert.deepEqual(fs.readFileSync(target), PNG_BYTES, '写盘内容必须与传入字节一致');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IA-7 保存：默认路径落在下载目录，脏名字不会带出目录穿越', async () => {
  const harness = createHarness();
  await handler(harness, 'image:save')({}, new Uint8Array(PNG_BYTES), '../../etc/passwd');
  const [options] = harness.dialogCalls[0];
  assert.equal(path.dirname(options.defaultPath), path.join(os.tmpdir(), 'lx-image-actions-test'));
  assert.match(path.basename(options.defaultPath), /^passwd\.png$/, '脏名字要洗净并补图片扩展名');
  assert.ok(Array.isArray(options.filters) && options.filters.length > 0, '必须给对话框过滤器');
});

test('IA-8 保存：来源未授权时不弹对话框', async () => {
  const harness = createHarness({ trusted: false });
  const result = await handler(harness, 'image:save')({}, new Uint8Array(PNG_BYTES), 'x.png');
  assert.equal(result.ok, false);
  assert.equal(harness.dialogCalls.length, 0);
});

test('IA-9 sanitizeSuggestedName：留扩展名、洗非法字符、空名兜底', () => {
  assert.equal(sanitizeSuggestedName('shot.png'), 'shot.png');
  assert.equal(sanitizeSuggestedName('shot'), 'shot.png');
  assert.equal(sanitizeSuggestedName('a<b>c:d.jpg'), 'a_b_c_d.jpg');
  assert.equal(sanitizeSuggestedName('C:\\tmp\\x.webp'), 'x.webp');
  assert.equal(sanitizeSuggestedName(''), 'image.png');
  assert.equal(sanitizeSuggestedName(undefined), 'image.png');
  assert.equal(sanitizeSuggestedName('x.exe'), 'x.exe.png', '非图片扩展名一律按 png，不许原样交出去');
});

test('IA-10 注销时两条通道都被摘掉', () => {
  const harness = createHarness();
  assert.deepEqual([...harness.handlers.keys()].sort(), ['image:copy', 'image:save']);
  harness.controller.close();
  assert.equal(harness.handlers.size, 0);
});
