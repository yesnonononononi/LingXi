/**
 * 产物级守卫单测（node:test）：`scripts/check-pet-not-shipped.mjs`。
 *
 * <p><b>为什么需要"反例"</b>：这类守卫最典型的失效方式不是报错，而是<b>永远绿</b>
 * ——解析正则匹配不到就当成"没有 pet"，扫描路径写错就当成"没有指纹"。
 * 所以每个判据都必须有一个注入样本，证明它<b>真的会红</b>：
 * 假 dist 里放一个 `pet.html`、假 vite 配置里加回 `pet` 入口、假 `build.files` 里加回 `pet-geometry.json`、
 * 假产物里塞一个桌宠指纹。</p>
 *
 * <p>真实仓库的那条断言分两种状态（都必须通过）：</p>
 * <ul>
 *   <li>没有 `dist/`：静态判据必须全绿，并给出"请先跑 npm run build"的说明（不能假装检查过了）；</li>
 *   <li>有 `dist/`（`npm run build` 之后）：产物里不许有 `pet.html`、不许有桌宠指纹。</li>
 * </ul>
 *
 * <p>运行：`npm run test:pet`。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONTEND_ROOT = path.join(__dirname, '..');

/** 合法的 vite 配置样本（没有 pet 入口）。 */
const GOOD_VITE = `import { defineConfig } from 'vite'
import { resolve } from 'node:path'
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        notification: resolve(__dirname, 'notification.html'),
      },
    },
  },
})
`;

/** 加了 pet 入口的坏 vite 配置样本。 */
const BAD_VITE = `import { defineConfig } from 'vite'
import { resolve } from 'node:path'
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        notification: resolve(__dirname, 'notification.html'),
        pet: resolve(__dirname, 'pet.html'),
      },
    },
  },
})
`;

/** 合法的 package.json 样本。 */
const GOOD_PKG = { name: 'fixture', build: { files: ['dist/**/*', 'electron/**/*', 'package.json'] } };

/** 带桌宠数据的坏 package.json 样本。 */
const BAD_PKG = { name: 'fixture', build: { files: ['dist/**/*', 'electron/**/*', 'pet-geometry.json', 'package.json'] } };

/**
 * 造一个临时前端根。
 *
 * @param {{vite?: string, pkg?: object, dist?: Record<string, string>}} [options] 样本
 * @returns {string} 临时目录绝对路径
 */
function makeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-pet-not-shipped-'));
  fs.writeFileSync(path.join(root, 'vite.config.ts'), options.vite ?? GOOD_VITE, 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(options.pkg ?? GOOD_PKG, null, 2), 'utf8');
  const dist = options.dist;
  if (dist) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    for (const [name, content] of Object.entries(dist)) {
      const target = path.join(root, 'dist', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  return root;
}

/**
 * 删掉临时目录（失败也只记日志：测试断言已经跑完了）。
 *
 * @param {string} root 临时目录
 * @returns {void}
 */
function removeFixture(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉不影响测试结论
  }
}

test('真实仓库：静态判据全绿（dist 不存在时明确说明"未检查产物"）', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const result = runNotShippedChecks({});
  const ids = result.checks.map((item) => item.id);
  assert.ok(ids.includes('vite-input'), '缺少 vite-input 判据');
  assert.ok(ids.includes('build-files'), '缺少 build-files 判据');
  assert.equal(result.ok, true, `真实仓库未通过产物级守卫：\n${result.problems.join('\n')}`);
  const distDir = path.join(FRONTEND_ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    assert.ok(
      result.notes.some((note) => note.includes('dist 不存在')),
      '没有 dist 时必须显式说明"跳过产物校验"，不能假装检查过',
    );
  } else {
    assert.ok(ids.includes('dist-entry'), 'dist 存在时必须校验 pet.html');
    assert.ok(ids.includes('dist-markers'), 'dist 存在时必须扫描桌宠指纹');
  }
});

test('反例：vite 配置里加回 pet 入口 → 守卫必须红', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({ vite: BAD_VITE });
  try {
    const result = runNotShippedChecks({ frontendRoot: root, distDir: path.join(root, 'no-dist') });
    assert.equal(result.ok, false, 'pet 入口回到 build input 却仍然绿：守卫失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('vite-input') && problem.includes('pet')),
      `问题列表里没有点名 vite 入口：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('反例：build.files 里加回 pet-geometry.json → 守卫必须红', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({ pkg: BAD_PKG });
  try {
    const result = runNotShippedChecks({ frontendRoot: root, distDir: path.join(root, 'no-dist') });
    assert.equal(result.ok, false, 'pet 数据回到 build.files 却仍然绿：守卫失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('build-files') && problem.includes('pet-geometry.json')),
      `问题列表里没有点名 build.files：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('反例：产物里残留桌宠静态资产目录（隔离失效）→ 守卫必须红（M2 线A任务 2）', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({
    dist: {
      'index.html': '<!doctype html><div id="app"></div>',
      'live2d/pet-poses/sit/sit_neutral@1x.webp': 'RIFF-fake-webp',
      'live2d/pet-poses/README.md': '# not a marker',
    },
  });
  try {
    const result = runNotShippedChecks({ frontendRoot: root });
    assert.equal(result.ok, false, '产物里躺着 pet-poses 却仍然绿：隔离判据失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('dist-pet-static-dirs') && problem.includes('pet-poses')),
      `问题列表里没有点名桌宠静态资产目录：\n${result.problems.join('\n')}`,
    );
    assert.ok(
      result.problems.some((problem) => problem.startsWith('dist-pet-static-paths')),
      `问题列表里没有点名桌宠路径段：\n${result.problems.join('\n')}`,
    );
    assert.ok(
      result.problems.some((problem) => problem.startsWith('dist-pet-static-media')),
      `问题列表里没有点名桌宠姿态 webp：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('反例：桌宠姿态 webp 被挪到别处也要抓（按文件名前缀，不只看目录）', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({
    dist: {
      'index.html': '<!doctype html><div id="app"></div>',
      'assets/pet-pose-sneaky@2x.webp': 'RIFF-fake-webp',
    },
  });
  try {
    const result = runNotShippedChecks({ frontendRoot: root });
    assert.equal(result.ok, false, '桌宠姿态 webp 藏在 assets/ 下却仍然绿：判据只看目录就会漏');
    assert.ok(
      result.problems.some(
        (problem) => problem.startsWith('dist-pet-static-media') && problem.includes('pet-pose-sneaky@2x.webp'),
      ),
      `问题列表里没有点名那个文件：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('非桌宠 Live2D 模型资产（live2d/<model>/texture.webp）不在禁令内 → 守卫必须绿', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({
    dist: {
      'index.html': '<!doctype html><div id="app"></div>',
      'live2d/hiyori/texture_00.webp': 'RIFF-fake-webp',
      'live2d/hiyori/model3.json': '{"version":3}',
    },
  });
  try {
    const result = runNotShippedChecks({ frontendRoot: root });
    assert.equal(
      result.ok,
      true,
      `非桌宠模型资产被误判成桌宠资产（这会让守卫被放宽成"禁所有 webp"）：\n${result.problems.join('\n')}`,
    );
    const ids = result.checks.map((item) => item.id);
    assert.ok(ids.includes('dist-pet-static-dirs'), '缺 dist-pet-static-dirs 判据');
    assert.ok(ids.includes('dist-pet-static-paths'), '缺 dist-pet-static-paths 判据');
    assert.ok(ids.includes('dist-pet-static-media'), '缺 dist-pet-static-media 判据');
  } finally {
    removeFixture(root);
  }
});

test('隔离脚本自身的幂等性：没有可删的目录时不抛错，删完再删一次也不抛错', async () => {
  const { isolatePetAssetsFromDist, listPetAssetDirs } = await import('../scripts/pet-asset-isolation.mjs');
  const root = makeFixture({
    dist: {
      'index.html': '<!doctype html>',
      'live2d/pet-poses/sit/a@1x.webp': 'x',
      'live2d/pet-v3/face/b@1x.webp': 'yy',
      'live2d/hiyori/texture_00.webp': 'zzz',
    },
  });
  try {
    const dist = path.join(root, 'dist');
    const before = listPetAssetDirs(dist);
    assert.equal(before.length, 2, `隔离前应看到 2 个 pet-* 目录：${before.join(', ')}`);

    const first = isolatePetAssetsFromDist(dist);
    assert.equal(first.removed.length, 2, '第一次隔离应删掉 2 个目录');
    assert.ok(first.removedFiles >= 2, '必须统计到被删的文件数（日志与门禁都靠它）');
    assert.ok(first.removedBytes > 0, '必须统计到被删的字节数');
    assert.deepEqual(first.removed.map((item) => item.name).sort(), ['pet-poses', 'pet-v3']);
    assert.ok(!fs.existsSync(path.join(dist, 'live2d', 'pet-poses')), 'pet-poses 必须被删掉');
    assert.ok(fs.existsSync(path.join(dist, 'live2d', 'hiyori', 'texture_00.webp')), '非桌宠模型资产必须留下');

    // 幂等：再删一次不抛错、返回空清单
    const second = isolatePetAssetsFromDist(dist);
    assert.deepEqual(second.removed, [], '第二次隔离没有可删的东西，必须返回空清单');
    assert.equal(second.removedBytes, 0);
  } finally {
    removeFixture(root);
  }
});

test('反例：dist 里出现 pet.html → 守卫必须红', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({ dist: { 'pet.html': '<!doctype html><div id="pet-root"></div>' } });
  try {
    const result = runNotShippedChecks({ frontendRoot: root });
    assert.equal(result.ok, false, 'dist 里有 pet.html 却仍然绿：守卫失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('dist-entry')),
      `问题列表里没有点名产物入口：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('反例：dist 的 js 产物里残留桌宠指纹 → 守卫必须红', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({
    dist: {
      'index.html': '<!doctype html><div id="app"></div>',
      'assets/main-abc.js': 'const tpl = \'<div id="pet-root"></div>\';',
    },
  });
  try {
    const result = runNotShippedChecks({ frontendRoot: root });
    assert.equal(result.ok, false, '产物里含桌宠指纹却仍然绿：守卫失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('dist-markers') && problem.includes('pet-root')),
      `问题列表里没有点名指纹：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('正例：干净产物 + 干净配置 → 守卫全绿', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({ dist: { 'index.html': '<!doctype html><div id="app"></div>', 'assets/main-abc.js': 'export const x = 1;' } });
  try {
    const result = runNotShippedChecks({ frontendRoot: root });
    assert.equal(result.ok, true, `干净样本被判失败：\n${result.problems.join('\n')}`);
    assert.equal(result.notes.length, 0);
  } finally {
    removeFixture(root);
  }
});

test('解析器口径：注释里的 pet.html 不算入口，代码里的才算', async () => {
  const { parseViteInput } = await import('../scripts/check-pet-not-shipped.mjs');
  const commented = `export default { build: { rollupOptions: { input: {
    main: resolve(__dirname, 'index.html'),
    notification: resolve(__dirname, 'notification.html'),
  } } } } // 历史：pet: resolve(__dirname, 'pet.html')`;
  const parsed = parseViteInput(commented);
  assert.equal(parsed.keys.includes('pet'), false, '注释里的 pet 被误判成入口');
  assert.equal(parsed.htmlFiles.some((file) => path.basename(file) === 'pet.html'), false);

  const real = parseViteInput(BAD_VITE);
  assert.equal(real.keys.includes('pet'), true);
  assert.equal(real.htmlFiles.some((file) => path.basename(file) === 'pet.html'), true);
});

test('守卫自检（--selftest 的同一实现）必须通过', async () => {
  const { selftest } = await import('../scripts/check-pet-not-shipped.mjs');
  const result = selftest();
  assert.equal(result.ok, true, `守卫自检失败：\n${result.problems.join('\n')}`);
});

test('反例：build.files 里加回 pet-poses.json → 守卫必须红（M2）', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const pkg = { name: 'fixture', build: { files: ['dist/**/*', 'electron/**/*', 'pet-poses.json', 'package.json'] } };
  const root = makeFixture({ pkg });
  try {
    const result = runNotShippedChecks({ frontendRoot: root, distDir: path.join(root, 'no-dist') });
    assert.equal(result.ok, false, 'pose 清单回到 build.files 却仍然绿：守卫失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('build-files') && problem.includes('pet-poses.json')),
      `问题列表里没有点名 pet-poses.json：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('反例：pose 运行目录里出现 PNG 母版 → 守卫必须红（D-02 母版不外流）', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  const root = makeFixture({});
  try {
    // 母版 png 只该留在 docs/assets/desktop-pet；进了 public/ 就会被 vite 拷进 dist 并随包发布
    const poseDir = path.join(root, 'public', 'live2d', 'pet-poses', 'sit');
    fs.mkdirSync(poseDir, { recursive: true });
    fs.writeFileSync(path.join(poseDir, 'sit_neutral@2x.png'), Buffer.alloc(64, 0x89));
    fs.writeFileSync(path.join(poseDir, 'sit_neutral@2x.webp'), Buffer.alloc(64, 0x52));
    // 清单存在 = 运行资产"应该有"，此时缺 dist 侧目录会只记 note，不影响本次断言
    fs.writeFileSync(path.join(root, 'pet-poses.json'), JSON.stringify({ version: 1, batches: {} }), 'utf8');
    const result = runNotShippedChecks({ frontendRoot: root, distDir: path.join(root, 'no-dist') });
    assert.equal(result.ok, false, 'pose 运行目录里躺着 PNG 却仍然绿：守卫失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('pose-png') && problem.includes('.png')),
      `问题列表里没有点名 PNG：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('反例：pose 运行资产合计超过 8 MiB → 守卫必须红（D-02 体积预算）', async () => {
  const { runNotShippedChecks } = await import('../scripts/check-pet-not-shipped.mjs');
  // 上限的真源：scripts/pet-budget.mjs（本用例断言的是"守卫按真源值拦"，不自己写死 8 MiB）
  const { POSE_TOTAL_MAX_BYTES } = await import('../scripts/pet-budget.mjs');
  const root = makeFixture({});
  try {
    const poseDir = path.join(root, 'public', 'live2d', 'pet-poses', 'walk');
    fs.mkdirSync(poseDir, { recursive: true });
    // 预算 +4 KiB：跨过阈值的形状（不是"随便写个大数"，越界幅度越小越能证明比较符号没写错）
    fs.writeFileSync(path.join(poseDir, 'walk_a@2x.webp'), Buffer.alloc(POSE_TOTAL_MAX_BYTES + 4096, 0x52));
    const result = runNotShippedChecks({ frontendRoot: root, distDir: path.join(root, 'no-dist') });
    assert.equal(result.ok, false, 'pose 资产超预算却仍然绿：守卫失效');
    assert.ok(
      result.problems.some((problem) => problem.startsWith('pose-budget') && problem.includes('MiB')),
      `问题列表里没有点名体积预算：\n${result.problems.join('\n')}`,
    );
  } finally {
    removeFixture(root);
  }
});

test('真实仓库：public 侧 pose 运行资产满足 D-02（无 PNG 且 ≤ 8 MiB）', async () => {
  const { runNotShippedChecks, POSE_RUNTIME_DIR_SEGMENTS, scanPoseRuntimeDir } = await import(
    '../scripts/check-pet-not-shipped.mjs'
  );
  // 上限的真源：scripts/pet-budget.mjs
  const { POSE_TOTAL_MAX_BYTES } = await import('../scripts/pet-budget.mjs');
  const publicPoseDir = path.join(FRONTEND_ROOT, 'public', ...POSE_RUNTIME_DIR_SEGMENTS);
  const stats = scanPoseRuntimeDir(publicPoseDir);
  if (!stats.exists) {
    // 切片 1 之后此目录必然存在；不存在说明有人删了运行资产，这是真问题
    assert.fail(`pose 运行目录不存在：${publicPoseDir}（请先跑 npm run build:pet-poses）`);
  }
  assert.deepEqual(stats.pngFiles, [], '运行目录里不许出现 PNG 母版');
  assert.ok(stats.webpFiles >= 1, '运行目录里至少要有 1 个 webp（sit 单帧也算可播放内容，D-03）');
  assert.ok(
    stats.bytes <= POSE_TOTAL_MAX_BYTES,
    `运行资产 ${(stats.bytes / 1024 / 1024).toFixed(2)} MiB 超过 D-02 预算 ${POSE_TOTAL_MAX_BYTES / 1024 / 1024} MiB`,
  );
  const result = runNotShippedChecks({});
  assert.ok(result.checks.some((item) => item.id === 'pose-budget'), '缺少 pose-budget 判据');
  assert.ok(result.checks.some((item) => item.id === 'pose-png'), '缺少 pose-png 判据');
  assert.equal(result.ok, true, `真实仓库未通过产物级守卫：\n${result.problems.join('\n')}`);
});
