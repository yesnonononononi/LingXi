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
 * 按 pom 固定的版本在本地 Maven 仓库里找 sqlite-jdbc；找不到就明确失败，不静默跳过。
 *
 * <p>候选仓库顺序**不由本文件维护**：来自 `scripts/lib/maven-settings.ps1` 的
 * `Get-MavenRepositoryCandidates`（显式参数 → `MAVEN_REPO_LOCAL` → 各 settings.xml 的
 * `<localRepository>` → 兜底 `~/.m2/repository`）。</p>
 *
 * @returns {string} sqlite-jdbc jar 的绝对路径
 * @throws {Error} 所有候选仓库里都没有时抛出
 */
function resolveSqliteJdbcJar() {
  const repositories = runMavenSettingsLib('candidates');
  for (const repository of repositories) {
    const root = path.join(repository, 'org', 'xerial', 'sqlite-jdbc');
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      const jar = path.join(root, version, `sqlite-jdbc-${version}.jar`);
      if (fs.existsSync(jar)) return jar;
    }
  }
  throw new Error(`本地 Maven 仓库里没有 sqlite-jdbc（先执行一次 mvn -o test 拉取依赖）；`
    + `候选仓库：${repositories.join(' / ')}`);
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


// ---------------------------------------------------------------- Maven settings 单一真源与真值表

/**
 * 造三态 settings.xml fixture（建在系统临时目录，用例结束由 `t.after` 删干净）。
 *
 * @param {import('node:test').TestContext} t 用例上下文
 * @returns {{root: string, home: string, onlyComment: string, real: string, commentedThenReal: string, realAfterPath: string}}
 *   fixture 根目录、假 USERPROFILE、三个 settings.xml 路径与"注释之后那个真实值"
 */
function createMavenSettingsFixtures(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-maven-settings-'));
  t.after(() => {
    // 只删自己造的那个前缀目录，绝不动临时目录本体
    const relative = path.relative(os.tmpdir(), root);
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

/** 归一化 Windows 路径，便于与 `GetFullPath` 的产物比较。 */
function normalizeWinPath(value) {
  return path.win32.normalize(String(value));
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
