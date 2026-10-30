/**
 * 全局字号门禁（S4）：**禁止新增硬编码字号** + `useFontScale` 行为单测。
 *
 * <p><b>为什么要有这个门禁：</b>字号令牌（`text-lx-fs-*` / `--lx-font-size-*`）的存在意义是让
 * 「全局字号缩放」改一个变量就整体生效。只要有人再写一处 `text-[12px]`，那一处就会在用户放大字号时
 * 纹丝不动——视觉上表现为「局部不跟着变」，而且这种缺陷极难被 review 发现。所以把「残留硬编码字号」
 * 白名单钉死在这里：集合只允许缩小或平移，任何新增都会让本文件变红。</p>
 *
 * <p><b>白名单为什么精确到「文件 + 字面量」：</b>若只断言总数不超过 N，删掉一处旧的再加一处新的
 * 就能绕过（总数不变）。按「文件 + 字面量」成对锚定后，新增必然表现为「多出一项」，无法用删除旧项抵消。</p>
 *
 * <p><b>关于 `useFontScale` 的模块隔离：</b>该模块是模块级单例，且 `import` 时就会读 localStorage、
 * 可能写文档根变量。因此每个用例都用「带 query 串的动态 import」拿一份全新实例（Node 的 ESM loader
 * 按完整 URL 缓存，`?case=n` 不同即为不同模块），再配合全局 `document` / `localStorage` 桩模拟运行时。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextTick } from 'vue';
import { FONT_SCALE_PRESETS } from '../src/utils/enum';

/** 前端源码根目录（守卫的扫描面）。 */
const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** 扫描后缀：字号可能写在 SFC 模板 / TS 常量 / 样式表里。 */
const SCANNED_EXTENSIONS: readonly string[] = ['.vue', '.ts', '.css'];

/** 任意值工具类：`text-[12.5px]`。 */
const TEXT_ARBITRARY_SIZE_PATTERN = /text-\[(\d+(?:\.\d+)?)px\]/g;
/** CSS 声明：`font-size: 26px`（允许冒号两侧空白）。 */
const FONT_SIZE_DECLARATION_PATTERN = /font-size\s*:\s*(\d+(?:\.\d+)?)px/g;

/**
 * 已知遗留的硬编码字号白名单（S4 之后的存量，**只许减不许增**）。
 *
 * <p>这 8 处都是「小数档」或「无对应整数档」的字号，S3 迁移时按「无对应令牌档位就保留 px」的口径
 * 原样留下；`BatchModelsForm` 的 26px/15px 是表单标题与输入区的手工排版，同样没有可比拟的令牌档位。
 * 它们写在这里是为了「可见且可回收」：将来为它们补出档位时，删掉对应行即可，而不是散落在源码里无人知晓。</p>
 */
const HARDCODED_FONT_SIZE_WHITELIST: readonly string[] = [
  // 小数档：15px 比 14px(xl) 大、比 16px(2xl) 小，无对应令牌
  'components/chat/DelegatedTaskMessage.vue::text-[15px]',
  // 小数档：13.5px 介于 lg(13px) 与 xl(14px) 之间
  'components/chat/PlanCard.vue::text-[13.5px]',
  // 小数档：过程流工具行的 12.5px / 11.5px
  'components/chat/process/ToolCallRenderer.vue::text-[11.5px]',
  'components/chat/process/ToolCallRenderer.vue::text-[12.5px]',
  // 小数档：选题卡内两处 13.5px
  'components/chat/RequireChoiceCard.vue::text-[13.5px]',
  'components/chat/RequireChoiceCard.vue::text-[13.5px]',
  // 表单手工排版：26px 弹层标题、15px 输入区
  'views/settings/tabs/BatchModelsForm.vue::font-size:15px',
  'views/settings/tabs/BatchModelsForm.vue::font-size:26px',
  // 桌宠窗口是独立入口（pet.html 不加载主题令牌层），字号拿不到 --lx-font-size-*，
  // 故这 4 处是文档化例外：改这里的数值不影响主应用，也请勿把主应用的 text-lx-fs-* 混进来
  'pet/pet.css::font-size:10px',
  'pet/pet.css::font-size:11px',
  'pet/pet.css::font-size:12px',
  'pet/pet.css::font-size:13px'
];

/** 扫描面下界：当前 249 个文件。下界断言用来防「遍历空转却报 0 处命中」的假绿。 */
const MIN_SCANNED_FILE_COUNT = 200;

/** 一条命中记录：`相对路径::字面量`。 */
type HardcodedFontSizeHit = string;

/**
 * 剥掉注释。
 *
 * <p>注释里会写「例如 `text-[12px]`」这种说明文字，不剥掉就会把说明当成真实违规。</p>
 *
 * @param text 原始文本
 * @returns 去掉块注释与 HTML 注释后的文本
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

/**
 * 从一个文本里抽出所有硬编码字号字面量。
 *
 * @param text 文件正文（未剥注释亦可，内部会剥）
 * @returns 形如 `text-[12px]` / `font-size:26px` 的字面量列表
 */
const scanHardcodedFontSizes = (text: string): string[] => {
  const body = stripComments(text);
  const found: string[] = [];
  for (const match of body.matchAll(TEXT_ARBITRARY_SIZE_PATTERN)) {
    found.push(`text-[${match[1]}px]`);
  }
  for (const match of body.matchAll(FONT_SIZE_DECLARATION_PATTERN)) {
    found.push(`font-size:${match[1]}px`);
  }
  return found;
};

/**
 * 递归收集 `src` 下需要扫描的文件（统一用 posix 分隔符，避免 Windows 反斜杠让白名单失配）。
 *
 * @param directory 起始目录
 * @returns 相对 `src` 的文件路径列表
 */
const collectScannedFiles = (directory: string): string[] => {
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectScannedFiles(fullPath));
      continue;
    }
    if (!SCANNED_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
      continue;
    }
    collected.push(path.relative(SRC_ROOT, fullPath).split(path.sep).join('/'));
  }
  return collected;
};

/** 全量扫描结果。 */
interface FontSizeScanResult {
  /** 形如 `components/chat/PlanCard.vue::text-[13.5px]` 的命中集合（已排序） */
  readonly hits: readonly HardcodedFontSizeHit[];
  /** 实际扫描到的文件数 */
  readonly scannedFileCount: number;
}

/**
 * 扫描整个 `src` 目录，产出硬编码字号命中集合。
 *
 * @returns 命中集合与扫描文件数
 */
const scanSourceTree = (): FontSizeScanResult => {
  const hits: HardcodedFontSizeHit[] = [];
  const files = collectScannedFiles(SRC_ROOT);
  for (const relativeFile of files) {
    const absoluteFile = path.join(SRC_ROOT, relativeFile.split('/').join(path.sep));
    const text = readFileSync(absoluteFile, 'utf8');
    for (const literal of scanHardcodedFontSizes(text)) {
      hits.push(`${relativeFile}::${literal}`);
    }
  }
  return { hits: hits.sort(), scannedFileCount: files.length };
};

/** 排序后的白名单副本（比较用）。 */
const sortedWhitelist = (): readonly string[] => [...HARDCODED_FONT_SIZE_WHITELIST].sort();

// ─────────────────────────────────────────────────────────────────────────────
// A. 禁止新增硬编码字号（守卫）
// ─────────────────────────────────────────────────────────────────────────────

test('A-0 金丝雀：扫描器能从合成样本里认出两类硬编码字号', () => {
  const sample = [
    '<div class="text-[12px] leading-5">甲</div>',
    '<span class="text-[13.5px]">乙</span>',
    '<style>.title { font-size: 26px; } .body { font-size:15px }</style>'
  ].join('\n');
  assert.deepEqual(
    scanHardcodedFontSizes(sample),
    ['text-[12px]', 'text-[13.5px]', 'font-size:26px', 'font-size:15px'],
    '扫描器必须能命中合成样本，否则后面的「0 处新增」是假绿'
  );
});

test('A-1 金丝雀：扫描器不会把注释里的示例当违规，也不会误伤令牌类名', () => {
  const sample = [
    '/* 历史写法：text-[12px] 已迁移为 text-lx-fs-md */',
    '<!-- 旧版 font-size:13px 已删除 -->',
    '<div class="text-lx-fs-sm text-lx-fs-2xs">丙</div>'
  ].join('\n');
  assert.deepEqual(scanHardcodedFontSizes(sample), [], '注释与令牌类名都不该被算作硬编码字号');
});

test('A-2 扫描面自证：确实遍历到了源码树（防遍历空转）', () => {
  const result = scanSourceTree();
  assert.ok(
    result.scannedFileCount >= MIN_SCANNED_FILE_COUNT,
    `扫描到的文件数 ${result.scannedFileCount} 少于下界 ${MIN_SCANNED_FILE_COUNT}，说明遍历或后缀过滤坏了`
  );
});

test('A-3 守卫：src 下的硬编码字号集合必须与白名单逐项相等（新增即红）', () => {
  const result = scanSourceTree();
  const actual = result.hits;
  const expected = sortedWhitelist();
  const added = actual.filter(hit => !expected.includes(hit));
  const removed = expected.filter(hit => !actual.includes(hit));
  const detail = [
    `新增（禁止）：${added.length === 0 ? '无' : added.join('、')}`,
    `减少（已在白名单里消失，请同步收窄白名单）：${removed.length === 0 ? '无' : removed.join('、')}`,
    `当前命中总数：${actual.length}（白名单 ${expected.length}）`
  ].join('\n');
  assert.deepEqual(actual, expected, `硬编码字号集合与白名单不一致：\n${detail}`);
  assert.ok(
    actual.length <= HARDCODED_FONT_SIZE_WHITELIST.length,
    `硬编码字号总数 ${actual.length} 超过白名单上限 ${HARDCODED_FONT_SIZE_WHITELIST.length}`
  );
});

test('A-4 白名单里的文件必须仍然存在（防路径漂移让白名单静默失配）', () => {
  const declaredFiles = [...new Set(HARDCODED_FONT_SIZE_WHITELIST.map(hit => hit.split('::')[0]))];
  assert.ok(declaredFiles.length > 0, '白名单文件集合不能为空');
  for (const relativeFile of declaredFiles) {
    const absoluteFile = path.join(SRC_ROOT, relativeFile.split('/').join(path.sep));
    assert.ok(existsSync(absoluteFile), `白名单指向的文件不存在：${relativeFile}（改名后请同步白名单）`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B. useFontScale 行为（模块级单例，逐用例隔离）
// ─────────────────────────────────────────────────────────────────────────────

/** 与 `useFontScale.ts` 约定一致的期望值：测试里显式写死，才能发现契约被悄悄改动。 */
const EXPECTED_STORAGE_KEY = 'lingxi-font-scale';
const EXPECTED_DEFAULT_SCALE = 1;
const EXPECTED_MIN_SCALE = 0.875;
const EXPECTED_MAX_SCALE = 1.5;
const FONT_SCALE_VAR = '--lx-font-scale';

/** 被测模块的导出形态（仅类型，运行时不产生 import 副作用）。 */
type FontScaleModule = typeof import('../src/composables/useFontScale');

/** 假的 `documentElement.style`：只记录 CSS 变量，足够覆盖本模块的读写口径。 */
class FakeStyleDeclaration {
  private readonly properties = new Map<string, string>();

  /**
   * 写入变量。
   * @param name 变量名
   * @param value 变量值
   */
  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  /**
   * 读取变量。
   * @param name 变量名
   * @returns 未设置时返回空串（与真实 DOM 一致）
   */
  getPropertyValue(name: string): string {
    const value = this.properties.get(name);
    return value === undefined ? '' : value;
  }

  /**
   * 删除变量。
   * @param name 变量名
   */
  removeProperty(name: string): void {
    this.properties.delete(name);
  }

  /** 当前已写入的变量名集合（断言「零写入」时用）。 */
  getWrittenPropertyNames(): string[] {
    return [...this.properties.keys()].sort();
  }
}

/** 假的 localStorage（Web Storage 的最小实现）。 */
class FakeLocalStorage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  /**
   * 读取键。
   * @param key 键名
   * @returns 值，或 null
   */
  getItem(key: string): string | null {
    const value = this.data.get(key);
    return value === undefined ? null : value;
  }

  /**
   * 写入键。
   * @param key 键名
   * @param value 值
   */
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  /**
   * 删除键。
   * @param key 键名
   */
  removeItem(key: string): void {
    this.data.delete(key);
  }

  /** 清空（用例之间复用实例时使用）。 */
  clear(): void {
    this.data.clear();
  }

  /**
   * 按序号取键名。
   * @param index 序号
   * @returns 键名，或 null
   */
  key(index: number): string | null {
    const keys = [...this.data.keys()];
    return index < keys.length ? keys[index] : null;
  }
}

/** 一次 DOM 沙箱：暴露桩对象，并提供还原入口。 */
interface DomSandbox {
  readonly style: FakeStyleDeclaration;
  readonly storage: FakeLocalStorage;
  restore: () => void;
}

/**
 * 把 `document` / `window` / `localStorage` 桩装到全局。
 *
 * <p>参数 `persisted` 用于模拟「上次会话留下的偏好」，是首帧镜像路径的输入。</p>
 *
 * @param persisted 预置到 localStorage 的原始字符串（`null` 表示不预置）
 * @returns 沙箱句柄
 */
const installDomSandbox = (persisted: string | null = null): DomSandbox => {
  const style = new FakeStyleDeclaration();
  const storage = new FakeLocalStorage();
  if (persisted !== null) {
    storage.setItem(EXPECTED_STORAGE_KEY, persisted);
  }
  const documentStub = {
    documentElement: { style },
    readyState: 'complete',
    addEventListener: (): void => {
      // 模块只在 readyState === 'loading' 时挂监听；这里给 'complete'，桩实现保持空转
    }
  };
  const windowStub = { addEventListener: (): void => {} };
  const globals = globalThis as unknown as Record<string, unknown>;
  const savedDocument = globals.document;
  const savedWindow = globals.window;
  const savedStorage = globals.localStorage;

  const restoreKey = (key: string, value: unknown): void => {
    if (value === undefined) {
      delete globals[key];
      return;
    }
    globals[key] = value;
  };

  globals.document = documentStub;
  globals.window = windowStub;
  globals.localStorage = storage;

  return {
    style,
    storage,
    restore: (): void => {
      restoreKey('document', savedDocument);
      restoreKey('window', savedWindow);
      restoreKey('localStorage', savedStorage);
    }
  };
};

/** 动态 import 的序号：每个用例取一个新的 query 串，保证拿到全新模块实例。 */
let fontScaleModuleSequence = 0;

/**
 * 载入一份全新的 `useFontScale` 模块实例。
 *
 * @returns 独立实例的模块命名空间
 */
const loadFontScaleModule = async (): Promise<FontScaleModule> => {
  fontScaleModuleSequence += 1;
  const specifier = `../src/composables/useFontScale?case=${fontScaleModuleSequence}`;
  return (await import(/* @vite-ignore */ specifier)) as FontScaleModule;
};

/** 在一次沙箱生命周期内跑用例：装桩 → 载入模块 → 执行 → 还原。 */
interface SandboxRun {
  readonly module: FontScaleModule;
  readonly sandbox: DomSandbox;
}

/**
 * 在沙箱内准备一个全新的模块实例。
 *
 * @param persisted 预置的持久化值（`null` 表示空 localStorage）
 * @returns 模块与沙箱
 */
const withFreshFontScale = async (persisted: string | null = null): Promise<SandboxRun> => {
  const sandbox = installDomSandbox(persisted);
  const module = await loadFontScaleModule();
  return { module, sandbox };
};

test('B-1 默认态零写入：不写 --lx-font-scale、不写 localStorage、applied=false', async () => {
  const { module, sandbox } = await withFreshFontScale(null);
  try {
    assert.equal(sandbox.style.getPropertyValue(FONT_SCALE_VAR), '', '默认态不得写入 --lx-font-scale（写 1 也算写）');
    assert.deepEqual(sandbox.style.getWrittenPropertyNames(), [], '默认态一个变量都不该写');
    assert.equal(sandbox.storage.getItem(EXPECTED_STORAGE_KEY), null, '默认态不得在 localStorage 留下镜像键');
    assert.equal(module.isDocumentVariablesApplied(), false, '默认态应报告「变量未写入」');

    const api = module.useFontScale();
    assert.equal(api.scale.value, EXPECTED_DEFAULT_SCALE, '默认缩放必须是 1');
    assert.equal(api.isDefault.value, true, '默认态 isDefault 应为 true');
    assert.equal(api.preset.value, 'MEDIUM', '默认缩放对应 MEDIUM 档');

    // 反复设成默认档也不该产生任何写入
    api.setScale(EXPECTED_DEFAULT_SCALE);
    await nextTick();
    assert.equal(sandbox.style.getPropertyValue(FONT_SCALE_VAR), '', '重复设置默认档后仍不得写入变量');
    assert.equal(sandbox.storage.getItem(EXPECTED_STORAGE_KEY), null, '重复设置默认档后仍不得写入镜像键');
    assert.equal(module.isDocumentVariablesApplied(), false, '重复设置默认档后 applied 仍为 false');
  } finally {
    sandbox.restore();
  }
});

test('B-2 setScale 越界夹紧到 [0.875, 1.5]，非档位值不被改写', async () => {
  const { module, sandbox } = await withFreshFontScale(null);
  try {
    const api = module.useFontScale();

    api.setScale(9);
    await nextTick();
    assert.equal(api.scale.value, EXPECTED_MAX_SCALE, '超过上限应夹紧到 1.5');
    assert.equal(sandbox.style.getPropertyValue(FONT_SCALE_VAR), '1.5', '夹紧后的值应写入变量');

    api.setScale(0.1);
    await nextTick();
    assert.equal(api.scale.value, EXPECTED_MIN_SCALE, '低于下限应夹紧到 0.875');
    assert.equal(sandbox.style.getPropertyValue(FONT_SCALE_VAR), '0.875', '夹紧后的下界值应写入变量');

    api.setScale(0.95);
    await nextTick();
    assert.equal(api.scale.value, 0.95, '区间内的自由值应原样保留（不被吸附到最近档位）');
    assert.equal(api.preset.value, null, '非档位值应报告 preset 为 null');
    assert.equal(module.isDocumentVariablesApplied(), true, '非默认档应报告变量已写入');
  } finally {
    sandbox.restore();
  }
});

test('B-3 非法值与 NaN 一律回落默认档 1', async () => {
  const { module, sandbox } = await withFreshFontScale(null);
  try {
    const api = module.useFontScale();
    api.setScale(1.125);
    await nextTick();
    assert.equal(api.scale.value, 1.125, '前置：先进入非默认档');

    const illegalValues: number[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const illegal of illegalValues) {
      api.setScale(illegal);
      await nextTick();
      assert.equal(api.scale.value, EXPECTED_DEFAULT_SCALE, `非法值 ${String(illegal)} 应回落默认档 1`);
      assert.equal(sandbox.style.getPropertyValue(FONT_SCALE_VAR), '', `非法值 ${String(illegal)} 落下后不应再写变量`);
      assert.equal(sandbox.storage.getItem(EXPECTED_STORAGE_KEY), null, `非法值 ${String(illegal)} 落下后不应保留镜像键`);
      api.setScale(1.125);
      await nextTick();
    }

    // 字符串形态的脏数据同样回落默认档（后端/localStorage 都可能给字符串）
    api.setScale('abc' as unknown as number);
    await nextTick();
    assert.equal(api.scale.value, EXPECTED_DEFAULT_SCALE, '非数字字符串应回落默认档');
  } finally {
    sandbox.restore();
  }
});

test('B-4 setPreset(LARGE) 写 1.125；reset() 删变量且删镜像键', async () => {
  const { module, sandbox } = await withFreshFontScale(null);
  try {
    const api = module.useFontScale();

    api.setPreset('LARGE');
    await nextTick();
    assert.equal(api.scale.value, 1.125, 'LARGE 档应映射为 1.125');
    assert.equal(sandbox.style.getPropertyValue(FONT_SCALE_VAR), '1.125', 'LARGE 档应写入变量 1.125');
    assert.equal(sandbox.storage.getItem(EXPECTED_STORAGE_KEY), '1.125', '非默认档应写入镜像键');
    assert.equal(module.isDocumentVariablesApplied(), true, 'LARGE 档应报告变量已写入');

    api.reset();
    await nextTick();
    assert.equal(api.scale.value, EXPECTED_DEFAULT_SCALE, 'reset 后应回到默认档');
    assert.equal(sandbox.style.getPropertyValue(FONT_SCALE_VAR), '', 'reset 后变量应被 removeProperty 清掉');
    assert.deepEqual(sandbox.style.getWrittenPropertyNames(), [], 'reset 后不应残留任何写入过的变量');
    assert.equal(sandbox.storage.getItem(EXPECTED_STORAGE_KEY), null, 'reset 后应删除 localStorage 镜像键');
    assert.equal(module.isDocumentVariablesApplied(), false, 'reset 后应报告变量未写入');
  } finally {
    sandbox.restore();
  }
});

test('B-5 PRESET_SCALE 四档映射与档位枚举单一真源一致', async () => {
  const { module, sandbox } = await withFreshFontScale(null);
  try {
    assert.deepEqual(
      { ...module.PRESET_SCALE },
      { SMALL: 0.875, MEDIUM: 1, LARGE: 1.125, X_LARGE: 1.25 },
      '四档映射必须与产品口径一致'
    );
    assert.deepEqual([...module.useFontScale().presets], [...FONT_SCALE_PRESETS], '档位列表必须取自 utils/enum 的单一真源');

    const api = module.useFontScale();
    for (const preset of FONT_SCALE_PRESETS) {
      api.setPreset(preset);
      await nextTick();
      assert.equal(api.scale.value, module.PRESET_SCALE[preset], `档位 ${preset} 应映射为 ${module.PRESET_SCALE[preset]}`);
      assert.equal(api.preset.value, preset, `档位 ${preset} 设置后应能回读为同一档位`);
      const expectedWritten = module.PRESET_SCALE[preset] === EXPECTED_DEFAULT_SCALE ? '' : String(module.PRESET_SCALE[preset]);
      assert.equal(
        sandbox.style.getPropertyValue(FONT_SCALE_VAR),
        expectedWritten,
        `档位 ${preset} 的变量写入值与「默认档零写入」口径不一致`
      );
    }

    assert.equal(module.MIN_FONT_SCALE, EXPECTED_MIN_SCALE, 'MIN_FONT_SCALE 契约值变了');
    assert.equal(module.MAX_FONT_SCALE, EXPECTED_MAX_SCALE, 'MAX_FONT_SCALE 契约值变了');
    assert.equal(module.DEFAULT_FONT_SCALE, EXPECTED_DEFAULT_SCALE, 'DEFAULT_FONT_SCALE 契约值变了');
  } finally {
    sandbox.restore();
  }
});

test('B-6 localStorage 镜像键 lingxi-font-scale 的读写口径', async () => {
  // 键名契约：index.html 的首帧脚本写死同一个字符串，改名会让首帧闪烁回归
  const first = await withFreshFontScale(null);
  try {
    assert.equal(first.module.FONT_SCALE_STORAGE_KEY, EXPECTED_STORAGE_KEY, '镜像键名必须是 lingxi-font-scale');
  } finally {
    first.sandbox.restore();
  }

  // 读：预置合法值 → 启动即恢复，并写变量（首帧镜像路径）
  const seeded = await withFreshFontScale('1.125');
  try {
    const api = seeded.module.useFontScale();
    assert.equal(api.scale.value, 1.125, '启动时应从 localStorage 恢复偏好');
    assert.equal(seeded.sandbox.style.getPropertyValue(FONT_SCALE_VAR), '1.125', '非默认偏好应在启动时写入变量');
    assert.equal(seeded.module.isDocumentVariablesApplied(), true, '恢复非默认偏好后应报告变量已写入');
  } finally {
    seeded.sandbox.restore();
  }

  // 读：越界值 → 夹紧后再用
  const clamped = await withFreshFontScale('9');
  try {
    assert.equal(clamped.module.useFontScale().scale.value, EXPECTED_MAX_SCALE, '持久化值越界应在读取时夹紧');
  } finally {
    clamped.sandbox.restore();
  }

  // 读：脏数据 / 空串 → 回落默认档，且不写变量
  for (const dirty of ['abc', '', '   ', 'null']) {
    const dirtyRun = await withFreshFontScale(dirty);
    try {
      assert.equal(dirtyRun.module.useFontScale().scale.value, EXPECTED_DEFAULT_SCALE, `脏数据 "${dirty}" 应回落默认档`);
      assert.equal(dirtyRun.sandbox.style.getPropertyValue(FONT_SCALE_VAR), '', `脏数据 "${dirty}" 不应导致变量写入`);
    } finally {
      dirtyRun.sandbox.restore();
    }
  }

  // 写：非默认档写字符串形态，默认档删键（不写 '1'）
  const writeRun = await withFreshFontScale(null);
  try {
    const api = writeRun.module.useFontScale();
    api.setScale(1.25);
    await nextTick();
    assert.equal(writeRun.sandbox.storage.getItem(EXPECTED_STORAGE_KEY), '1.25', '非默认档应写入字符串形态的倍数');
    api.setScale(EXPECTED_DEFAULT_SCALE);
    await nextTick();
    assert.equal(writeRun.sandbox.storage.getItem(EXPECTED_STORAGE_KEY), null, '默认档应删除镜像键而不是写 "1"');
  } finally {
    writeRun.sandbox.restore();
  }
});
