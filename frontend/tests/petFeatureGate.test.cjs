/**
 * 桌宠暴露门禁单测（node:test，不启动 Electron）。
 *
 * <p><b>守的是什么：</b>用户硬约束 #3——"桌宠只在开发链可见，安装版不得出现桌宠入口"。
 * 这条约束的失败形态不是崩溃，而是<b>装好的应用里冒出一个透明小窗</b>，
 * 而且只要有人手滑在 `main.cjs` 里把 `pet.show()` 挪出门禁，它就会静默复现。
 * 所以这里守两层：</p>
 * <ol>
 *   <li><b>行为</b>：`resolvePetExposure` 的真值表（安装版恒关且 env 不得覆盖 / 开发态默认开 / `LX_PET=0` 可关）；</li>
 *   <li><b>结构</b>：静态扫描 `main.cjs`，要求 `require('./pet-window.cjs')`、
 *       `require('./lx-protocol.cjs')` 与托盘「显示桌宠」都只出现在 `petExposure.enabled` 的分支里。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND_ROOT = path.join(__dirname, '..');

/**
 * 按相对路径读文本。
 *
 * @param {string} relativePath 相对 frontend 的路径
 * @returns {string} 文件内容
 */
function read(relativePath) {
  return fs.readFileSync(path.join(FRONTEND_ROOT, relativePath), 'utf8');
}

const gate = require(path.join(FRONTEND_ROOT, 'electron', 'pet-feature-gate.cjs'));

/**
 * 去掉源码里的注释（保留字符串字面量，行号不变）。
 *
 * <p>口径与 `tests/petDevEndpoint.test.cjs` 的 `stripComments` 一致：注释里提到
 * `pet.html` / `pet-window.cjs` 是说明，不算违规；代码里的字符串字面量才是硬编码。</p>
 *
 * @param {string} source 源码文本
 * @returns {string} 去掉注释后的文本
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  let quote = '';
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '\n' && (quote === '"' || quote === "'")) quote = '';
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next === undefined ? '' : next;
        index += 2;
        continue;
      }
      if (ch === quote) quote = '';
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 找某个记号在**代码**里出现的行号，并要求每处邻域都含门禁变量（邻域断言）。
 *
 * @param {string} source 源码
 * @param {string} needle 要找的记号（如 `./pet-window.cjs`）
 * @param {number} window 邻域半径（行）
 * @param {string} gateSymbol 必须出现在邻域里的门禁变量名
 * @returns {{hits: number[], offenders: string[]}} 命中行号与违规行
 */
function findUngatedOccurrences(source, needle, window, gateSymbol) {
  const lines = stripComments(source).split('\n');
  const hits = [];
  const offenders = [];
  lines.forEach((line, index) => {
    if (!line.includes(needle)) return;
    hits.push(index + 1);
    const from = Math.max(0, index - window);
    const to = Math.min(lines.length - 1, index + window);
    let gated = false;
    for (let cursor = from; cursor <= to; cursor += 1) {
      if (lines[cursor].includes(gateSymbol)) {
        gated = true;
        break;
      }
    }
    if (!gated) offenders.push(`第 ${index + 1} 行：${line.trim()}`);
  });
  return { hits, offenders };
}

test('真值表 1/4：安装版恒关（reason=packaged）', () => {
  const exposure = gate.resolvePetExposure({ isPackaged: true, env: {} });
  assert.equal(exposure.enabled, false, '安装版必须不暴露桌宠');
  assert.equal(exposure.reason, gate.PET_EXPOSURE_REASON.PACKAGED);
});

test('真值表 2/4：安装版 env 不得覆盖（LX_PET=1 也打不开）', () => {
  for (const value of ['1', 'true', 'on', 'yes', '']) {
    const exposure = gate.resolvePetExposure({ isPackaged: true, env: { LX_PET: value } });
    assert.equal(exposure.enabled, false, `安装版被 LX_PET=${JSON.stringify(value)} 打开了：这条硬约束失效`);
    assert.equal(exposure.reason, gate.PET_EXPOSURE_REASON.PACKAGED);
  }
});

test('真值表 3/4：开发态默认开（与今天行为一致）', () => {
  const exposure = gate.resolvePetExposure({ isPackaged: false, env: {} });
  assert.equal(exposure.enabled, true, '开发态必须默认开启（dev 链是 M1 唯一的验收口径）');
  assert.equal(exposure.reason, gate.PET_EXPOSURE_REASON.DEV);
  // 未打包 + 明确写 1 也是开
  assert.equal(gate.resolvePetExposure({ isPackaged: false, env: { LX_PET: '1' } }).enabled, true);
});

test('真值表 4/4：开发态 LX_PET=0 可关（大小写不敏感）', () => {
  for (const env of [{ LX_PET: '0' }, { lx_pet: '0' }, { LX_PET: ' OFF ' }]) {
    const exposure = gate.resolvePetExposure({ isPackaged: false, env });
    assert.equal(exposure.enabled, false, `开发态 ${JSON.stringify(env)} 应关闭桌宠`);
    assert.equal(exposure.reason, gate.PET_EXPOSURE_REASON.ENV_OFF);
  }
});

test('resolvePetExposure：参数缺失/畸形时不抛且按开发态开', () => {
  assert.equal(gate.resolvePetExposure().enabled, true, '缺省调用应按开发态处理（不能因为读不到 env 就静默关掉）');
  assert.equal(gate.resolvePetExposure({}).enabled, true);
  assert.equal(gate.resolvePetExposure({ isPackaged: 'true' }).enabled, true, 'isPackaged 只认真布尔 true');
  assert.equal(gate.resolvePetExposure(null).enabled, true);
});

test('createDisabledPet：所有方法可安全调用，且与 pet-window 同形状', () => {
  const disabled = gate.createDisabledPet();
  const expected = ['create', 'show', 'hide', 'toggle', 'isVisible', 'destroy', 'onVisibilityChange', 'statePath'];
  for (const key of expected) {
    assert.ok(key in disabled, `空对象缺少 ${key}：下游调用点会 TypeError`);
  }
  assert.equal(disabled.show(), false, 'show() 必须返回 false（main.cjs 用 !!pet.show() 判成败）');
  assert.equal(disabled.create(), false);
  assert.equal(disabled.isVisible(), false);
  assert.equal(disabled.hide(), undefined);
  assert.equal(disabled.toggle(), undefined);
  assert.equal(disabled.destroy(), undefined);
  assert.equal(typeof disabled.onVisibilityChange(() => {}), 'function', 'onVisibilityChange 必须返回取消函数');
  assert.equal(disabled.statePath, '');
});

test('createDisabledPet：每个方法重复调用都不抛（启动/退出路径不允许因门禁崩溃）', () => {
  const disabled = gate.createDisabledPet();
  assert.doesNotThrow(() => {
    for (let round = 0; round < 3; round += 1) {
      disabled.show();
      disabled.hide();
      disabled.toggle();
      disabled.isVisible();
      disabled.destroy();
      disabled.onVisibilityChange();
      disabled.onVisibilityChange(null);
    }
  });
});

test('静态扫描：pet-window / lx-protocol / 托盘「显示桌宠」都只出现在门禁分支里', () => {
  const source = read('electron/main.cjs');
  const petWindow = findUngatedOccurrences(source, './pet-window.cjs', 3, 'petExposure.enabled');
  assert.ok(petWindow.hits.length > 0, 'main.cjs 里找不到 require(\'./pet-window.cjs\')：结构已变，请同步本测试');
  assert.deepEqual(petWindow.offenders, [], `桌宠窗口模块被无条件 require（安装版也会加载桌宠代码）：\n${petWindow.offenders.join('\n')}`);

  const protocol = findUngatedOccurrences(source, './lx-protocol.cjs', 3, 'petExposure.enabled');
  assert.ok(protocol.hits.length > 0, 'main.cjs 里找不到 require(\'./lx-protocol.cjs\')：结构已变，请同步本测试');
  assert.deepEqual(protocol.offenders, [], `lxa:// 协议被无条件 require：\n${protocol.offenders.join('\n')}`);

  // 前提变了（M3 T04）：托盘菜单的文案与勾选态搬到了 electron/pet-menu.cjs，
  // main.cjs 不再持有任何 label 字面量。所以这条从"文案要出现在门禁分支里"
  // 改成**更严**的两条：① main.cjs 代码里不许再有桌宠菜单文案（单一真源）；
  // ② 桌宠段的出现与否必须由门禁变量绑定（`includePet: petExposure.enabled`），
  //    安装版靠这条得到"零桌宠菜单项"（行为断言见 tests/petPrefsWiring.test.cjs W12）。
  for (const label of ['显示桌宠', '跟随鼠标', '自由漫游']) {
    assert.equal(
      stripComments(source).includes(label),
      false,
      `main.cjs 代码里出现了菜单文案「${label}」：文案必须只有 pet-menu.cjs 一份（M3 T04 的单一真源）`,
    );
  }
  const includePet = findUngatedOccurrences(source, 'includePet:', 3, 'petExposure.enabled');
  assert.ok(includePet.hits.length > 0, 'main.cjs 里找不到 includePet 绑定：结构已变，请同步本测试');
  assert.deepEqual(includePet.offenders, [], `桌宠菜单段没有绑定门禁：安装版会出现桌宠入口\n${includePet.offenders.join('\n')}`);
  assert.match(source, /builder:\s*petMenu/, '托盘 spec 必须由 pet-menu.cjs（唯一构建器）产出');

  // 门禁关闭时必须真的用空对象兜底（否则 pet 会是 undefined，下游 5 处调用全崩）
  assert.match(
    source,
    /:\s*createDisabledPet\(\)/,
    '门禁关闭时的兜底必须是 createDisabledPet()（pet 不能是 undefined）',
  );
  assert.match(source, /const petExposure = resolvePetExposure\(\{ isPackaged: app\.isPackaged \}\)/, '门禁必须由 app.isPackaged 驱动');
});

test('静态扫描器自证：门禁外的写法必须被抓到', () => {
  const ungated = [
    "const pet = require('./pet-window.cjs').registerPetWindow({ ipcMain, isDev, frontendRoot });",
  ].join('\n');
  assert.equal(findUngatedOccurrences(ungated, './pet-window.cjs', 3, 'petExposure.enabled').offenders.length, 1);

  const gated = [
    'const pet = petExposure.enabled',
    "  ? require('./pet-window.cjs').registerPetWindow({ ipcMain })",
    '  : createDisabledPet();',
  ].join('\n');
  assert.deepEqual(findUngatedOccurrences(gated, './pet-window.cjs', 3, 'petExposure.enabled').offenders, []);

  // 注释里的提及不算违规
  const commented = "// 曾经：const pet = require('./pet-window.cjs')";
  assert.equal(findUngatedOccurrences(commented, './pet-window.cjs', 3, 'petExposure.enabled').hits.length, 0);
});
