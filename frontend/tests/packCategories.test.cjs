const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PACK_CATEGORIES,
  LEGACY_PACK_CATEGORIES,
  ALLOWED_CATEGORIES,
  scanCustomPacksDir,
} = require('../electron/packs-manager.cjs');

/**
 * 扩展包类目契约用例。
 *
 * <p><b>守护的缺陷：</b>UI、类型定义与开放文档都按 8 个类目出货，主进程白名单却只放行 6 个，
 * `motion` / `taskProgress` / `interactionCard` 三类本地包会被 `normalizeRemoteManifest` 静默丢弃
 * （返回 null），用户按文档写完只看到「未发现合法扩展包」；同一常量还让在线注册表直接报
 * 「非法扩展包类目」。</p>
 *
 * <p><b>为什么期望值写成字面量：</b>最初这组用例直接遍历 `PACK_CATEGORIES` 造包，
 * 于是把常量里的 `taskProgress` 删掉时，期望值跟着一起缩水，测试照样绿——安慰剂。
 * 现在期望值钉成字面量，只改常量不改契约就会变红。</p>
 */
const EXPECTED_CATEGORIES = [
  'theme',
  'font',
  'background',
  'sidebar',
  'input',
  'motion',
  'taskProgress',
  'interactionCard',
];

/** 在 root 下按 category 造一个最小合法扩展包，返回目录名。 */
function writeProbePack(root, category) {
  const id = `probe-${category.toLowerCase()}`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        category,
        name: `探针 ${category}`,
        version: '1.0.0',
        hostApiVersion: '1',
        entryCss: 'pack.css',
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'pack.css'), ':root { --lx-probe: 1; }\n', 'utf8');
  return id;
}

test('主进程类目白名单与契约一致', () => {
  assert.deepEqual(
    [...PACK_CATEGORIES].sort(),
    [...EXPECTED_CATEGORIES].sort(),
    '主进程类目白名单与契约不一致：少一个类目就会静默丢弃该类目的本地包',
  );
});

test('渲染进程 OfficialPackCategory 与主进程白名单保持一致', () => {
  const typesPath = path.resolve(__dirname, '..', 'src', 'packs', 'types.ts');
  const source = fs.readFileSync(typesPath, 'utf8');
  const match = source.match(/export type OfficialPackCategory\s*=([^;]+);/);
  assert.ok(match, '未能从 src/packs/types.ts 解析出 OfficialPackCategory 联合类型');

  const rendererCategories = [...match[1].matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
  assert.deepEqual(
    [...rendererCategories].sort(),
    [...EXPECTED_CATEGORIES].sort(),
    'types.ts 的类目联合类型与契约不一致：渲染进程会归类出错，设置页卡片与 manifest 对不上',
  );
  assert.deepEqual(
    [...PACK_CATEGORIES].sort(),
    [...rendererCategories].sort(),
    '主进程白名单与渲染进程类型分裂了（历史上就是这里出的问题）',
  );
});

test('scanCustomPacksDir 接受全部官方类目的本地扩展包', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-pack-categories-'));
  try {
    for (const category of EXPECTED_CATEGORIES) {
      writeProbePack(tmpRoot, category);
    }

    const res = scanCustomPacksDir(tmpRoot);
    assert.equal(res.ok, true, res.error);

    const accepted = res.packs.map(p => p.category).sort();
    assert.deepEqual(
      accepted,
      [...EXPECTED_CATEGORIES].sort(),
      `本地包类目丢包：期望 ${[...EXPECTED_CATEGORIES].sort().join(',')}，实际 ${accepted.join(',')}`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('scanCustomPacksDir 丢弃未知类目，但不影响同目录下的合法包', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-pack-categories-bad-'));
  try {
    writeProbePack(tmpRoot, 'sidebar');
    const badId = writeProbePack(tmpRoot, 'notACategory');

    const res = scanCustomPacksDir(tmpRoot);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.packs.length, 1, '未知类目必须被丢弃，且不能牵连其它包');
    assert.equal(res.packs[0].category, 'sidebar');
    assert.ok(!res.packs.some(p => p.id === badId), `未知类目 ${badId} 不应被接受`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('历史别名 component 仍被接受，但不属于官方类目', () => {
  assert.equal(PACK_CATEGORIES.includes('component'), false, 'component 不应出现在官方类目里');
  assert.equal(LEGACY_PACK_CATEGORIES.includes('component'), true);
  assert.equal(ALLOWED_CATEGORIES.has('component'), true, '历史别名一旦拒绝，早期包会集体失效');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-pack-categories-legacy-'));
  try {
    writeProbePack(tmpRoot, 'component');
    const res = scanCustomPacksDir(tmpRoot);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.packs.length, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
