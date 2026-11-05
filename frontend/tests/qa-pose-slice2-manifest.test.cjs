/**
 * QA 对抗测试（切片 2）· 清单层：`isPlayable` 第三参与 `byFacingSource` 判据。
 *
 * <p>运行方式（**必须走 tsx**：本文件 require 的是 TS 模块）：</p>
 * <pre>npx tsx --test tests/qa-pose-slice2-manifest.test.cjs</pre>
 *
 * <p>本文件守的四件事：</p>
 * <ol>
 *   <li><b>方向 1</b>：`byFacingSource` 缺失 / `null` / `''` / `0` 在**真实加载路径**
 *       （`normalizePetPoses`）上是否被拦；`isPlayable` 自身是黑名单还是白名单；</li>
 *   <li><b>方向 5</b>：`facing` 缺省与显式 `undefined` 是否逐字节等价；给了 facing 但批次
 *       只有另一朝向是否 false；`batch-single`（sit/walk）会不会因此被误判；</li>
 *   <li><b>方向 7</b>（静态半）：`petFacing` 的唯一写入点与 `import.meta.env.DEV` 闸门；</li>
 *   <li><b>方向 7</b>（动态半）：`postureOf` 透传 facing 后语义确实会变（所以生产必须恒 −1）。</li>
 * </ol>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.resolve(__dirname, '..');
const manifest = require(path.join(FRONTEND, 'src/pet/poses/manifest.ts'));
const stateMachine = require(path.join(FRONTEND, 'src/pet/behavior/state-machine.ts'));

const { isPlayable, normalizePetPoses, PET_POSES } = manifest;
const { postureOf } = stateMachine;

/** 全姿态 id（含切片 3 未交付的 lie/sleep，用来验"未 accepted ⇒ false"）。 */
const ALL_POSTURES = ['stand', 'sit', 'walk', 'run', 'jump', 'lie', 'sleep'];

/**
 * 读磁盘上的**原始** `pet-poses.json`（就是 `loadPetPoses()` 的输入）。
 *
 * <p>不用 `PET_POSES`（那是归一后的对象）：要测的是"喂给加载器的裸数据被怎么判"。</p>
 *
 * @returns {Record<string, any>} 原始清单
 */
function rawPoses() {
  return JSON.parse(fs.readFileSync(path.join(FRONTEND, 'pet-poses.json'), 'utf8'));
}

/**
 * 深拷贝真清单并改动（只在内存里，绝不写盘）。
 *
 * @param {(draft: Record<string, any>) => void} mutate 改动函数
 * @returns {Record<string, any>} 合成原始清单
 */
function rawWith(mutate) {
  const draft = rawPoses();
  mutate(draft);
  return draft;
}

// ---------------------------------------------------------------- 方向 1

test('Q1-1 基线自证：原始 pet-poses.json 能被 normalizePetPoses 收下（否则后面每条变异都无意义）', () => {
  assert.doesNotThrow(() => normalizePetPoses(rawPoses()));
});

test('Q1-2 真实加载路径：四个 accepted 批次逐个删掉 byFacingSource ⇒ 全部 TypeError 且点名该字段', () => {
  const accepted = rawPoses().accepted;
  assert.deepEqual(accepted, ['sit', 'walk', 'run', 'jump'], 'accepted 名单变了就要重新核本用例的覆盖面');
  for (const posture of accepted) {
    const broken = rawWith((draft) => {
      delete draft.batches[posture].bodyAnchor.byFacingSource;
    });
    assert.throws(
      () => normalizePetPoses(broken),
      (err) => err instanceof TypeError && /byFacingSource/.test(err.message),
      `${posture} 缺 byFacingSource 必须在加载期抛 TypeError（否则 isPlayable 的黑名单判据会把它当合法值放行）`,
    );
  }
});

test('Q1-3 真实加载路径：null / 空串 / 0 / 未知值 / 大写变体 一律 TypeError（枚举白名单，大小写敏感）', () => {
  const bad = [null, '', 0, 'webp', 'MIRROR-DERIVED', 'mirror_derived', true];
  for (const value of bad) {
    const broken = rawWith((draft) => {
      draft.batches.walk.bodyAnchor.byFacingSource = value;
    });
    assert.throws(
      () => normalizePetPoses(broken),
      (err) => err instanceof TypeError,
      `byFacingSource=${JSON.stringify(value)} 必须在加载期被拒（大写变体不许被放过）`,
    );
  }
});

test('Q1-4 锚点来源是白名单：手搓对象上缺失/null/空串/0/未知值一律判不可播（缺口 G-1 已关闭）', () => {
  // 用"真清单的归一结果"做底座（形状与运行时完全一致），只把 byFacingSource 改掉：
  // 这样 `isPlayable` 收到的是它在运行期真能见到的形状，不是玩具对象。
  const base = JSON.parse(JSON.stringify(PET_POSES));
  assert.equal(isPlayable(base, 'walk'), true, '底座本身必须可播，否则下面的 false 说明不了任何问题');

  // 对照：白名单内的两个合法值必须仍然可播（证明这不是"恒 false"的坏实现）
  for (const ok of ['measured-per-facing', 'batch-single']) {
    const legit = JSON.parse(JSON.stringify(PET_POSES));
    legit.batches.walk.bodyAnchor.byFacingSource = ok;
    assert.equal(isPlayable(legit, 'walk'), true, `白名单内的 ${ok} 必须仍然可播`);
  }

  for (const value of [undefined, null, '', 0, 'MEASURED-PER-FACING']) {
    const soft = JSON.parse(JSON.stringify(PET_POSES));
    soft.batches.walk.bodyAnchor.byFacingSource = value;
    assert.equal(
      isPlayable(soft, 'walk'),
      false,
      `byFacingSource=${JSON.stringify(value)} 不在白名单 {'measured-per-facing','batch-single'} 里 ⇒ 必须判不可播。` +
        '安全方向是降级 stand：未知值恰恰是将来新增枚举 / 手搓对象 / 跨版本清单最可能出现的东西，' +
        "黑名单写法（`!== 'mirror-derived'`）会把它当合法值放行（manifest.ts 的 PLAYABLE_ANCHOR_SOURCES）。",
    );
    // 给朝向也必须是同一个结论（判据③在按朝向过滤之前生效）
    assert.equal(isPlayable(soft, 'walk', -1), false, `byFacingSource=${JSON.stringify(value)} 左向也必须不可播`);
    assert.equal(isPlayable(soft, 'walk', 1), false, `byFacingSource=${JSON.stringify(value)} 右向也必须不可播`);
  }

  // 更严：非字符串（true / 数组 / 对象）也一律不可播（`typeof source !== 'string'`）
  for (const value of [true, [], {}, Symbol.iterator]) {
    const soft = JSON.parse(JSON.stringify(PET_POSES));
    soft.batches.walk.bodyAnchor.byFacingSource = value;
    assert.equal(isPlayable(soft, 'walk'), false, `非字符串 ${String(value)} 必须判不可播`);
  }
});

test('Q1-5 mirror-derived 经加载器合法转入，但 isPlayable 整批判不可播（两参与给朝向都一样）', () => {
  const mirrored = rawWith((draft) => {
    draft.batches.walk.bodyAnchor.byFacingSource = 'mirror-derived';
  });
  const poses = normalizePetPoses(mirrored); // 加载期允许（枚举内）
  assert.equal(isPlayable(poses, 'walk'), false, '缺省判据必须整批拒绝');
  assert.equal(isPlayable(poses, 'walk', -1), false);
  assert.equal(isPlayable(poses, 'walk', 1), false);
  // 其余批次不受连坐
  assert.equal(isPlayable(poses, 'run'), true);
  assert.equal(isPlayable(poses, 'jump'), true);
});

// ---------------------------------------------------------------- 方向 5

test('Q5-1 缺省 vs 显式 undefined：真清单 × 7 个姿态 id 结果逐项相同', () => {
  for (const posture of ALL_POSTURES) {
    const omitted = isPlayable(PET_POSES, posture);
    const explicit = isPlayable(PET_POSES, posture, undefined);
    assert.equal(explicit, omitted, `${posture}：显式 undefined 必须与两参调用完全一致`);
    assert.equal(typeof explicit, 'boolean');
  }
});

test('Q5-2 缺省 vs 显式 undefined：6 份合成清单（删朝向/删帧/未登记/镜像/空片段）结果逐项相同', () => {
  const variants = {
    '删左向片段': rawWith((draft) => {
      draft.batches.walk.clips = draft.batches.walk.clips.filter((clip) => clip.facing !== -1);
    }),
    '删右向片段': rawWith((draft) => {
      draft.batches.walk.clips = draft.batches.walk.clips.filter((clip) => clip.facing !== 1);
    }),
    '删一帧': rawWith((draft) => {
      // 必须"帧 + clip.frames + frameMs"三处同时删：只删 frames 会被 normalizeClip 的
      // 等长断言当场拒掉（这本身是好事，见 Q5-6）
      const batch = draft.batches.run;
      const clip = batch.clips[0];
      const dropped = clip.frames.pop();
      clip.frameMs.pop();
      delete batch.frames[dropped];
    }),
    '从 accepted 摘掉': rawWith((draft) => {
      draft.accepted = draft.accepted.filter((id) => id !== 'run');
    }),
    '镜像锚点': rawWith((draft) => {
      draft.batches.jump.bodyAnchor.byFacingSource = 'mirror-derived';
    }),
    'accepted 清空': rawWith((draft) => {
      draft.accepted = [];
    }),
  };
  for (const [label, raw] of Object.entries(variants)) {
    const poses = normalizePetPoses(raw);
    for (const posture of ALL_POSTURES) {
      assert.equal(
        isPlayable(poses, posture, undefined),
        isPlayable(poses, posture),
        `${label} / ${posture}：显式 undefined 与两参调用必须逐项一致`,
      );
    }
  }
});

test('Q5-3 给了 facing 但批次只有另一朝向 ⇒ false（合成：walk 只留右向）', () => {
  const rightOnly = normalizePetPoses(
    rawWith((draft) => {
      draft.batches.walk.clips = draft.batches.walk.clips.filter((clip) => clip.facing !== -1);
    }),
  );
  assert.equal(isPlayable(rightOnly, 'walk', 1), true, '右向片段还在 ⇒ 右向可播');
  assert.equal(isPlayable(rightOnly, 'walk', -1), false, '左向片段没了 ⇒ 左向必须不可播（不许拿右向顶上）');
  assert.equal(isPlayable(rightOnly, 'walk'), true, '缺省判据不看朝向，仍为真（与旧实现一致）');
});

test('Q5-4 batch-single 不许被当成"缺朝向"：sit 只有左向、walk 左右俱全', () => {
  assert.equal(PET_POSES.batches.sit.bodyAnchor.byFacingSource, 'batch-single');
  assert.equal(PET_POSES.batches.walk.bodyAnchor.byFacingSource, 'batch-single');
  // sit：只有 -1 一条 hold ⇒ 右向不可播（batch-single 不是放行理由）
  assert.equal(isPlayable(PET_POSES, 'sit', -1), true);
  assert.equal(isPlayable(PET_POSES, 'sit', 1), false);
  // walk：同为 batch-single 但左右各一条 ⇒ 两个朝向都可播（不许因 batch-single 就判死）
  assert.equal(isPlayable(PET_POSES, 'walk', -1), true);
  assert.equal(isPlayable(PET_POSES, 'walk', 1), true);
});

test('Q5-5 facing 非法值抛 TypeError，而 undefined 与 null 不等价（记录项：null 会炸）', () => {
  for (const bad of [0, 2, -2, '1', '-1', NaN, true, null]) {
    assert.throws(
      () => isPlayable(PET_POSES, 'walk', bad),
      (err) => err instanceof TypeError && /facing/.test(err.message),
      `facing=${String(bad)} 必须抛 TypeError（不允许类型宽松转换）`,
    );
  }
  assert.doesNotThrow(() => isPlayable(PET_POSES, 'walk', undefined));
  // 记录项：`null` 不像 `undefined` 那样走缺省分支 —— 调用方若写 `facing ?? null` 会当场抛错
  assert.throws(() => isPlayable(PET_POSES, 'walk', null), TypeError);
});

test('Q5-6 加载期硬拒"幻影帧"与 frameMs 不等长 —— 这决定了 setPosture 的朝向不对称是否可达', () => {
  // 1) clip 引用不存在的帧 id
  const phantom = rawWith((draft) => {
    draft.batches.walk.clips[0].frames[0] = 'frame-that-does-not-exist';
  });
  assert.throws(() => normalizePetPoses(phantom), /frame-that-does-not-exist|不存在/, '幻影帧必须在加载期抛错');

  // 2) frameMs 与帧数不等长
  const badTiming = rawWith((draft) => {
    draft.batches.walk.clips[0].frameMs.pop();
  });
  assert.throws(() => normalizePetPoses(badTiming), /frameMs/);

  // 3) 顺带钉住"setPosture 用两参 isPlayable、pickClip 用 facing"的不对称不会真的发生：
  //    想造出"左向片段在、但左向帧残缺"的清单，必须先过上面两条，过不去。
  const leftBroken = rawWith((draft) => {
    draft.batches.walk.frames[draft.batches.walk.clips[0].frames[0]].files = { '1x': { url: '/a.webp' } };
  });
  assert.throws(() => normalizePetPoses(leftBroken), TypeError, '缺密度档的帧在加载期就被拒 ⇒ 该不对称不可达');

  // 4) 空 clips 同样在加载期硬失败（"没有片段的批次不是可播资产"）
  const noClips = rawWith((draft) => {
    draft.batches.walk.clips = [];
  });
  assert.throws(() => normalizePetPoses(noClips), /clips/);
});

// ---------------------------------------------------------------- 方向 7

test('Q7-1 静态：petFacing 初值 -1，唯一写入点在 applyPoseFacing，且调用方全部属于 dev 后门', () => {
  const mainPath = path.join(FRONTEND, 'src/pet/main.ts');
  const text = fs.readFileSync(mainPath, 'utf8');
  const lines = text.split(/\r?\n/);

  const declaration = lines.findIndex((line) => /let petFacing: Facing = -1;/.test(line));
  assert.notEqual(declaration, -1, 'petFacing 必须声明为 -1（生产态没有朝向来源）');

  const writes = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((item) => /^petFacing\s*=[^=]/.test(item.line));
  assert.equal(writes.length, 1, `petFacing 只允许一个写入点，实际 ${writes.length} 处：${JSON.stringify(writes)}`);
  const writeIndex = writes[0].index;
  const owner = lines
    .slice(0, writeIndex + 1)
    .reverse()
    .find((line) => /function \w+\(/.test(line));
  assert.ok(owner && /applyPoseFacing/.test(owner), `petFacing 的写入必须在 applyPoseFacing 内，实际所在函数：${owner}`);
});

test('Q7-2 静态：applyPoseFacing 的每一处调用都在 dev 后门（forcePose / poseFacing 句柄）里', () => {
  const text = fs.readFileSync(path.join(FRONTEND, 'src/pet/main.ts'), 'utf8');
  const lines = text.split(/\r?\n/);
  const callSites = lines
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter((item) => /applyPoseFacing\(/.test(item.line) && !/function applyPoseFacing/.test(item.line));
  assert.equal(callSites.length, 2, `期望恰有两处调用（forcePose + poseFacing 句柄），实际：${JSON.stringify(callSites)}`);
  for (const site of callSites) {
    assert.match(
      site.line,
      /^(applyPoseFacing\(facing\);|poseFacing: \(next\) => applyPoseFacing\(next\),)$/,
      `第 ${site.index} 行是意料之外的朝向写入路径：${site.line}`,
    );
  }
});

test('Q7-3 静态：dev 后门由 import.meta.env.DEV 闸门把守（生产构建里这段被摇掉）', () => {
  const text = fs.readFileSync(path.join(FRONTEND, 'src/pet/main.ts'), 'utf8');
  const mountStart = text.indexOf('function mountDevTools(');
  assert.notEqual(mountStart, -1, '找不到 mountDevTools');
  const body = text.slice(mountStart, mountStart + 400);
  assert.match(body, /if \(!import\.meta\.env\.DEV\) return;/, 'dev 后门必须以构建期常量收口，不许用运行期 search 参数');
  assert.equal(/petFacing\s*=[^=]/.test(text.slice(0, mountStart)), true, 'petFacing 的写入点应在 mountDevTools 之前的普通函数里');
});

test('Q7-4 动态：postureOf 透传 facing 会改变生产语义 —— petFacing 一旦不是 -1，sit 会静默退化 stand', () => {
  assert.equal(postureOf('sit', PET_POSES), 'sit', '缺省（不传 facing）⇒ sit 可播');
  assert.equal(postureOf('sit', PET_POSES, -1), 'sit', '生产态 -1 ⇒ 语义与缺省一致');
  assert.equal(
    postureOf('sit', PET_POSES, 1),
    'stand',
    'sit 没有右向片段 ⇒ 右向必须降级 stand（这条正是"生产必须恒 -1"的理由）',
  );
  for (const posture of ['walk', 'run', 'jump']) {
    assert.equal(postureOf(posture, PET_POSES, -1), posture, `${posture} 左向应派生自己`);
    assert.equal(postureOf(posture, PET_POSES, 1), posture, `${posture} 右向应派生自己`);
  }
  assert.equal(postureOf('lie', PET_POSES, -1), 'stand', 'lie 未 accepted ⇒ 降级');
  assert.equal(postureOf('sleeping', PET_POSES, -1), 'stand', 'sleep 未 accepted ⇒ 降级');
});
