const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { resolveContainedFile, resolvePreviewFile, resolveAbsoluteFile, readTextPreview, resolveLocalBase, registerFilePreview, MAX_BYTES } = require('../electron/file-preview.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../node_modules/.tmp');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'file-preview-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'sample.java'), 'class 示例 {\n  String name = "你好";\n}\n');
  return { directory, root };
}

test('读取中文源码和 UTF-16，超出大小或行数时截断，二进制明确拒绝', async t => {
  const { root } = await fixture(t);
  assert.match((await readTextPreview(path.join(root, 'sample.java'))).content, /你好/);
  await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文内容', 'utf16le')]));
  const utf16 = await readTextPreview(path.join(root, 'utf16.txt'));
  assert.equal(utf16.content, '中文内容');
  assert.equal(utf16.encoding, 'UTF-16LE');
  await fs.writeFile(path.join(root, 'big.txt'), 'a'.repeat(MAX_BYTES + 100));
  const big = await readTextPreview(path.join(root, 'big.txt'));
  assert.equal(big.truncated, true);
  assert.equal(big.content.length, MAX_BYTES);
  await fs.writeFile(path.join(root, 'lines.txt'), 'line\n'.repeat(4000));
  const lines = await readTextPreview(path.join(root, 'lines.txt'));
  assert.equal(lines.truncated, true);
  assert.equal(lines.content.split('\n').length, 3000);
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(readTextPreview(path.join(root, 'binary.bin')), /二进制/);
});

test('相对路径仍被工作区约束：拒绝目录穿越与目录联接', async t => {
  const { directory, root } = await fixture(t);
  const file = await resolveContainedFile(root, 'sample.java');
  assert.equal(file, await fs.realpath(path.join(root, 'sample.java')));
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await assert.rejects(resolveContainedFile(root, '../outside/secret.txt'), /工作目录/);
  await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveContainedFile(root, 'link/secret.txt'), /实际位置/);
});

test('绝对路径整机放行：工作区外的文件可读，目录仍被拒绝', async t => {
  const { directory, root } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const target = path.join(outside, 'secret.txt');
  await fs.writeFile(target, '整机只读');

  // 这是本次放开的核心：绝对路径不再受工作区约束
  assert.equal(await resolvePreviewFile(root, target), await fs.realpath(target));
  assert.equal((await readTextPreview(await resolvePreviewFile(root, target))).content, '整机只读');
  assert.equal(await resolveAbsoluteFile(target), await fs.realpath(target));

  // 目录不是文件，仍然拒绝
  await assert.rejects(resolveAbsoluteFile(outside), /不是文件/);
  // 不存在的绝对路径必须报错，而不是静默放行
  await assert.rejects(resolveAbsoluteFile(path.join(outside, 'nope.txt')), /ENOENT|不存在/);
});

test('相对路径锚定工作区，绝对路径走整机放行 —— 两条路的分派点', async t => {
  const { root } = await fixture(t);
  // 相对路径：锚在工作区
  assert.equal(await resolvePreviewFile(root, 'sample.java'), await fs.realpath(path.join(root, 'sample.java')));
  // 绝对路径：不受 root 影响，即使传入一个与 root 无关的目录
  const other = path.join(root, '..', 'sample.java');
  await fs.writeFile(other, 'root 之外的同名文件');
  assert.equal(await resolvePreviewFile(root, other), await fs.realpath(other));
  assert.equal((await readTextPreview(await resolvePreviewFile(root, other))).content, 'root 之外的同名文件');
  // 空路径与 NUL 一律拒绝
  await assert.rejects(resolvePreviewFile(root, ''), /不能为空/);
  await assert.rejects(resolvePreviewFile(root, 'a\0b'), /不能为空/);
});

test('整机放行后仍拒绝用默认程序打开可执行类文件（纵深防御，防 Windows 当脚本执行）', async t => {
  const { directory, root } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const handlers = new Map();
  const opened = [];
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = () => {};
  t.mock.method(global, 'fetch', async url => ({
    ok: true,
    json: async () => ({ code: 1, data: String(url).endsWith('/config/current') ? { type: 'LOCAL' }
      : String(url).includes('/session/') ? { workspaceId: '1234567890123456789' }
        : { hostDir: root } }),
  }));
  const stop = registerFilePreview({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { openPath: async file => { opened.push(file); return ''; }, showItemInFolder: () => {} },
    getWindow: () => ({ isDestroyed: () => false, webContents: sender }),
  });
  t.after(stop);
  const event = { sender };
  const open = handlers.get('file-preview:open');

  // 工作区外的脚本文件：路径已被放行，但扩展名白名单必须仍拦住 open
  const script = path.join(outside, 'payload.js');
  await fs.writeFile(script, 'alert(1)');
  const blocked = await open(event, { sessionId: '1234567890123456788', baseUrl: 'http://localhost:8088', path: script });
  assert.equal(blocked.ok, false, '整机放行的是「读」，不是「交给系统程序执行」');
  assert.match(blocked.error, /定位/);
  assert.equal(opened.length, 0);

  // 对照：安全扩展名在工作区外可以打开
  const java = path.join(outside, 'Sample.java');
  await fs.writeFile(java, 'class Sample {}');
  const allowed = await open(event, { sessionId: '1234567890123456788', baseUrl: 'http://localhost:8088', path: java });
  assert.equal(allowed.ok, true);
  assert.equal(opened.length, 1);
});

test('远程服务、URL 凭证和额外路径不会触发本地文件读取', () => {
  assert.equal(resolveLocalBase('http://127.0.0.1:8088'), 'http://127.0.0.1:8088');
  for (const url of ['https://example.com', 'http://localhost:8088/proxy', 'http://user:pass@localhost:8088', 'file:///C:/']) {
    assert.throws(() => resolveLocalBase(url));
  }
});

test('原生接口校验会话环境，文件替换后通知刷新，关闭标签释放监听', async t => {
  const { root } = await fixture(t);
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (channel, data) => sender.emit(channel, data);
  const handlers = new Map();
  let type = 'LOCAL';
  t.mock.method(global, 'fetch', async url => ({
    ok: true,
    json: async () => ({ code: 1, data: String(url).endsWith('/config/current') ? { type }
      : String(url).includes('/session/') ? { workspaceId: '1234567890123456789' }
        : { hostDir: root } }),
  }));
  const opened = [];
  const revealed = [];
  const stop = registerFilePreview({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { openPath: async file => { opened.push(file); return ''; }, showItemInFolder: file => revealed.push(file) },
    getWindow: () => ({ isDestroyed: () => false, webContents: sender }),
  });
  t.after(stop);
  const event = { sender };
  const request = { sessionId: '1234567890123456788', baseUrl: 'http://localhost:8088', path: 'sample.java', watchKey: 'test-tab' };
  const read = handlers.get('file-preview:read');
  const first = await read(event, request);
  assert.equal(first.ok, true);
  assert.ok(first.data.watchId);
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('文件变化通知超时')), 3000);
    sender.once('file-preview:changed', data => { clearTimeout(timer); resolve(data); });
  });
  await fs.writeFile(path.join(root, 'replacement.java'), 'class Updated {}');
  await fs.rename(path.join(root, 'replacement.java'), path.join(root, 'sample.java'));
  assert.equal((await changed).watchId, first.data.watchId);
  const refreshed = await read(event, request);
  assert.equal(refreshed.data.content, 'class Updated {}');
  assert.equal(refreshed.data.watchId, first.data.watchId);
  assert.equal((await handlers.get('file-preview:open')(event, request)).ok, true);
  assert.equal((await handlers.get('file-preview:reveal')(event, request)).ok, true);
  assert.equal(opened.length, 1);
  assert.equal(revealed.length, 1);
  await fs.writeFile(path.join(root, 'script.js'), 'alert(1)');
  assert.equal((await handlers.get('file-preview:open')(event, { ...request, path: 'script.js' })).ok, false);
  assert.equal(opened.length, 1);
  type = 'SAND_BOX';
  assert.match((await read(event, request)).error, /沙箱/);
  assert.equal((await read({ sender: {} }, request)).ok, false);
  assert.equal((await handlers.get('file-preview:unwatch')(event, first.data.watchId)).ok, true);
  let notifications = 0;
  sender.on('file-preview:changed', () => { notifications++; });
  await fs.writeFile(path.join(root, 'sample.java'), 'class Closed {}');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(notifications, 0);
});
