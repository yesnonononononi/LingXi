const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const http = require('node:http');
const { buildSync, transformSync } = require('esbuild');
// 路径比较只有一个口径：先把路径规范成长名（见 tests/support/tmp-paths.cjs 文件头）。
// 绝不直接用 os.tmpdir() 的拼写：Windows 上它可能是 8.3 短名（CI 的 RUNNER~1），
// 而 PowerShell / javac 回报的是长名，字符串比较必然假失败。
const { canonicalPath, TMP_ROOT } = require('./support/tmp-paths.cjs');

function loadViteConfig() {
  const source = fs.readFileSync(path.join(__dirname, '../vite.config.ts'), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  // 配置里的裸相对 require（如 './scripts/pet-asset-isolation.mjs'）必须以 vite.config.ts
  // 所在目录为基准解析；用本文件的 require 会解析成 tests/scripts/*，直接 MODULE_NOT_FOUND。
  const configRequire = createRequire(path.join(__dirname, '../vite.config.ts'));
  vm.runInNewContext(code, { module, exports: module.exports, __dirname,
    require: name => name === 'vite' ? { defineConfig: value => value }
      : name === '@vitejs/plugin-vue' ? () => ({}) : configRequire(name) });
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

test('绝对路径预览在开发版走页面代理，安装版使用后端地址', () => {
  const vue = { ...require('vue'), onBeforeUnmount: () => {} };
  const origin = 'http://127.0.0.1:59174';
  const configured = 'http://127.0.0.1:9000';
  for (const development of [true, false]) {
    const { outputFiles } = buildSync({
      entryPoints: [path.join(__dirname, '../src/composables/useFilePreview.ts')],
      bundle: true, write: false, format: 'cjs', external: ['vue'],
      logOverride: { 'empty-import-meta': 'silent' },
      define: {
        'import.meta.env.DEV': String(development),
        'import.meta.env.PROD': String(!development),
        'import.meta.env.VITE_API_BASE_URL': 'undefined',
      },
    });
    const baseUrls = [];
    const module = { exports: {} };
    let storedUrl = configured;
    vm.runInNewContext(outputFiles[0].text, {
      module, exports: module.exports, require: () => vue,
      localStorage: { getItem: key => key === 'lingxi_api_base_url' ? storedUrl : null },
      window: {
        location: { origin: development ? origin : 'file://' },
        electronAPI: {
          previewFile: async request => {
            baseUrls.push(request.baseUrl);
            return { ok: true, data: {} };
          },
        },
      },
    });
    const { openFilePreview } = module.exports.useFilePreview();
    openFilePreview('101', path.join(__dirname, 'first.java'));
    storedUrl = '';
    openFilePreview('101', path.join(__dirname, 'second.java'));
    assert.deepEqual(baseUrls, development ? [origin, origin] : [configured, 'http://localhost:8088']);
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

/** 仓库根目录（本文件在 `frontend/tests/`）。 */
const REPO_ROOT_DIR = path.resolve(__dirname, '../..');

/**
 * Maven 本地仓库解析的**唯一真源**：`scripts/lib/maven-settings.ps1`。
 *
 * <p>它负责"剥 XML 注释 → 提取 `<localRepository>` → 候选顺序 → 兜底"四件事。以前这段逻辑在本文件、
 * `Migrate-SqliteToH2.ps1`、`Initialize-Development.ps1` 里各写了一份，于是同一个缺陷
 * （Maven 发行版 `conf/settings.xml` 里**被注释掉的** `<localRepository>/path/to/local/repo</localRepository>`
 * 示例被注释盲正则当成真实配置，最终解析成 `D:\path\to\local\repo` 这种不存在的路径）修一处漏两处。
 * 所以这里**不再自己维护候选顺序**，一律问真源。</p>
 */
const MAVEN_SETTINGS_LIB = path.join(REPO_ROOT_DIR, 'scripts', 'lib', 'maven-settings.ps1');

/** 真源是 Windows PowerShell 脚本（与两个 PS 调用方的运行环境一致）。 */
const POWERSHELL = 'powershell.exe';

/**
 * 把值包成 PowerShell 单引号字符串（单引号内只需把 `'` 写成 `''`）。
 *
 * @param {unknown} value 原值
 * @returns {string} 可直接拼进 `-Command` 的字面量
 */
function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/**
 * 调 `scripts/lib/maven-settings.ps1` 取解析结果。
 *
 * @param {'value'|'candidates'} mode `value` = 单个 settings.xml 里生效的 `<localRepository>`；
 *   `candidates` = 按优先级排好的本地仓库候选列表
 * @param {{settingsPath?: string, explicit?: string, env?: NodeJS.ProcessEnv}} [options] 选项；
 *   `env` 里值为 `undefined` 表示从子进程环境里**删掉**该变量（用于验证"脏值不参与"）
 * @returns {string|string[]} `value` 模式返回字符串（没有配置时为空串），`candidates` 模式返回数组
 * @throws {Error} 真源缺失或 PowerShell 调用失败时抛出
 */
function runMavenSettingsLib(mode, options = {}) {
  if (mode !== 'value' && mode !== 'candidates') {
    throw new TypeError(`runMavenSettingsLib: mode 只能是 value / candidates，收到 ${String(mode)}`);
  }
  if (!fs.existsSync(MAVEN_SETTINGS_LIB)) {
    throw new Error(`缺少 Maven settings 真源：${MAVEN_SETTINGS_LIB}`);
  }
  const settingsPath = typeof options.settingsPath === 'string' ? options.settingsPath : '';
  const explicit = typeof options.explicit === 'string' ? options.explicit : '';
  const body = mode === 'value'
    ? `$value = Read-MavenSettingsLocalRepository -Path ${psQuote(settingsPath)}; if ($value) { [Console]::Out.Write($value) }`
    : `(Get-MavenRepositoryCandidates -Explicit ${psQuote(explicit)}) | ForEach-Object { [Console]::Out.WriteLine($_) }`;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `. ${psQuote(MAVEN_SETTINGS_LIB)}`,
    body,
  ].join('; ');
  const env = { ...process.env };
  for (const [key, value] of Object.entries(options.env || {})) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', env, timeout: 60000 });
  if (result.error) throw new Error(`调用 Maven settings 真源失败：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Maven settings 真源执行失败（${mode}，退出码 ${result.status}）：${(result.stderr || result.stdout || '').trim()}`);
  }
  const output = result.stdout || '';
  if (mode === 'value') return output.trim();
  return output.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
}

/**
 * 在本地 Maven 仓库候选里找一个 jar。
 *
 * <p>候选仓库顺序**不由本文件维护**：来自 `scripts/lib/maven-settings.ps1` 的
 * `Get-MavenRepositoryCandidates`（显式参数 → `MAVEN_REPO_LOCAL` → 各 settings.xml 的
 * `<localRepository>` → 兜底 `~/.m2/repository`）。</p>
 *
 * @param {string[]} groupSegments 组路径片段，例如 `['org','xerial','sqlite-jdbc']`
 * @param {string} artifactPrefix jar 名前缀，例如 `'sqlite-jdbc-'`（`-sources`/`-javadoc` 会被跳过）
 * @returns {string} jar 的绝对路径
 * @throws {Error} 所有候选仓库里都没有时抛出
 */
function resolveMavenArtifactJar(groupSegments, artifactPrefix) {
  const repositories = runMavenSettingsLib('candidates');
  for (const repository of repositories) {
    const root = path.join(repository, ...groupSegments);
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      const versionDirectory = path.join(root, version);
      if (!fs.statSync(versionDirectory).isDirectory()) continue;
      for (const name of fs.readdirSync(versionDirectory)) {
        if (!name.startsWith(artifactPrefix) || !name.endsWith('.jar')) continue;
        if (name.endsWith('-sources.jar') || name.endsWith('-javadoc.jar')) continue;
        return path.join(versionDirectory, name);
      }
    }
  }
  throw new Error(`本地 Maven 仓库里没有 ${groupSegments.join('/')} 的 jar`
    + `（先执行一次 mvn -o test 拉取依赖）；候选仓库：${repositories.join(' / ')}`);
}

/** 按 pom 固定的版本找 sqlite-jdbc；找不到就明确失败，不静默跳过。 */
function resolveSqliteJdbcJar() {
  return resolveMavenArtifactJar(['org', 'xerial', 'sqlite-jdbc'], 'sqlite-jdbc-');
}

/** 找 H2 引擎 jar：读 H2 开发库时必须把它放进探针的 classpath。 */
function resolveH2Jar() {
  return resolveMavenArtifactJar(['com', 'h2database', 'h2'], 'h2-');
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

/**
 * 跑一条只读查询并返回**全部**行的第一列（去空行）。
 *
 * @param {string} probeSource 探针源码路径
 * @param {string} databaseFile SQLite 库文件
 * @param {string} query 查询语句
 * @returns {string[]} 每一行的第一列
 */
function sqliteQueryAll(probeSource, databaseFile, query) {
  const result = spawnSync(resolveJdkJava(), ['-cp', resolveSqliteJdbcJar(), probeSource,
    databaseFile, '', query], { encoding: 'utf8' });
  assert.equal(result.status, 0, `sqlite 查询失败: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
}

/** H2 只读探针：读 H2 开发库必须走驱动，不能靠翻二进制文件。 */
const H2_PROBE = `
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

public final class H2Probe {
    public static void main(String[] args) throws Exception {
        String base = args[0].replace('\\\\', '/');
        String url = "jdbc:h2:file:" + base + ";IFEXISTS=TRUE;ACCESS_MODE_DATA=r;DB_CLOSE_ON_EXIT=FALSE";
        try (Connection connection = DriverManager.getConnection(url, "sa", "");
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(args[1])) {
            while (rows.next()) {
                System.out.println(rows.getString(1));
            }
        }
    }
}
`;

/**
 * 对 H2 库跑一条只读查询，返回全部行的第一列。
 *
 * @param {string} probeSource H2 探针源码路径
 * @param {string} databaseBase H2 库文件主干（不含 `.mv.db`）
 * @param {string} query 查询语句
 * @returns {string[]} 每一行的第一列
 */
function h2Query(probeSource, databaseBase, query) {
  const result = spawnSync(resolveJdkJava(), ['-cp', resolveH2Jar(), probeSource, databaseBase, query],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, `H2 探针失败: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
}

/** 生产 H2 基线 DDL：迁移后的目标库结构就是它（本用例的夹具在它基础上补哨兵表）。 */
const H2_BASELINE_SCHEMA = path.resolve(__dirname, '../../src/main/resources/db/h2/V1__schema.sql');

test('初始化把 SQLite 迁移成 H2 开发库：产出 H2 库 + 迁移清单 + checkpoints，改写副本目录，并拒绝覆盖已有开发数据',
  { skip: process.platform !== 'win32', timeout: 240000 }, t => {
    const temporary = fs.mkdtempSync(path.join(TMP_ROOT, 'lingxi-isolation-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const probeSource = path.join(temporary, 'SqliteProbe.java');
    fs.writeFileSync(probeSource, SQLITE_PROBE);
    const h2ProbeSource = path.join(temporary, 'H2Probe.java');
    fs.writeFileSync(h2ProbeSource, H2_PROBE);
    const source = path.join(temporary, 'installed');
    const destination = path.join(temporary, 'development');
    fs.mkdirSync(path.join(source, 'config'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data', 'images'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data', 'checkpoints', '123'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skill'), { recursive: true });
    const sourceDatabase = path.join(source, 'data', 'lingxi.sqlite');
    sqliteProbe(probeSource, sourceDatabase, 'CREATE TABLE canary(marker TEXT)', 'SELECT 1');
    sqliteProbe(probeSource, sourceDatabase, "INSERT INTO canary VALUES('database-copy-canary')", 'SELECT 1');
    fs.writeFileSync(path.join(source, 'data', 'checkpoints', '123', 'abc.json'), 'checkpoint-copy-canary');
    fs.writeFileSync(path.join(source, 'data', 'images', 'one.png'), 'image-copy-canary');
    fs.writeFileSync(path.join(source, 'skill', 'SKILL.md'), 'skill-copy-canary');
    fs.writeFileSync(path.join(source, 'config', 'models.json'), '[{"id":"123","name":"same-model"}]');
    const originalSettings = JSON.stringify([{ id: '1', dataDir: path.join(source, 'data'),
      skillDir: path.join(source, 'skill'), modelId: '123', accessMode: 'IN_WORKSPACE' }]);
    fs.writeFileSync(path.join(source, 'config', 'user-configs.json'), originalSettings);
    // 列名用 marker 而不是 value：VALUE 是 H2 2.x 的保留字，写成 value 会直接语法错误。
    // 迁移工具强制「源库每张表都必须在目标库存在」（SqliteToH2Migration.buildTablePlans），
    // 所以目标结构必须认识 canary。夹具 = 生产基线 DDL + canary 哨兵表；业务基线本身不动。
    const schemaPath = path.join(temporary, 'h2-schema-with-canary.sql');
    fs.writeFileSync(schemaPath,
      `${fs.readFileSync(H2_BASELINE_SCHEMA, 'utf8')}\nCREATE TABLE IF NOT EXISTS canary(marker TEXT);\n`);
    const sourceDatabaseSha = createHash('sha256').update(fs.readFileSync(sourceDatabase)).digest('hex').toUpperCase();
    const initialize = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, '../../scripts/Initialize-Development.ps1'), '-SourceHome', source, '-Destination', destination,
      '-H2Schema', schemaPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    // 库被占用时不允许初始化：复制正在写入的库就是复制一份自相矛盾的数据。
    const occupiedDatabase = fs.openSync(sourceDatabase, 'r');
    try {
      assert.equal(initialize().status, 1);
      assert.equal(fs.existsSync(destination), false);
    } finally { fs.closeSync(occupiedDatabase); }
    const result = initialize();
    assert.equal(result.status, 0, result.stderr);
    const dataDirectory = path.join(destination, 'data');
    // 非库文件按原样复制。
    for (const relative of ['data/images/one.png', 'skill/SKILL.md', 'config/models.json',
      'data/checkpoints/123/abc.json']) {
      assert.deepEqual(fs.readFileSync(path.join(destination, relative)), fs.readFileSync(path.join(source, relative)));
    }
    // 新契约：开发数据目录里是 H2 库 + 迁移清单 + checkpoints，不再留 SQLite。
    assert.equal(fs.existsSync(path.join(dataDirectory, 'lingxi-h2.mv.db')), true,
      '开发目录必须有 H2 库文件 lingxi-h2.mv.db');
    assert.equal(fs.existsSync(path.join(dataDirectory, 'lingxi.sqlite')), false,
      '迁移完成后开发目录里不许留 SQLite 库：SQLite 只是搬运来源');
    assert.equal(fs.existsSync(path.join(dataDirectory, 'lingxi.mv.db')), false,
      'H2 库名必须是 lingxi-h2.mv.db，不能用默认主干名');
    const migrationManifest = JSON.parse(
      fs.readFileSync(path.join(dataDirectory, 'migration-from-sqlite.json'), 'utf8'));
    assert.equal(migrationManifest.verified, true,
      `迁移清单必须 verified=true：${migrationManifest.failureReason || '(无 failureReason)'}`);
    // 迁移清单刻意不落 engine/schemaMode（见 MigrationManifest 注释）：引擎归属看 initialization.json。
    assert.equal(migrationManifest.targetDatabaseFile, 'lingxi-h2.mv.db');
    // 表齐全守护（不降力）：H2 目标库必须包含源库**全部**表，canary 哨兵表也在内。
    const sourceTables = sqliteQueryAll(probeSource, sourceDatabase,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    assert.ok(sourceTables.length > 0, '源库必须至少有一张表，否则这条用例什么都没验');
    assert.ok(sourceTables.map(name => name.toUpperCase()).includes('CANARY'),
      `源库必须含 canary 哨兵表，实际: ${sourceTables.join(', ')}`);
    const h2Tables = h2Query(h2ProbeSource, path.join(dataDirectory, 'lingxi-h2'),
      "SELECT table_name FROM information_schema.tables WHERE table_schema='PUBLIC'")
      .map(name => name.toUpperCase());
    for (const table of sourceTables) {
      assert.ok(h2Tables.includes(table.toUpperCase()),
        `H2 目标库缺少源库表 ${table}（目标库现有: ${h2Tables.join(', ')}）`);
    }
    // 迁移清单的记录方式：tableFingerprints/sourceRowCounts 是「表名 → 指纹/行数」映射（没有 tables 数组），
    // 它只记**源库**的表（目标库还有基线自带的表，所以不能拿它跟 H2 表数直接比）。
    const migratedTables = Object.keys(migrationManifest.tableFingerprints || {});
    assert.deepEqual(migratedTables.map(name => name.toUpperCase()).sort(),
      sourceTables.map(name => name.toUpperCase()).sort(),
      '迁移清单必须逐表记录源库全部表（含 canary）');
    const rowCounts = migrationManifest.sourceRowCounts || {};
    const canaryKey = Object.keys(rowCounts).find(name => name.toUpperCase() === 'CANARY');
    assert.ok(canaryKey, `迁移清单必须记录 canary 的行数，实际记录: ${Object.keys(rowCounts).join(', ')}`);
    assert.equal(rowCounts[canaryKey], 1, 'canary 表必须真的搬过去 1 行');
    // 数据也得过去：canary 的值必须能在 H2 里读回同一条业务数据。
    assert.deepEqual(h2Query(h2ProbeSource, path.join(dataDirectory, 'lingxi-h2'), 'SELECT marker FROM canary'),
      ['database-copy-canary']);
    // 快照是只读动作：源库本体不能被改动（不能靠复制正在写入的主文件蒙过去）。
    assert.equal(createHash('sha256').update(fs.readFileSync(sourceDatabase)).digest('hex').toUpperCase(),
      sourceDatabaseSha);
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'initialization.json'), 'utf8'));
    assert.equal(manifest.engine, 'h2');
    assert.equal(manifest.databaseSnapshot, 'VACUUM INTO 后迁移 H2');
    assert.equal(manifest.h2DatabaseFile, 'lingxi-h2.mv.db');
    assert.equal(manifest.h2MigrationVerified, true);
    assert.equal(manifest.h2MigrationTables, sourceTables.length,
      'initialization.json 记录的表数必须等于源库表数');
    assert.equal(manifest.databaseSha256, manifest.h2MigrationSourceSha256,
      '库快照指纹必须与迁移清单里的源指纹一致（两者指向同一份 VACUUM INTO 快照）');
    assert.deepEqual(manifest.checkpointFiles.map(file => file.split(path.sep).join('/')), ['123/abc.json']);
    assert.ok(manifest.configFiles.some(file => file.name === 'user-configs.json'));
    assert.equal(fs.readFileSync(path.join(source, 'config', 'user-configs.json'), 'utf8'), originalSettings);
    const copiedSettings = JSON.parse(fs.readFileSync(path.join(destination, 'config', 'user-configs.json'), 'utf8'));
    // 严格相等，只是比较前先规范成长名：PowerShell 改了副本里的 dataDir/skillDir 后回报的是
    // 长名（runneradmin），而 JS 侧的 destination 可能带 8.3 短名成分（RUNNER~1），
    // 直接比字符串就会假不等 —— 这是 CI 上红过的那条断言。
    assert.equal(canonicalPath(copiedSettings[0].dataDir), canonicalPath(path.join(destination, 'data')),
      '副本 settings 的 dataDir 必须指向开发目录的 data（比较前先规范化，避免 8.3 短名假不等）');
    assert.equal(canonicalPath(copiedSettings[0].skillDir), canonicalPath(path.join(destination, 'skill')),
      '副本 settings 的 skillDir 必须指向开发目录的 skill（比较前先规范化）');
    assert.equal(copiedSettings[0].modelId, '123');
    assert.equal(copiedSettings[0].accessMode, 'IN_WORKSPACE');
    // 已有开发目录不许被覆盖。
    assert.equal(initialize().status, 1);
    assert.equal(fs.readFileSync(path.join(destination, 'data', 'checkpoints', '123', 'abc.json'), 'utf8'),
      'checkpoint-copy-canary');
  });



// ---------------------------------------------------------------- Maven settings 单一真源与真值表

/**
 * 造三态 settings.xml fixture（建在系统临时目录，用例结束由 `t.after` 删干净）。
 *
 * @param {import('node:test').TestContext} t 用例上下文
 * @returns {{root: string, home: string, onlyComment: string, real: string, commentedThenReal: string, realAfterPath: string}}
 *   fixture 根目录、假 USERPROFILE、三个 settings.xml 路径与"注释之后那个真实值"
 */
function createMavenSettingsFixtures(t) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'lx-maven-settings-'));
  t.after(() => {
    // 只删自己造的那个前缀目录，绝不动临时目录本体
    const relative = path.relative(TMP_ROOT, root);
    assert.ok(relative.startsWith('lx-maven-settings-') && !relative.includes(path.sep), `拒删非 fixture 目录：${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.m2'), { recursive: true });
  /** 写一个 settings.xml（无 BOM UTF-8）。 */
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  };
  // (a) 只有被注释掉的示例 —— 这是 Maven 发行版 conf/settings.xml 的真实形态
  const onlyComment = write('only-comment.xml', `<settings>
  <!--
  <localRepository>/path/to/local/repo</localRepository>
  -->
</settings>
`);
  // (b) 有真实元素
  const real = write('real.xml', `<settings>
  <localRepository>D:/tmp/lx-real-repo</localRepository>
</settings>
`);
  // (c) 注释里的示例在前，后面才是真实元素（顺序不能颠倒）
  const commentedThenReal = write('commented-then-real.xml', `<settings>
  <!--
  <localRepository>/path/to/local/repo</localRepository>
  -->
  <localRepository>D:/tmp/lx-real-after-comment</localRepository>
</settings>
`);
  return { root, home, onlyComment, real, commentedThenReal, realAfterPath: 'D:/tmp/lx-real-after-comment' };
}

/**
 * 路径比较的**唯一**口径：先按 Windows 语义归一化分隔符，再规范化成长名。
 *
 * <p>为什么不能只 `path.win32.normalize`：候选列表由 PowerShell 生成（`GetFullPath` 回报长名
 * `runneradmin`），而 fixture home 可能来自 `os.tmpdir()` 的 8.3 短名（`RUNNER~1`），
 * 两者是同一目录但字符串不同，`indexOf` 会得到 -1，断言假红。</p>
 *
 * @param {string} value 待比较的路径
 * @returns {string} 可安全用于严格相等 / indexOf 的比较键
 */
function normalizeWinPath(value) {
  return canonicalPath(path.win32.normalize(String(value)));
}

test('Maven settings 解析只有一份实现：两个 PowerShell 脚本都 dot-source scripts/lib/maven-settings.ps1', () => {
  const libSource = fs.readFileSync(MAVEN_SETTINGS_LIB, 'utf8');
  for (const name of ['Get-MavenLocalRepository', 'Get-MavenRepositoryCandidates',
    'Read-MavenSettingsLocalRepository', 'Remove-MavenSettingsComments']) {
    assert.match(libSource, new RegExp(`function ${name}\\b`), `真源里必须导出 ${name}`);
  }
  // 剥掉 PS 注释后再看：注释里提 <localRepository> 是正当说明，代码里出现才是重复实现。
  // 注意用 trimStart().startsWith('#') 判行注释：JS 的 '.' 不匹配 \r，
  // 写成 /^\s*#.*$/ 在 CRLF 文件上会整行漏掉（本文件踩过这个坑）。
  const stripPowerShellComments = source => String(source)
    .replace(/<#[\s\S]*?#>/g, '')
    .split(/\r?\n/)
    .map(line => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n');
  for (const name of ['Migrate-SqliteToH2.ps1', 'Initialize-Development.ps1']) {
    const file = path.join(REPO_ROOT_DIR, 'scripts', name);
    const code = stripPowerShellComments(fs.readFileSync(file, 'utf8'));
    assert.match(code, /\.\s+\(Join-Path \$PSScriptRoot 'lib\/maven-settings\.ps1'\)/,
      `${name} 必须 dot-source 真源，而不是自带一份解析`);
    assert.equal(code.includes('<localRepository>'), false,
      `${name} 的代码里不许再出现 <localRepository> 正则/解析（规则真源在 scripts/lib/maven-settings.ps1）`);
    assert.equal(code.includes('<!--'), false,
      `${name} 的代码里不许再自带注释剥离规则（规则真源在 scripts/lib/maven-settings.ps1）`);
  }
  // 本文件自己也不许再维护第四份：不允许出现注释盲的提取正则
  const selfSource = fs.readFileSync(__filename, 'utf8');
  assert.equal(/<localRepository>\\s\*\(\[\^<\]/.test(selfSource), false,
    'JS 侧不许再出现自己的 <localRepository> 提取正则（问 scripts/lib/maven-settings.ps1）');
});

test('Maven settings 真值表（PowerShell 真源，三态）', { skip: process.platform !== 'win32' }, t => {
  const fixtures = createMavenSettingsFixtures(t);
  const cases = [
    { name: '(a) 只有被注释掉的示例 → 没有配置', file: fixtures.onlyComment, expected: '' },
    { name: '(b) 真实 <localRepository> → 返回它', file: fixtures.real, expected: 'D:/tmp/lx-real-repo' },
    { name: '(c) 注释示例在前、真实元素在后 → 返回真实那个', file: fixtures.commentedThenReal, expected: fixtures.realAfterPath },
  ];
  for (const item of cases) {
    const actual = runMavenSettingsLib('value', { settingsPath: item.file });
    assert.equal(actual, item.expected, `${item.name}；实际 ${JSON.stringify(actual)}`);
    assert.notEqual(actual, '/path/to/local/repo', `${item.name}：绝不能把注释里的示例当成配置`);
    assert.notEqual(actual, 'D:\\path\\to\\local\\repo', `${item.name}：绝不能返回 GetFullPath 把示例拼出来的路径`);
  }
});

test('Maven settings 真值表（JS 消费侧同构：候选列表里不得出现被注释的示例）', { skip: process.platform !== 'win32' }, t => {
  const fixtures = createMavenSettingsFixtures(t);
  // 假 HOME + 清掉宿主可能带进来的仓库变量，保证 "候选里有什么" 只由 fixture 决定
  const isolatedEnv = { USERPROFILE: fixtures.home, MAVEN_REPO_LOCAL: undefined, MAVEN_HOME: undefined, M2_HOME: undefined };
  const candidatesWith = (settingsFixture) => {
    fs.copyFileSync(settingsFixture, path.join(fixtures.home, '.m2', 'settings.xml'));
    return runMavenSettingsLib('candidates', { explicit: '', env: isolatedEnv });
  };

  // (a) 只有注释示例 → 候选里没有示例路径，也没有那个由 GetFullPath 拼出来的假路径
  const onlyComment = candidatesWith(fixtures.onlyComment);
  for (const candidate of onlyComment) {
    assert.equal(candidate.includes('path\\to\\local\\repo'), false, `(a) 候选里出现了注释示例：${candidate}`);
    assert.equal(candidate.includes('path/to/local/repo'), false, `(a) 候选里出现了注释示例：${candidate}`);
  }
  assert.ok(onlyComment.length > 0, '(a) 候选列表至少要有兜底的 ~/.m2/repository');

  // (b) 真实元素 → 候选里必须有它
  const withReal = candidatesWith(fixtures.real);
  assert.ok(withReal.map(normalizeWinPath).includes(normalizeWinPath('D:/tmp/lx-real-repo')),
    `(b) 候选里必须有真实的 <localRepository>：${withReal.join(' / ')}`);

  // (c) 注释在前、真实在后 → 候选是真实那个，且排在兜底 ~/.m2/repository 之前（顺序不能颠倒）
  const withBoth = candidatesWith(fixtures.commentedThenReal);
  const index = withBoth.map(normalizeWinPath).indexOf(normalizeWinPath(fixtures.realAfterPath));
  assert.ok(index >= 0, `(c) 候选里必须有注释之后那个真实值：${withBoth.join(' / ')}`);
  const fallbackIndex = withBoth.map(normalizeWinPath)
    .indexOf(normalizeWinPath(path.join(fixtures.home, '.m2', 'repository')));
  assert.ok(fallbackIndex > index, `(c) 真实值必须排在兜底 ~/.m2/repository 之前：${withBoth.join(' / ')}`);
  for (const candidate of withBoth) {
    assert.equal(candidate.includes('path\\to\\local\\repo'), false, `(c) 候选里出现了注释示例：${candidate}`);
  }
});

// ---------------------------------------------------------------- 临时目录路径比较的回归守卫（Windows 8.3 短名）

/**
 * 与子进程交换路径的测试文件：fixture 根**必须**来自 `TMP_ROOT`，且不许再用 `os.tmpdir`
 * 自己拼路径。
 *
 * <p>为什么只锁这几个：短名缺陷的成因是"同一个目录在 JS 侧拼成短名、被子进程回报成长名"，
 * 只有跨进程交换路径的地方才会踩到；纯 JS 文件里自己跟自己比不会假不等。</p>
 *
 * @type {readonly string[]}
 */
const TMP_ROOT_GUARDED_FILES = Object.freeze(['developmentIsolation.test.cjs', 'backendRuntimeMaven.test.cjs']);

/**
 * 跨进程但**暂不**强制走 `TMP_ROOT` 的文件，每条都必须给出"为什么现在不违规"的理由。
 *
 * <p>白名单是数据驱动的显式清单，不是"检测到就放过"：新增一个既起子进程又用 `os.tmpdir`
 * 的文件，必须在这里登记，否则守卫直接红 —— 逼下一个人做决定，而不是默默复制旧写法。</p>
 *
 * @type {readonly {file: string, reason: string}[]}
 */
const CROSS_PROCESS_TMP_EXEMPTIONS = Object.freeze([
  {
    file: 'electronPackaging.test.cjs',
    reason: 'fixture 根只喂给 electron-builder 配置，全程只在 JS 侧使用，不与子进程回报的路径比较',
  },
  {
    file: 'frameworkDependencies.test.cjs',
    reason: '已用 fs.realpathSync 直接规范 os.tmpdir 的返回值（同一目录得到同一字符串），未迁到共享模块列入未决项',
  },
  {
    file: 'petDevServer.test.cjs',
    reason: 'TEST_TMP_DIR 只作隔离用日志/锁目录，涉及 tmpdir 的断言两侧都由本文件拼出，无跨进程比较',
  },
  {
    file: 'sandboxRuntime.test.cjs',
    reason: '已用 fs.realpathSync 直接规范 os.tmpdir 的返回值（同一目录得到同一字符串），未迁到共享模块列入未决项',
  },
]);

/** 扫描用的针：拼出来而不是写成字面量，否则本文件自己会被自己的扫描命中。 */
const TMPDIR_NEEDLE = ['os', 'tmpdir('].join('.');
const SUBPROCESS_NEEDLE = /\b(?:spawnSync|execFileSync|execSync|spawn)\s*\(/;

/**
 * 剥掉 JS 注释：注释里提及 `os.tmpdir` 是正当说明，代码里出现才是违规。
 *
 * @param {string} source 源文件全文
 * @returns {string} 去掉 `/* *\/` 与 `//` 注释后的文本
 */
function stripJsComments(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * 递归列出 `tests/` 下的测试源码（.cjs / .ts）。
 *
 * @returns {string[]} 绝对路径列表
 */
function listTestSources() {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:cjs|ts)$/.test(entry.name)) found.push(full);
    }
  };
  walk(__dirname);
  return found;
}

test('TMP_ROOT 必须是长名规范形：路径比较的唯一口径（Windows 8.3 短名回归守卫）', () => {
  const shortSegments = TMP_ROOT.split(path.sep).filter(segment => /~\d/.test(segment));
  assert.deepEqual(shortSegments, [],
    `TMP_ROOT 不许含 8.3 短名段（~n）：${TMP_ROOT}；否则 PowerShell / javac 回报的长名与它做字符串比较必然假失败`);
  assert.equal(canonicalPath(TMP_ROOT), TMP_ROOT, `TMP_ROOT 必须是规范化的不动点，实际 ${TMP_ROOT}`);
  // 下面两条与本机是否真能造出短名无关：canonicalPath 一旦退化成 "原样返回" 就立刻红，
  // 保证"去规范化"这个变异体在长名机器上也抓得住。
  assert.equal(canonicalPath('.'), fs.realpathSync.native(path.resolve('.')),
    'canonicalPath 必须解出真实路径（相对路径先按 cwd 解析）');
  assert.equal(path.isAbsolute(canonicalPath('support')), true, 'canonicalPath 必须返回绝对路径');
  const missing = path.join(TMP_ROOT, 'lx-canonical-probe-not-created', 'tail.webp');
  assert.equal(canonicalPath(missing), missing,
    '目标不存在时必须规范化最近的已存在祖先并保留尾段原样（mkdtemp 之前就要能算出同一个键）');
  assert.throws(() => canonicalPath(''), TypeError, 'canonicalPath 必须校验入参');
});

test('路径比较必须经过 canonicalPath：跨进程测试文件不许直接用 os.tmpdir 拼路径（注释提及不算）', () => {
  // 先证明扫描器本身有效，避免它退化成"永远绿"。
  assert.equal(stripJsComments(`// ${TMPDIR_NEEDLE} 在注释里提及不算违规`).includes(TMPDIR_NEEDLE), false,
    '注释剥离必须生效：注释里提及不算违规');
  assert.equal(stripJsComments(`/* ${TMPDIR_NEEDLE} */`).includes(TMPDIR_NEEDLE), false,
    '块注释也必须剥掉');
  assert.equal(stripJsComments(`fs.mkdtempSync(path.join(${TMPDIR_NEEDLE}, 'x-'))`).includes(TMPDIR_NEEDLE), true,
    '代码里的真实调用必须被扫到（否则守卫形同虚设）');

  const sources = listTestSources();
  assert.ok(sources.length > 10, `tests/ 下应当扫到足够多的测试源码，实际 ${sources.length} 个`);

  // 被判为"跨进程交换路径"的文件：既起子进程、又用 os.tmpdir 拼路径。
  const crossProcess = [];
  for (const file of sources) {
    const code = stripJsComments(fs.readFileSync(file, 'utf8'));
    if (!code.includes(TMPDIR_NEEDLE)) continue;
    if (!SUBPROCESS_NEEDLE.test(code)) continue;
    crossProcess.push(path.relative(__dirname, file).split(path.sep).join('/'));
  }

  // ① 受管文件：必须只用 TMP_ROOT，不许自己拼 tmpdir。
  for (const name of TMP_ROOT_GUARDED_FILES) {
    const code = stripJsComments(fs.readFileSync(path.join(__dirname, name), 'utf8'));
    assert.equal(code.includes(TMPDIR_NEEDLE), false,
      `${name} 不许直接用 os.tmpdir 拼路径：fixture 必须基于 TMP_ROOT，`
      + '否则 Windows 上会出现"JS 侧短名 vs 子进程长名"的假不等');
    assert.match(code, /require\('\.\/support\/tmp-paths\.cjs'\)/,
      `${name} 必须从 tests/support/tmp-paths.cjs 取 canonicalPath / TMP_ROOT`);
  }

  // ② 豁免清单必须名副其实：每条都有理由，且仍然真的"跨进程 + 用 tmpdir"。
  const exempted = CROSS_PROCESS_TMP_EXEMPTIONS.map(item => item.file);
  for (const item of CROSS_PROCESS_TMP_EXEMPTIONS) {
    assert.ok(item.reason.length >= 20, `豁免 ${item.file} 必须写清理由（≥20 字），实际 ${JSON.stringify(item.reason)}`);
    assert.equal(crossProcess.includes(item.file), true,
      `豁免清单里的 ${item.file} 已经不需要豁免（不再跨进程交换路径或已迁到 TMP_ROOT），请删掉这条`);
  }

  // ③ 新增的跨进程文件必须显式登记，不许默默复制旧写法。
  const declared = new Set([...TMP_ROOT_GUARDED_FILES, ...exempted]);
  assert.deepEqual(crossProcess.filter(name => !declared.has(name)), [],
    '新出现的"起子进程 + 用 os.tmpdir 拼路径"文件必须登记到 TMP_ROOT_GUARDED_FILES（改用 TMP_ROOT）'
    + '或 CROSS_PROCESS_TMP_EXEMPTIONS（写明理由）：短名/长名假不等只会在这里发生');
});