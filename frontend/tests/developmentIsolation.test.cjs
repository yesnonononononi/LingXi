const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const { transformSync } = require('esbuild');

function loadViteConfig() {
  const source = fs.readFileSync(path.join(__dirname, '../vite.config.ts'), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, __dirname,
    require: name => name === 'vite' ? { defineConfig: value => value }
      : name === '@vitejs/plugin-vue' ? () => ({}) : require(name) });
  return module.exports.default;
}

test('开发页面忽略旧桌面地址，安装版保留默认地址和用户配置', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/apiConfig.ts'), 'utf8');
  for (const development of [true, false]) {
    const code = transformSync(source, { loader: 'ts', format: 'cjs', define: {
      'import.meta.env.DEV': String(development), 'import.meta.env.PROD': String(!development),
      'import.meta.env.VITE_API_BASE_URL': 'undefined',
    } }).code;
    let configured = 'http://localhost:8088';
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, window: { electronAPI: {} },
      localStorage: { getItem: () => configured } });
    assert.equal(module.exports.getApiBaseUrl(), development ? '' : configured);
    configured = '';
    assert.equal(module.exports.getApiBaseUrl(), development ? '' : 'http://localhost:8088');
  }
});

test('Vite 的实际代理表将业务请求送到开发端口', () => {
  const proxy = loadViteConfig().server.proxy;
  for (const prefix of ['/a', '/config', '/execution', '/session', '/mcp', '/personalization', '/provider', '/skill', '/log']) {
    assert.equal(proxy[prefix]?.target, 'http://localhost:8089', prefix);
  }
});

test('Vite 监听源码，但跳过 Electron 验证缓存目录', { timeout: 15000 }, async t => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, '.run'), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(root, '.run', 'watch-canary-'));
  fs.writeFileSync(path.join(temporary, 'cache.db'), 'watch-canary');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { createServer } = await import('vite');
  const config = loadViteConfig();
  const vite = await createServer({ ...config, configFile: false, root, logLevel: 'silent',
    server: { ...config.server, middlewareMode: true } });
  t.after(() => vite.close());
  for (let attempt = 0; attempt < 50 && !vite.watcher.getWatched()[__dirname]?.includes(path.basename(__filename)); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const watched = vite.watcher.getWatched();
  assert.ok(watched[__dirname]?.includes(path.basename(__filename)), '正对照：源码必须进入真实监听器');
  const generated = path.join(root, '.run');
  assert.equal(Object.keys(watched).some(directory => directory === generated || directory.startsWith(generated + path.sep)),
    false, '运行缓存不得进入真实监听器');
});

test('设置请求经过真实 Vite 代理返回后端 JSON，不能落到 HTML 页面', async t => {
  const requests = [];
  const backend = http.createServer((request, response) => {
    requests.push([request.method, request.url]);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 1, data: { method: request.method, path: request.url } }));
  });
  t.after(() => new Promise(resolve => { backend.closeAllConnections(); backend.close(resolve); }));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const config = loadViteConfig();
  const target = `http://127.0.0.1:${backend.address().port}`;
  const { createServer } = await import('vite');
  const vite = await createServer({ ...config, configFile: false, root: path.join(__dirname, '..'),
    logLevel: 'silent', server: { ...config.server, host: '127.0.0.1', port: 0,
      watch: null, proxy: Object.fromEntries(Object.entries(config.server.proxy)
        .map(([prefix, options]) => [prefix, { ...options, target }])) } });
  t.after(() => vite.close());
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const endpoints = [['GET', '/personalization/current'], ['GET', '/personalization/reply-styles'],
    ['POST', '/personalization/update'], ['GET', '/provider/list'], ['GET', '/skill/list'], ['GET', '/log/location'],
    ['GET', '/execution/cleanup/preview'], ['POST', '/execution/cleanup']];
  for (const [method, endpoint] of endpoints) {
    const response = await fetch(base + endpoint, { method });
    assert.equal(response.status, 200, endpoint);
    assert.match(response.headers.get('content-type'), /application\/json/, endpoint);
    assert.deepEqual(await response.json(), { code: 1, data: { method, path: endpoint } });
  }
  assert.deepEqual(requests, endpoints);
});

test('初始化复制真实文件、改写副本目录，并拒绝覆盖已有开发数据', { skip: process.platform !== 'win32' }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-isolation-'));
  const source = path.join(temporary, 'installed');
  const destination = path.join(temporary, 'development');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true });
  fs.mkdirSync(path.join(source, 'data', 'images'), { recursive: true });
  fs.mkdirSync(path.join(source, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(source, 'data', 'lingxi.mv.db'), 'database-copy-canary');
  fs.writeFileSync(path.join(source, 'data', 'images', 'one.png'), 'image-copy-canary');
  fs.writeFileSync(path.join(source, 'skill', 'SKILL.md'), 'skill-copy-canary');
  fs.writeFileSync(path.join(source, 'config', 'models.json'), '[{"id":"123","name":"same-model"}]');
  const originalSettings = JSON.stringify([{ id: '1', dataDir: path.join(source, 'data'),
    skillDir: path.join(source, 'skill'), modelId: '123', accessMode: 'IN_WORKSPACE' }]);
  fs.writeFileSync(path.join(source, 'config', 'user-configs.json'), originalSettings);
  const initialize = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, '../../scripts/Initialize-Development.ps1'), '-SourceHome', source, '-Destination', destination],
    { encoding: 'utf8' });
  const occupiedDatabase = fs.openSync(path.join(source, 'data', 'lingxi.mv.db'), 'r');
  try {
    assert.equal(initialize().status, 1);
    assert.equal(fs.existsSync(destination), false);
  } finally { fs.closeSync(occupiedDatabase); }
  const result = initialize();
  assert.equal(result.status, 0, result.stderr);
  for (const relative of ['data/lingxi.mv.db', 'data/images/one.png', 'skill/SKILL.md', 'config/models.json']) {
    assert.deepEqual(fs.readFileSync(path.join(destination, relative)), fs.readFileSync(path.join(source, relative)));
  }
  assert.equal(fs.readFileSync(path.join(source, 'config', 'user-configs.json'), 'utf8'), originalSettings);
  const copiedSettings = JSON.parse(fs.readFileSync(path.join(destination, 'config', 'user-configs.json'), 'utf8'));
  assert.equal(copiedSettings[0].dataDir, path.join(destination, 'data'));
  assert.equal(copiedSettings[0].skillDir, path.join(destination, 'skill'));
  assert.equal(copiedSettings[0].modelId, '123');
  assert.equal(copiedSettings[0].accessMode, 'IN_WORKSPACE');
  assert.equal(initialize().status, 1);
  assert.equal(fs.readFileSync(path.join(destination, 'data', 'lingxi.mv.db'), 'utf8'), 'database-copy-canary');
});
