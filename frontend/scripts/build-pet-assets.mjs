#!/usr/bin/env node
/**
 * 桌宠资产管线：母版 → 运行时 @1x/@2x → 资产清单 `src/pet/assets/manifest.ts`。
 *
 * <p><b>为什么必须流水化：</b>母版是 1024×1536 / 1.97MB 的 PNG，直接进 `public/` 会让桌宠窗口
 * 每次启动读 2MB、解码 6MB 纹理。<b>母版只留在 `docs/`，运行时只放降采样后的 WebP。</b></p>
 *
 * <p><b>源目录可配置（不许硬编码）：</b>美术资产可能落在暂存区（`.lingxi/assets/pet`）也可能
 * 迁到入库位置（`docs/assets/desktop-pet/v3`），路径会变、代码不该跟着改。优先级：</p>
 * <ol>
 *   <li>`--source <dir>` 命令行参数；</li>
 *   <li>`PET_ASSET_SOURCE` 环境变量；</li>
 *   <li>默认 `docs/assets/desktop-pet/v2`（当前入库的 v2 母版）。</li>
 * </ol>
 *
 * <p><b>容忍源不完整：</b>美术可能只交了立绘、还没交 8 张表情贴片。此时脚本打印清晰提示并
 * <b>优雅退出</b>（缺立绘 → 退出码 1 并给出缺哪个文件；缺贴片 → 退出码 0，清单里 `expressions`
 * 留空）。绝不允许抛未捕获异常。</p>
 *
 * <p><b>`sharp` 是可选构建期依赖：</b>可用则转码；不可用则退化为"只校验已有产物"，
 * 并打出明确的安装提示（**不是静默跳过**）。产物缺失且没有 sharp 时直接失败。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/build-pet-assets.mjs                      # 转码 + 生成清单
 *   node scripts/build-pet-assets.mjs --source ../../.lingxi/assets/pet
 *   node scripts/build-pet-assets.mjs --check               # 只校验（不转码）
 * </pre>
 *
 * @module scripts/build-pet-assets
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_ASPECT, ASPECT_TOLERANCE, FRONTEND_ROOT, GEOMETRY_PATH, readJsonFile } from './build-pet-geometry.mjs';
import { readImageSize } from './check-pet-geometry.mjs';

/** 脚本所在目录。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认源目录（相对 `frontend/`）：当前入库的 v2 母版位置。 */
export const DEFAULT_SOURCE_DIR = resolve(FRONTEND_ROOT, '..', 'docs', 'assets', 'desktop-pet', 'v2');

/** 美术暂存区（已知的候选位置；只用于提示，不自动采用）。 */
export const KNOWN_STAGING_DIR = resolve(FRONTEND_ROOT, '..', '.lingxi', 'assets', 'pet');

/** 运行时输出目录（相对 `frontend/`，落在 `public/` 以便 Vite 原样复制、`lxa://` 直接可读）。 */
export const DEFAULT_OUT_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-v2');

/** 清单文件路径（生成物，入库）。 */
export const MANIFEST_PATH = resolve(FRONTEND_ROOT, 'src', 'pet', 'assets', 'manifest.ts');

/** 母版文件名。 */
export const MASTER_FILE_NAME = 'front-standing.png';

/** 两档密度：与设计文档 §7.1 的预算一致（@2x 供 DPR2 显示，@1x 兜底）。 */
export const DENSITIES = [
  { id: '1x', suffix: '@1x', width: 160, height: 240, maxBytes: 40 * 1024 },
  { id: '2x', suffix: '@2x', width: 320, height: 480, maxBytes: 90 * 1024 },
];

/** WebP 编码参数（质量与体积的折中）。 */
export const WEBP_OPTIONS = { quality: 88, alphaQuality: 100, effort: 6 };

/** 表情贴片候选文件名前缀（美术规格书 §5 用 E1–E8 编号，也允许直接用 id 命名）。 */
export const EXPRESSION_IDS_ORDER = [
  'neutral',
  'blink',
  'happy',
  'shy',
  'angry',
  'sad',
  'surprised',
  'sleepy',
];

/** E 编号 → ExpressionId（美术规格书 §5 的对账表）。 */
export const EXPRESSION_FILE_ALIASES = {
  neutral: ['neutral', 'E1_default', 'E1_neutral'],
  blink: ['blink', 'E2_blink'],
  surprised: ['surprised', 'E3_surprised'],
  sad: ['sad', 'E4_sad'],
  angry: ['angry', 'E5_angry'],
  shy: ['shy', 'E6_shy'],
  happy: ['happy', 'E7_happy'],
  sleepy: ['sleepy', 'E8_sleepy'],
};

/**
 * 动态加载 `sharp`（可选依赖）。
 *
 * @returns {Promise<any | null>} sharp 模块；不可用时 null
 */
export async function loadSharp() {
  try {
    const module = await import('sharp');
    return module.default ?? module;
  } catch {
    return null;
  }
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 进程参数（不含 node 与脚本名）
 * @returns {{ source: string, out: string, check: boolean, verbose: boolean }}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  /**
   * 取某个开关的值。
   *
   * @param {string} name 开关名
   * @returns {string | null} 值
   */
  const valueOf = (name) => {
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    const prefixed = args.find((item) => item.startsWith(`${name}=`));
    return prefixed ? prefixed.slice(name.length + 1) : null;
  };
  const sourceArg = valueOf('--source') || process.env.PET_ASSET_SOURCE || '';
  const outArg = valueOf('--out') || process.env.PET_ASSET_OUT || '';
  return {
    source: sourceArg ? resolve(process.cwd(), sourceArg) : DEFAULT_SOURCE_DIR,
    out: outArg ? resolve(process.cwd(), outArg) : DEFAULT_OUT_DIR,
    check: args.includes('--check'),
    verbose: args.includes('--verbose'),
  };
}

/**
 * 读几何真源（裁剪用：断言运行时不小于立绘箱）。
 *
 * @returns {{ artWidth: number, artHeight: number }} 立绘箱尺寸
 */
export function readArtSize() {
  const geometry = readJsonFile(GEOMETRY_PATH);
  return { artWidth: Number(geometry.artWidth), artHeight: Number(geometry.artHeight) };
}

/**
 * 在源目录里找一个表情贴片（支持 `neutral.png` 与 `E1_default.png` 两种命名）。
 *
 * @param {string} sourceDir 源目录
 * @param {string} id 表情 id
 * @returns {string | null} 命中的文件绝对路径
 */
export function findExpressionFile(sourceDir, id) {
  const aliases = EXPRESSION_FILE_ALIASES[id] ?? [id];
  const candidates = [];
  for (const alias of aliases) {
    for (const ext of ['.png', '.webp']) {
      candidates.push(resolve(sourceDir, `${alias}${ext}`));
      candidates.push(resolve(sourceDir, 'expressions', `${alias}${ext}`));
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 校验一个产物的尺寸与体积。
 *
 * @param {string} filePath 产物路径
 * @param {{ width: number, height: number, maxBytes: number }} target 目标规格
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function verifyOutput(filePath, target) {
  const problems = [];
  if (!existsSync(filePath)) {
    problems.push(`产物不存在: ${filePath}`);
    return problems;
  }
  let size;
  try {
    size = readImageSize(filePath);
  } catch (err) {
    problems.push(`产物头解析失败: ${filePath}（${(err && err.message) || err}）`);
    return problems;
  }
  const aspect = size.width / size.height;
  if (Math.abs(aspect - ART_ASPECT) / ART_ASPECT > ASPECT_TOLERANCE) {
    problems.push(`${filePath} 宽高比 ${aspect.toFixed(4)} 不是 2:3`);
  }
  if (size.width !== target.width || size.height !== target.height) {
    problems.push(`${filePath} 尺寸 ${size.width}×${size.height} 与目标 ${target.width}×${target.height} 不一致`);
  }
  const bytes = statSync(filePath).size;
  if (bytes > target.maxBytes) {
    problems.push(`${filePath} 体积 ${bytes}B 超过预算 ${target.maxBytes}B`);
  }
  return problems;
}

/**
 * 用 sharp 把母版转成目标尺寸的 WebP。
 *
 * @param {any} sharp sharp 模块
 * @param {string} masterPath 母版路径
 * @param {string} outputPath 产物路径
 * @param {{ width: number, height: number }} target 目标尺寸
 * @returns {Promise<{ width: number, height: number, size: number }>} 产物信息
 */
export async function transcode(sharp, masterPath, outputPath, target) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const info = await sharp(masterPath)
    .resize(target.width, target.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp(WEBP_OPTIONS)
    .toFile(outputPath);
  return { width: info.width, height: info.height, size: info.size };
}

/**
 * 生成清单文件内容。
 *
 * @param {{ source: string, master: { file: string, width: number, height: number, bytes: number }, art: object[], expressions: object[] }} input 清单数据
 * @returns {string} `manifest.ts` 文本
 */
export function renderManifest(input) {
  const artEntries = input.art
    .map(
      (item) => `    {
      density: '${item.density}',
      file: '${item.file}',
      url: '${item.url}',
      width: ${item.width},
      height: ${item.height},
      bytes: ${item.bytes},
      format: '${item.format}',
    },`,
    )
    .join('\n');
  const expressionEntries = input.expressions
    .map(
      (item) => `    ${item.id}: {
      id: '${item.id}',
      file: '${item.file}',
      url: '${item.url}',
      width: ${item.width},
      height: ${item.height},
      bytes: ${item.bytes},
      format: '${item.format}',
    },`,
    )
    .join('\n');

  return `/**
 * 桌宠运行时资产清单（**生成物，勿手改**）。
 *
 * <p>由 \`frontend/scripts/build-pet-assets.mjs\` 从源目录
 * \`${input.source}\` 生成：\`npm run build:pet-assets\`。</p>
 *
 * <p>为什么要生成而不是手写：资产尺寸、体积、URL 三处必须一致，手写必然漂移；
 * 门禁 \`npm run gate:pet\` 校验资产头比例，\`tests/petAssetManifest.test.cjs\` 校验清单与磁盘一致。</p>
 *
 * @module pet/assets/manifest
 */
import type { ExpressionId } from '../presentation/types';

/** 一档运行时立绘。 */
export interface PetArtAsset {
  /** 密度标识（\`1x\` / \`2x\`）。 */
  readonly density: '1x' | '2x';
  /** 文件名（相对运行时目录）。 */
  readonly file: string;
  /** \`lxa://\` URL。 */
  readonly url: string;
  /** 像素宽度。 */
  readonly width: number;
  /** 像素高度。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** 容器格式。 */
  readonly format: string;
}

/** 一档表情差分贴片（与立绘同画布同位置）。 */
export interface PetExpressionAsset {
  /** 表情 id（与美术规格书 §5 的 E1–E8 对应）。 */
  readonly id: ExpressionId;
  /** 文件名。 */
  readonly file: string;
  /** \`lxa://\` URL。 */
  readonly url: string;
  /** 像素宽度。 */
  readonly width: number;
  /** 像素高度。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** 容器格式。 */
  readonly format: string;
}

/** 资产清单。 */
export interface PetAssetManifest {
  /** 清单结构版本。 */
  readonly version: number;
  /** 生成器标识（排障用）。 */
  readonly generatedBy: string;
  /** 母版信息（只用于对账，不进运行时）。 */
  readonly master: {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
  /** 运行时立绘（按密度）。 */
  readonly art: readonly PetArtAsset[];
  /** 表情贴片（未交付时为空表）。 */
  readonly expressions: Readonly<Partial<Record<ExpressionId, PetExpressionAsset>>>;
}

/** 运行时资产清单。 */
export const PET_ASSET_MANIFEST: PetAssetManifest = {
  version: 1,
  generatedBy: 'scripts/build-pet-assets.mjs',
  master: {
    file: '${input.master.file}',
    width: ${input.master.width},
    height: ${input.master.height},
    bytes: ${input.master.bytes},
  },
  art: [
${artEntries}
  ],
  expressions: {
${expressionEntries}
  },
};

/**
 * 取某个密度的立绘 URL。
 *
 * @param density 密度（缺省 \`2x\`）
 * @returns \`lxa://\` URL；该密度不存在时回落到 \`2x\`，再没有则返回空串
 */
export function petArtUrl(density: '1x' | '2x' = '2x'): string {
  const matched = PET_ASSET_MANIFEST.art.find((item) => item.density === density);
  if (matched) return matched.url;
  return PET_ASSET_MANIFEST.art[0]?.url ?? '';
}

/**
 * 表情贴片 URL 表（直接喂给 \`SpritePresentation\`）。
 *
 * @returns 表情 id → URL；未交付的档不会出现在表里
 */
export function expressionPatchUrls(): Partial<Record<ExpressionId, string>> {
  const result: Partial<Record<ExpressionId, string>> = {};
  for (const [id, asset] of Object.entries(PET_ASSET_MANIFEST.expressions)) {
    if (asset) result[id as ExpressionId] = asset.url;
  }
  return result;
}
`;
}

/**
 * 校验磁盘上的产物与已生成的清单是否一致（供测试与 `--check` 使用）。
 *
 * @param {{ out?: string, manifestPath?: string }} [options] 覆盖路径
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function verifyManifestAgainstDisk(options = {}) {
  const out = options.out ?? DEFAULT_OUT_DIR;
  const manifestPath = options.manifestPath ?? MANIFEST_PATH;
  const problems = [];
  if (!existsSync(manifestPath)) {
    problems.push(`清单文件不存在: ${manifestPath}`);
    return problems;
  }
  const manifestText = readFileSync(manifestPath, 'utf8');

  for (const density of DENSITIES) {
    const file = resolve(out, `front-standing${density.suffix}.webp`);
    problems.push(...verifyOutput(file, density));
    const url = `lxa://pet-v2/front-standing${density.suffix}.webp`;
    if (!manifestText.includes(url)) problems.push(`清单里缺少 ${density.id} 档 URL: ${url}`);
    const bytes = existsSync(file) ? statSync(file).size : -1;
    if (bytes > 0 && !manifestText.includes(`bytes: ${bytes},`)) {
      problems.push(`清单里 ${density.id} 档的体积与磁盘不一致（磁盘 ${bytes}B）`);
    }
  }

  // 清单声明的表情贴片必须真的存在（声明了却没文件 = 运行时会 404）
  const expressionUrls = [...manifestText.matchAll(/url: '(lxa:\/\/[^']*expressions?\/[^']*)'/g)].map((match) => match[1]);
  for (const url of expressionUrls) {
    const relativePath = url.replace(/^lxa:\/\//, '');
    const fileName = relativePath.split('/').slice(1).join('/');
    if (!existsSync(resolve(out, fileName))) {
      problems.push(`清单声明的表情贴片不存在: ${url}`);
    }
  }
  return problems;
}

/**
 * 主流程。
 *
 * @param {{ source: string, out: string, check: boolean, verbose: boolean }} options 运行选项
 * @returns {Promise<number>} 退出码
 */
export async function run(options) {
  const { source, out, check, verbose } = options;
  const log = (message) => console.log(`[pet-assets] ${message}`);

  if (!existsSync(source)) {
    console.error(`[pet-assets] 源目录不存在: ${source}`);
    if (existsSync(KNOWN_STAGING_DIR)) {
      console.error(`[pet-assets] 美术暂存区似乎已就绪，可指定: --source "${KNOWN_STAGING_DIR}"`);
    } else {
      console.error('[pet-assets] 请用 --source <dir> 指定母版目录，或先把美术资产入库到默认位置');
    }
    return 1;
  }

  const masterPath = resolve(source, MASTER_FILE_NAME);
  if (!existsSync(masterPath)) {
    console.error(`[pet-assets] 源目录缺少母版 ${MASTER_FILE_NAME}: ${source}`);
    console.error('[pet-assets] 已跳过（不生成产物、不改清单）；资产到位后重跑本脚本即可');
    return 1;
  }

  const masterSize = readImageSize(masterPath);
  const masterBytes = statSync(masterPath).size;
  if (verbose) log(`母版 ${masterPath}: ${masterSize.width}×${masterSize.height}, ${masterBytes}B`);

  const sharp = await loadSharp();
  const art = [];
  for (const density of DENSITIES) {
    const outputPath = resolve(out, `front-standing${density.suffix}.webp`);
    if (!check) {
      if (sharp) {
        if (verbose) log(`转码 ${density.id} → ${outputPath}`);
        await transcode(sharp, masterPath, outputPath, density);
      } else if (!existsSync(outputPath)) {
        console.error('[pet-assets] 既没有 sharp，产物也不存在，无法生成运行时立绘。');
        console.error('[pet-assets] 请任选其一：① npm install --no-save sharp 后重跑；② 用其它工具生成');
        console.error(`[pet-assets] 期望产物：${outputPath}`);
        return 1;
      } else {
        log(`⚠ 未检测到 sharp，跳过转码，仅校验已有产物: ${outputPath}`);
      }
    }
    const problems = verifyOutput(outputPath, density);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[pet-assets] ${problem}`);
      return 1;
    }
    const size = readImageSize(outputPath);
    art.push({
      density: density.id,
      file: `front-standing${density.suffix}.webp`,
      url: `lxa://pet-v2/front-standing${density.suffix}.webp`,
      width: size.width,
      height: size.height,
      bytes: statSync(outputPath).size,
      format: size.format,
    });
  }

  // 表情贴片：缺了不算失败（美术未交付时清单留空，表现层自动降级为立绘自带脸）
  const expressions = [];
  const missing = [];
  for (const id of EXPRESSION_IDS_ORDER) {
    const found = findExpressionFile(source, id);
    if (!found) {
      missing.push(id);
      continue;
    }
    const size = readImageSize(found);
    expressions.push({
      id,
      file: relative(out, found).split('\\').join('/'),
      url: `lxa://pet-v2/${relative(out, found).split('\\').join('/')}`,
      width: size.width,
      height: size.height,
      bytes: statSync(found).size,
      format: size.format,
    });
  }
  if (missing.length > 0) {
    log(`⚠ 表情贴片缺失 ${missing.length}/${EXPRESSION_IDS_ORDER.length}（${missing.join(', ')}）`);
    log('  表现层会自动降级：表情只改状态、保持立绘自带脸。贴片到位后重跑本脚本即可填充清单。');
  }

  if (check) {
    const problems = verifyManifestAgainstDisk({ out });
    for (const problem of problems) console.error(`[pet-assets] ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }

  const manifestText = renderManifest({
    source: relative(FRONTEND_ROOT, source).split('\\').join('/'),
    master: {
      file: MASTER_FILE_NAME,
      width: masterSize.width,
      height: masterSize.height,
      bytes: masterBytes,
    },
    art,
    expressions,
  });
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  const previous = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf8') : '';
  if (previous !== manifestText) {
    writeFileSync(MANIFEST_PATH, manifestText, 'utf8');
    log(`已更新清单: ${relative(FRONTEND_ROOT, MANIFEST_PATH)}`);
  } else {
    log('清单无变化');
  }
  for (const item of art) log(`产物 ${item.file}: ${item.width}×${item.height}, ${item.bytes}B`);
  return 0;
}

// 仅被直接执行时跑 CLI（被测试 import 时保持静默）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[pet-assets] 未预期异常: ${(err && err.message) || err}`);
      process.exit(1);
    });
}
