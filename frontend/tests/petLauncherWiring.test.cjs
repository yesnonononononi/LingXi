/**
 * S4.1 · **预览启动器与生产路径的对齐守卫**（`electron/pet-launcher.cjs`）。
 *
 * <p><b>这个缺陷是什么（主理人 9315 真机采到的事实）：</b>启动器里那行
 * `registerPetWindow({ ipcMain, isDev: true, frontendRoot })` **没有传 `prefs` 与 `menu`
 * 两个端口**。后果是三连塌：</p>
 * <ol>
 *   <li>`window.petAPI.prefsSet({roam:true})` 返回 `{ok:false, changed:false}`——
 *       接线层 `store === null`（门禁关闭态），偏好根本写不进去；</li>
 *   <li>磁盘上 `<userData>/pet-prefs.json` 从未生成 ⇒ 渲染层永远收不到偏好广播 ⇒
 *       **漫游/跟随在开发预览里完全打不开**，用户没法手动验收 M3 的核心功能；</li>
 *   <li>launcher 自己的托盘还在用内联模板，与 `pet-menu.cjs` 的单一真源分裂
 *       （生产已经是同源了，开发反而没有）。</li>
 * </ol>
 *
 * <p><b>为什么必须是测试而不是"记得传"：</b>这个缺口**没有任何既有用例会红**——
 * 少传端口是一个完全合法的调用（两个参数都是可选的），类型也不会报错。它只在真机上表现为
 * "点了没反应"。所以这里把它钉成四条结构性判据：端口在、文案不在、路径对、调用点齐。</p>
 *
 * <p><b>为什么可以静态读源码：</b>`pet-launcher.cjs` `require('electron')`，在 node 里
 * 跑不起来（这也是启动器逻辑一直没人测的原因）。所以"装配是否正确"只能读源码判定；
 * 真正会跑的装配逻辑（接线器本身）另有 `petPrefsWiring.test.cjs` 手摇，两者互补。</p>
 *
 * @module tests/petLauncherWiring
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONTEND_ROOT = path.resolve(__dirname, '..');
const LAUNCHER_FILE = path.join(FRONTEND_ROOT, 'electron', 'pet-launcher.cjs');
const MAIN_FILE = path.join(FRONTEND_ROOT, 'electron', 'main.cjs');

const LAUNCHER_CONFIG = require(path.join(FRONTEND_ROOT, 'electron', 'pet-launcher-config.cjs'));
const { MENU_LABELS, MENU_IDS, buildTrayItems } = require(path.join(FRONTEND_ROOT, 'electron', 'pet-menu.cjs'));
const { createPrefsWiring } = require(path.join(FRONTEND_ROOT, 'electron', 'pet-prefs-wiring.cjs'));
const { createPrefsStore } = require(path.join(FRONTEND_ROOT, 'electron', 'pet-prefs.cjs'));

/**
 * 读源码。
 *
 * @param {string} file 绝对路径
 * @returns {string} 内容
 */
function readSource(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * 取 `registerPetWindow({...})` 的**实参片段**（从 `{` 到配对的 `}`）。
 *
 * <p>不用正则一把梭：实参里嵌了对象字面量，正则会在第一个 `)` 就停。手写括号配对
 * 才能稳定切出整个调用点——这也让"少传一个键"这件事变成可判定的字符串事实。</p>
 *
 * @param {string} source 源码
 * @returns {string} 实参文本（不含外层括号）
 * @throws {Error} 找不到调用点时抛出（改名后必须同步本测试）
 */
function extractRegisterCallArgs(source) {
  const marker = 'registerPetWindow({';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'pet-launcher.cjs 找不到 registerPetWindow({...}) 调用点（改名后请同步本测试）');
  const openIndex = start + marker.length - 1;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error('pet-launcher.cjs 的 registerPetWindow 调用括号不配对');
}

// ---------------------------------------------------------------- ① 端口必须传

test('端口（静态）：registerPetWindow 调用点必须带 prefs: 与 menu: 两个端口', () => {
  const args = extractRegisterCallArgs(readSource(LAUNCHER_FILE));
  assert.match(args, /(^|[\s,])prefs\s*:/, '缺少 prefs 端口：接线层会拿到 store===null，偏好写不进去（真机即"点了没反应"）');
  assert.match(args, /(^[,\s])?menu\s*:/, '缺少 menu 端口：右键菜单会退回内联模板，与 pet-menu.cjs 分裂');
  assert.match(args, /isDev\s*:\s*true/, '启动器恒为开发态');
  assert.match(args, /frontendRoot\s*:/, 'frontendRoot 必须传（lxa:// 与 dist 解析都靠它）');
});

test('端口（静态）：端口形状与生产 main.cjs 同形（三件套齐，不许少 onPrefsChange）', () => {
  const source = readSource(LAUNCHER_FILE);
  for (const key of ['getPrefs', 'setPrefs', 'onPrefsChange']) {
    assert.ok(
      source.includes(`${key}:`) || source.includes(`${key} =`) || source.includes(`.${key}(`),
      `启动器缺少端口方法 ${key}：渲染层订阅不到偏好广播（漫游/跟随永远打不开）`,
    );
  }
  // 三件套必须真的接到接线器上（不是自己另写一份内存对象）
  assert.match(source, /petPrefsWiring\.getPrefs\(\)/, 'getPrefs 必须来自接线器');
  assert.match(source, /petPrefsWiring\.setPrefs\(/, 'setPrefs 必须来自接线器（先落盘→广播→重建菜单）');
  assert.match(source, /petPrefsWiring\.onChange\(/, 'onPrefsChange 必须来自接线器');

  // 生产侧同一份接线（两侧都真实存在，才叫"路径对齐"）
  const mainSource = readSource(MAIN_FILE);
  assert.match(mainSource, /petPrefsWiring\.onChange\(/, 'main.cjs 也应走同一接线器（对齐的另一半）');
});

test('门禁语义（静态）：启动器恒为开发态 ⇒ includePet: true；打包版才为 false', () => {
  const source = readSource(LAUNCHER_FILE);
  assert.match(source, /includePet\s*:\s*true/, '预览启动器恒开桌宠段（includePet:true 就是门禁语义）');
  const mainSource = readSource(MAIN_FILE);
  assert.match(
    mainSource,
    /includePet\s*:\s*petExposure\.enabled/,
    'main.cjs 的桌宠段必须绑定门禁（打包版不许出现桌宠菜单项）',
  );
});

// ---------------------------------------------------------------- ② 文案字面量必须一个不留

test('文案（静态）：launcher 里不许出现任何菜单文案字面量（label 字面量清零）', () => {
  const source = readSource(LAUNCHER_FILE);
  const offenders = [];
  for (const [key, label] of Object.entries(MENU_LABELS)) {
    if (source.includes(label)) offenders.push(`${key}="${label}"`);
  }
  assert.deepEqual(offenders, [], `launcher 出现菜单文案：\n${offenders.join('\n')}\n—— 文案唯一真源是 pet-menu.cjs`);
  assert.equal(
    /\blabel\s*:/.test(source),
    false,
    'launcher 里不许再出现 label 键：托盘模板必须整份来自 pet-menu.cjs 的 buildTrayItems',
  );
});

test('文案（静态）：launcher 必须 require pet-menu.cjs 与 pet-prefs 接线层（不许自建模板）', () => {
  const source = readSource(LAUNCHER_FILE);
  assert.match(source, /require\('\.\/pet-menu\.cjs'\)/, '必须 require pet-menu.cjs（文案与结构真源）');
  assert.match(source, /require\('\.\/pet-prefs-wiring\.cjs'\)/, '必须 require 接线层（别自己写落盘/广播顺序）');
  assert.match(source, /require\('\.\/pet-prefs\.cjs'\)/, '必须 require 偏好仓库（原子写与逐字段降级在里面）');
  assert.match(source, /builder\s*:\s*petMenu/, '接线器必须注入 petMenu 作为 builder');
  assert.match(source, /buildTrayItems|rebuildTray\(\)/, '托盘模板只能经接线器/构建器产生');
});

// ---------------------------------------------------------------- ③ 落盘路径必须在 CONFIG.userDataDir 下

test('落盘路径（静态）：pet-prefs.json 挂在 CONFIG.userDataDir 下，不许污染真 userData', () => {
  const source = readSource(LAUNCHER_FILE);
  assert.match(
    source,
    /path\.join\(CONFIG\.userDataDir,\s*'pet-prefs\.json'\)/,
    '偏好文件必须是 path.join(CONFIG.userDataDir, "pet-prefs.json")（不进真 userData）',
  );
  assert.equal(
    /app\.getPath\('userData'\)[\s\S]{0,40}pet-prefs\.json/.test(source),
    false,
    '偏好文件不许挂在 app.getPath("userData") 的推导链上（那是真 profile）',
  );
  // 启动器仍然要把 Electron 的 userData 指到同一处（否则 lxa:// 缓存与偏好分家）
  assert.match(source, /app\.setPath\('userData',\s*CONFIG\.userDataDir\)/, 'userData 必须指到 CONFIG.userDataDir');
});

test('落盘路径（真跑）：同一份路径与接线器确实能落盘、写后读回、勾选态跟随', () => {
  const dirname = path.join(FRONTEND_ROOT, 'electron');
  const config = LAUNCHER_CONFIG.resolveLauncherConfig({ dirname, env: {} });
  // 用真实 CONFIG.userDataDir 的**同级临时目录**（不写 .lingxi/tmp，避免污染工作区）
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-launcher-wiring-'));
  const filePath = path.join(tmpRoot, path.basename(path.dirname(config.userDataDir)), 'pet-prefs.json');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const store = createPrefsStore({ filePath });
    const traySpecs = [];
    const wiring = createPrefsWiring({
      store,
      builder: { buildTrayItems },
      isVisible: () => true,
      includePet: true,
      rebuildTray: (spec) => traySpecs.push(spec),
      actions: { showMain: () => {}, toggleVisible: () => {}, quitApp: () => {} },
      warn: () => {},
    });

    assert.equal(wiring.getPrefs().roam, true, '默认漫游开（U-M2）');
    const result = wiring.setPrefs({ roam: false });
    assert.equal(result.ok, true, `写盘必须成功（实际 problems=${JSON.stringify(result.problems)}）`);
    assert.equal(result.changed, true);

    assert.equal(fs.existsSync(filePath), true, '偏好文件必须真的落盘（这正是真机上从未生成的那个文件）');
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.roam, false, '磁盘内容必须与开关一致');
    assert.equal(store.read().prefs.roam, false, '写后读回一致（原子写生效）');

    assert.equal(traySpecs.length, 1, '每次变更必须重建一次托盘菜单（勾选态与事实对齐）');
    const roamItem = traySpecs[0].find((item) => item.label === MENU_LABELS.roam);
    assert.equal(roamItem.checked, false, '托盘勾选态必须跟着偏好走');
    const followItem = traySpecs[0].find((item) => item.label === MENU_LABELS.follow);
    assert.equal(followItem.checked, false, '未开启的开关必须是未勾选');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- ④ 静态：调用点 + 与生产对齐的其他细节

test('调用点（静态）：registerPetWindow 只被调用一次（多一处就是第二个装配路径）', () => {
  const source = readSource(LAUNCHER_FILE);
  const calls = source.split('registerPetWindow({').length - 1;
  assert.equal(calls, 1, `launcher 里有 ${calls} 处 registerPetWindow 调用：装配路径必须唯一`);
});

test('同源（静态）：launcher 与 main.cjs 都注入 builder: petMenu（托盘与右键同一份 spec 源）', () => {
  for (const [name, file] of [['pet-launcher.cjs', LAUNCHER_FILE], ['main.cjs', MAIN_FILE]]) {
    const source = readSource(file);
    assert.match(source, /builder\s*:\s*petMenu/, `${name} 必须把 petMenu 作为 builder 注入接线器`);
    assert.match(source, /require\('\.\/pet-menu\.cjs'\)/, `${name} 必须 require pet-menu.cjs`);
  }
});

test('同源（真跑）：buildTrayItems 在两个调用点给出同一份开关段（勾选态只由 prefs 派生）', () => {
  const prefs = { version: 1, follow: true, roam: false };
  const actions = { showMain: () => {}, toggleVisible: () => {}, quitApp: () => {} };
  const spec = buildTrayItems({ prefs, isVisible: true, includePet: true, actions });
  const byId = new Map(spec.filter((item) => typeof item.id === 'string').map((item) => [item.id, item]));
  assert.equal(byId.get(MENU_IDS.FOLLOW).checked, true, '跟随开 ⇒ 勾上');
  assert.equal(byId.get(MENU_IDS.ROAM).checked, false, '漫游关 ⇒ 不勾');
  // 打包版（includePet:false）一个桌宠项都不该有
  const packaged = buildTrayItems({ prefs, isVisible: true, includePet: false, actions });
  assert.equal(
    packaged.some((item) => item.id === MENU_IDS.FOLLOW || item.id === MENU_IDS.ROAM),
    false,
    'includePet:false 时不许出现任何桌宠开关（打包版语义）',
  );
});
