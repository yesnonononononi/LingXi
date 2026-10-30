const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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

// 初始化脚本的数据目录口径是「SQLite 库文件 lingxi.sqlite + checkpoints 目录」，
// 库快照由驱动做 VACUUM INTO，所以测试必须准备一份真 SQLite 库，不能拿文本文件冒充。

/** 找 JDK 的 java.exe：单文件源码启动需要带编译器的 JDK，JAVA_HOME 可能只是精简运行时。 */
function resolveJdkJava() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (entry) candidates.push(path.join(entry, 'java.exe'));
  }
  for (const candidate of candidates) {
    const javac = path.join(path.dirname(candidate), 'javac.exe');
    if (fs.existsSync(candidate) && fs.existsSync(javac)) return candidate;
  }
  throw new Error('找不到带 javac 的 JDK，无法为初始化用例准备 SQLite 库');
}

/** 按 pom 固定的版本在本地 Maven 仓库里找 sqlite-jdbc；找不到就明确失败，不静默跳过。 */
function resolveSqliteJdbcJar() {
  const repositories = [];
  if (process.env.MAVEN_REPO_LOCAL) repositories.push(process.env.MAVEN_REPO_LOCAL);
  const settingsFiles = [path.join(os.homedir(), '.m2', 'settings.xml')];
  for (const variable of [process.env.MAVEN_HOME, process.env.M2_HOME]) {
    if (variable) settingsFiles.push(path.join(variable, 'conf', 'settings.xml'));
  }
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (entry && fs.existsSync(path.join(entry, 'mvn.cmd'))) {
      settingsFiles.push(path.join(entry, '..', 'conf', 'settings.xml'));
      break;
    }
  }
  for (const settingsFile of settingsFiles) {
    if (!fs.existsSync(settingsFile)) continue;
    const matched = /<localRepository>\s*([^<]+?)\s*<\/localRepository>/.exec(fs.readFileSync(settingsFile, 'utf8'));
    if (matched) repositories.push(matched[1]);
  }
  repositories.push(path.join(os.homedir(), '.m2', 'repository'));
  for (const repository of repositories) {
    const root = path.join(repository, 'org', 'xerial', 'sqlite-jdbc');
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      const jar = path.join(root, version, `sqlite-jdbc-${version}.jar`);
      if (fs.existsSync(jar)) return jar;
    }
  }
  throw new Error('本地 Maven 仓库里没有 sqlite-jdbc（先执行一次 mvn -o test 拉取依赖）');
}

const SQLITE_PROBE = `
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

public final class SqliteProbe {
    public static void main(String[] args) throws Exception {
        String url = "jdbc:sqlite:" + args[0].replace('\\\\', '/');
        try (Connection connection = DriverManager.getConnection(url);
             Statement statement = connection.createStatement()) {
            if (!args[1].isEmpty()) {
                statement.execute(args[1]);
            }
            try (ResultSet rows = statement.executeQuery(args[2])) {
                while (rows.next()) {
                    System.out.println(rows.getString(1));
                }
            }
        }
    }
}
`;

/** 用反射不到的最小探针跑一条语句/查询，返回值是查询第一列的首行。 */
function sqliteProbe(probeSource, databaseFile, statement, query) {
  const result = spawnSync(resolveJdkJava(), ['-cp', resolveSqliteJdbcJar(), probeSource,
    databaseFile, statement || '', query || 'SELECT 1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `sqlite 探针失败: ${result.stderr}`);
  return result.stdout.trim();
}

test('初始化用 VACUUM INTO 复制 SQLite 库与 checkpoints，改写副本目录，并拒绝覆盖已有开发数据',
  { skip: process.platform !== 'win32', timeout: 120000 }, t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-isolation-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const probeSource = path.join(temporary, 'SqliteProbe.java');
    fs.writeFileSync(probeSource, SQLITE_PROBE);
    const source = path.join(temporary, 'installed');
    const destination = path.join(temporary, 'development');
    fs.mkdirSync(path.join(source, 'config'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data', 'images'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data', 'checkpoints', '123'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skill'), { recursive: true });
    const sourceDatabase = path.join(source, 'data', 'lingxi.sqlite');
    sqliteProbe(probeSource, sourceDatabase, 'CREATE TABLE canary(value TEXT)', 'SELECT 1');
    sqliteProbe(probeSource, sourceDatabase, "INSERT INTO canary VALUES('database-copy-canary')", 'SELECT 1');
    fs.writeFileSync(path.join(source, 'data', 'checkpoints', '123', 'abc.json'), 'checkpoint-copy-canary');
    fs.writeFileSync(path.join(source, 'data', 'images', 'one.png'), 'image-copy-canary');
    fs.writeFileSync(path.join(source, 'skill', 'SKILL.md'), 'skill-copy-canary');
    fs.writeFileSync(path.join(source, 'config', 'models.json'), '[{"id":"123","name":"same-model"}]');
    const originalSettings = JSON.stringify([{ id: '1', dataDir: path.join(source, 'data'),
      skillDir: path.join(source, 'skill'), modelId: '123', accessMode: 'IN_WORKSPACE' }]);
    fs.writeFileSync(path.join(source, 'config', 'user-configs.json'), originalSettings);
    const sourceDatabaseSha = createHash('sha256').update(fs.readFileSync(sourceDatabase)).digest('hex').toUpperCase();
    const initialize = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, '../../scripts/Initialize-Development.ps1'), '-SourceHome', source, '-Destination', destination],
      { encoding: 'utf8' });
    // 库被占用时不允许初始化：复制正在写入的库就是复制一份自相矛盾的数据。
    const occupiedDatabase = fs.openSync(sourceDatabase, 'r');
    try {
      assert.equal(initialize().status, 1);
      assert.equal(fs.existsSync(destination), false);
    } finally { fs.closeSync(occupiedDatabase); }
    const result = initialize();
    assert.equal(result.status, 0, result.stderr);
    // 非库文件按原样复制；库是快照，内容必须能读回同一条业务数据。
    for (const relative of ['data/images/one.png', 'skill/SKILL.md', 'config/models.json',
      'data/checkpoints/123/abc.json']) {
      assert.deepEqual(fs.readFileSync(path.join(destination, relative)), fs.readFileSync(path.join(source, relative)));
    }
    assert.equal(fs.existsSync(path.join(destination, 'data', 'lingxi.mv.db')), false);
    assert.equal(sqliteProbe(probeSource, path.join(destination, 'data', 'lingxi.sqlite'), '',
      'SELECT value FROM canary'), 'database-copy-canary');
    // 快照是只读动作：源库本体不能被改动（不能靠复制正在写入的主文件蒙过去）。
    assert.equal(createHash('sha256').update(fs.readFileSync(sourceDatabase)).digest('hex').toUpperCase(),
      sourceDatabaseSha);
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'initialization.json'), 'utf8'));
    assert.equal(manifest.databaseSnapshot, 'VACUUM INTO');
    assert.equal(manifest.databaseSha256, createHash('sha256')
      .update(fs.readFileSync(path.join(destination, 'data', 'lingxi.sqlite'))).digest('hex').toUpperCase());
    assert.deepEqual(manifest.checkpointFiles.map(file => file.split(path.sep).join('/')), ['123/abc.json']);
    assert.ok(manifest.configFiles.some(file => file.name === 'user-configs.json'));
    assert.equal(fs.readFileSync(path.join(source, 'config', 'user-configs.json'), 'utf8'), originalSettings);
    const copiedSettings = JSON.parse(fs.readFileSync(path.join(destination, 'config', 'user-configs.json'), 'utf8'));
    assert.equal(copiedSettings[0].dataDir, path.join(destination, 'data'));
    assert.equal(copiedSettings[0].skillDir, path.join(destination, 'skill'));
    assert.equal(copiedSettings[0].modelId, '123');
    assert.equal(copiedSettings[0].accessMode, 'IN_WORKSPACE');
    // 已有开发目录不许被覆盖。
    assert.equal(initialize().status, 1);
    assert.equal(fs.readFileSync(path.join(destination, 'data', 'checkpoints', '123', 'abc.json'), 'utf8'),
      'checkpoint-copy-canary');
  });

