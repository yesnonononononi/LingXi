/**
 * 「在动」判据的数据侧证据（M2 切片 3 · G-P14 / P-06 / P-07）。
 *
 * <p><b>为什么要单独立一个文件：</b>"这两帧是不是同一张画"这个问题只能由 `contentId`
 * （母版 PNG 摘要）回答。用帧数回答会在两类真实数据上出错：</p>
 * <ol>
 *   <li><b>假动画</b>：两帧同图（例如有人为了"看起来有动画"把同一张画复制成两帧）——
 *       帧数 2、时序合法、`rAF` 空转、用户看到静止画面；</li>
 *   <li><b>合法的"停留"</b>：`lie` 的 `enter` 末两帧同像素（`down_03` = `neutral`，
 *       美术用 `aliases` 声明的等价），这是**用时长表达停留**的正确形态，不是缺陷。</li>
 * </ol>
 *
 * <p>所以判据只能是"多帧片段必须有 ≥2 个 distinct `contentId`"，并且单帧片段要显式豁免。
 * 本文件把真数据（`lie`/`sleep`）与变异样本都钉住。</p>
 *
 * @module tests/petPoseMotion
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkClipMotion } from '../scripts/check-pet-poses.mjs';

/** 已提交的运行清单。 */
const MANIFEST = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'pet-poses.json'), 'utf8')) as Record<
  string,
  any
>;

/**
 * 取一个片段里出现的 distinct `contentId` 数量。
 *
 * @param batch 批次
 * @param clip 片段
 * @returns distinct contentId 数
 */
function distinctContentIdsOf(batch: any, clip: any): number {
  const ids = new Set<string>();
  for (const frameId of clip.frames as string[]) {
    ids.add(batch.frames[frameId].files['1x'].contentId as string);
  }
  return ids.size;
}

test('P-06 lie 的 enter 必须真的在动（distinct contentId = 3 ≥ 2），末两帧同像素是"停留"不是缺陷', () => {
  const lie = MANIFEST.batches.lie;
  const enter = (lie.clips as any[]).find((clip) => clip.id === 'enter');
  assert.ok(enter, 'lie 必须有 enter');
  assert.equal(enter.frames.length, 4, 'enter 是 4 帧（down_01/down_02/down_03/neutral）');
  const distinct = distinctContentIdsOf(lie, enter);
  assert.equal(distinct, 3, `lie 的 enter 应有 3 个 distinct contentId（7 个帧位里只有 3 张画），实际 ${distinct}`);
  assert.ok(distinct >= 2, 'G-P14：多帧片段的 distinct contentId 必须 ≥ 2');
  // 停留证据：末两帧同内容、但时长是两拍（用时长表达停留，不靠复制帧凑动画）
  const [third, fourth] = enter.frames.slice(-2) as [string, string];
  assert.equal(
    lie.frames[third].files['1x'].contentId,
    lie.frames[fourth].files['1x'].contentId,
    'enter 的末两帧必须同像素（down_03 与 neutral 是 aliases 等价的同一张画）',
  );
  assert.deepEqual(enter.frameMs, [120, 120, 120, 120], '同像素的两帧各占 120ms ⇒ 视觉上是停顿 120ms');
  // 门禁判据对它是绿的（"同像素但 ≥2 个 distinct"是合法形态）
  assert.deepEqual(checkClipMotion(lie), []);
});

test('P-06 sleep 的呼吸 cycle 3 帧必须是 3 张不同的画（呼吸循环不能靠复制帧）；单帧 exit 显式豁免', () => {
  const sleep = MANIFEST.batches.sleep;
  const cycle = (sleep.clips as any[]).find((clip: any) => clip.id === 'cycle');
  assert.ok(cycle, 'sleep 必须有 cycle');
  // 修订要点：cycle 只剩呼吸三帧（`startle` 是睡→醒的过渡、`curled` 是深睡阶段，都不在循环里）
  assert.deepEqual(cycle.frames, ['neutral', 'breathIn', 'breathOut']);
  assert.equal(cycle.frames.length, 3);
  assert.equal(distinctContentIdsOf(sleep, cycle), 3, 'sleep 的呼吸 3 帧必须是 3 个 distinct contentId');
  // `exit` 只有 1 帧（`startle`）：单帧片段由判据显式豁免，不是"碰巧没遍历到"
  const exit = (sleep.clips as any[]).find((clip: any) => clip.id === 'exit');
  assert.ok(exit, 'sleep 必须有 exit');
  assert.equal(exit.frames.length, 1, 'exit 是单帧（睁眼惊醒）');
  assert.deepEqual(checkClipMotion(sleep), [], 'sleep 的两条片段都不该被判红（cycle 3 张画；exit 单帧豁免）');
});

test('P-06 动作批逐条：walk/run/jump 的每个片段 distinct contentId 都 ≥ 2', () => {
  for (const posture of ['walk', 'run', 'jump'] as const) {
    const batch = MANIFEST.batches[posture];
    assert.ok(batch, `运行清单里必须有 ${posture}`);
    for (const clip of batch.clips as any[]) {
      const distinct = distinctContentIdsOf(batch, clip);
      assert.ok(distinct >= 2, `${posture}/${clip.id}@${clip.facing} 只有 ${distinct} 个 distinct contentId`);
    }
    assert.deepEqual(checkClipMotion(batch), [], `${posture} 不该被判红`);
  }
});

test('G-P14 变异：把 sleep 呼吸 cycle 的帧全塞成同一个 contentId ⇒ 必红（帧数骗不过判据）', () => {
  const sleep = MANIFEST.batches.sleep;
  const cycle = (sleep.clips as any[]).find((clip: any) => clip.id === 'cycle');
  assert.ok(cycle, 'sleep 必须有 cycle');
  const firstId = cycle.frames[0] as string;
  const shared = sleep.frames[firstId].files['1x'].contentId as string;
  const mutated = {
    ...sleep,
    frames: Object.fromEntries(
      Object.entries(sleep.frames).map(([frameId, frame]: [string, any]) => [
        frameId,
        {
          ...frame,
          files: {
            '1x': { ...frame.files['1x'], contentId: shared },
            '2x': { ...frame.files['2x'], contentId: shared },
          },
        },
      ]),
    ),
  };
  assert.equal(distinctContentIdsOf(mutated, cycle), 1, '前置：变异后只剩 1 个 contentId');
  const problems = checkClipMotion(mutated);
  // cycle 有 3 帧却只有 1 张画 ⇒ 必红；exit 是单帧 ⇒ 豁免，所以正好一条
  assert.equal(problems.length, 1, `必须正好红一条，实际：${JSON.stringify(problems)}`);
  assert.match(problems[0], /G-P14/);
  assert.match(problems[0], /有 3 帧但只有 1 个 distinct contentId/);
});

test('G-P14 单帧豁免的边角：sit 只有 1 帧且 frameMs=[0]，判据必须放行而不是"碰巧没遍历到"', () => {
  const sit = MANIFEST.batches.sit;
  const hold = (sit.clips as any[])[0];
  assert.equal(hold.frames.length, 1, 'sit 的 hold 就是单帧静止姿态');
  assert.deepEqual(hold.frameMs, [0], '静止片段的帧时长是 0（不推进）');
  assert.deepEqual(checkClipMotion(sit), [], '单帧片段必须显式豁免');
  // 反向：给它复制成两帧同图 ⇒ 立刻变成"假动画"必须红
  const faked = {
    ...sit,
    clips: [{ ...hold, frames: [hold.frames[0], hold.frames[0]], frameMs: [0, 0] }],
  };
  const problems = checkClipMotion(faked);
  assert.equal(problems.length, 1, '两帧同图必须判红（哪怕帧时长是 0）');
  assert.match(problems[0], /假动画/);
});
