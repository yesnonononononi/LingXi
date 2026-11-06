/**
 * QA 对抗测试（切片 2）· dev 后门层：采样时机与终态断言能不能被弄成假绿。
 *
 * <p>运行方式（必须走 tsx：require 的是 TS 模块）：</p>
 * <pre>npx tsx --test tests/qa-pose-slice2-backdoor.test.cjs</pre>
 *
 * <p>这一组审的是**验收仪器本身**：`verifyMatrix` 是"6 组合全绿"的唯一依据，
 * 所以它的采样时刻、终态断言、以及"哪些情况下它其实什么都没验"必须钉死。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FRONTEND = path.resolve(__dirname, '..');
const { PET_POSES } = require(path.join(FRONTEND, 'src/pet/poses/manifest.ts'));
const backdoor = require(path.join(FRONTEND, 'src/pet/debug/dev-backdoor.ts'));

const {
  SAMPLE_CAP_MS,
  TERMINAL_BUFFER_MS,
  POSE_MATRIX_POSTURES,
  POSE_MATRIX_FACINGS,
  clipTimingOf,
  sampleDelayOf,
  judgePoseStep,
  runPoseMatrix,
} = backdoor;

/** 造一条合成时序。 */
function timing(overrides) {
  return { clipId: 'once', clipMs: 650, loop: false, returnsToStand: true, ...overrides };
}

/** 造一份姿态快照。 */
function snapshot(overrides) {
  return {
    posture: 'jump',
    facing: 1,
    clipId: 'once',
    clipFacing: 1,
    frameId: 'f0',
    playing: true,
    override: 'jump',
    ...overrides,
  };
}

test('D-1 采样时刻按片段真实时长算：真清单四批逐一核对（与主理人真机数字交叉验证）', () => {
  assert.equal(SAMPLE_CAP_MS, 300, '上限常量变了就要重新核本用例');
  assert.equal(TERMINAL_BUFFER_MS, 200);

  const cases = [
    // [姿态, 朝向, 片段 id, 期望 clipMs, 期望 loop, 期望采样时刻]
    ['walk', -1, 'cycle', 440, true, 220],
    ['walk', 1, 'cycle', 440, true, 220],
    ['run', -1, 'cycle', 540, true, 270],
    ['run', 1, 'cycle', 540, true, 270],
    ['jump', -1, 'once', 650, false, 260],
    ['jump', 1, 'once', 650, false, 260],
    // sit 从切片 4 起是 7 帧眨眼循环（supplemental/gif-v1 的 clips.sit_blink）：
    // 2600+110+1800+90+100+110+1800 = 6610ms 循环 ⇒ 循环采样 = min(6610/2, 300) = 300。
    // 前提变了（旧期望是"单帧 hold ⇒ clipMs 0 ⇒ 立即采样"），期望值随真数据更新，判据未动。
    ['sit', -1, 'cycle', 6610, true, 300],
  ];
  for (const [posture, facing, clipId, clipMs, loop, delay] of cases) {
    const time = clipTimingOf(PET_POSES, posture, facing, clipId);
    assert.ok(time, `${posture}@${facing}#${clipId} 必须查得到时序`);
    assert.equal(time.clipMs, clipMs, `${posture}@${facing} 的 clipMs`);
    assert.equal(time.loop, loop, `${posture}@${facing} 的 loop`);
    assert.equal(time.returnsToStand, posture === 'jump', `${posture} 的 onEnd 语义`);
    assert.equal(sampleDelayOf(time), delay, `${posture}@${facing} 的采样时刻`);
  }
  // 真机数字核对：jump 的 260 与主理人 CDP 观测到的 sampleAtMs=260 一致
  assert.equal(sampleDelayOf(clipTimingOf(PET_POSES, 'jump', 1, 'once')), 260);
});

test('D-2 极短片段：1 帧 80ms ⇒ 循环 40ms / 一次性 32ms（不会采到"还没开始"以外的东西）', () => {
  assert.equal(sampleDelayOf(timing({ clipMs: 80, loop: true })), 40);
  assert.equal(sampleDelayOf(timing({ clipMs: 80, loop: false })), 32);
  // 两帧各 40ms 的循环：与单帧 80ms 等价
  assert.equal(sampleDelayOf(timing({ clipMs: 80, loop: true })), 40);
});

test('D-3 clipMs <= 0 / 非有限 ⇒ 立即采样（0）；Infinity 按上限封顶（不猜一个"无穷长"）', () => {
  assert.equal(sampleDelayOf(null), 0, '查不到时序 ⇒ 立刻拍（宁可不等待也不猜）');
  for (const clipMs of [0, -1, -650, NaN, -Infinity]) {
    assert.equal(sampleDelayOf(timing({ clipMs })), 0, `clipMs=${String(clipMs)} 必须给 0`);
  }
  assert.equal(sampleDelayOf(timing({ clipMs: Infinity })), SAMPLE_CAP_MS, '+Infinity 会被上限封住（不会 NaN 也不会无穷等待）');
});

test('D-4 capMs 语义：只封顶不放大（0 ⇒ 立即；超大 ⇒ 封到 300；NaN ⇒ 300）', () => {
  const loop = timing({ clipMs: 10000, loop: true });
  assert.equal(sampleDelayOf(loop), SAMPLE_CAP_MS, '默认必须封顶到 300');
  assert.equal(sampleDelayOf(loop, 1e6), SAMPLE_CAP_MS, '调用方不许把上限调大（那是"看一眼就收工"的入口）');
  assert.equal(sampleDelayOf(loop, 0), 0, 'cap=0 ⇒ 立即采样');
  assert.equal(sampleDelayOf(loop, 50), 50, 'cap 小 ⇒ 按 cap 采样');
  assert.equal(sampleDelayOf(loop, NaN), SAMPLE_CAP_MS);
  assert.equal(sampleDelayOf(loop, -5), SAMPLE_CAP_MS, '负 cap 视为非法 ⇒ 回落默认上限');
  // 小于上限时按真实时长，不按 cap
  assert.equal(sampleDelayOf(timing({ clipMs: 650 })), 260);
  // 一次性 650ms 的终态时刻 = 650 + 200
  assert.equal(650 + TERMINAL_BUFFER_MS, 850);
});

test('D-5 judgePoseStep：一次性 return-stand 给了时序却没给终态快照 ⇒ 必须判红（该验的没验）', () => {
  const settled = snapshot();
  const problems = judgePoseStep(settled, 'jump', 1, { timing: timing(), terminal: null });
  assert.equal(problems.length, 1, `必须恰好一条问题，实际 ${JSON.stringify(problems)}`);
  assert.match(problems[0], /没有验|该验的没验/);
});

test('D-6 judgePoseStep：终态错了（posture 对但还在播 / posture 没回站姿）⇒ 判红', () => {
  const settled = snapshot();
  const stillPlaying = judgePoseStep(settled, 'jump', 1, {
    timing: timing(),
    terminal: snapshot({ posture: 'stand', playing: true }),
  });
  assert.equal(stillPlaying.length, 1);
  assert.match(stillPlaying[0], /没有回站姿/);

  const stuckJump = judgePoseStep(settled, 'jump', 1, {
    timing: timing(),
    terminal: snapshot({ posture: 'jump', playing: false }),
  });
  assert.equal(stuckJump.length, 1);
  assert.match(stuckJump[0], /没有回站姿/);

  // 正确终态 ⇒ 零问题（对照组，防止"永远判红"）
  assert.deepEqual(
    judgePoseStep(settled, 'jump', 1, { timing: timing(), terminal: snapshot({ posture: 'stand', playing: false }) }),
    [],
  );
});

test('D-7 runPoseMatrix 真清单：6 个组合、采样时刻逐条正确、jump 补等 590ms 验终态、收尾必叫 poseStop', async () => {
  const waits = [];
  const played = [];
  let stops = 0;
  /** 当前"在播"的快照（模拟真实端口：pause 之后返回同一姿态）。 */
  let live = null;
  /** 本步已等待的毫秒（用来模拟"jump 播完自己回站姿"）。 */
  let waitedInStep = 0;
  const report = await runPoseMatrix({
    posePlay: (posture, facing) => {
      played.push(`${posture}@${facing}`);
      waitedInStep = 0;
      live = snapshot({
        posture,
        facing,
        clipId: posture === 'jump' ? 'once' : 'cycle',
        clipFacing: facing,
        frameId: `${posture}-0`,
      });
      return live;
    },
    poseStop: () => {
      stops += 1;
    },
    poseSnapshot: () =>
      // 一次性 return-stand 片段：等够 clipMs + 缓冲 就"回站姿"；循环片段一直在播。
      // 帧必须**随等待时间推进**（G-4 之后矩阵会比对采样前后的 frameId）：
      // 用"本步已等待毫秒"当帧序号，等于模拟"每帧边界换一帧"，语义与改前完全一致
      // （改前只验姿态/朝向/在播，现在多验一条"帧动了"，其余断言一条未动）。
      waitedInStep >= 850 && live.clipId === 'once'
        ? { ...live, posture: 'stand', clipFacing: null, playing: false, frameId: `${live.posture}-${waitedInStep}` }
        : { ...live, frameId: `${live.posture}-${waitedInStep}` },
    poseWait: async (ms) => {
      waits.push(ms);
      waitedInStep += ms;
    },
  });

  assert.deepEqual(played, ['walk@-1', 'walk@1', 'run@-1', 'run@1', 'jump@-1', 'jump@1'], '顺序必须固定且覆盖 6 组合');
  assert.equal(POSE_MATRIX_POSTURES.length * POSE_MATRIX_FACINGS.length, 6);
  // 每个组合的采样等待：walk 220 / run 270 / jump 260，jump 再等 850-260 = 590
  assert.deepEqual(waits, [220, 220, 270, 270, 260, 590, 260, 590]);
  assert.equal(report.ok, true, `报告应通过：${JSON.stringify(report.problems)}`);
  assert.deepEqual(
    report.steps.map((step) => [step.posture, step.facing, step.clipMs, step.sampleAtMs, step.terminalChecked]),
    [
      ['walk', -1, 440, 220, false],
      ['walk', 1, 440, 220, false],
      ['run', -1, 540, 270, false],
      ['run', 1, 540, 270, false],
      ['jump', -1, 650, 260, true],
      ['jump', 1, 650, 260, true],
    ],
    '每步的 clipMs / sampleAtMs / terminalChecked 都必须如实落进报告',
  );
  assert.equal(stops, 1, 'finally 里必须叫一次 poseStop（不留"矩阵跑完还在跳"的现场）');

  // 变严（不改原语义）：既然 mock 现在真的"推帧"，这三条也必须一起成立，
  // 否则"帧在推进"那一项就等于又退化成没验。
  assert.deepEqual(
    report.steps.map((step) => step.motionChecked),
    [true, true, true, true, true, true],
    '6 步都跨过帧边界 ⇒ "帧在推进"必须真的验了',
  );
  for (const step of report.steps) {
    assert.notEqual(
      step.sampleFrameId,
      step.startFrameId,
      `${step.posture}@${step.facing} 的采样帧必须已经变了（mock 按等待毫秒推进帧）`,
    );
    assert.match(step.motionReason, /多帧片段/, `motionReason 必须说明依据：${step.motionReason}`);
  }
});

test('D-8 posePlay 抛错时：异常向上抛，但 poseStop 仍必须被调用一次（不留现场）', async () => {
  let stops = 0;
  await assert.rejects(
    () =>
      runPoseMatrix({
        posePlay: () => {
          throw new Error('控制器未就绪');
        },
        poseStop: () => {
          stops += 1;
        },
        poseSnapshot: () => null,
        poseWait: async () => {},
      }),
    /控制器未就绪/,
  );
  assert.equal(stops, 1, '出错也必须在 finally 里收尾');
});

test('D-9 时序查不到 + 该姿态声明 onEnd:return-stand ⇒ 必须判红"该验的没验"（缺口 G-2 已关闭）：成因此①端口返回 null', async () => {
  // 端口故意模拟"jump 播完不回站姿"（这是 onEnd:return-stand 的真缺陷形态）：
  // 姿态/朝向/playing 全对，只是**永远不回 stand**。
  // 成因①：`poseClip` 端口返回 null（等价于"端口缺失/不工作"，时序查不到）。
  const live = { current: null };
  const report = await runPoseMatrix({
    posePlay: (posture, facing) => {
      live.current = snapshot({
        posture,
        facing,
        clipId: posture === 'jump' ? 'once' : 'cycle',
        clipFacing: facing,
        frameId: `${posture}-0`,
      });
      return live.current;
    },
    poseStop: () => {},
    poseSnapshot: () => live.current,
    poseWait: async () => {},
    poseClip: () => null,
  });

  assert.equal(report.ok, false, '时序查不到但其姿态声明了 return-stand ⇒ 必须判红（不许静默跳过终态断言）');
  const expectLine = (facing) =>
    report.problems.find((line) => line.startsWith(`jump@${facing}:`) && line.includes('该验的没验'));
  assert.ok(expectLine(-1), `jump@-1 必须点名"该验的没验"，实际 problems：${JSON.stringify(report.problems)}`);
  assert.ok(expectLine(1), `jump@1 必须点名"该验的没验"，实际 problems：${JSON.stringify(report.problems)}`);
  // 判红的同时，报告仍须如实承认"终态没验"（ok:false 与 terminalChecked:false 并存是允许的，
  // 不允许的是 ok:true + terminalChecked:false 这种"假装验过"）
  assert.deepEqual(
    report.steps.map((step) => step.terminalChecked),
    [false, false, false, false, false, false],
    '时序查不到 ⇒ terminalChecked 全为 false（如实标注"没验"）',
  );
  // walk/run 没有声明 return-stand ⇒ 不许被连坐判红
  for (const step of report.steps) {
    if (step.posture !== 'jump') {
      assert.equal(step.ok, true, `${step.posture}@${step.facing} 不声明 return-stand，不许连坐：${JSON.stringify(step.problems)}`);
    }
  }
});

test('D-9b 成因此②clipId 在清单里查不到 ⇒ 同样必须判红"该验的没验"（缺口 G-2 已关闭）', async () => {
  // 成因②：快照报的 clipId 是清单里不存在的名字（拼错 / 跨版本漂移）。
  // 不打 `poseClip` 端口 ⇒ 走真实 `clipTimingOf(poses, …)`，查不到返回 null。
  const live = { current: null };
  const report = await runPoseMatrix({
    posePlay: (posture, facing) => {
      live.current = snapshot({
        posture,
        facing,
        clipId: posture === 'jump' ? 'once-typo' : 'cycle-typo',
        clipFacing: facing,
        frameId: `${posture}-0`,
      });
      return live.current;
    },
    poseStop: () => {},
    poseSnapshot: () => live.current,
    poseWait: async () => {},
  });

  assert.equal(report.ok, false, 'clipId 查不到 + 该姿态声明 return-stand ⇒ 必须判红');
  assert.ok(
    report.problems.some((line) => line.startsWith('jump@') && line.includes('该验的没验')),
    `jump 必须点名"该验的没验"（clipId 查不到是成因②），实际：${JSON.stringify(report.problems)}`,
  );
  // 这一条也顺带钉住"缺省姿态扫描兜底"：clipId 查不到时 declaresReturnStand 退化为
  // "扫描该姿态全部片段"，因此 jump 仍被要求验终态（不因 clipId 拼错就逃过）
  assert.deepEqual(
    report.steps.filter((step) => step.posture === 'jump').map((step) => step.terminalChecked),
    [false, false],
    '终态仍未被验（如实标注）',
  );
});

test('D-10 动画冻住（frameId 恒定）⇒ 必须判红"帧没在推进"，且该步 motionChecked 为 true（缺口 G-4 已关闭）', async () => {
  // 模拟"player 从不推进帧"：posture/clipFacing/playing 三个字段全对，frameId 永远是同一帧。
  // 不注入 poseClip ⇒ 用真清单时序（walk 4 帧/440ms、run 6 帧/540ms、jump 5 帧/650ms），
  // 于是三步都跨过了帧边界 ⇒ motionRequired 必须为 true。
  const live = { current: null };
  let waitedInStep = 0;
  const report = await runPoseMatrix({
    posePlay: (posture, facing) => {
      waitedInStep = 0;
      live.current = snapshot({
        posture,
        facing,
        clipId: posture === 'jump' ? 'once' : 'cycle',
        clipFacing: facing,
        frameId: `${posture}-frozen-0`,
      });
      return live.current;
    },
    poseStop: () => {},
    // 冻住的画面：无论如何等待，frameId 都不变；但 jump 的终态照常回站姿（否则会混进终态问题，
    // 让这条用例抓不准"帧没推进"这一条）
    poseSnapshot: () =>
      waitedInStep >= 850 && live.current.clipId === 'once'
        ? { ...live.current, posture: 'stand', clipFacing: null, playing: false }
        : live.current,
    poseWait: async (ms) => {
      waitedInStep += ms;
    },
  });

  assert.equal(report.ok, false, '动画冻住必须判红（"在播"不等于"画面在动"）');
  const motionProblems = report.problems.filter((line) => line.includes('帧没在推进'));
  assert.equal(motionProblems.length, 6, `6 个组合都必须报"帧没在推进"，实际：${JSON.stringify(report.problems)}`);
  // 判据真的执行了（不是靠显式豁免混过去）：每一步 motionChecked 必须为 true
  assert.deepEqual(
    report.steps.map((step) => step.motionChecked),
    [true, true, true, true, true, true],
    '6 步都跨过了帧边界 ⇒ "帧在推进"这一项必须真的验了',
  );
  // 起点与采样点的 frameId 逐值相同 —— 这就是"冻住"的可观测特征
  for (const step of report.steps) {
    assert.equal(step.startFrameId, `${step.posture}-frozen-0`, `${step.posture}@${step.facing} 的起点帧`);
    assert.equal(step.sampleFrameId, step.startFrameId, `${step.posture}@${step.facing} 采样点帧 id 未变`);
    assert.match(step.motionReason, /多帧片段/, `motionReason 必须说明为什么要求推进：${step.motionReason}`);
  }
});

test('D-11 单帧片段必须**显式豁免**：motionChecked=false 且 motionReason 写明"不适用"（不许静默跳过）', async () => {
  // 合成时序：1 帧 0ms 的 hold（与真 sit 同形），姿态用矩阵里的三个姿态以便混进矩阵；
  // onEnd 不是 return-stand ⇒ 不牵扯终态断言，只为孤立出"帧推进"这一项。
  const live = { current: null };
  const report = await runPoseMatrix(
    {
      posePlay: (posture, facing) => {
        live.current = snapshot({ posture, facing, clipId: 'hold', clipFacing: facing, frameId: 'hold-0' });
        return live.current;
      },
      poseStop: () => {},
      poseSnapshot: () => live.current,
      poseWait: async () => {},
      poseClip: () => ({ clipId: 'hold', clipMs: 0, frameCount: 1, loop: false, returnsToStand: false }),
    },
  );

  assert.equal(report.ok, true, `单帧片段不该判红（那是"不适用"，不是"冻住"）：${JSON.stringify(report.problems)}`);
  assert.deepEqual(
    report.steps.map((step) => step.motionChecked),
    [false, false, false, false, false, false],
    '单帧片段 ⇒ motionChecked 必须是 false（"这一项没验"）',
  );
  for (const step of report.steps) {
    assert.match(step.motionReason, /单帧片段/, `必须写明是单帧：${step.motionReason}`);
    assert.match(step.motionReason, /显式豁免/, `必须写明是"显式豁免"而不是静默跳过：${step.motionReason}`);
    assert.equal(step.sampleFrameId, step.startFrameId, '单帧片段的 frameId 本来就不会变');
  }
});

test('D-12 采样时刻短于单帧时长（holdMs 压到 0）⇒ motionChecked=false 且给出原因，**不**判红', async () => {
  // 把采样上限压到 0 ⇒ 采样时刻 0ms < 单帧时长（walk 110 / run 90 / jump 130）⇒ 还没跨过帧边界。
  // 这一项必须标"未验"并写明原因；判红就变成假红了（采样太早不是动画冻住）。
  const live = { current: null };
  let waitedInStep = 0;
  const report = await runPoseMatrix(
    {
      posePlay: (posture, facing) => {
        waitedInStep = 0;
        live.current = snapshot({
          posture,
          facing,
          clipId: posture === 'jump' ? 'once' : 'cycle',
          clipFacing: facing,
          frameId: `${posture}-0`,
        });
        return live.current;
      },
      poseStop: () => {},
      poseSnapshot: () =>
        waitedInStep >= 850 && live.current.clipId === 'once'
          ? { ...live.current, posture: 'stand', clipFacing: null, playing: false }
          : live.current,
      poseWait: async (ms) => {
        waitedInStep += ms;
      },
    },
    { holdMs: 0 },
  );

  assert.equal(report.ok, true, `采样太早不是缺陷，不许判红：${JSON.stringify(report.problems)}`);
  assert.deepEqual(
    report.steps.map((step) => step.motionChecked),
    [false, false, false, false, false, false],
    '采样时刻没跨过帧边界 ⇒ 本项未验（false）',
  );
  assert.deepEqual(
    report.steps.map((step) => step.sampleAtMs),
    [0, 0, 0, 0, 0, 0],
    'holdMs=0 ⇒ 采样时刻必须是 0（立即拍）',
  );
  for (const step of report.steps) {
    assert.match(step.motionReason, /短于单帧时长/, `必须写明是采样太早：${step.motionReason}`);
    assert.match(step.motionReason, /本项未验/, `必须明确说"未验"：${step.motionReason}`);
  }
});
