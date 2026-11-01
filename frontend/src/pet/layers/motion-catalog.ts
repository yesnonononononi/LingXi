/**
 * 动作目录：`frontend/pet-motions.json` 的类型、校验与配方派生。
 *
 * <p><b>它解决什么：</b>以前"一个动作要多久、抢多高优先级、顺带切哪个表情"写死在
 * `command-router.ts` 的 `MOTION_RECIPES` 里，改一个数字要改代码、重新构建；
 * 现在这些数值是**数据**（`pet-motions.json`），代码只是消费方。</p>
 *
 * <p><b>等值迁移怎么保证不回归（M2 的验收条件）：</b>{@link deriveMotionRecipes} 的规则是
 * "目录里有的用目录值，没有的用 {@link BUILTIN_MOTION_RECIPES}"。首版目录逐字复制了
 * 原来的 9 条配方，因此 `deriveMotionRecipes(首版目录)` 与内置表**深度相等**；
 * 更极端地，`deriveMotionRecipes(空目录)` 也必须深度相等——这两条都被
 * `tests/petMotionCompiler.test.ts` 钉住，任一处漂移都会红。</p>
 *
 * <p><b>本模块是纯数据 + 纯函数，不碰 DOM、不读时钟、不读随机</b>（设计文档 §8 共享知识第 4、5 条）。</p>
 *
 * @module pet/layers/motion-catalog
 */
import catalogSource from '../../../pet-motions.json';
import {
  MOTION_IDS,
  isExpressionId,
  isMotionId,
  isPriority,
  type ExpressionId,
  type LayerId,
  type MotionId,
  type Priority,
} from '../presentation/types';

/** 可被关键帧驱动的 CSS 属性白名单。 */
export type MotionProperty = 'rotate' | 'translateX' | 'translateY' | 'scale' | 'opacity';

/** 属性白名单（顺序即报错时的提示顺序）。 */
export const MOTION_PROPERTIES: readonly MotionProperty[] = ['rotate', 'translateX', 'translateY', 'scale', 'opacity'];

/** 允许的指令层（与 `presentation/types.ts` 的 `LayerId` 一致）。 */
export const MOTION_LAYERS: readonly LayerId[] = ['base', 'transient', 'ambient'];

/** 一个关键帧（时间用 0..1 的归一化比例，与 `@keyframes` 百分比同构）。 */
export interface Keyframe {
  /** 归一化时间点，0 = 起点，1 = 终点。 */
  readonly at: number;
  /** 数值（单位由轨道 `unit` 或属性默认值决定）。 */
  readonly value: number;
}

/** 延迟跟随：编译期把源轨关键帧的时间轴环移 `lagMs`、幅值乘 `gain`。 */
export interface FollowSpec {
  /** 源信号名（如 `bodySway`、`bodyTilt`），只用于排障与将来的耦合）。 */
  readonly source: string;
  /** 滞后毫秒数（正数 = 拖在后面）。 */
  readonly lagMs: number;
  /** 幅值增益（0..2）。 */
  readonly gain: number;
  /** 滞后上限（毫秒），防止目录里写出比动作本身还长的滞后。 */
  readonly maxLagMs: number;
}

/** 弹簧：编译期采样成 N 帧带过冲的曲线（零 rAF）。 */
export interface SpringSpec {
  /** 刚度（0..1，越大越快）。 */
  readonly stiffness: number;
  /** 阻尼（0..1，越大越不弹）。 */
  readonly damping: number;
  /** 质量（正数）。 */
  readonly mass: number;
}

/** 一条轨道（一层的一个属性）。 */
export interface MotionTrack {
  /** 目标层 id（来自层清单，**不枚举**）。 */
  readonly layerId: string;
  /** 属性。 */
  readonly property: MotionProperty;
  /** 单位（`deg` / `px` / 空串）；缺省按属性推导。 */
  readonly unit?: string;
  /** 缓动（CSS `animation-timing-function` 语法）；缺省 `ease-out`。 */
  readonly ease?: string;
  /** 镜像源层 id（复制其关键帧，方向由美术层自身决定）。 */
  readonly mirror?: string;
  /** 延迟跟随（与 `spring` 互斥）。 */
  readonly follow?: FollowSpec;
  /** 弹簧（与 `follow` 互斥）。 */
  readonly spring?: SpringSpec;
  /** 采样帧数（仅 `spring` 有意义，缺省取目录 `defaults.samples`）。 */
  readonly samples?: number;
  /** 关键帧（至少 2 个，`at` 严格递增，首项 0）。 */
  readonly keyframes: readonly Keyframe[];
}

/** 一个动作的目录项。 */
export interface MotionDef {
  /** 动作 id（与目录键一致，冗余存放便于遍历）。 */
  readonly id: string;
  /** 优先级（打断规则仍由 `priority.ts` 判定，这里只是数值）。 */
  readonly priority: Priority;
  /** 动作时长（毫秒）；`null` = 循环。 */
  readonly durationMs: number | null;
  /** 是否循环。 */
  readonly loop: boolean;
  /** 指令层。 */
  readonly layer: LayerId;
  /** 同时要切的表情（`null` = 不切）。 */
  readonly expression: { readonly id: ExpressionId; readonly durationMs: number } | null;
  /** 轨道列表。 */
  readonly tracks: readonly MotionTrack[];
}

/** 目录默认值。 */
export interface MotionCatalogDefaults {
  /** 弹簧采样帧数。 */
  readonly samples: number;
  /** 延迟跟随的滞后上限（毫秒）。 */
  readonly maxLagMs: number;
  /** 默认角度单位。 */
  readonly unit: string;
}

/** 动作目录。 */
export interface MotionCatalog {
  /** 目录版本。 */
  readonly version: number;
  /** 默认值。 */
  readonly defaults: MotionCatalogDefaults;
  /** 动作表（键 = 动作 id）。 */
  readonly motions: Readonly<Record<string, MotionDef>>;
}

/**
 * 动作配方：一条"动作"要多久、抢多高优先级、顺带切哪个表情。
 *
 * <p>字段与 `command-router.ts` 原来的 `MotionRecipe` **逐字相同**（导出名也从那里再导出，
 * 保证既有引用不改）。</p>
 */
export interface MotionRecipe {
  /** 动作本身的持续时间（毫秒）；`null` = 循环/不限时（idle、drag）。 */
  readonly motionMs: number | null;
  /** 动作优先级。 */
  readonly priority: Priority;
  /** 动作是否循环。 */
  readonly loop: boolean;
  /** 同时要切的表情。 */
  readonly expression: ExpressionId | null;
  /** 表情持续时长（毫秒）；动作没有表情时为 `null`。 */
  readonly expressionMs: number | null;
}

/**
 * 内置配方表（今天 `MOTION_RECIPES` 的**冻结副本**）。
 *
 * <p>它是回退基线：目录缺失/缺项时全量走它，于是"删掉 `pet-motions.json`"就是一个安全的回退开关。</p>
 */
export const BUILTIN_MOTION_RECIPES: Readonly<Record<MotionId, MotionRecipe>> = Object.freeze({
  idle: Object.freeze({ motionMs: null, priority: 0, loop: true, expression: null, expressionMs: null }),
  tap: Object.freeze({ motionMs: 480, priority: 1, loop: false, expression: 'happy', expressionMs: 900 }),
  happy: Object.freeze({ motionMs: 900, priority: 1, loop: false, expression: 'happy', expressionMs: 900 }),
  angry: Object.freeze({ motionMs: 800, priority: 1, loop: false, expression: 'angry', expressionMs: 800 }),
  surprised: Object.freeze({ motionMs: 600, priority: 1, loop: false, expression: 'surprised', expressionMs: 600 }),
  sleepy: Object.freeze({ motionMs: 1600, priority: 0, loop: false, expression: 'sleepy', expressionMs: 1600 }),
  sad: Object.freeze({ motionMs: 1200, priority: 0, loop: false, expression: 'sad', expressionMs: 1200 }),
  drag: Object.freeze({ motionMs: null, priority: 2, loop: true, expression: null, expressionMs: null }),
  wake: Object.freeze({ motionMs: 500, priority: 2, loop: false, expression: 'surprised', expressionMs: 600 }),
} as Record<MotionId, MotionRecipe>) as Readonly<Record<MotionId, MotionRecipe>>;

/** 空目录（结构合法但没有任何动作）。 */
export const EMPTY_MOTION_CATALOG: MotionCatalog = Object.freeze({
  version: 1,
  defaults: Object.freeze({ samples: 12, maxLagMs: 320, unit: 'deg' }),
  motions: Object.freeze({} as Record<string, MotionDef>),
}) as MotionCatalog;

/**
 * 判断是否是允许的层名。
 *
 * @param value 待判断值
 * @returns 是否合法
 */
function isMotionLayer(value: unknown): value is LayerId {
  return typeof value === 'string' && (MOTION_LAYERS as readonly string[]).includes(value);
}

/**
 * 判断是否是允许的属性。
 *
 * @param value 待判断值
 * @returns 是否合法
 */
function isMotionProperty(value: unknown): value is MotionProperty {
  return typeof value === 'string' && (MOTION_PROPERTIES as readonly string[]).includes(value);
}

/**
 * 判断是否是有限数值。
 *
 * @param value 待判断值
 * @returns 是否为有限数值
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 校验关键帧序列。
 *
 * @param keyframes 关键帧（不可信）
 * @param path 定位串
 * @param problems 问题收集器
 */
function validateKeyframes(keyframes: unknown, path: string, problems: string[]): void {
  if (!Array.isArray(keyframes) || keyframes.length < 2) {
    problems.push(`${path} 至少需要 2 个关键帧`);
    return;
  }
  let previous = -1;
  keyframes.forEach((frame, index) => {
    if (!frame || typeof frame !== 'object') {
      problems.push(`${path}[${index}] 必须是对象`);
      return;
    }
    const record = frame as Record<string, unknown>;
    if (!isFiniteNumber(record.at) || record.at < 0 || record.at > 1) {
      problems.push(`${path}[${index}].at 必须落在 0..1，实际为 ${String(record.at)}`);
    } else {
      if (record.at <= previous) problems.push(`${path}[${index}].at 必须严格递增（实际 ${record.at} ≤ ${previous}）`);
      previous = record.at;
    }
    if (!isFiniteNumber(record.value)) problems.push(`${path}[${index}].value 必须是有限数值`);
  });
  const first = keyframes[0] as Record<string, unknown> | undefined;
  if (first && isFiniteNumber(first.at) && first.at !== 0) problems.push(`${path} 首帧 at 必须为 0，实际为 ${first.at}`);
}

/**
 * 校验轨道。
 *
 * @param tracks 轨道列表（不可信）
 * @param path 定位串
 * @param defaults 目录默认值
 * @param problems 问题收集器
 */
function validateTracks(tracks: unknown, path: string, defaults: MotionCatalogDefaults, problems: string[]): void {
  if (!Array.isArray(tracks)) {
    problems.push(`${path} 必须是数组`);
    return;
  }
  const layerIds = new Set<string>();
  tracks.forEach((track, index) => {
    if (track && typeof track === 'object') {
      const record = track as Record<string, unknown>;
      if (typeof record.layerId === 'string') layerIds.add(record.layerId);
    } else {
      problems.push(`${path}[${index}] 必须是对象`);
    }
  });
  tracks.forEach((track, index) => {
    const trackPath = `${path}[${index}]`;
    if (!track || typeof track !== 'object') return;
    const record = track as Record<string, unknown>;
    if (typeof record.layerId !== 'string' || record.layerId.length === 0) {
      problems.push(`${trackPath}.layerId 必须是非空字符串`);
    }
    if (!isMotionProperty(record.property)) {
      problems.push(`${trackPath}.property 只允许 ${MOTION_PROPERTIES.join(' / ')}，实际为 ${String(record.property)}`);
    }
    if (record.unit !== undefined && typeof record.unit !== 'string') {
      problems.push(`${trackPath}.unit 必须是字符串`);
    }
    if (record.ease !== undefined && typeof record.ease !== 'string') {
      problems.push(`${trackPath}.ease 必须是字符串`);
    }
    if (record.mirror !== undefined) {
      if (typeof record.mirror !== 'string') problems.push(`${trackPath}.mirror 必须是层 id 字符串`);
      else if (!layerIds.has(record.mirror)) {
        problems.push(`${trackPath}.mirror 指向的层 ${record.mirror} 不在同一动作的轨道里`);
      } else if (record.mirror === record.layerId) {
        problems.push(`${trackPath}.mirror 不得指向自己（会自激）`);
      }
    }
    if (record.follow !== undefined && record.spring !== undefined) {
      problems.push(`${trackPath} 同时出现 follow 与 spring：语义叠加不可预测，只允许二选一`);
    }    if (record.follow !== undefined) {
      const follow = record.follow as Record<string, unknown>;
      if (!follow || typeof follow !== 'object') {
        problems.push(`${trackPath}.follow 必须是对象`);
      } else {
        if (typeof follow.source !== 'string' || follow.source.length === 0) {
          problems.push(`${trackPath}.follow.source 必须是非空字符串`);
        }
        if (!isFiniteNumber(follow.lagMs) || follow.lagMs < 0 || follow.lagMs > defaults.maxLagMs) {
          problems.push(`${trackPath}.follow.lagMs 必须落在 0..${defaults.maxLagMs}`);
        }
        if (!isFiniteNumber(follow.gain) || follow.gain < 0 || follow.gain > 2) {
          problems.push(`${trackPath}.follow.gain 必须落在 0..2`);
        }
      }
    }
    if (record.spring !== undefined) {
      const spring = record.spring as Record<string, unknown>;
      if (!spring || typeof spring !== 'object') {
        problems.push(`${trackPath}.spring 必须是对象`);
      } else {
        for (const key of ['stiffness', 'damping', 'mass']) {
          if (!isFiniteNumber(spring[key]) || (spring[key] as number) <= 0) {
            problems.push(`${trackPath}.spring.${key} 必须是正数`);
          }
        }
      }
      if (record.samples !== undefined) {
        if (!isFiniteNumber(record.samples) || (record.samples as number) < 3 || (record.samples as number) > 64) {
          problems.push(`${trackPath}.samples 必须落在 3..64`);
        }
      }
    }
    // 镜像轨道的关键帧来自源轨道，不需要自己写（见 design §1.7 的 `mirror` 语义）
    if (record.mirror === undefined) {
      validateKeyframes(record.keyframes, `${trackPath}.keyframes`, problems);
    }
  });
}

/**
 * 校验整份动作目录（**不抛异常**，返回人话问题列表）。
 *
 * <p>规则见设计文档 §1.7：时长与循环自洽、关键帧递增、属性白名单、`spring`/`follow` 互斥、
 * `mirror` 指向同动作内的层、每个历史 `MotionId` 都能解析到。</p>
 *
 * @param catalog 待校验值（不可信）
 * @returns 问题列表（空 = 合法）
 */
export function validateCatalog(catalog: unknown): string[] {
  const problems: string[] = [];
  if (!catalog || typeof catalog !== 'object') return ['动作目录必须是对象'];
  const source = catalog as Record<string, unknown>;
  if (source.version !== 1) problems.push(`version 必须为 1，实际为 ${String(source.version)}`);

  const defaultsRaw = source.defaults as Record<string, unknown> | undefined;
  const defaults: MotionCatalogDefaults = {
    samples: isFiniteNumber(defaultsRaw?.samples) ? (defaultsRaw?.samples as number) : 12,
    maxLagMs: isFiniteNumber(defaultsRaw?.maxLagMs) ? (defaultsRaw?.maxLagMs as number) : 320,
    unit: typeof defaultsRaw?.unit === 'string' ? (defaultsRaw?.unit as string) : 'deg',
  };
  if (!isFiniteNumber(defaultsRaw?.samples) || defaults.samples < 3 || defaults.samples > 64) {
    problems.push('defaults.samples 必须落在 3..64');
  }
  if (!isFiniteNumber(defaultsRaw?.maxLagMs) || defaults.maxLagMs <= 0) {
    problems.push('defaults.maxLagMs 必须是正数');
  }
  if (typeof defaultsRaw?.unit !== 'string' || defaults.unit.length === 0) {
    problems.push('defaults.unit 必须是非空字符串');
  }

  const motions = source.motions;
  if (!motions || typeof motions !== 'object' || Array.isArray(motions)) {
    problems.push('motions 必须是对象（键 = 动作 id）');
    return problems;
  }

  for (const [id, value] of Object.entries(motions as Record<string, unknown>)) {
    const path = `motions.${id}`;
    if (!isMotionId(id)) {
      problems.push(`${path}: 未知动作 id（只允许 ${MOTION_IDS.join(' / ')}）`);
    }
    if (!value || typeof value !== 'object') {
      problems.push(`${path} 必须是对象`);
      continue;
    }
    const def = value as Record<string, unknown>;
    if (def.id !== undefined && def.id !== id) {
      problems.push(`${path}.id 与键不一致（actual=${String(def.id)}）`);
    }
    if (!isPriority(def.priority)) {
      problems.push(`${path}.priority 只允许 0 / 1 / 2，实际为 ${String(def.priority)}`);
    }
    if (typeof def.loop !== 'boolean') problems.push(`${path}.loop 必须是布尔值`);
    const durationMs = def.durationMs;
    if (durationMs !== null && (!isFiniteNumber(durationMs) || durationMs <= 0)) {
      problems.push(`${path}.durationMs 必须是正数或 null，实际为 ${String(durationMs)}`);
    }
    if (def.loop === true && durationMs !== null) {
      problems.push(`${path} loop=true 时 durationMs 必须为 null（循环动作没有总时长）`);
    }
    if (!isMotionLayer(def.layer)) {
      problems.push(`${path}.layer 只允许 ${MOTION_LAYERS.join(' / ')}，实际为 ${String(def.layer)}`);
    }
    const expression = def.expression;
    if (expression !== null && expression !== undefined) {
      if (typeof expression !== 'object') {
        problems.push(`${path}.expression 必须是对象或 null`);
      } else {
        const record = expression as Record<string, unknown>;
        if (!isExpressionId(record.id)) {
          problems.push(`${path}.expression.id 不是合法表情，实际为 ${String(record.id)}`);
        }
        if (!isFiniteNumber(record.durationMs) || (record.durationMs as number) <= 0) {
          problems.push(`${path}.expression.durationMs 必须是正数`);
        }
      }
    }
    validateTracks(def.tracks, `${path}.tracks`, defaults, problems);
  }

  // 每个历史动作都必须出现在目录里：缺项虽然能回退内置表，但那会让"改目录"变成静默无效，
  // 也会让"把 tap 改没了"这种事故毫无提示（设计文档 §1.7 第 6 条）
  for (const id of MOTION_IDS) {
    if (!Object.prototype.hasOwnProperty.call(motions, id)) {
      problems.push(`motions 缺少动作 ${id}（目录必须完整，缺项只能整体回退内置表）`);
    }
  }

  return problems;
}

/**
 * 安全加载：结构非法时回落**空目录**（= 全量走内置表，行为等于今天）并记日志。
 *
 * @param raw 原始 JSON 值
 * @param log 日志出口（缺省静默）
 * @returns 可用的目录
 */
export function loadMotionCatalog(raw: unknown, log: (message: string) => void = () => {}): MotionCatalog {
  const problems = validateCatalog(raw);
  if (problems.length === 0) return normalizeMotionCatalog(raw);
  log(`[pet] 动作目录非法，已回落内置配方表（动作行为不变）: ${problems.join('; ')}`);
  return EMPTY_MOTION_CATALOG;
}

/**
 * 把合法 JSON 转成强类型目录（调用前请先 {@link validateCatalog}）。
 *
 * @param raw 原始 JSON 值
 * @returns 强类型目录（深拷贝，调用方改不动原始 JSON 模块）
 */
export function normalizeMotionCatalog(raw: unknown): MotionCatalog {
  const source = raw as Record<string, unknown>;
  const defaultsRaw = (source.defaults ?? {}) as Record<string, unknown>;
  const motionsRaw = (source.motions ?? {}) as Record<string, Record<string, unknown>>;
  const motions: Record<string, MotionDef> = {};
  for (const [id, def] of Object.entries(motionsRaw)) {
    const expressionRaw = def.expression as Record<string, unknown> | null | undefined;
    const tracks = (Array.isArray(def.tracks) ? def.tracks : []).map((track): MotionTrack => {
      const record = track as Record<string, unknown>;
      const followRaw = record.follow as Record<string, unknown> | undefined;
      const springRaw = record.spring as Record<string, unknown> | undefined;
      const keyframes = (Array.isArray(record.keyframes) ? record.keyframes : []).map((frame): Keyframe => {
        const item = frame as Record<string, unknown>;
        return { at: item.at as number, value: item.value as number };
      });
      return {
        layerId: record.layerId as string,
        property: record.property as MotionProperty,
        unit: record.unit as string | undefined,
        ease: record.ease as string | undefined,
        mirror: record.mirror as string | undefined,
        follow: followRaw
          ? {
              source: followRaw.source as string,
              lagMs: followRaw.lagMs as number,
              gain: followRaw.gain as number,
              maxLagMs: isFiniteNumber(followRaw.maxLagMs) ? (followRaw.maxLagMs as number) : (defaultsRaw.maxLagMs as number),
            }
          : undefined,
        spring: springRaw
          ? {
              stiffness: springRaw.stiffness as number,
              damping: springRaw.damping as number,
              mass: springRaw.mass as number,
            }
          : undefined,
        samples: isFiniteNumber(record.samples) ? (record.samples as number) : undefined,
        keyframes,
      };
    });
    motions[id] = {
      id,
      priority: def.priority as Priority,
      durationMs: def.durationMs === null || def.durationMs === undefined ? null : (def.durationMs as number),
      loop: def.loop === true,
      layer: def.layer as LayerId,
      expression:
        expressionRaw && isExpressionId(expressionRaw.id)
          ? { id: expressionRaw.id, durationMs: expressionRaw.durationMs as number }
          : null,
      tracks,
    };
  }
  return {
    version: source.version as number,
    defaults: {
      samples: defaultsRaw.samples as number,
      maxLagMs: defaultsRaw.maxLagMs as number,
      unit: defaultsRaw.unit as string,
    },
    motions,
  };
}

/** 运行时动作目录（由 `frontend/pet-motions.json` 校验而来）。 */
export const MOTION_CATALOG: MotionCatalog = loadMotionCatalog(catalogSource, (message) => console.warn(message));

/**
 * 从目录派生动作配方表（**等值迁移的核心**）。
 *
 * <p>规则只有两条：目录里有的动作用目录值；没有的用 {@link BUILTIN_MOTION_RECIPES}。
 * 因此"空目录"与"首版目录"派生的结果都必须与内置表深度相等。</p>
 *
 * @param catalog 动作目录（缺省用运行时目录）
 * @returns 动作 id → 配方（新对象，可安全持有）
 */
export function deriveMotionRecipes(catalog: MotionCatalog = MOTION_CATALOG): Readonly<Record<MotionId, MotionRecipe>> {
  const recipes = {} as Record<MotionId, MotionRecipe>;
  for (const id of MOTION_IDS) {
    const def = catalog?.motions?.[id];
    if (!def) {
      recipes[id] = { ...BUILTIN_MOTION_RECIPES[id] };
      continue;
    }
    recipes[id] = {
      motionMs: def.durationMs,
      priority: def.priority,
      loop: def.loop,
      expression: def.expression?.id ?? null,
      expressionMs: def.expression?.durationMs ?? null,
    };
  }
  return recipes;
}
