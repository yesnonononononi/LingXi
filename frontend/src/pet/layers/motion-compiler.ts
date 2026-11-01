/**
 * 动作编译器：动作目录的关键帧 → 一段 CSS 文本（纯函数，零 rAF）。
 *
 * <p><b>为什么不是逐帧 JS 动画：</b>现有渲染模型是"零 rAF + 四档功耗靠 CSS 时长乘数"，
 * 引 gsap / anime.js 会推翻这套模型，而且它们的产物无法在 node 里断言。把关键帧编译成
 * `@keyframes` 文本之后，动画完全跑在合成器上，成本从"每帧 JS"降到"一段字符串"，
 * 且编译器本身可单测、可变异。</p>
 *
 * <p><b>三种轨道怎么编译：</b></p>
 * <ul>
 *   <li>`mirror`：直接复制源轨的关键帧（左右方向由美术层自身镜像，不在这里取反）；</li>
 *   <li>`follow`：把关键帧的时间轴环移 `lagMs/duration`，幅值乘 `gain`
 *       （<b>环移而不是 `animation-delay`</b>：正延迟会让循环动画开头"停住 lagMs"，读成卡顿）；</li>
 *   <li>`spring`：按阻尼振荡采样成 N 帧，过冲靠采样而不是运行期积分。</li>
 * </ul>
 *
 * @module pet/layers/motion-compiler
 */
import type { Power } from '../power-policy';
import type { Keyframe, MotionCatalog, MotionDef, MotionProperty, MotionTrack, SpringSpec } from './motion-catalog';

/** 循环动作（`durationMs=null`）的编译时长（毫秒），与 `pet.css` 的呼吸周期同值。 */
export const DEFAULT_LOOP_DURATION_MS = 3600;

/** 默认缓动（与 `pet.css` 的动作默认一致）。 */
export const DEFAULT_TRACK_EASE = 'ease-out';

/**
 * 弹簧归一化的时间缩放。
 *
 * <p>不做缩放时，12 帧采样点会落在"还没稳定"的位置上，动画收尾会硬切。
 * 乘 3 让采样窗口内基本收敛（末帧回到目标值 ±2% 以内），同时保留中段可见的过冲。</p>
 */
export const SPRING_TIME_SCALE = 3;

/** 编译选项。 */
export interface CompileOptions {
  /** 功耗档：`low` 档时长 ×2（视觉降频，不降帧）。 */
  readonly power: Power;
  /** 系统是否要求减少动态效果（true → 不产出任何规则）。 */
  readonly reducedMotion: boolean;
  /** 选择器根（如 `#pet-root[data-motion='tap']`）。 */
  readonly selectorRoot: string;
  /**
   * 允许接受动画的层 id 白名单（缺省 = 不过滤）。
   *
   * <p><b>为什么需要它：</b>动作目录里的 `layerId` 是手写字符串，与层清单是两个文件。
   * 门禁（`gate:pet`）能在构建期挡住"轨道落在支撑层上"，但**运行期**没有第二道防线：
   * 用户装的是打包产物，一旦两者漂移，支撑层（底绘/遮挡片）会被转起来，露出补绘缝——
   * 这种故障在屏幕上极其隐蔽。传入 `animatableLayerIds()` 之后，落在非可动层上的轨道
   * 一律进 `unsupportedTracks` 并跳过，最坏情况是"某层不动"，而不是"某层露缝"。</p>
   */
  readonly allowedLayerIds?: readonly string[];
}

/** 编译结果。 */
export interface CompiledMotion {
  /** 动作 id。 */
  readonly id: string;
  /** 实际动画时长（毫秒）；`0` 表示不产出动画。 */
  readonly durationMs: number;
  /** 可直接写进 `<style>` 的规则（`@keyframes` 块与消费规则交替）。 */
  readonly cssRules: readonly string[];
  /** 无法编译的轨道（层名/属性非法、缺关键帧等；记日志用，不抛异常）。 */
  readonly unsupportedTracks: readonly string[];
}

/**
 * 把数值格式化成短小稳定的字符串（避免 `0.30000000000000004` 这类噪声进 CSS）。
 *
 * @param value 数值
 * @returns 最多 4 位小数、去掉尾随零
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10000) / 10000;
  // `-0` 会让 CSS 文本出现 `rotate(-0deg)`，归一化成 0
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * 取属性的默认单位。
 *
 * @param property 属性
 * @returns 单位（`deg` / `px` / 空串）
 */
export function defaultUnit(property: MotionProperty): string {
  if (property === 'rotate') return 'deg';
  if (property === 'translateX' || property === 'translateY') return 'px';
  return '';
}

/**
 * 把一帧的值转成一条 CSS 声明。
 *
 * @param property 属性
 * @param value 数值
 * @param unit 单位（空串 = 由属性决定）
 * @returns CSS 声明（不含分号之外的修饰）
 */
export function declarationOf(property: MotionProperty, value: number, unit: string): string {
  if (property === 'opacity') return `opacity: ${formatNumber(value)};`;
  if (property === 'scale') return `transform: scale(${formatNumber(value)});`;
  return `transform: ${property}(${formatNumber(value)}${unit});`;
}

/**
 * 在关键帧曲线上取值（分段线性，两端线性外插）。
 *
 * <p>外插是过冲的来源：弹簧采样点会越过末帧，如果钳制就变成"顶到就停"，读成硬直。</p>
 *
 * @param keyframes 关键帧（至少 1 个，`at` 升序）
 * @param at 归一化时间（可越界）
 * @returns 该时间的值
 */
export function evaluateCurve(keyframes: readonly Keyframe[], at: number): number {
  if (keyframes.length === 0) return 0;
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (at <= first.at) {
    if (keyframes.length === 1) return first.value;
    const second = keyframes[1];
    const span = second.at - first.at;
    if (span <= 0) return first.value;
    return first.value + ((at - first.at) * (second.value - first.value)) / span;
  }
  if (at >= last.at) {
    if (keyframes.length === 1) return last.value;
    const prev = keyframes[keyframes.length - 2];
    const span = last.at - prev.at;
    if (span <= 0) return last.value;
    return last.value + ((at - last.at) * (last.value - prev.value)) / span;
  }
  for (let index = 1; index < keyframes.length; index += 1) {
    const right = keyframes[index];
    if (at > right.at) continue;
    const left = keyframes[index - 1];
    const span = right.at - left.at;
    if (span <= 0) return right.value;
    return left.value + ((at - left.at) * (right.value - left.value)) / span;
  }
  return last.value;
}

/**
 * 延迟跟随：环移时间轴并乘增益。
 *
 * @param keyframes 源关键帧（`at` 升序，首项 0）
 * @param lagRatio 滞后占比（`lagMs / duration`，0..1）
 * @param gain 幅值增益
 * @returns 环移后的关键帧（首项 0、末项 1，可直接进 `@keyframes`）
 */
export function wrapKeyframes(keyframes: readonly Keyframe[], lagRatio: number, gain: number): Keyframe[] {
  if (keyframes.length === 0) return [];
  const ratio = Math.min(1, Math.max(0, Number.isFinite(lagRatio) ? lagRatio : 0));
  if (ratio === 0) {
    const scaled = keyframes.map((frame) => ({ at: frame.at, value: frame.value * gain }));
    if (scaled[scaled.length - 1].at < 1) scaled.push({ at: 1, value: scaled[0].value });
    return scaled;
  }
  // 末帧与首帧同值（闭合），环移后会与位于 `ratio` 的帧重叠，先丢弃
  const body = keyframes.filter((frame) => frame.at < 1);
  const shifted = body
    .map((frame) => ({
      at: Math.round(((frame.at + ratio) % 1) * 1e6) / 1e6,
      value: frame.value * gain,
    }))
    .sort((left, right) => left.at - right.at);
  if (shifted.length === 0) return [{ at: 0, value: 0 }, { at: 1, value: 0 }];
  if (shifted[0].at > 0) {
    // 环移后开头缺一段：用环上"紧邻 0 点之前"的那一帧补上（环移是首尾相接的）
    shifted.unshift({ at: 0, value: shifted[shifted.length - 1].value });
  }
  shifted.push({ at: 1, value: shifted[0].value });
  return shifted;
}

/**
 * 弹簧采样：把阻尼振荡的进度曲线映射到关键帧上，得到 N 帧带过冲的序列。
 *
 * @param keyframes 基础关键帧（描述"往哪儿摆"）
 * @param spring 弹簧参数
 * @param samples 采样帧数（≥3）
 * @returns 采样后的关键帧（首项 0、末项 1）
 */
export function sampleSpring(keyframes: readonly Keyframe[], spring: SpringSpec, samples: number): Keyframe[] {
  if (keyframes.length === 0) return [];
  const count = Math.min(64, Math.max(3, Math.round(Number.isFinite(samples) ? samples : 12)));
  const stiffness = spring.stiffness > 0 ? spring.stiffness : 0.18;
  const mass = spring.mass > 0 ? spring.mass : 1;
  const damping = spring.damping >= 0 ? spring.damping : 0.12;
  const omega = Math.sqrt(stiffness / mass) * Math.PI * 2;
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const dampedOmega = omega * Math.sqrt(Math.max(0.0001, 1 - zeta * zeta));
  const frames: Keyframe[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = index / (count - 1);
    const t = at * SPRING_TIME_SCALE;
    const envelope = Math.exp(-zeta * omega * t);
    const progress = 1 - envelope * Math.cos(dampedOmega * t);
    frames.push({ at: Math.round(at * 1e6) / 1e6, value: evaluateCurve(keyframes, progress) });
  }
  return frames;
}

/**
 * 清洗层 id，得到合法的 CSS 动画名片段。
 *
 * @param layerId 层 id
 * @returns 只含字母数字与连字符的片段
 */
export function animationNameOf(motionId: string, layerId: string): string {
  const safe = layerId.replace(/[^a-zA-Z0-9-]/g, '-');
  return `pet-motion-${motionId}-${safe}`;
}

/**
 * 把一个动作编译成 CSS 规则。
 *
 * @param catalog 动作目录
 * @param id 动作 id
 * @param options 编译选项
 * @returns 编译结果（`cssRules` 为空 = 不改动样式，例如减少动态模式）
 */
export function compileMotion(catalog: MotionCatalog, id: string, options: CompileOptions): CompiledMotion {
  // 减少动态：一条规则都不产出（CSS 那边已经用 @media 关了动画，这里不再叠一层）
  if (options.reducedMotion) {
    return { id, durationMs: 0, cssRules: [], unsupportedTracks: [] };
  }
  const def: MotionDef | undefined = catalog?.motions?.[id];
  if (!def) {
    return { id, durationMs: 0, cssRules: [], unsupportedTracks: [id] };
  }
  const baseDuration = def.durationMs ?? DEFAULT_LOOP_DURATION_MS;
  const durationMs = options.power === 'low' ? baseDuration * 2 : baseDuration;
  const cssRules: string[] = [];
  const unsupportedTracks: string[] = [];
  // 白名单先建成 Set：每帧都会走这条路径，数组 includes 在高频重建时是白给的开销
  const allowed = Array.isArray(options.allowedLayerIds) ? new Set(options.allowedLayerIds) : null;

  for (const track of def.tracks) {
    if (allowed && !allowed.has(track.layerId)) {
      // 非可动层（支撑层 / 清单里不存在的层）：不给规则，只记账
      unsupportedTracks.push(`${id}:${track.layerId}`);
      continue;
    }
    const compiled = compileTrack(def, track, baseDuration, durationMs, options.selectorRoot);
    if (!compiled) {
      unsupportedTracks.push(`${id}:${track.layerId}`);
      continue;
    }
    cssRules.push(compiled.keyframesRule, compiled.consumerRule);
  }

  return { id, durationMs, cssRules, unsupportedTracks };
}

/**
 * 编译单条轨道。
 *
 * @param def 动作定义（提供 `loop` 与镜像源）
 * @param track 轨道
 * @param baseDuration 动作本身时长（算滞后占比用，不含功耗乘数）
 * @param durationMs 实际动画时长
 * @param selectorRoot 选择器根（如 `#pet-root[data-motion='tap']`）
 * @returns 两条规则；无法编译时返回 null
 */
function compileTrack(
  def: MotionDef,
  track: MotionTrack,
  baseDuration: number,
  durationMs: number,
  selectorRoot: string,
): { keyframesRule: string; consumerRule: string } | null {
  let property = track.property;
  let ease = track.ease ?? DEFAULT_TRACK_EASE;
  let frames: readonly Keyframe[] = track.keyframes;

  if (track.mirror) {
    const source = def.tracks.find((item) => item.layerId === track.mirror);
    if (!source || source.mirror) return null;
    property = source.property;
    ease = track.ease ?? source.ease ?? DEFAULT_TRACK_EASE;
    frames = source.keyframes;
  }

  if (track.follow) {
    const lagMs = Math.max(0, Math.min(track.follow.lagMs, track.follow.maxLagMs, baseDuration));
    frames = wrapKeyframes(frames, lagMs / baseDuration, track.follow.gain);
  } else if (track.spring) {
    frames = sampleSpring(frames, track.spring, track.samples ?? 12);
  }

  if (frames.length < 2) return null;

  const unit = typeof track.unit === 'string' && track.unit.length > 0 ? track.unit : defaultUnit(property);
  const name = animationNameOf(def.id, track.layerId);
  const body = frames
    .map((frame) => `${formatNumber(frame.at * 100)}% { ${declarationOf(property, frame.value, unit)} }`)
    .join(' ');
  const keyframesRule = `@keyframes ${name} { ${body} }`;
  const iterations = def.loop ? ' infinite' : '';
  const consumerRule = `${selectorRoot} [data-layer='${track.layerId}'] { animation: ${name} ${durationMs}ms ${ease} both${iterations}; }`;
  return { keyframesRule, consumerRule };
}
