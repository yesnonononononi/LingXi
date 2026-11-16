const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  sanitizePackId,
  sanitizeRelativeFile,
  inlineCssLocalAssets,
  listInstalledPacksFromDir,
  loadInstalledPackFromDir,
  scanCustomPacksDir,
  registerPacksManager,
} = require('../electron/packs-manager.cjs');

test('sanitizePackId 拒绝目录穿越与非法字符', () => {
  assert.equal(sanitizePackId('midnight-indigo'), 'midnight-indigo');
  assert.equal(sanitizePackId('../evil'), null);
  assert.equal(sanitizePackId('Pack_Upper'), null);
  assert.equal(sanitizePackId('.hidden'), null);
  assert.equal(sanitizePackId(''), null);
});

test('sanitizeRelativeFile 只放行白名单静态资源，拒绝脚本与穿越', () => {
  assert.equal(sanitizeRelativeFile('pack.css'), 'pack.css');
  assert.equal(sanitizeRelativeFile('fonts/sans.woff2'), 'fonts/sans.woff2');
  assert.equal(sanitizeRelativeFile('index.mjs'), null);
  assert.equal(sanitizeRelativeFile('evil.js'), null);
  assert.equal(sanitizeRelativeFile('../secret.css'), null);
  assert.equal(sanitizeRelativeFile('.git/config'), null);
});

test('inlineCssLocalAssets 将本地相对资源内联为 data URL', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-packs-inline-'));
  try {
    const packDir = path.join(tmpRoot, 'demo');
    fs.mkdirSync(path.join(packDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'assets', 'dot.png'), Buffer.from([137, 80, 78, 71]));

    const out = inlineCssLocalAssets(
      ".bg { background-image: url('./assets/dot.png'); }",
      packDir,
    );
    assert.match(out, /data:image\/png;base64,/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('registerPacksManager 支持拉取清单、安装落盘、读取、卸载与来源校验', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-packs-mgr-'));
  const handlers = new Map();
  const fakeIpc = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };

  const remoteFiles = {
    'https://raw.example/categories/theme.json': JSON.stringify({
      version: 1,
      category: 'theme',
      packs: [
        {
          id: 'midnight-indigo',
          category: 'theme',
          name: '午夜靛蓝',
          description: 'desc',
          version: '1.0.0',
          hostApiVersion: '1',
          files: ['manifest.json', 'pack.css'],
        },
      ],
    }),
    'https://raw.example/packs/midnight-indigo/manifest.json': JSON.stringify({
      id: 'midnight-indigo',
      category: 'theme',
      name: '午夜靛蓝',
      description: 'desc',
      version: '1.0.0',
      hostApiVersion: '1',
      entryCss: 'pack.css',
    }),
    'https://raw.example/packs/midnight-indigo/pack.css': ':root { --lx-accent: #6366f1; }',
  };

  const mgr = registerPacksManager({
    ipcMain: fakeIpc,
    userDataDir,
    assertTrustedSender: (ev) => {
      if (!ev?.trusted) throw new Error('untrusted');
    },
    categoriesRawBase: 'https://raw.example/categories',
    packsRawBase: 'https://raw.example/packs',
    fetchImpl: async (url) => {
      const body = remoteFiles[url];
      if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      const buf = Buffer.from(body, 'utf8');
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    },
  });

  try {
    const trusted = { trusted: true };

    // 未授权来源直接拒绝
    await assert.rejects(
      () => handlers.get('packs:fetch-registry')({ trusted: false }, 'theme'),
      /untrusted/,
    );

    // 非法类目拒绝
    const badCat = await handlers.get('packs:fetch-registry')(trusted, '../evil');
    assert.equal(badCat.ok, false);

    // 1. 按类目拉取远端清单
    const reg = await handlers.get('packs:fetch-registry')(trusted, 'theme');
    assert.equal(reg.ok, true);
    assert.equal(reg.packs.length, 1);
    assert.equal(reg.packs[0].id, 'midnight-indigo');

    // 2. 安装落盘
    const inst = await handlers.get('packs:install')(trusted, {
      id: 'midnight-indigo',
      files: ['manifest.json', 'pack.css'],
    });
    assert.equal(inst.ok, true);
    assert.equal(listInstalledPacksFromDir(path.join(userDataDir, 'packs')).length, 1);

    // 3. 读取
    const loaded = await handlers.get('packs:load')(trusted, 'midnight-indigo');
    assert.equal(loaded.ok, true);
    assert.match(loaded.cssText, /--lx-accent: #6366f1/);

    // 4. 卸载
    const uninst = await handlers.get('packs:uninstall')(trusted, 'midnight-indigo');
    assert.equal(uninst.ok, true);
    assert.equal(listInstalledPacksFromDir(path.join(userDataDir, 'packs')).length, 0);
    assert.equal(loadInstalledPackFromDir(path.join(userDataDir, 'packs'), 'midnight-indigo').ok, false);
  } finally {
    mgr.close();
    assert.equal(handlers.size, 0);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('scanCustomPacksDir 支持单包目录、多包合集目录并拦截相对路径', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-custom-packs-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-custom-ud-'));
  const handlers = new Map();
  const mgr = registerPacksManager({
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    },
    userDataDir,
    assertTrustedSender: () => {},
  });

  try {
    // 1. 相对路径直接拒绝
    const relRes = scanCustomPacksDir('relative/path');
    assert.equal(relRes.ok, false);

    // 2. 多包合集目录
    const multiDir = path.join(tmpRoot, 'multi');
    const pack1Dir = path.join(multiDir, 'custom-theme');
    fs.mkdirSync(pack1Dir, { recursive: true });
    fs.writeFileSync(
      path.join(pack1Dir, 'manifest.json'),
      JSON.stringify({
        id: 'custom-theme',
        category: 'theme',
        name: '自定义主题',
        version: '1.0.0',
        hostApiVersion: '1',
      }),
    );
    fs.writeFileSync(path.join(pack1Dir, 'pack.css'), ':root { --lx-accent: #123456; }');

    const scanMulti = await handlers.get('packs:scan-custom-dir')({}, multiDir);
    assert.equal(scanMulti.ok, true);
    assert.equal(scanMulti.packs.length, 1);
    assert.equal(scanMulti.packs[0].id, 'custom-theme');

    // 3. 单包目录（manifest.json 直接在根下）
    const scanSingle = await handlers.get('packs:scan-custom-dir')({}, pack1Dir);
    assert.equal(scanSingle.ok, true);
    assert.equal(scanSingle.packs.length, 1);
    assert.equal(scanSingle.packs[0].packDir, pack1Dir);

    // 4. 加载自定义包样式
    const loaded = await handlers.get('packs:load-custom')({}, { id: 'custom-theme', packDir: pack1Dir });
    assert.equal(loaded.ok, true);
    assert.match(loaded.cssText, /--lx-accent: #123456/);
  } finally {
    mgr.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
