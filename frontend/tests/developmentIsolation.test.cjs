const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { transformSync } = require('esbuild');

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
  const source = fs.readFileSync(path.join(__dirname, '../vite.config.ts'), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, __dirname,
    require: name => name === 'vite' ? { defineConfig: value => value }
      : name === '@vitejs/plugin-vue' ? () => ({}) : require(name) });
  const proxy = module.exports.default.server.proxy;
  for (const prefix of ['/a', '/config', '/session', '/mcp']) {
    assert.equal(proxy[prefix].target, 'http://localhost:8089');
  }
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
