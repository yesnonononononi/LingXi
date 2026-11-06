/**
 * M3 S1 · `electron/pet-prefs.cjs` 的单测（schema v1 / 逐字段降级 / 原子写）。
 *
 * <p><b>守的是什么：</b>偏好文件是"用户唯一亲手配置过的东西"，两种失败最伤：
 * ①一个坏字节让整份配置回默认（用户以为设置丢了）；②写到一半崩溃留下半截 JSON
 * （下次启动又走一次降级）。所以本文件钉住：<b>逐字段</b>降级（不是整文件回默认）、
 * 读路径**永不抛**、写路径**原子**（临时文件不残留）、**未知字段不落盘**。</p>
 *
 * <p>所有用例都用临时目录（`os.tmpdir()` 下的独立子目录），跑完即删——
 * 绝不碰真实 `userData`，也绝不在工作区留文件。</p>
 *
 * <p>运行：`npm run test:pet`（node 直接跑）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const prefsModule = require(path.join(__dirname, '..', 'electron', 'pet-prefs.cjs'));

const {
  PREFS_VERSION,
  DEFAULT_PREFS,
  KNOWN_FIELDS,
  PREF_PROBLEMS,
  defaultPrefs,
  detectReducedMotion,
  normalizePrefs,
  toPersistedPrefs,
  readPrefs,
  writePrefs,
  createPrefsStore,
  formatPrefsProblems,
  loadInitialPrefs,
  applyPrefsPatch,
} = prefsModule;

/**
 * 建一个独立的临时目录（每个用例一个，跑完删）。
 *
 * @param {string} label 目录名标签（排障用）
 * @returns {{dir: string, file: string, dispose: () => void}} 目录、偏好文件路径、清理函数
 */
function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pet-prefs-${label}-`));
  return {
    dir,
    file: path.join(dir, 'pet-prefs.json'),
    dispose() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响断言结果 */
      }
    },
  };
}

test('P01 · 默认值：version=1 / follow=false / roam=true；reduced-motion 时默认两项都关', () => {
  assert.equal(PREFS_VERSION, 1);
  assert.equal(DEFAULT_PREFS.follow, false);
  assert.equal(DEFAULT_PREFS.roam, true);

  const plain = defaultPrefs();
  assert.deepEqual(plain, { version: 1, follow: false, roam: true });
  // 每次都返回**新对象**：调用方改它不该污染"真源"
  plain.follow = true;
  assert.equal(defaultPrefs().follow, false, 'defaultPrefs 必须每次返回新对象');

  // U-M4：prefers-reduced-motion ⇒ 默认关掉 roam 与 follow（但仍可被菜单手动开启）
  assert.deepEqual(defaultPrefs({ prefersReducedMotion: true }), { version: 1, follow: false, roam: false });
  // 非 true 的一律按"没启用 reduced-motion"处理（不做真值转换）
  assert.deepEqual(defaultPrefs({ prefersReducedMotion: 'yes' }), { version: 1, follow: false, roam: true });
});

test('P02 · 降级①文件缺失：返回默认值 + missing，且绝不抛', () => {
  const temp = makeTempDir('missing');
  try {
    const result = readPrefs({ filePath: temp.file });
    assert.deepEqual(result.prefs, { version: 1, follow: false, roam: true });
    assert.deepEqual(result.problems, [PREF_PROBLEMS.MISSING_FILE]);
    assert.equal(result.status, 'missing');
    assert.equal(result.writable, true);
    assert.equal(result.renamedCorrupt, false);
    assert.equal(fs.existsSync(temp.file), false, '读缺失文件不许顺手创建它');
  } finally {
    temp.dispose();
  }
});

test('P03 · 降级②坏 JSON：全部默认 + 原文件改名 .corrupt（只改一次，不覆盖第一现场）', () => {
  const temp = makeTempDir('badjson');
  try {
    fs.writeFileSync(temp.file, '{ "follow": tr', 'utf8');
    const first = readPrefs({ filePath: temp.file });
    assert.deepEqual(first.prefs, { version: 1, follow: false, roam: true });
    assert.ok(first.problems.includes(PREF_PROBLEMS.BAD_JSON), '必须报 prefs-bad-json');
    assert.ok(first.problems.includes(PREF_PROBLEMS.CORRUPT_RENAMED), '必须报 prefs-corrupt-renamed');
    assert.equal(first.status, 'corrupt');
    assert.equal(fs.existsSync(`${temp.file}.corrupt`), true, '坏文件必须改名留存');
    assert.equal(fs.existsSync(temp.file), false, '原文件名不该还在');

    // 第二次再来一份坏文件：`.corrupt` 已存在 ⇒ 不再改名（保留第一现场）
    fs.writeFileSync(temp.file, 'still { bad', 'utf8');
    const second = readPrefs({ filePath: temp.file });
    assert.ok(second.problems.includes(PREF_PROBLEMS.BAD_JSON));
    assert.equal(second.problems.includes(PREF_PROBLEMS.CORRUPT_RENAMED), false, '第二次不许再改名');
    assert.equal(fs.readFileSync(`${temp.file}.corrupt`, 'utf8'), '{ "follow": tr', '第一现场必须原样保留');
  } finally {
    temp.dispose();
  }
});

test('P04 · 降级③版本过高（version 2）：只读已知字段 + 拒绝回写', () => {
  const temp = makeTempDir('newer');
  try {
    fs.writeFileSync(temp.file, JSON.stringify({ version: 2, follow: true, roam: false, future: 'x' }), 'utf8');
    const result = readPrefs({ filePath: temp.file });
    assert.equal(result.prefs.follow, true, '已知字段必须照读');
    assert.equal(result.prefs.roam, false, '已知字段必须照读');
    assert.equal(result.status, 'newer');
    assert.equal(result.writable, false, '版本更高时不许回写（否则会把新版字段抹掉）');
    assert.ok(result.problems.some((item) => item.startsWith(PREF_PROBLEMS.NEWER_VERSION)));

    // update 在这种情况下必须**什么都不写**（文件一字不动）
    const before = fs.readFileSync(temp.file, 'utf8');
    const store = createPrefsStore({ filePath: temp.file });
    const updated = store.update({ follow: false });
    assert.equal(updated.ok, false);
    assert.equal(fs.readFileSync(temp.file, 'utf8'), before, '拒绝回写时必须逐字节不变');
  } finally {
    temp.dispose();
  }
});

test('P05 · 降级④字段类型错：该字段降级默认，**其它字段照用**（不是整文件回默认）', () => {
  const temp = makeTempDir('badfield');
  try {
    fs.writeFileSync(temp.file, JSON.stringify({ version: 1, follow: 'yes', roam: false }), 'utf8');
    const result = readPrefs({ filePath: temp.file });
    assert.equal(result.prefs.follow, false, 'follow 类型错 ⇒ 降级默认 false');
    assert.equal(result.prefs.roam, false, '**roam 必须保住**（这就是"逐字段"与"整文件回默认"的分水岭）');
    assert.ok(result.problems.includes(`${PREF_PROBLEMS.BAD_FIELD}:follow`));
    assert.equal(result.status, 'ok');
    assert.equal(result.writable, true);

    // updatedAt 非字符串：丢弃该字段并报问题，其它字段照用
    const badStamp = normalizePrefs({ version: 1, follow: true, roam: true, updatedAt: 42 });
    assert.equal(badStamp.prefs.follow, true);
    assert.equal('updatedAt' in badStamp.prefs, false);
    assert.ok(badStamp.problems.includes(`${PREF_PROBLEMS.BAD_FIELD}:updatedAt`));
  } finally {
    temp.dispose();
  }
});

test('P06 · 缺字段：follow 缺失 ⇒ false，roam 必须保持 true；version 缺失视作 1', () => {
  const temp = makeTempDir('partial');
  try {
    fs.writeFileSync(temp.file, JSON.stringify({ roam: false }), 'utf8');
    const result = readPrefs({ filePath: temp.file });
    assert.deepEqual(result.prefs, { version: 1, follow: false, roam: false });
    assert.deepEqual(result.problems, [], '缺字段是正常状态，不该报问题');

    fs.writeFileSync(temp.file, JSON.stringify({ follow: true }), 'utf8');
    const second = readPrefs({ filePath: temp.file });
    assert.equal(second.prefs.follow, true);
    assert.equal(second.prefs.roam, true, 'roam 缺失 ⇒ 默认 true（U-M2：桌宠默认会动）');
  } finally {
    temp.dispose();
  }
});

test('P07 · 根不是对象（数组/null/字符串）：全默认 + bad-root，不抛', () => {
  for (const raw of [[1, 2, 3], null, 'text', 42]) {
    const normalized = normalizePrefs(raw);
    assert.deepEqual(normalized.prefs, { version: 1, follow: false, roam: true }, `raw=${JSON.stringify(raw)}`);
    assert.deepEqual(normalized.problems, [PREF_PROBLEMS.BAD_ROOT]);
    assert.equal(normalized.status, 'corrupt');
  }
});

test('P08 · 写后读回逐字段一致，且**未知字段不落盘**', () => {
  const temp = makeTempDir('roundtrip');
  try {
    const store = createPrefsStore({ filePath: temp.file });
    const writeResult = store.write({ version: 1, follow: true, roam: false, evil: 'x', nested: { a: 1 } });
    assert.equal(writeResult.ok, true);
    assert.deepEqual(writeResult.problems, []);

    const onDisk = JSON.parse(fs.readFileSync(temp.file, 'utf8'));
    assert.equal('evil' in onDisk, false, '未知字段绝不许落盘');
    assert.equal('nested' in onDisk, false, '未知字段绝不许落盘');
    for (const key of Object.keys(onDisk)) {
      assert.ok(KNOWN_FIELDS.includes(key), `落盘出现白名单外的字段：${key}`);
    }
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.follow, true);
    assert.equal(onDisk.roam, false);

    const readBack = store.read();
    assert.equal(readBack.prefs.follow, true);
    assert.equal(readBack.prefs.roam, false);
    assert.equal(readBack.status, 'ok');

    // toPersistedPrefs 是"只写已知字段"的唯一出口
    assert.deepEqual(toPersistedPrefs({ follow: true, roam: true, junk: 1 }), { version: 1, follow: true, roam: true });
  } finally {
    temp.dispose();
  }
});

test('P09 · 原子写：不残留 .tmp；写失败时也在返回值里报原因而不是抛', () => {
  const temp = makeTempDir('atomic');
  try {
    const store = createPrefsStore({ filePath: temp.file });
    store.write({ follow: false, roam: true });
    const leftovers = fs.readdirSync(temp.dir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `临时文件没收拾干净：${leftovers.join(',')}`);

    // 注入一个"rename 必失败"的假 fs：写必须返回 ok:false 且清掉临时文件
    const fakeFs = {
      existsSync: () => true,
      readFileSync: () => '{"version":1,"follow":false,"roam":true}',
      writeFileSync: () => {},
      renameSync: () => {
        const error = new Error('rename 失败');
        error.code = 'EPERM';
        throw error;
      },
      unlinkSync: (target) => {
        fakeFs.unlinked.push(target);
      },
      unlinked: [],
    };
    const failed = writePrefs({ filePath: temp.file, prefs: { follow: true, roam: true }, fs: fakeFs });
    assert.equal(failed.ok, false);
    assert.ok(failed.problems.some((item) => item.startsWith(PREF_PROBLEMS.WRITE_FAILED)), '必须报 prefs-write-failed');
    assert.equal(fakeFs.unlinked.length, 1, '失败后必须尝试清理临时文件');
    assert.ok(fakeFs.unlinked[0].endsWith('.tmp'));
  } finally {
    temp.dispose();
  }
});

test('P10 · 读不动（权限/占用）：按默认值走，但**不**把文件当坏 JSON 改名', () => {
  const temp = makeTempDir('unreadable');
  try {
    fs.writeFileSync(temp.file, '{}', 'utf8');
    const fakeFs = {
      existsSync: () => true,
      readFileSync: () => {
        const error = new Error('EACCES');
        error.code = 'EACCES';
        throw error;
      },
      renameSync: () => {
        throw new Error('不该走到改名');
      },
    };
    const result = readPrefs({ filePath: temp.file, fs: fakeFs });
    assert.deepEqual(result.prefs, { version: 1, follow: false, roam: true });
    assert.ok(result.problems.some((item) => item.startsWith(PREF_PROBLEMS.WRITE_FAILED)));
    assert.equal(result.renamedCorrupt, false, '读不动不等于文件坏了，不许改名');
    assert.equal(fs.existsSync(temp.file), true);
  } finally {
    temp.dispose();
  }
});

test('P11 · update：只接受布尔补丁，未知键忽略；先落盘再返回', () => {
  const temp = makeTempDir('update');
  try {
    const store = createPrefsStore({ filePath: temp.file });
    const first = store.update({ follow: true });
    assert.equal(first.ok, true);
    assert.equal(first.prefs.follow, true);

    // 未知键与非法类型都被忽略（前向兼容；非法值不该把已有值改坏）
    const second = store.update({ roam: 'nope', teleport: true });
    assert.equal(second.prefs.roam, true, '非法布尔值必须被忽略');
    assert.equal(second.prefs.follow, true, '未提供的字段保持不变');

    const onDisk = JSON.parse(fs.readFileSync(temp.file, 'utf8'));
    assert.equal(onDisk.follow, true);
    assert.equal('teleport' in onDisk, false);
    assert.equal(typeof onDisk.updatedAt, 'string', 'update 会打 updatedAt 时间戳');
  } finally {
    temp.dispose();
  }
});

test('P13 · detectReducedMotion：探针优先级 + 接口不可用时"不动"（不覆盖默认值）', () => {
  // ① 首选 systemPreferences.getAnimationSettings().shouldRenderRichAnimation
  assert.deepEqual(
    detectReducedMotion({ systemPreferences: { getAnimationSettings: () => ({ shouldRenderRichAnimation: false }) } }),
    { reducedMotion: true, source: 'systemPreferences.getAnimationSettings' },
  );
  assert.deepEqual(
    detectReducedMotion({ systemPreferences: { getAnimationSettings: () => ({ shouldRenderRichAnimation: true }) } }),
    { reducedMotion: false, source: 'systemPreferences.getAnimationSettings' },
  );

  // ② 次选 app.getSystemPreferences?.()：只认布尔字段（含两种命名）
  assert.deepEqual(
    detectReducedMotion({ app: { getSystemPreferences: () => ({ reducedMotion: true }) } }),
    { reducedMotion: true, source: 'app.getSystemPreferences.reducedMotion' },
  );
  assert.deepEqual(
    detectReducedMotion({ app: { getSystemPreferences: () => ({ prefersReducedMotion: true }) } }),
    { reducedMotion: true, source: 'app.getSystemPreferences.prefersReducedMotion' },
  );

  // ③ 两个接口都没有 ⇒ **不动**（reducedMotion:false）——这是 U-M4 的降级口径：
  //    把"探测不到"当成"用户要求减少动效"，会让每台机器首启都变成"猫一动不动"。
  assert.deepEqual(detectReducedMotion({}), { reducedMotion: false, source: 'unavailable-fallback-no-override' });
  assert.deepEqual(detectReducedMotion(null), { reducedMotion: false, source: 'unavailable-fallback-no-override' });
  assert.deepEqual(
    detectReducedMotion({ systemPreferences: {} }),
    { reducedMotion: false, source: 'unavailable-fallback-no-override' },
  );

  // ④ 探针抛错不许把启动搞崩（降级到下一档/兜底）
  assert.doesNotThrow(() =>
    detectReducedMotion({
      systemPreferences: {
        getAnimationSettings: () => {
          throw new Error('boom');
        },
      },
      app: { getSystemPreferences: () => ({ reducedMotion: true }) },
    }),
  );
  assert.deepEqual(
    detectReducedMotion({
      systemPreferences: {
        getAnimationSettings: () => {
          throw new Error('boom');
        },
      },
      app: { getSystemPreferences: () => ({ reducedMotion: true }) },
    }),
    { reducedMotion: true, source: 'app.getSystemPreferences.reducedMotion' },
  );
  // 字段类型不对时同样落到兜底（不许把 undefined 当真值用）
  assert.deepEqual(
    detectReducedMotion({ app: { getSystemPreferences: () => ({ reducedMotion: 'yes' }) } }),
    { reducedMotion: false, source: 'unavailable-fallback-no-override' },
  );
});

test('P14 · loadInitialPrefs：文件存在 ⇒ 以文件为准（reduced-motion 不许改写用户选择）', () => {
  const temp = makeTempDir('load-file');
  try {
    fs.writeFileSync(temp.file, JSON.stringify({ version: 1, follow: true, roam: true }), 'utf8');
    const warns = [];
    const result = loadInitialPrefs({
      store: createPrefsStore({ filePath: temp.file }),
      prefersReducedMotion: true,
      warn: (message) => warns.push(message),
    });
    assert.deepEqual(result.prefs, { version: 1, follow: true, roam: true });
    assert.equal(result.source, 'file');
    assert.equal(result.appliedReducedMotion, false);
    assert.deepEqual(warns, [], '健康的文件不该在启动日志里刷"降级"');
  } finally {
    temp.dispose();
  }
});

test('P15 · loadInitialPrefs：无文件 + reduced-motion ⇒ 两个开关默认全关；无文件未要求 ⇒ U-M2 默认', () => {
  const reducedTemp = makeTempDir('load-reduced');
  const plainTemp = makeTempDir('load-plain');
  try {
    const reduced = loadInitialPrefs({
      store: createPrefsStore({ filePath: reducedTemp.file }),
      prefersReducedMotion: true,
    });
    assert.deepEqual(reduced.prefs, { version: 1, follow: false, roam: false });
    assert.equal(reduced.source, 'reduced-motion-default');
    assert.equal(reduced.appliedReducedMotion, true);
    assert.ok(reduced.problems.includes(PREF_PROBLEMS.REDUCED_MOTION_DEFAULTS), '必须留一条可断言的信息码');

    const plain = loadInitialPrefs({ store: createPrefsStore({ filePath: plainTemp.file }) });
    assert.deepEqual(plain.prefs, { version: 1, follow: false, roam: true });
    assert.equal(plain.source, 'default');
    assert.equal(plain.appliedReducedMotion, false);
  } finally {
    reducedTemp.dispose();
    plainTemp.dispose();
  }
});

test('P16 · loadInitialPrefs：读失败记**一条** warn（含原因码），缺失文件不 warn', () => {
  const temp = makeTempDir('load-warn');
  const missingTemp = makeTempDir('load-nofile');
  try {
    fs.writeFileSync(temp.file, JSON.stringify({ version: 1, follow: 'yes', roam: true }), 'utf8');
    const warns = [];
    const degraded = loadInitialPrefs({
      store: createPrefsStore({ filePath: temp.file }),
      warn: (message) => warns.push(message),
    });
    assert.equal(warns.length, 1, `降级只许 warn 一条，实际 ${warns.length} 条`);
    assert.ok(warns[0].includes(`${PREF_PROBLEMS.BAD_FIELD}:follow`), `warn 必须点名字段：${warns[0]}`);
    assert.equal(degraded.prefs.roam, true, '其它字段照用（逐字段降级）');

    const quiet = [];
    loadInitialPrefs({ store: createPrefsStore({ filePath: missingTemp.file }), warn: (m) => quiet.push(m) });
    assert.deepEqual(quiet, [], '首次运行没有文件是正常状态，不该 warn');
  } finally {
    temp.dispose();
    missingTemp.dispose();
  }
});

test('P17 · applyPrefsPatch：只吃布尔、changed 如实、写失败 warn 且仍返回新值', () => {
  const temp = makeTempDir('apply');
  try {
    const store = createPrefsStore({ filePath: temp.file });
    const first = applyPrefsPatch({ store, prefs: { version: 1, follow: false, roam: true }, patch: { follow: true } });
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    assert.deepEqual(first.prefs, { version: 1, follow: true, roam: true });
    assert.equal(JSON.parse(fs.readFileSync(temp.file, 'utf8')).follow, true, '必须真落盘');

    // 非布尔补丁忽略；未知键忽略
    const ignored = applyPrefsPatch({
      store,
      prefs: first.prefs,
      patch: { follow: 'no', roam: undefined, teleport: true },
    });
    assert.equal(ignored.changed, false);
    assert.equal(ignored.prefs.follow, true);

    // 写失败：warn 一条，但仍返回新值（本轮内存生效）
    const warns = [];
    const failing = { write: () => ({ ok: false, problems: [`${PREF_PROBLEMS.WRITE_FAILED}:EACCES`] }) };
    const failed = applyPrefsPatch({
      store: failing,
      prefs: first.prefs,
      patch: { roam: false },
      warn: (message) => warns.push(message),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.prefs.roam, false, '写失败也要返回新值');
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes(PREF_PROBLEMS.WRITE_FAILED));

    // 入参校验
    assert.throws(() => applyPrefsPatch({ store, prefs: null, patch: {} }), TypeError);
    assert.throws(() => applyPrefsPatch({ store: null, prefs: { follow: true, roam: true }, patch: {} }), TypeError);
    assert.throws(() => loadInitialPrefs({ store: null }), TypeError);
  } finally {
    temp.dispose();
  }
});

test('P18 · formatPrefsProblems：一次读完只拼一条；空列表返回空串', () => {
  assert.equal(formatPrefsProblems([]), '');
  assert.equal(formatPrefsProblems(null), '');
  assert.equal(
    formatPrefsProblems([PREF_PROBLEMS.BAD_JSON, `${PREF_PROBLEMS.BAD_FIELD}:follow`]),
    `${PREF_PROBLEMS.BAD_JSON}; ${PREF_PROBLEMS.BAD_FIELD}:follow`,
  );
});

test('P12 · 入参校验：没给路径 / 没给偏好 ⇒ 立刻 TypeError（编程错误不该被吞）', () => {
  assert.throws(() => readPrefs({}), TypeError);
  assert.throws(() => readPrefs(null), TypeError);
  assert.throws(() => writePrefs({ prefs: { follow: true, roam: true } }), TypeError);
  assert.throws(() => writePrefs({ filePath: 'x.json', prefs: null }), TypeError);
  assert.throws(() => createPrefsStore({}), TypeError);
  // 路径给了就正常工作（用临时目录验证一次，避免"只测抛不测通用"）
  const temp = makeTempDir('validate');
  try {
    assert.equal(createPrefsStore({ filePath: temp.file }).path(), temp.file);
  } finally {
    temp.dispose();
  }
});
